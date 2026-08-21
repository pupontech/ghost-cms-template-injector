import { createContentScript } from './content-script';
import { deriveAdminApiBase, GhostAdminClient } from './ghost-api';
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
    postMessage: (message) => globalThis.postMessage(message, '*'),
    setTimeoutFn: (fn, ms) => new Promise(() => setTimeout(fn, ms)),
    clearTimeoutFn: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
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
