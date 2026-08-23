/**
 * MAIN-world bridge capability gate (C8 revoke hardening).
 *
 * The dynamically-registered MAIN-world bridge script installs a `message`
 * listener at evaluation time. `chrome.scripting.unregisterContentScripts()`
 * removes the registration RECORD only — it cannot unload code already
 * executed in an existing document, so the listener keeps answering the fixed
 * bridge protocol until the document is truly destroyed. Registration queries
 * (`getRegisteredContentScripts() === []`) are therefore NOT a runtime kill
 * switch.
 *
 * This gate makes the bridge DORMANT BY DEFAULT: every inbound request,
 * including `discover`, is rejected with `CAPABILITY_REQUIRED` until the
 * isolated extension world activates it via a one-time per-enable token
 * (minted with crypto randomness in the extension context, which page code
 * cannot observe). Deactivation with the SAME active token puts the bridge
 * back to sleep; a stale or wrong token can never activate or deactivate it.
 *
 * Pure state machine: all randomness and timing are injected so this is fully
 * unit-testable without a browser.
 */

import type { BridgeRequest, BridgeResponse } from './bridge-protocol';

export type CapabilityToken = string;

export interface CapabilityGateDeps {
  /** Mint a fresh unguessable per-enable token (extension context). */
  randomToken: () => string;
}

export type CapabilityGateDecision =
  { kind: 'reject'; response: BridgeResponse } | { kind: 'allow'; request: BridgeRequest };

export interface CapabilityGate {
  /**
   * Gate one validated inbound bridge request. Dormant ⇒ CAPABILITY_REQUIRED
   * rejection carrying the request's own nonce when parseable.
   */
  guard: (request: BridgeRequest) => CapabilityGateDecision;
  /** Activate with a candidate token; true only on an exact match while dormant. */
  activate: (candidate: string) => boolean;
  /** Deactivate with the currently-active token; true only on exact match. */
  deactivate: (candidate: string) => boolean;
  /** True when the bridge would currently answer requests. */
  isActive: () => boolean;
  /** Current token, or null while dormant. Never exposed to the page. */
  currentToken: () => CapabilityToken | null;
}

/** Minimum accepted token length — minted tokens must be unguessable. */
const MIN_TOKEN_LENGTH = 16;

function reject(request: BridgeRequest): CapabilityGateDecision {
  return {
    kind: 'reject',
    response: {
      v: 1,
      source: 'ghost-preset-toolbar/page-bridge/v1',
      nonce: request.nonce,
      ok: false,
      error: 'CAPABILITY_REQUIRED',
    },
  };
}

export function createCapabilityGate(deps: CapabilityGateDeps): CapabilityGate {
  let activeToken: string | null = null;

  return {
    guard(request) {
      if (activeToken === null) return reject(request);
      return { kind: 'allow', request };
    },
    activate(candidate) {
      // Already activated for this enable cycle: a second activation attempt
      // (even with the right token) is refused — one handshake per enable.
      if (activeToken !== null) return false;
      if (
        typeof candidate !== 'string' ||
        candidate.length < MIN_TOKEN_LENGTH ||
        candidate !== deps.randomToken()
      ) {
        return false;
      }
      activeToken = candidate;
      return true;
    },
    deactivate(candidate) {
      if (activeToken === null || candidate !== activeToken) return false;
      activeToken = null;
      return true;
    },
    isActive: () => activeToken !== null,
    currentToken: () => activeToken,
  };
}
