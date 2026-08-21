import { createContentScript } from './content-script';

const deps = {
  isGhostAdminPage: () => {
    const path = globalThis.location?.pathname ?? '';
    return /\/ghost\//.test(path);
  },
  addRuntimeMessageListener: (
    cb: (message: unknown, sendResponse: (response: unknown) => void) => Promise<unknown> | unknown,
  ) => {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      // Return `true` to signal an async reply; the resolved value (or its
      // absence) is delivered to the caller via sendResponse. This keeps the
      // message channel open for the (currently fail-closed) handler.
      void Promise.resolve(cb(message, sendResponse)).then(
        (response) => sendResponse(response),
        () => sendResponse(undefined),
      );
      return true;
    });
  },
};

createContentScript(deps).init();
