/**
 * C3 MAIN-world bridge: isolated-side client + MAIN-world responder.
 *
 * Isolated side (createPageBridge): posts validated requests to
 * `window.postMessage`, accepts replies only from the injected bridge
 * identity with the matching nonce, and fails closed on timeout.
 *
 * MAIN side (createPageBridgeResponder): answers ONLY the fixed operation
 * allowlist through capability-gated handlers. No eval, no generic property
 * access, no fetch, no extension APIs. One apply transaction is serialized
 * per editor tab: concurrent apply/save requests fail closed with `BUSY`.
 */

import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SOURCE_ID,
  createBridgeRequest,
  isBridgeRequest,
  isBridgeResponse,
  validateBridgeResponse,
  type BridgeErrorCode,
  type BridgeOperation,
  type BridgeRequest,
  type BridgeResponse,
} from './bridge-protocol';

export const BRIDGE_TIMEOUT_MS = 5_000;

/* ------------------------------------------------------------------ */
/* Isolated-world client                                              */
/* ------------------------------------------------------------------ */

export interface PageBridgeEnv {
  addEventListener: (cb: (event: MessageEvent) => void) => void;
  removeEventListener: (cb: (event: MessageEvent) => void) => void;
  postMessage: (message: unknown) => void;
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (id: unknown) => void;
}

export interface PageBridge {
  request(
    op: BridgeOperation,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: BridgeErrorCode }>;
}

export function createPageBridge(env: PageBridgeEnv): PageBridge {
  let listener: ((event: MessageEvent) => void) | null = null;
  const pending = new Map<
    string,
    (reply: { ok: true; result: unknown } | { ok: false; error: BridgeErrorCode }) => void
  >();

  function ensureListener(): void {
    if (listener) return;
    listener = (event: MessageEvent) => {
      const data: unknown = event.data;
      // The client accepts ONLY response-shaped messages. Its own outbound
      // request is also stamped with our source/nonce, so the loose
      // source check allowed it through and raced the real responder reply
      // with a SOURCE_MISMATCH. Requiring a valid response shape (via
      // isBridgeResponse) drops the self-echo; validateBridgeResponse still
      // re-checks nonce and fails closed.
      if (!isBridgeResponse(data)) return;
      const nonce = data.nonce;
      const resolve = pending.get(nonce);
      if (!resolve) return; // stale or unknown nonce — ignore, fail closed via timeout
      pending.delete(nonce);
      resolve(
        validateBridgeResponse(data, {
          nonce,
        } as unknown as BridgeRequest) as
          { ok: true; result: unknown } | { ok: false; error: BridgeErrorCode },
      );
    };
    env.addEventListener(listener);
  }

  return {
    request(op, payload) {
      ensureListener();
      const req = createBridgeRequest(op, payload);
      return new Promise<
        | {
            ok: true;
            result: unknown;
          }
        | { ok: false; error: BridgeErrorCode }
      >((resolve) => {
        const timer = env.setTimeoutFn(() => {
          pending.delete(req.nonce);
          resolve({ ok: false, error: 'TIMEOUT' });
        }, BRIDGE_TIMEOUT_MS);
        pending.set(req.nonce, (reply) => {
          env.clearTimeoutFn(timer);
          resolve(reply);
        });
        env.postMessage(req);
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* MAIN-world responder                                               */
/* ------------------------------------------------------------------ */

export type BridgeHandler = (payload: Record<string, unknown>) => unknown | Promise<unknown>;

export interface PageBridgeResponderEnv {
  /** Capability-gated operation handlers; absent ops fail closed. */
  discover?: BridgeHandler;
  snapshot?: BridgeHandler;
  planApply?: BridgeHandler;
  apply?: BridgeHandler;
  save?: BridgeHandler;
  rollback?: BridgeHandler;
}

export interface PageBridgeResponder {
  handle(message: unknown): BridgeResponse | Promise<BridgeResponse>;
}

/** Operations that mutate live state — serialized one transaction per tab. */
const TRANSACTIONAL_OPS: ReadonlySet<BridgeOperation> = new Set([
  'planApply',
  'apply',
  'save',
  'rollback',
]);

export function createPageBridgeResponder(env: PageBridgeResponderEnv): PageBridgeResponder {
  let busy = false;

  function respond(
    request: BridgeRequest,
    outcome: () => { ok: true; result: unknown } | { ok: false; error: BridgeErrorCode },
  ): BridgeResponse {
    const reply = outcome();
    return reply.ok
      ? {
          v: BRIDGE_PROTOCOL_VERSION,
          source: BRIDGE_SOURCE_ID,
          nonce: request.nonce,
          ok: true,
          result: reply.result,
        }
      : {
          v: BRIDGE_PROTOCOL_VERSION,
          source: BRIDGE_SOURCE_ID,
          nonce: request.nonce,
          ok: false,
          error: reply.error,
        };
  }

  return {
    handle(message: unknown): BridgeResponse | Promise<BridgeResponse> {
      // 1. Schema/identity gate — fail closed without mutation.
      if (!isBridgeRequest(message)) {
        const nonce =
          typeof (message as Record<string, unknown> | null)?.['nonce'] === 'string'
            ? ((message as Record<string, unknown>)['nonce'] as string)
            : crypto.randomUUID();
        return {
          v: BRIDGE_PROTOCOL_VERSION,
          source: BRIDGE_SOURCE_ID,
          nonce,
          ok: false,
          error: 'INVALID_REQUEST',
        };
      }
      const request: BridgeRequest = message;

      // 2. Handler gate — unimplemented operations fail closed.
      const handler = env[request.op as keyof PageBridgeResponderEnv];
      if (typeof handler !== 'function') {
        return respond(request, () => ({
          ok: false,
          error: 'UNSUPPORTED_OPERATION',
        }));
      }

      // 3. Per-tab transaction serialization.
      if (TRANSACTIONAL_OPS.has(request.op)) {
        if (busy) {
          return respond(request, () => ({ ok: false, error: 'BUSY' }));
        }
        busy = true;
        try {
          const result = handler(request.payload);
          if (result && typeof (result as { then?: unknown }).then === 'function') {
            // Async handler: release the slot when it settles.
            return (result as Promise<unknown>).then(
              (value) => {
                busy = false;
                return {
                  v: BRIDGE_PROTOCOL_VERSION,
                  source: BRIDGE_SOURCE_ID,
                  nonce: request.nonce,
                  ok: true,
                  result: value,
                } satisfies BridgeResponse;
              },
              () => {
                busy = false;
                return {
                  v: BRIDGE_PROTOCOL_VERSION,
                  source: BRIDGE_SOURCE_ID,
                  nonce: request.nonce,
                  ok: false,
                  error: 'APPLY_FAILED',
                } satisfies BridgeResponse;
              },
            );
          }
          busy = false;
          return respond(request, () => ({ ok: true, result }));
        } catch {
          busy = false;
          return respond(request, () => ({
            ok: false,
            error: 'APPLY_FAILED',
          }));
        }
      }

      try {
        return respond(request, () => ({ ok: true, result: handler(request.payload) }));
      } catch {
        return respond(request, () => ({ ok: false, error: 'APPLY_FAILED' }));
      }
    },
  };
}
