import { POPUP_MESSAGE_SOURCE, type PopupMessage } from './ui-popup';
import {
  isOptionsCaptureMessage,
  toContentScriptMessage,
  type OptionsCaptureMessage,
} from './import-protocol';
import {
  createImageAssetResponder,
  type ImageAssetReply,
  type ImageAssetStore,
} from './image-asset-store';

export interface BackgroundDeps {
  addOnInstalledListener: (cb: (details: { reason: string }) => void) => void;
  storage?: { set: (items: Record<string, unknown>) => Promise<void> };
  fetchFn?: typeof fetch;
}

/**
 * Phase-1 scaffold service worker. No preset logic, no network, no storage
 * writes — behavior is intentionally inert until later phases add contracts.
 */
export function createBackground(deps: BackgroundDeps): {
  init: () => void;
  handleInstalled: (details: { reason: string }) => Promise<void>;
} {
  let initialized = false;

  async function handleInstalled(_details: { reason: string }): Promise<void> {
    // Scaffold only: deliberately no side effects.
  }

  return {
    init(): void {
      if (initialized) return;
      initialized = true;
      deps.addOnInstalledListener((details) => {
        void handleInstalled(details);
      });
    },
    handleInstalled,
  };
}

/* ------------------------------------------------------------------ */
/* Phase-5 same-tab relay                                             */
/* ------------------------------------------------------------------ */

/**
 * Injected seams for the runtime.onMessage relay, so the relay can be unit
 * tested without a real service worker / `chrome` global.
 */
export interface RelayDeps {
  /** Install the single `chrome.runtime.onMessage` listener. */
  addRuntimeMessageListener: (
    cb: (
      message: unknown,
      sender: { tab?: { id?: number } },
      sendResponse: (response: unknown) => void,
    ) => boolean,
  ) => void;
  /** Forward a message to a specific tab's content script. */
  sendTabMessage: (tabId: number, message: PopupMessage) => Promise<unknown>;
}

/** Shape the relay accepts and re-emits to the same-tab content script. */
type RelayMessage = {
  source: string;
  op: 'discover' | 'apply' | 'preview' | 'undo' | 'listPosts' | 'capture' | 'capturePost';
  tabId?: unknown;
  presetId?: unknown;
  promptAnswers?: unknown;
  resourceType?: unknown;
  resourceId?: unknown;
};

/** Operations the relay forwards to the content script (fixed allowlist). */
const RELAY_OPERATIONS: ReadonlySet<string> = new Set([
  'discover',
  'preview',
  'apply',
  'undo',
  'listPosts',
  'capture',
  'capturePost',
]);

function isRelayMessage(message: unknown): message is RelayMessage {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  if (m['source'] !== POPUP_MESSAGE_SOURCE) return false;
  if (typeof m['op'] !== 'string' || !RELAY_OPERATIONS.has(m['op'])) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Options-page capture routing                                        */
/* ------------------------------------------------------------------ */

/** Message sender shape the router inspects. */
export interface CaptureSender {
  tab?: { id?: number } | undefined;
  /** Sender frame URL: the web page for a content script, the extension page otherwise. */
  url?: string | undefined;
  /** Sending extension id (always this extension: nothing else may message it). */
  id?: string | undefined;
}

/** This extension's own pages (options/popup) are the only valid senders. */
function isExtensionPageSender(sender: CaptureSender, extensionId?: string): boolean {
  if (extensionId !== undefined && sender.id !== undefined && sender.id !== extensionId)
    return false;
  const url = sender.url ?? '';
  return url.startsWith('chrome-extension://');
}

export interface OptionsCaptureDeps {
  /** This extension's id, used to reject a sender that is not one of its pages. */
  extensionId?: string;
  /**
   * Tabs visible to the extension. `url` is only populated for tabs whose host
   * the user has granted (the extension declares no `tabs` permission on
   * purpose), which is exactly the set we may read from.
   */
  queryTabs: () => Promise<Array<{ id?: number | undefined; url?: string | undefined }>>;
  /** Forward a content-script message to one tab. */
  sendTabMessage: (tabId: number, message: unknown) => Promise<unknown>;
}

/** Is this tab a Ghost Admin page we may read from? */
function isGhostAdminUrl(url: string): boolean {
  return url.includes('/ghost/') && !url.startsWith('chrome-extension://');
}

/** Prefer an editor route; otherwise the first Ghost Admin page. */
export function pickGhostTab(
  tabs: readonly { id?: number | undefined; url?: string | undefined }[],
): { id: number; url: string } | null {
  const candidates = tabs.filter(
    (tab): tab is { id: number; url: string } =>
      typeof tab.id === 'number' && typeof tab.url === 'string' && isGhostAdminUrl(tab.url),
  );
  const editor = candidates.find((tab) => /\/ghost\/(#\/)?editor\//.test(tab.url));
  return editor ?? candidates[0] ?? null;
}

/**
 * Handle an options-page capture request.
 *
 * The options page owns the import UI but has no content script of its own, so
 * the service worker routes the read-only operation to a Ghost Admin tab the
 * user has already granted. The target tab is chosen here, never by the caller,
 * so an extension page cannot point a read at an arbitrary tab. Only this
 * extension's own pages are accepted: their sender URL is a `chrome-extension://`
 * URL, while a content script reports the web page it runs in — and a web page
 * cannot message this extension at all, because no `externally_connectable` is
 * declared.
 *
 * Returns `null` when the message is not an options-page capture request, so the
 * single dispatcher can fall through to the popup/toolbar relay.
 */
export function createOptionsCaptureHandler(
  deps: OptionsCaptureDeps,
): (
  message: unknown,
  sender: { tab?: { id?: number } },
  sendResponse: (response: unknown) => void,
) => boolean | null {
  return (message, sender, sendResponse) => {
    if (!isOptionsCaptureMessage(message)) return null;
    void (async () => {
      // The Options page is normally opened in a tab, so `sender.tab` is set and
      // cannot be the discriminator. What matters is that the SENDER is one of
      // this extension's own pages (a content script reports the web page URL),
      // and that the sender cannot choose the target tab.
      if (!isExtensionPageSender(sender, deps.extensionId)) {
        sendResponse({ ok: false, error: 'NOT_AN_EXTENSION_PAGE' });
        return;
      }
      let tabs: Array<{ id?: number | undefined; url?: string | undefined }>;
      try {
        tabs = await deps.queryTabs();
      } catch (err) {
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : 'tab lookup failed',
        });
        return;
      }
      const tab = pickGhostTab(tabs);
      if (!tab) {
        sendResponse({ ok: false, error: 'NO_GHOST_TAB' });
        return;
      }
      try {
        const reply = await deps.sendTabMessage(
          tab.id,
          toContentScriptMessage(message as OptionsCaptureMessage),
        );
        sendResponse(reply);
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : 'read failed' });
      }
    })();
    return true;
  };
}

/* ------------------------------------------------------------------ */
/* Single runtime.onMessage dispatcher                                 */
/* ------------------------------------------------------------------ */

export interface RuntimeMessageDispatcherDeps {
  /** Extension-origin image asset store (service worker owns it). */
  assetStore: ImageAssetStore;
  /** Options-page capture routing (import UI lives in the Options page). */
  optionsCapture: {
    handleMessage: (
      message: unknown,
      sender: { tab?: { id?: number } },
      sendResponse: (response: unknown) => void,
    ) => boolean | null;
  };
  /** Popup/toolbar relay for the fixed popup protocol. */
  relay: {
    handleMessage: (
      message: unknown,
      sender: { tab?: { id?: number } },
      sendResponse: (response: unknown) => void,
    ) => boolean;
  };
}

/**
 * One `chrome.runtime.onMessage` listener for the whole service worker.
 *
 * Two message families arrive here and they must not race for the same
 * response channel (registering two listeners would let the relay answer an
 * asset request with a schema rejection). Asset requests are answered first
 * and only then does everything else fall through to the popup/toolbar relay.
 *
 * Asset messages are only deliverable by this extension's own contexts: no
 * `externally_connectable` is declared, so a web page cannot send them.
 */
export function createRuntimeMessageDispatcher(
  deps: RuntimeMessageDispatcherDeps,
): (
  message: unknown,
  sender: { tab?: { id?: number } },
  sendResponse: (response: unknown) => void,
) => boolean {
  const respondToAsset = createImageAssetResponder(deps.assetStore);
  return (message, sender, sendResponse) => {
    const pending = respondToAsset(message);
    if (pending) {
      void pending.then(sendResponse, () =>
        sendResponse({ ok: false, error: 'asset request failed' } satisfies ImageAssetReply),
      );
      return true;
    }
    const routed = deps.optionsCapture.handleMessage(message, sender, sendResponse);
    if (routed !== null) return routed;
    return deps.relay.handleMessage(message, sender, sendResponse);
  };
}

/**
 * Build the service-worker relay. The toolbar content script and popup use
 * `chrome.runtime.sendMessage` with the fixed popup `source`. In MV3 that
 * message is delivered to the service worker, NOT directly to the co-resident
 * content script. This relay validates the message against the fixed
 * popup/toolbar schema, derives the destination tab from the trusted
 * `sender.tab.id` (the tab that actually sent it), and forwards to that same
 * tab via `chrome.tabs.sendMessage`. The payload `tabId` is intentionally
 * ignored — a sender must not be able to redirect the relay to another tab.
 *
 * The async content-script reply is threaded back through `sendResponse`, and
 * any forwarding failure is surfaced as a structured relay error. No `tabs`
 * permission is required: `chrome.tabs.sendMessage` only needs the message
 * host permission that is already granted.
 *
 * Security (C3/C8): only the fixed identity plus the fixed operation allowlist
 * (`discover`/`preview`/`apply`/`undo` and the read-only import operations
 * `listPosts`/`capture`/`capturePost`) are forwarded; every other message is
 * rejected without forwarding. Unknown senders (no tab) cannot be relayed.
 */
export function createRelay(deps: RelayDeps): {
  init: () => void;
  handleMessage: (
    message: unknown,
    sender: { tab?: { id?: number } },
    sendResponse: (response: unknown) => void,
  ) => boolean;
} {
  let initialized = false;

  function handleMessage(
    message: unknown,
    sender: { tab?: { id?: number } },
    sendResponse: (response: unknown) => void,
  ): boolean {
    // Always keep the channel open for the async reply below.
    void (async () => {
      if (!isRelayMessage(message)) {
        sendResponse({ relay: 'rejected', reason: 'SCHEMA_MISMATCH' });
        return;
      }
      const tabId = sender.tab?.id;
      if (typeof tabId !== 'number') {
        sendResponse({ relay: 'rejected', reason: 'NO_SENDER_TAB' });
        return;
      }
      try {
        const response = await deps.sendTabMessage(tabId, message as PopupMessage);
        sendResponse(response);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown relay error';
        sendResponse({ relay: 'error', reason });
      }
    })();
    return true;
  }

  return {
    init(): void {
      if (initialized) return;
      initialized = true;
      deps.addRuntimeMessageListener((message, sender, sendResponse) => {
        // Return `true` to keep the message channel open for the async reply.
        return handleMessage(message, sender, sendResponse);
      });
    },
    handleMessage,
  };
}
