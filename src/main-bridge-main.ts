/**
 * Phase-5 MAIN-world bridge entry point.
 *
 * Runs as a `world: 'MAIN'` content script (registered after consent via
 * the host-permission). Installs `createGhostMainBridge().handle` as the page's
 * bridge responder, listening for the fixed C3 protocol over `window` messages
 * from the isolated content script. This is the ONLY code with access to Ghost
 * internals; it exposes no eval, no arbitrary property access, no fetch, no
 * extension APIs.
 *
 * Direction is enforced explicitly: only a valid *request* (isBridgeRequest)
 * is handled. The responder's own reply is response-shaped and is therefore
 * ignored on re-entry, which closes the response-echo path.
 *
 * C8 revoke hardening (capability gate): `unregisterContentScripts()` removes
 * only the registration record — it cannot unload code already evaluated in an
 * existing document, so this listener would otherwise keep answering forever.
 * The bridge is therefore DORMANT BY DEFAULT: every inbound request, including
 * `discover`, is silently dropped until the isolated extension world posts a
 * one-time per-enable activation token (minted with crypto randomness in the
 * extension context, unobservable from page code — a page can only replay a
 * token it has legitimately observed after activation was granted).
 * Deactivation with the same token puts the bridge back to sleep; document
 * teardown (pagehide) also clears all state. A stale token from a previous
 * enable cycle cannot activate anything.
 */

import { createGhostMainBridge } from './main-bridge';
import {
  isBridgeRequest,
  isBridgeCapabilityEnvelope,
  type BridgeCapabilityMessage,
  type BridgeRequest,
  type BridgeResponse,
} from './bridge-protocol';
import { createCapabilityGate } from './capability-gate';

/** Filter used by the MAIN entry: accept only valid bridge requests. */
export function isPageBridgeInbound(message: unknown): boolean {
  return isBridgeRequest(message);
}

/** Structural check for the capability handshake envelope (no token compare). */
export function isCapabilityMessage(value: unknown): value is BridgeCapabilityMessage {
  return isBridgeCapabilityEnvelope(value);
}

function isBrowserContext(): boolean {
  return typeof globalThis !== 'undefined' && 'chrome' in globalThis;
}

/**
 * Install the gated MAIN-world bridge on the current window. Separated from
 * the browser guard below so unit tests drive the exact production path.
 * Returns nothing; all interaction is via `window` messages.
 */
export function installMainBridge(
  handle: (message: unknown) => BridgeReply | Promise<BridgeReply>,
): void {
  // The single source of truth for the bridge's alive/dormant state. The MAIN
  // world never mints the token — only the isolated world does — so we inject
  // a candidate-minter that is never used by the responder path; activation
  // succeeds only when the isolated world posts a fresh, never-seen token.
  const gate = createCapabilityGate();

  function onCapability(msg: BridgeCapabilityMessage): void {
    if (msg.action === 'activate') {
      // Record the posted token as active only if we are dormant and the token
      // is a fresh, never-before-seen value (the gate enforces the length
      // floor and refuses already-consumed/stale tokens). One handshake per
      // enable cycle; a replay cannot re-activate.
      gate.activate(msg.token);
      return;
    }
    // deactivate: only the currently-active token puts the bridge to sleep,
    // and it is then remembered as consumed so a replay cannot re-activate.
    gate.deactivate(msg.token);
  }

  async function handleGated(data: unknown): Promise<BridgeReply | undefined> {
    // Single decision point is the gate's `guard`: dormant ⇒ reject. On the
    // wire a reject is rendered as SILENCE (no reply at all — not even a
    // CAPABILITY_REQUIRED error), so a probing page gets no signal that the
    // bridge exists; that is the strongest revoke posture and exactly matches
    // the "no bridge response" acceptance criterion. Activation (capability
    // handshake above) is the only thing that transitions this realm to a
    // responsive state.
    const decision = gate.guard(data as BridgeRequest);
    if (decision.kind === 'reject') return undefined;
    return (await handle(decision.request)) as BridgeReply;
  }

  const listener = (event: MessageEvent): void => {
    const data: unknown = event.data;

    // Capability handshake first: activation/deactivation envelope.
    if (isCapabilityMessage(data)) {
      onCapability(data);
      return;
    }

    // Accept ONLY valid C3 bridge requests, then run them through the gate.
    if (!isPageBridgeInbound(data)) return;
    void handleGated(data).then((reply) => {
      if (reply === undefined) return; // dormant: silence
      const source = event.source as { postMessage?: (m: unknown, t: string) => void } | null;
      source?.postMessage?.(reply, '*');
    });
  };

  globalThis.addEventListener('message', listener as EventListener);

  // Document teardown: deactivate (consuming the token) and remove the listener
  // so a BFCache restore / target reuse cannot revive an activated bridge from
  // a previous enable cycle. A fresh enable always mints a NEW token, which is
  // not consumed, so it re-activates cleanly.
  globalThis.addEventListener('pagehide', () => {
    const tok = gate.currentToken();
    if (tok) gate.deactivate(tok);
    globalThis.removeEventListener('message', listener as EventListener);
  });

  // Test/evidence introspection hook (no page-reachable capability).
  (globalThis as Record<string, unknown>)['__ghostPresetToolbarBridgeActive'] = () =>
    gate.isActive();
}

type BridgeReply = BridgeResponse;

if (isBrowserContext() && typeof globalThis.addEventListener === 'function') {
  const { handle } = createGhostMainBridge();
  installMainBridge(handle);
}
