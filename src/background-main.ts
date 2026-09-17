import { createBackground, createRelay, createRuntimeMessageDispatcher } from './background';
import {
  createImageAssetStore,
  createIndexedDbAssetBackend,
  type ImageAssetBackend,
  type ImageAssetStore,
} from './image-asset-store';
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
  addRuntimeMessageListener: () => {
    /* registered below by the single dispatcher */
  },
  sendTabMessage: (tabId: number, message: PopupMessage): Promise<unknown> =>
    chrome.tabs.sendMessage(tabId, message),
};

const relay = createRelay(relayDeps);

/* ------------------------------------------------------------------ */
/* Feature-image asset store (extension origin)                        */
/* ------------------------------------------------------------------ */

/**
 * The service worker owns the image asset database. If IndexedDB cannot be
 * opened (rare, but it would otherwise throw at import time and kill the whole
 * worker), fall back to a store that fails every read: a preset carrying a
 * cached photo then blocks with an explicit reason instead of applying without
 * its image — and the popup/toolbar relay keeps working.
 */
function buildAssetStore(): ImageAssetStore {
  try {
    return createImageAssetStore(createIndexedDbAssetBackend());
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('asset store unavailable');
    const unavailable: ImageAssetBackend = {
      get: () => Promise.reject(failure),
      put: () => Promise.reject(failure),
      remove: () => Promise.reject(failure),
      keys: () => Promise.reject(failure),
    };
    return createImageAssetStore(unavailable);
  }
}

/**
 * ONE runtime message listener for the worker: image-asset requests (from the
 * content script, which cannot reach the extension's IndexedDB) are answered
 * directly; everything else goes to the popup/toolbar relay.
 */
const dispatch = createRuntimeMessageDispatcher({ assetStore: buildAssetStore(), relay });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) =>
  dispatch(message, sender as { tab?: { id?: number } }, sendResponse),
);
