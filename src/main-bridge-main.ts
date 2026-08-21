/**
 * Phase-5 MAIN-world bridge entry point.
 *
 * Runs as a `world: 'MAIN'` content script (registered after consent via
 * host-permission). Installs `createGhostMainBridge().handle` as the page's
 * bridge responder, listening for the fixed C3 protocol over `window` messages
 * from the isolated content script. This is the ONLY code with access to Ghost
 * internals; it exposes no eval, no arbitrary property access, no fetch, no
 * extension APIs.
 */

import { createGhostMainBridge } from './main-bridge';

function isBrowserContext(): boolean {
  return typeof globalThis !== 'undefined' && 'chrome' in globalThis;
}

if (isBrowserContext() && typeof globalThis.addEventListener === 'function') {
  const { handle } = createGhostMainBridge();
  globalThis.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (typeof data !== 'object' || data === null) return;
    const d = data as Record<string, unknown>;
    // Only handle C3 bridge requests stamped with our protocol identity/version.
    if (d['source'] !== 'ghost-preset-toolbar/page-bridge/v1') return;
    if (d['v'] !== 1) return;
    void Promise.resolve(handle(data)).then((reply) => {
      const source = event.source as { postMessage?: (m: unknown, t: string) => void } | null;
      source?.postMessage?.(reply, '*');
    });
  });
}
