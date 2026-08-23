/**
 * Phase-5 MAIN-world bridge entry point.
 *
 * Runs as a `world: 'MAIN'` content script (registered after consent via
 * the host-permission). Installs `createGhostMainBridge().handle` as the page's
 * bridge responder, listening for the fixed C3 protocol over `window` messages
 * from the isolated content script. This is the ONLY code with access to Ghost
 * internals; it exposes no eval, no arbitrary property access, no fetch, no
 * extension APIs.
 *
 * Direction is enforced explicitly: only a valid *request* (isBridgeRequest)
 * is handled. The responder's own reply is response-shaped and is therefore
 * ignored on re-entry, which closes the response-echo path.
 */

import { createGhostMainBridge } from './main-bridge';
import { isBridgeRequest } from './bridge-protocol';

/** Filter used by the MAIN entry: accept only valid bridge requests. */
export function isPageBridgeInbound(message: unknown): boolean {
  return isBridgeRequest(message);
}

function isBrowserContext(): boolean {
  return typeof globalThis !== 'undefined' && 'chrome' in globalThis;
}

if (isBrowserContext() && typeof globalThis.addEventListener === 'function') {
  const { handle } = createGhostMainBridge();
  globalThis.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    // Accept ONLY valid C3 bridge requests. Loose source/version checks let the
    // responder's own reply re-enter `handle` (response echo); the request-only
    // schema gate drops it before any mutation.
    if (!isPageBridgeInbound(data)) return;
    void Promise.resolve(handle(data)).then((reply) => {
      const source = event.source as { postMessage?: (m: unknown, t: string) => void } | null;
      source?.postMessage?.(reply, '*');
    });
  });
}
