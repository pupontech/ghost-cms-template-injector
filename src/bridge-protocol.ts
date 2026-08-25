/**
 * C3 bridge wire protocol — shared by the isolated-world client and the
 * MAIN-world responder.
 *
 * Fixed allowlist only: discover, snapshot, planApply, apply, save, rollback.
 * Every message carries protocol version `v`, a UUID nonce/request id, the
 * bridge `source` identity, and a structured-cloneable payload. No eval,
 * arbitrary property paths, function names, fetch, or extension APIs cross
 * this boundary. All validation fails closed.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Identity string stamped on every request and accepted on every response. */
export const BRIDGE_SOURCE_ID = 'ghost-preset-toolbar/page-bridge/v1';

export const BRIDGE_OPERATIONS = [
  'discover',
  'snapshot',
  'planApply',
  'apply',
  'save',
  'rollback',
] as const;

export type BridgeOperation = (typeof BRIDGE_OPERATIONS)[number];

export type BridgeErrorCode =
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_OPERATION'
  | 'UNSUPPORTED_CAPABILITY'
  | 'NONCE_MISMATCH'
  | 'SOURCE_MISMATCH'
  | 'TIMEOUT'
  | 'BUSY'
  | 'APPLY_FAILED'
  | 'ROLLBACK_FAILED'
  /** Request arrived while the MAIN bridge is dormant (no capability active). */
  | 'CAPABILITY_REQUIRED';

export interface BridgeRequest {
  v: number;
  op: BridgeOperation;
  nonce: string;
  source: string;
  payload: Record<string, unknown>;
}

export interface BridgeSuccess<R = unknown> {
  v: number;
  source: string;
  nonce: string;
  ok: true;
  result: R;
}

export interface BridgeFailure {
  v: number;
  source: string;
  nonce: string;
  ok: false;
  error: BridgeErrorCode;
}

export type BridgeResponse<R = unknown> = BridgeSuccess<R> | BridgeFailure;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Structured-cloneable check: rejects functions, symbols, DOM nodes. */
function isCloneable(value: unknown, seen: Set<object>): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return true;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return false;
  if (typeof value !== 'object') return false;
  const obj = value as object;
  if (seen.has(obj)) return false; // cycles are not cloneable
  seen.add(obj);
  if (Array.isArray(obj)) {
    return obj.every((item) => isCloneable(item, seen));
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(obj).every((item) => isCloneable(item, seen));
}

/** Cryptographically secure nonce. Prefers randomUUID; falls back to
 * getRandomValues (available in every browser target, min Chrome 116).
 * Math.random is never used — nonces must be unguessable. */
function createNonce(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`.slice(
    0,
    36,
  );
}

export function createBridgeRequest(
  op: BridgeOperation,
  payload: Record<string, unknown>,
): BridgeRequest {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    op,
    nonce: createNonce(),
    source: BRIDGE_SOURCE_ID,
    payload,
  };
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r['v'] !== BRIDGE_PROTOCOL_VERSION) return false;
  if (typeof r['op'] !== 'string' || !BRIDGE_OPERATIONS.includes(r['op'] as BridgeOperation)) {
    return false;
  }
  if (typeof r['nonce'] !== 'string' || !UUID_RE.test(r['nonce'])) return false;
  if (r['source'] !== BRIDGE_SOURCE_ID) return false;
  if (typeof r['payload'] !== 'object' || r['payload'] === null) return false;
  return isCloneable(r['payload'], new Set());
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r['v'] !== BRIDGE_PROTOCOL_VERSION) return false;
  if (r['source'] !== BRIDGE_SOURCE_ID) return false;
  if (typeof r['nonce'] !== 'string' || !UUID_RE.test(r['nonce'])) return false;
  if (r['ok'] === true) {
    return typeof r['result'] === 'object';
  }
  if (r['ok'] === false) {
    return (
      typeof r['error'] === 'string' &&
      [
        'INVALID_REQUEST',
        'UNSUPPORTED_OPERATION',
        'UNSUPPORTED_CAPABILITY',
        'NONCE_MISMATCH',
        'SOURCE_MISMATCH',
        'TIMEOUT',
        'BUSY',
        'APPLY_FAILED',
        'ROLLBACK_FAILED',
        'CAPABILITY_REQUIRED',
      ].includes(r['error'])
    );
  }
  return false;
}

/**
 * Isolated-side acceptance: the reply must come from our injected bridge
 * identity and carry the exact request nonce. Fail closed otherwise.
 */
export function validateBridgeResponse<R = unknown>(
  response: unknown,
  request: BridgeRequest,
): { ok: true; result: R } | { ok: false; error: BridgeErrorCode } {
  if (!isBridgeResponse(response)) {
    return { ok: false, error: 'SOURCE_MISMATCH' };
  }
  if (response.nonce !== request.nonce) {
    return { ok: false, error: 'NONCE_MISMATCH' };
  }
  if (response.ok) {
    return { ok: true, result: response.result as R };
  }
  return { ok: false, error: response.error };
}

/* ------------------------------------------------------------------ */
/* Capability handshake (C8 revoke hardening)                         */
/* ------------------------------------------------------------------ */

/**
 * Identity string for the one-time capability ACTIVATION message sent from the
 * isolated world to the MAIN bridge. The MAIN bridge is dormant by default and
 * answers NOTHING (not even `discover`) until it receives this activation with
 * the exact per-enable token minted in the extension context. When the user
 * disables the toolbar, a matching DEACTIVATE message (same token) puts the
 * bridge back to sleep; any other message shape is ignored entirely.
 *
 * The token is scoped per enable cycle: each grant() mints a fresh random
 * value in the extension's isolated/service-worker context (never derivable
 * from page code), and a stale token from a previous enable cannot reactivate
 * a dormant or already-activated bridge.
 */
export const BRIDGE_CAPABILITY_SOURCE = 'ghost-preset-toolbar/page-bridge-capability/v1';

export interface BridgeCapabilityMessage {
  capSource: string;
  action: 'activate' | 'deactivate';
  token: string;
}

/** Structural check for the capability handshake envelope (no token compare). */
export function isBridgeCapabilityEnvelope(value: unknown): value is BridgeCapabilityMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m['capSource'] === BRIDGE_CAPABILITY_SOURCE &&
    (m['action'] === 'activate' || m['action'] === 'deactivate') &&
    typeof m['token'] === 'string'
  );
}
