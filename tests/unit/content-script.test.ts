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

  it('rejects a second concurrent apply with APPLY_BUSY', async () => {
    // A bridge that never replies keeps the first apply in flight (discover
    // awaits the bridge response), so the message-boundary guard should catch
    // the second apply with APPLY_BUSY.
    const hangingEnv: PageBridgeEnv = {
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: () => {
        /* never responds */
      },
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => {},
    };
    const cs = createContentScript(makeDeps({ createBridgeEnv: () => hangingEnv }));
    const first = cs.handleMessage({
      source: 'ghost-preset-toolbar/popup/v1',
      op: 'apply',
      presetId: 'p1',
    }) as Promise<unknown>;
    const second = (await cs.handleMessage({
      source: 'ghost-preset-toolbar/popup/v1',
      op: 'apply',
      presetId: 'p1',
    })) as Record<string, unknown>;
    expect(second).toMatchObject({ ok: false, error: 'APPLY_BUSY' });
    // Release the first hang so the test process can exit cleanly.
    await Promise.race([first, new Promise((r) => setTimeout(r, 10))]);
  });

  it('resolveContext is cached within the TTL (no second API call)', async () => {
    const listSnippets = vi.fn().mockResolvedValue([]);
    const getActiveThemeTemplates = vi.fn().mockResolvedValue([]);
    const cs = createContentScript(
      makeDeps({
        createApiClient: () => ({ listSnippets, getActiveThemeTemplates }) as never,
      }),
    );
    const ctx1 = await cs.resolveContext();
    const ctx2 = await cs.resolveContext();
    // Identical references ⇒ served from cache, not re-fetched.
    expect(ctx1).toBe(ctx2);
    expect(listSnippets).toHaveBeenCalledTimes(1);
    expect(getActiveThemeTemplates).toHaveBeenCalledTimes(1);
  });

  it('cached context is invalidated by resetResolveContextCache', async () => {
    const listSnippets = vi.fn().mockResolvedValue([]);
    const getActiveThemeTemplates = vi.fn().mockResolvedValue([]);
    const cs = createContentScript(
      makeDeps({
        createApiClient: () => ({ listSnippets, getActiveThemeTemplates }) as never,
      }),
    );
    await cs.resolveContext();
    cs.resetResolveContextCache();
    await cs.resolveContext();
    expect(listSnippets).toHaveBeenCalledTimes(2);
    expect(getActiveThemeTemplates).toHaveBeenCalledTimes(2);
  });

  it('resolveContext fails closed to empty when the API errors', async () => {
    const cs = createContentScript(
      makeDeps({
        createApiClient: () =>
          ({
            listSnippets: async () => {
              throw new Error('network');
            },
            getActiveThemeTemplates: async () => [],
          }) as never,
      }),
    );
    const ctx = await cs.resolveContext();
    expect(ctx).toEqual({});
    // A fail-closed empty result must NOT be cached (force re-resolve next time).
    cs.resetResolveContextCache();
  });
});
