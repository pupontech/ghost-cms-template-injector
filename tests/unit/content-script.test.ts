import { describe, expect, it, vi } from 'vitest';
import { initContentScript } from '../helpers/fake-dom';
import { createContentScript } from '../../src/content-script';

describe('content-script scaffold', () => {
  it('does nothing on non-Ghost-admin pages', () => {
    const addListener = vi.fn();
    const cs = createContentScript({
      isGhostAdminPage: () => false,
      addRuntimeMessageListener: addListener,
    });
    cs.init();
    expect(addListener).not.toHaveBeenCalled();
  });

  it('on a Ghost admin page installs exactly one isolated-world listener and stays inert', () => {
    const addListener = vi.fn();
    const cs = createContentScript({
      isGhostAdminPage: () => true,
      addRuntimeMessageListener: addListener,
    });
    cs.init();
    expect(addListener).toHaveBeenCalledTimes(1);
  });

  it('init is idempotent', () => {
    let count = 0;
    const cs = createContentScript({
      isGhostAdminPage: () => true,
      addRuntimeMessageListener: () => {
        count += 1;
      },
    });
    cs.init();
    cs.init();
    expect(count).toBe(1);
    void initContentScript;
  });

  it('replies UNSUPPORTED_CAPABILITY to any bridge probe until Phase 3 implements the contract', async () => {
    const cs = createContentScript({
      isGhostAdminPage: () => true,
      addRuntimeMessageListener: () => {},
    });
    const reply = await cs.handleMessage({ type: 'bridge/discover' });
    expect(reply).toEqual({ ok: false, error: 'UNSUPPORTED_CAPABILITY' });
  });

  it('onMessage listener invokes the handler and replies via sendResponse (returns true)', async () => {
    // The controller's listener callback must actually invoke handleMessage
    // (previously it ignored the return value) and surface the reply.
    let captured:
      | ((message: unknown, sendResponse: (r: unknown) => void) => Promise<unknown> | unknown)
      | null = null;
    const cs = createContentScript({
      isGhostAdminPage: () => true,
      addRuntimeMessageListener: (cb) => {
        captured = cb;
      },
    });
    cs.init();
    expect(typeof captured).toBe('function');
    const reply = await (captured as unknown as (m: unknown) => Promise<unknown>)({
      type: 'bridge/discover',
    });
    expect(reply).toEqual({ ok: false, error: 'UNSUPPORTED_CAPABILITY' });
  });

  it('content-script-main listener keeps the channel open (returns true) and delivers the reply to sendResponse', async () => {
    // Run the real entry point against a stubbed chrome + Ghost Admin location
    // so we can capture the chrome.runtime.onMessage listener and assert its
    // wiring. init() only registers when isGhostAdminPage() is true, so the
    // location pathname must look like a Ghost Admin page.
    const listeners: Array<(...args: unknown[]) => unknown> = [];
    const store = globalThis as unknown as {
      chrome?: unknown;
      location?: { pathname: string };
    };
    store.chrome = {
      runtime: {
        onMessage: {
          addListener: (fn: (...args: unknown[]) => unknown) => listeners.push(fn),
        },
      },
    };
    store.location = { pathname: '/ghost/settings' };

    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/content-script-main.ts', 'utf8');
    // The entry must keep the channel open for the async reply...
    expect(source).toMatch(/return true;/);
    // ...and must actually invoke the handler rather than ignoring it.
    expect(source).toMatch(/cb\(message/);

    // Re-import the entry so its top-level bootstrap registers the listener.
    vi.resetModules();
    await import('../../src/content-script-main');
    vi.resetModules();

    expect(listeners.length).toBeGreaterThan(0);
    const listener = listeners[0]!;

    let replied: unknown = 'not-called';
    const returned = listener({ type: 'bridge/discover' }, {}, (r: unknown) => {
      replied = r;
    });
    expect(returned).toBe(true);
    // Allow the async sendResponse microtask to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(replied).toEqual({ ok: false, error: 'UNSUPPORTED_CAPABILITY' });

    Reflect.deleteProperty(store, 'chrome');
    Reflect.deleteProperty(store, 'location');
  });
});
