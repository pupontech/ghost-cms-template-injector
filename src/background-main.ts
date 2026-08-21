import { createBackground, createRelay } from './background';
import type { PopupMessage } from './ui-popup';

const deps = {
  addOnInstalledListener: (cb: (details: { reason: string }) => void) => {
    chrome.runtime.onInstalled.addListener(cb);
  },
};

createBackground(deps).init();

/* ------------------------------------------------------------------ */
/* Phase-5 same-tab relay                                             */
/* ------------------------------------------------------------------ */
// The toolbar content script and popup send the fixed popup protocol via
// `chrome.runtime.sendMessage`. In MV3 that message is delivered to the
// service worker, NOT directly to the co-resident content script. This relay
// validates the message against the fixed popup/toolbar schema, derives the
// destination tab from the trusted `sender.tab.id` (the tab that actually sent
// it), and forwards to that same tab via `chrome.tabs.sendMessage`. The
// payload `tabId` is intentionally ignored — a sender must not be able to
// redirect the relay to another tab. No `tabs` permission is required:
// `chrome.tabs.sendMessage` only needs the message host permission already
// granted. The async content-script reply is threaded back through
// sendResponse (C3/C8: only the fixed identity + discover/apply are forwarded;
// unknown senders without a tab cannot be relayed).
const relayDeps = {
  addRuntimeMessageListener: (
    cb: (
      message: unknown,
      sender: { tab?: { id?: number } },
      sendResponse: (response: unknown) => void,
    ) => boolean,
  ) => {
    chrome.runtime.onMessage.addListener(cb as never);
  },
  sendTabMessage: (tabId: number, message: PopupMessage): Promise<unknown> =>
    chrome.tabs.sendMessage(tabId, message),
};

createRelay(relayDeps).init();
