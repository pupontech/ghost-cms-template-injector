export interface ContentScriptDeps {
  isGhostAdminPage: () => boolean;
  addRuntimeMessageListener: (
    cb: (message: unknown, sendResponse: (response: unknown) => void) => Promise<unknown> | unknown,
  ) => void;
}

export interface BridgeReply {
  ok: false;
  error: 'UNSUPPORTED_CAPABILITY';
}

/**
 * Phase-1 scaffold content script. It installs a single isolated-world message
 * listener on Ghost Admin pages and fail-closes every bridge probe until the
 * Phase-3 capability-gated MAIN-world bridge exists. No DOM automation, no
 * generic property access, no page-owned state access.
 */
export function createContentScript(deps: ContentScriptDeps): {
  init: () => void;
  handleMessage: (message: unknown) => Promise<BridgeReply>;
} {
  let initialized = false;

  async function handleMessage(_message: unknown): Promise<BridgeReply> {
    return { ok: false, error: 'UNSUPPORTED_CAPABILITY' };
  }

  return {
    init(): void {
      if (initialized) return;
      if (!deps.isGhostAdminPage()) return;
      initialized = true;
      deps.addRuntimeMessageListener((message) => handleMessage(message));
    },
    handleMessage,
  };
}
