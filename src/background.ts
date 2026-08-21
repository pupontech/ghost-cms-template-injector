import { POPUP_MESSAGE_SOURCE, type PopupMessage } from './ui-popup';

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
  op: 'discover' | 'apply';
  tabId?: unknown;
  presetId?: unknown;
  promptAnswers?: unknown;
};

function isRelayMessage(message: unknown): message is RelayMessage {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  if (m['source'] !== POPUP_MESSAGE_SOURCE) return false;
  if (m['op'] !== 'discover' && m['op'] !== 'apply') return false;
  return true;
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
 * Security (C3/C8): only the fixed identity + `discover`/`apply` operations are
 * forwarded; every other message is rejected without forwarding. Unknown
 * senders (no tab) cannot be relayed.
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
