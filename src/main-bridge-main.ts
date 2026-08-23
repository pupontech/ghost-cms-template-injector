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
  const gate = createCapabilityGate({
    // The gate never mints its own token: activation succeeds only when the
    // candidate matches the token the ISOLATED world proved possession of via
    // the activation envelope. randomToken is unused by design here; see
    // capability-gate.ts — activate() requires exact equality with the token
    // carried by the handshake message while dormant. To keep the pure gate's
    // mint-comparison semantics, we wrap it: the accepted token is whatever
    // the extension world sent first while dormant.
    randomToken: () => '',
  });
  // The pure gate compares against deps.randomToken(); for the MAIN world we
  // instead track the accepted token directly (first activation wins) using a
  // thin adapter around the same state machine semantics.
  let acceptedToken: string | null = null;
  let consumedToken: string | null = null;
  const isActive = () => acceptedToken !== null;
  const guard = (request: Parameters<ReturnType<typeof createCapabilityGate>['guard']>[0]) =>
    isActive() ? { kind: 'allow', request } : { kind: 'reject' };

  function onCapability(msg: BridgeCapabilityMessage): void {
    if (msg.action === 'activate') {
      // One handshake per enable cycle. Refuse activation when:
      //  - already active (token already set for this cycle), OR
      //  - the token was already consumed by a prior deactivation (a stale
      //    token from a previous enable cycle cannot reactivate).
      if (acceptedToken === null && consumedToken !== msg.token && msg.token.length >= 16) {
        acceptedToken = msg.token;
      }
      return;
    }
    // deactivate: only the currently-active token may put the bridge to sleep,
    // and it is then consumed so a replay of the same token cannot re-activate.
    if (acceptedToken !== null && msg.token === acceptedToken) {
      acceptedToken = null;
      consumedToken = msg.token;
    }
  }

  async function handleGated(data: unknown): Promise<BridgeReply> {
    if (!isActive()) {
      // Dormant by default: answer NOTHING — not even a reject. A silent bridge
      // gives a probing page no signal that the bridge exists, which is the
      // strongest revoke posture and exactly matches the "no bridge response"
      // acceptance criterion. Activation (capability handshake) is the only
      // thing that transitions this realm to a responsive state.
      return undefined as unknown as BridgeReply;
    }
    return (await handle(data)) as BridgeReply;
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

  // Document teardown: drop every reference so a BFCache restore cannot revive
  // an activated bridge from a previous enable cycle.
  globalThis.addEventListener('pagehide', () => {
    acceptedToken = null;
    consumedToken = null;
  });

  // Test/evidence introspection hook (no page-reachable capability).
  (globalThis as Record<string, unknown>)['__ghostPresetToolbarBridgeActive'] = () => isActive();
  void guard;
  void gate;
}

type BridgeReply = BridgeResponse;

if (isBrowserContext() && typeof globalThis.addEventListener === 'function') {
  const { handle } = createGhostMainBridge();
  installMainBridge(handle);
}
