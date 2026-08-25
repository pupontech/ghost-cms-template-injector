import { createContentScript } from './content-script';
import { deriveAdminApiBase, GhostAdminClient } from './ghost-api';
import { createCapabilityClient, type CapabilityClientDeps } from './capability-client';
import { CONSENT_STORAGE_KEY } from './host-permission';
import type { PageBridgeEnv } from './page-bridge';

const deps = {
  isGhostAdminPage: () => {
    const path = globalThis.location?.pathname ?? '';
    return /\/ghost\//.test(path);
  },
  addRuntimeMessageListener: (
    cb: (message: unknown, sendResponse: (response: unknown) => void) => Promise<unknown> | unknown,
  ) => {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      // Return `true` to keep the channel open for the async reply.
      void Promise.resolve(cb(message, sendResponse)).then(
        (response) => sendResponse(response),
        () => sendResponse(undefined),
      );
      return true;
    });
  },
  createBridgeEnv: (): PageBridgeEnv => ({
    addEventListener: (cb) => globalThis.addEventListener('message', cb),
    removeEventListener: (cb) => globalThis.removeEventListener('message', cb),
    // Both bridge ends share this window, so target our own origin rather
    // than '*' — replies never fan out to embedding frames.
    postMessage: (message) => globalThis.postMessage(message, globalThis.location?.origin || '*'),
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }),
  getAdminApiBase: () => {
    try {
      const url = globalThis.location?.href ?? '';
      if (!/\/ghost\//.test(url)) return null;
      return { base: deriveAdminApiBase(url) };
    } catch {
      return null;
    }
  },
  createApiClient: (base: string) => new GhostAdminClient(globalThis.fetch.bind(globalThis), base),
};

createContentScript(deps).init();

/* ------------------------------------------------------------------ */
/* C8 capability handshake: activate the MAIN bridge per document     */
/* ------------------------------------------------------------------ */

/**
 * The MAIN-world bridge is dormant by default. After this isolated script
 * loads in a Ghost Admin document, mint a fresh token here (extension world —
 * page code cannot observe generation), post the one-time ACTIVATION envelope
 * to `window`, and watch chrome.storage.local for consent revocation: when
 * Disable clears the consent key, deactivate with the held token so any live
 * MAIN bridge in THIS or a pre-existing document goes back to sleep.
 *
 * Token freshness is enforced by the MAIN gate's one-handshake-per-enable
 * rule plus document teardown clearing; a stale token cannot reactivate.
 */

function buildCapabilityDeps(): CapabilityClientDeps {
  const cryptoRef = globalThis.crypto;
  return {
    randomToken: () => {
      if (typeof cryptoRef?.randomUUID === 'function') return cryptoRef.randomUUID();
      // Chrome ≥116 always provides randomUUID; this fallback must STILL be
      // cryptographically secure (the activation token gates the MAIN bridge).
      // getRandomValues is guaranteed in the MV3 browser target (Chrome 116+),
      // so Math.random is never acceptable here.
      const bytes = cryptoRef.getRandomValues(new Uint8Array(16));
      return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    },
    // The activation envelope reaches the MAIN bridge in THIS same window.
    // Target our own origin (not '*') so a cross-origin embedding frame can
    // never eavesdrop on the handshake or race the one-time activation.
    postToWindow: (message) => globalThis.postMessage(message, globalThis.location?.origin || '*'),
    // The MAIN bridge installs the live-state introspection hook only under
    // test/evidence builds; in production we don't expose it. When present we
    // treat a truthy result as "awake", otherwise fall back to repeated
    // activation retries (the gateway below) to guarantee delivery.
    isBridgeActive: () => {
      const hook = (globalThis as Record<string, unknown>)[
        '__ghostCmsTemplateInjectorBridgeActive'
      ];
      return typeof hook === 'function' && Boolean((hook as () => boolean)());
    },
    onConsentRevoked: (cb) => {
      let lastConsent: unknown = undefined;
      // Snapshot initial consent so we only fire on an actual revocation
      // transition while this document is alive.
      void chrome.storage.local.get(CONSENT_STORAGE_KEY).then((r) => {
        lastConsent = r[CONSENT_STORAGE_KEY];
      });
      const listener = (
        changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
        area: string,
      ) => {
        if (area !== 'local') return;
        if (!(CONSENT_STORAGE_KEY in changes)) return;
        if (changes[CONSENT_STORAGE_KEY].newValue === null && lastConsent !== null) {
          cb();
        }
        lastConsent = changes[CONSENT_STORAGE_KEY].newValue ?? null;
      };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },
  };
}

if (
  deps.isGhostAdminPage() &&
  typeof chrome !== 'undefined' &&
  chrome.storage?.onChanged &&
  typeof chrome.storage.local.get === 'function'
) {
  const client = createCapabilityClient(buildCapabilityDeps());
  client.activateForDocument();
  client.watchRevocation();

  // BFCache restore: the MAIN bridge tears down its listener + consumes its
  // token on pagehide, so a back/forward-cache restore must re-mint a fresh
  // token and re-run the one-time activation handshake for this document
  // (M2: without this, every op after restore silently times out).
  globalThis.addEventListener('pageshow', (event: PageTransitionEvent) => {
    if (event.persisted === true) {
      client.deactivate(); // drop the (consumed) held token
      client.activateForDocument(); // mint a fresh never-seen token
    }
  });
}
