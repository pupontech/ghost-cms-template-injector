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

export function createCapabilityClient(deps: CapabilityClientDeps): CapabilityClient {
  let token: string | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    activateForDocument() {
      // One token per document lifecycle: first call mints and posts the
      // one-time activation; subsequent calls are idempotent (the MAIN gate
      // also refuses a second activation while already active).
      if (token === null) {
        token = deps.randomToken();
        deps.postToWindow(envelope('activate', token));
      }
    },
    deactivate() {
      if (token === null) return;
      deps.postToWindow(envelope('deactivate', token));
    },
    watchRevocation() {
      if (unsubscribe) return;
      unsubscribe = deps.onConsentRevoked(() => this.deactivate());
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      token = null;
    },
    holdsToken: () => token !== null,
  };
}
