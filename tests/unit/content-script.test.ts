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
        source: 'ghost-cms-template-injector/page-bridge/v1',
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

function makeDepsWithDiscoverFailure(): ContentScriptDeps {
  let onMainMessage: ((event: MessageEvent) => void) | null = null;
  return makeDeps({
    createBridgeEnv: () => ({
      addEventListener: (cb) => {
        onMainMessage = cb;
      },
      removeEventListener: () => {},
      postMessage: (message) => {
        onMainMessage?.(
          new MessageEvent('message', {
            data: {
              v: 1,
              source: 'ghost-cms-template-injector/page-bridge/v1',
              nonce: (message as { nonce: string }).nonce,
              ok: false,
              error: 'TIMEOUT',
            },
          }),
        );
      },
      setTimeoutFn: (fn) => setTimeout(fn, 0) as unknown,
      clearTimeoutFn: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    }),
  });
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
    const reply = await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'nope',
    });
    expect(reply).toMatchObject({ ok: false, error: 'UNKNOWN_OP' });
  });

  it('discover delegates to the bridge and returns the capability', async () => {
    const cs = createContentScript(makeDepsWithDiscover());
    const reply = (await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'discover',
    })) as Record<string, unknown>;
    expect(reply.source).toBe('ghost-cms-template-injector/popup/v1');
    expect(reply.ok).toBe(true);
    expect((reply.result as Record<string, unknown>)['capability']).toMatchObject({
      canNativeSave: true,
    });
  });

  it('preserves a discover bridge failure instead of double-wrapping it as success', async () => {
    const reply = await createContentScript(makeDepsWithDiscoverFailure()).handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'discover',
    });

    expect(reply).toEqual({
      source: 'ghost-cms-template-injector/popup/v1',
      ok: false,
      error: 'TIMEOUT',
    });
  });

  it('apply refuses a request missing presetId', async () => {
    const cs = createContentScript(makeDeps());
    const reply = await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'apply',
    });
    expect(reply).toMatchObject({ ok: false, error: 'MISSING_PRESET_ID' });
  });

  it('never replies `undefined` when the apply pipeline crashes — surfaces a structured failure', async () => {
    // Simulate a bridge that answers discover but CRASHES the pipeline later
    // (e.g. a ghost-state adapter regression inside snapshot/plan): the apply
    // handler MUST return a structured error, never undefined (which the popup
    // parses as no reply).
    const reqNonce = (msg: unknown) => (msg as { nonce: string }).nonce;
    const makeBridge = (onRequest: (msg: unknown) => unknown) => {
      let onMainMessage: ((event: MessageEvent) => void) | null = null;
      return {
        env: {
          addEventListener: (cb: (e: MessageEvent) => void) => {
            onMainMessage = cb;
          },
          removeEventListener: () => {},
          postMessage: (message: unknown) => {
            Promise.resolve(onRequest(message)).then(
              (v) => onMainMessage?.(new MessageEvent('message', { data: v })),
              (err: unknown) => {
                // A bridge rejection (e.g. STALE_EDITOR / ROLLBACK_FAILED)
                // must not hang the apply; it is surfaced as an error reply.
                onMainMessage?.(
                  new MessageEvent('message', {
                    data: {
                      v: 1,
                      source: 'ghost-cms-template-injector/page-bridge/v1',
                      nonce: reqNonce(message),
                      ok: false,
                      error: err instanceof Error ? 'APPLY_FAILED' : 'APPLY_FAILED',
                    },
                  }),
                );
              },
            );
          },
          setTimeoutFn: (fn: () => void) => setTimeout(fn, 0) as unknown,
          clearTimeoutFn: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
        } satisfies PageBridgeEnv,
        dispatch: (data: unknown) => onMainMessage?.(new MessageEvent('message', { data })),
      };
    };
    const { env } = makeBridge((msg) => {
      const op = (msg as { op: string }).op;
      if (op === 'discover') {
        return {
          v: 1,
          source: 'ghost-cms-template-injector/page-bridge/v1',
          nonce: reqNonce(msg),
          ok: true,
          result: { supported: true, capability: { canNativeSave: true } },
        };
      }
      if (op === 'snapshot') {
        // Crash the pipeline mid-flight.
        throw new Error('ghost-state adapter exploded');
      }
      return {
        v: 1,
        source: 'ghost-cms-template-injector/page-bridge/v1',
        nonce: reqNonce(msg),
        ok: false,
        error: 'APPLY_FAILED',
      };
    });
    const cs = createContentScript(
      makeDeps({
        createBridgeEnv: () => env,
        getAdminApiBase: () => null,
      }),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const reply = (await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'apply',
      presetId: 'x',
    })) as Record<string, unknown>;

    spy.mockRestore();
    expect(reply).toBeDefined();
    expect(reply.source).toBe('ghost-cms-template-injector/popup/v1');
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/^APPLY_CRASH|^APPLY_FAILED|^TIMEOUT|^BLOCKED/);
  });

  it('apply rejects malformed prompt answers at the runtime trust boundary', async () => {
    const reply = await createContentScript(makeDeps()).handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'apply',
      presetId: 'starter-post',
      promptAnswers: { title: 'yes', __proto__: { polluted: true } },
    });

    expect(reply).toMatchObject({ ok: false, error: 'INVALID_PROMPT_ANSWERS' });
  });
});
