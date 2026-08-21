import { describe, expect, it, vi } from 'vitest';
import { createContentScript } from '../../src/content-script';
import type { ContentScriptDeps } from '../../src/content-script';
import type { PageBridgeEnv } from '../../src/page-bridge';

function makeDeps(overrides: Partial<ContentScriptDeps> = {}): ContentScriptDeps {
  const base: ContentScriptDeps = {
    isGhostAdminPage: () => true,
    addRuntimeMessageListener: () => {},
    createBridgeEnv: (): PageBridgeEnv => ({
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {},
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    }),
    getAdminApiBase: () => ({ base: 'https://ghost.test/ghost/api/admin/' }),
    createApiClient: () => ({}) as never,
    ...overrides,
  };
  return base;
}

/** Wire the isolated bridge to an in-process responder that answers discover. */
function makeDepsWithDiscover(): ContentScriptDeps {
  let onMainMessage: ((event: MessageEvent) => void) | null = null;
  const isolatedEnv: PageBridgeEnv = {
    addEventListener: (cb) => {
      onMainMessage = cb;
    },
    removeEventListener: () => {},
    postMessage: (message) => {
      const reply = {
        v: 1,
        source: 'ghost-preset-toolbar/page-bridge/v1',
        nonce: (message as { nonce: string }).nonce,
        ok: true,
        result: { supported: true, capability: { canNativeSave: true } },
      };
      onMainMessage?.(new MessageEvent('message', { data: reply }));
    },
    setTimeoutFn: (fn) => setTimeout(fn, 0) as unknown,
    clearTimeoutFn: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  return makeDeps({ createBridgeEnv: () => isolatedEnv });
}

describe('content-script Phase-5 orchestration', () => {
  it('does nothing on non-Ghost-admin pages', () => {
    const addListener = vi.fn();
    const cs = createContentScript(
      makeDeps({ isGhostAdminPage: () => false, addRuntimeMessageListener: addListener }),
    );
    cs.init();
    expect(addListener).not.toHaveBeenCalled();
  });

  it('on a Ghost admin page installs exactly one isolated-world listener', () => {
    const addListener = vi.fn();
    const cs = createContentScript(makeDeps({ addRuntimeMessageListener: addListener }));
    cs.init();
    expect(addListener).toHaveBeenCalledTimes(1);
  });

  it('init is idempotent', () => {
    let count = 0;
    const cs = createContentScript(
      makeDeps({
        addRuntimeMessageListener: () => {
          count += 1;
        },
      }),
    );
    cs.init();
    cs.init();
    expect(count).toBe(1);
  });

  it('replies with SOURCE_MISMATCH to a non-popup message', async () => {
    const cs = createContentScript(makeDeps());
    const reply = await cs.handleMessage({ source: 'evil', op: 'discover' });
    expect(reply).toMatchObject({ ok: false, error: 'SOURCE_MISMATCH' });
  });

  it('replies UNKNOWN_OP for an unsupported popup operation', async () => {
    const cs = createContentScript(makeDeps());
    const reply = await cs.handleMessage({ source: 'ghost-preset-toolbar/popup/v1', op: 'nope' });
    expect(reply).toMatchObject({ ok: false, error: 'UNKNOWN_OP' });
  });

  it('discover delegates to the bridge and returns the capability', async () => {
    const cs = createContentScript(makeDepsWithDiscover());
    const reply = (await cs.handleMessage({
      source: 'ghost-preset-toolbar/popup/v1',
      op: 'discover',
    })) as Record<string, unknown>;
    expect(reply.source).toBe('ghost-preset-toolbar/popup/v1');
    expect(reply.ok).toBe(true);
    expect((reply.result as Record<string, unknown>)['capability']).toMatchObject({
      canNativeSave: true,
    });
  });

  it('apply refuses a request missing presetId', async () => {
    const cs = createContentScript(makeDeps());
    const reply = await cs.handleMessage({
      source: 'ghost-preset-toolbar/popup/v1',
      op: 'apply',
    });
    expect(reply).toMatchObject({ ok: false, error: 'MISSING_PRESET_ID' });
  });
});
