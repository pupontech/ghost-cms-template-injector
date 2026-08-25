/**
 * Isolated-world capability client for the MAIN bridge (C8 revoke hardening).
 *
 * After the extension enables the toolbar, each Ghost Admin document runs this
 * client from the isolated content script: it mints a fresh unguessable token
 * (extension context — page MAIN-world code never sees generation), posts the
 * one-time ACTIVATION envelope to `window`, and holds the token. When consent
 * is revoked (Disable), the controller writes null consent to
 * chrome.storage.local; the client observes that via the injected watcher and
 * posts DEACTIVATION with the exact held token, returning any already-injected
 * MAIN bridge in pre-existing documents to dormancy.
 *
 * Pure orchestration: all randomness, messaging, and storage watching are
 * injected seams, fully unit-testable without a browser.
 */

import { BRIDGE_CAPABILITY_SOURCE } from './bridge-protocol';

export interface CapabilityClientDeps {
  /** Mint a fresh unguessable token (must use crypto-grade randomness). */
  randomToken: () => string;
  /** Post a message to `window` (reaches the MAIN bridge). */
  postToWindow: (message: unknown) => void;
  /** Subscribe to consent-revocation notifications; returns unsubscribe. */
  onConsentRevoked: (cb: () => void) => () => void;
  /** True when the MAIN bridge has answered with this client's token and is awake. Optional: when omitted, the client relies on repeated activation retries to guarantee delivery. */
  isBridgeActive?: () => boolean;
  /**
   * Polling interval (ms) used while waiting for the MAIN bridge to install and
   * acknowledge activation. Guards against the fire-and-forget activation being
   * lost when the isolated content script runs before the MAIN bridge listener
   * is installed (registration/execution ordering at document_idle).
   */
  pollIntervalMs?: number;
  /** Cap on activation retries (each retry re-posts the held token). */
  maxActivationAttempts?: number;
}

export interface CapabilityClient {
  /** Mint a token, hold it, and activate the MAIN bridge for this document. */
  activateForDocument: () => void;
  /** Deactivate the MAIN bridge with the held token (no-op when dormant). */
  deactivate: () => void;
  /** Start watching for consent revocation (wires onConsentRevoked). */
  watchRevocation: () => void;
  /** Stop watching and drop the held token. */
  dispose: () => void;
  /** Test introspection: whether a token is currently held. */
  holdsToken: () => boolean;
}

function envelope(action: 'activate' | 'deactivate', token: string): unknown {
  return { capSource: BRIDGE_CAPABILITY_SOURCE, action, token };
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_ATTEMPTS = 25; // ~2.5s at 100ms — covers document_idle registration ordering

export function createCapabilityClient(deps: CapabilityClientDeps): CapabilityClient {
  let token: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let poll: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  function clearPoll(): void {
    if (poll !== null) {
      clearTimeout(poll);
      poll = null;
    }
  }

  function activateOnce(): void {
    if (token !== null) deps.postToWindow(envelope('activate', token));
  }

  return {
    activateForDocument() {
      // Idempotent across calls: only the first call in a document lifecycle
      // mints the token and begins the activation handshake. Because the MAIN
      // bridge listener may not yet be installed when this isolated script runs
      // (it is registered after this content script at document_idle), the
      // one-time activation envelope can be silently lost, so once started we
      // re-post the held token on a short poll until the bridge acknowledges
      // activation (`isBridgeActive`) or we hit the attempt cap. A genuinely new
      // enable always mints a fresh token and re-runs the handshake (see
      // deactivate(), which clears the local token + restart capability).
      if (started) return;
      started = true;
      if (token === null) token = deps.randomToken();
      const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const maxAttempts = deps.maxActivationAttempts ?? DEFAULT_MAX_ATTEMPTS;
      let attempts = 0;
      activateOnce();
      const tick = (): void => {
        if (token === null || poll === null) return;
        if (deps.isBridgeActive?.()) {
          clearPoll();
          return;
        }
        if (attempts >= maxAttempts) {
          clearPoll();
          return;
        }
        attempts += 1;
        activateOnce();
        poll = setTimeout(tick, interval);
      };
      clearPoll();
      poll = setTimeout(tick, interval);
    },
    deactivate() {
      clearPoll();
      started = false;
      if (token === null) return;
      deps.postToWindow(envelope('deactivate', token));
      // Drop the held token so a later re-enable (consent re-granted without a
      // reload) mints a FRESH token and re-runs the activation handshake. The
      // MAIN gate consumes the old token on deactivate, so it can never
      // re-activate the bridge; clearing it here guarantees the next enable
      // cycle produces an unseen token that the gate will accept.
      token = null;
    },
    watchRevocation() {
      if (unsubscribe) return;
      unsubscribe = deps.onConsentRevoked(() => this.deactivate());
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      clearPoll();
      token = null;
    },
    holdsToken: () => token !== null,
  };
}
