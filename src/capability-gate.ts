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
 * including `discover`, is answered with silence (no reply at all) until the
 * isolated extension world activates it via a one-time per-enable token
 * (minted with crypto randomness in the extension context, which page code
 * cannot observe). Deactivation with the SAME active token puts the bridge
 * back to sleep; the consumed token is remembered so a replay of it (or any
 * stale token from a previous enable cycle) can never re-activate.
 *
 * Responder model: the MAIN world cannot mint the token — only the isolated
 * world can. So `activate(candidate)` becomes "record the candidate as the
 * active token if (a) we are currently dormant and (b) the candidate is a
 * fresh, never-before-seen token." A token that was already consumed by a
 * prior deactivation is remembered in `consumed` and is therefore refused.
 * `deactivate(candidate)` clears the active token only when it matches the
 * currently-active one, and records it as consumed.
 *
 * Pure state machine: all randomness and timing are injected so this is fully
 * unit-testable without a browser.
 */

import type { BridgeRequest, BridgeResponse } from './bridge-protocol';

export type CapabilityToken = string;

export type CapabilityGateDecision =
  { kind: 'reject'; response: BridgeResponse } | { kind: 'allow'; request: BridgeRequest };

export interface CapabilityGate {
  /**
   * Gate one validated inbound bridge request. Dormant ⇒ silent reject
   * (CAPABILITY_REQUIRED) carrying the request's own nonce. The MAIN bridge
   * turns this into *no reply at all* on the wire, but the decision type is
   * what unit tests assert on.
   */
  guard: (request: BridgeRequest) => CapabilityGateDecision;
  /**
   * Activate with a candidate token. Returns true only when:
   *   - the bridge is currently dormant (no active token), AND
   *   - the candidate is a fresh token (never before activated AND never
   *     before consumed by a deactivation), AND
   *   - the candidate meets the minimum length floor.
   * On success the candidate becomes the active token.
   */
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

export function createCapabilityGate(): CapabilityGate {
  let activeToken: CapabilityToken | null = null;
  const consumed = new Set<CapabilityToken>();

  function mustReject(request: BridgeRequest): CapabilityGateDecision {
    return {
      kind: 'reject',
      response: {
        v: 1,
        source: 'ghost-cms-template-injector/page-bridge/v1',
        nonce: request.nonce,
        ok: false,
        error: 'CAPABILITY_REQUIRED',
      },
    };
  }

  return {
    guard(request) {
      if (activeToken === null) return mustReject(request);
      return { kind: 'allow', request };
    },
    activate(candidate) {
      // Already activated for this enable cycle: a second activation attempt
      // (even with a fresh token) is refused — one handshake per enable.
      if (activeToken !== null) return false;
      if (typeof candidate !== 'string' || candidate.length < MIN_TOKEN_LENGTH) {
        return false;
      }
      // A token that was already consumed by a prior deactivation (a stale
      // token from a previous enable cycle) can never re-activate. Because the
      // isolated world mints a fresh token every enable, a genuinely new
      // enable always produces a never-seen candidate and therefore succeeds.
      if (consumed.has(candidate)) return false;
      activeToken = candidate;
      return true;
    },
    deactivate(candidate) {
      if (activeToken === null || candidate !== activeToken) return false;
      consumed.add(activeToken);
      activeToken = null;
      return true;
    },
    isActive: () => activeToken !== null,
    currentToken: () => activeToken,
  };
}
