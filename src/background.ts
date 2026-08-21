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
