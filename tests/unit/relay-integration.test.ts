/**
 * Phase-5 same-tab relay — INTEGRATION coverage (t_7fd67cbf).
 *
 * Proves the real production topology end to end WITHOUT a browser, by driving
 * the actual extension messaging bus:
 *
 *   toolbar content script
 *     → chrome.runtime.sendMessage({source, op})            (MV3: → SW only)
 *     → SW `runtime.onMessage` listener (background-main)   = the relay
 *     → chrome.tabs.sendMessage(sender.tab.id, message)     = same-tab forward
 *     → co-resident content-script `runtime.onMessage` listener
 *     → ApplyReply threaded back through sendResponse to the toolbar promise.
 *
 * The relay derives the destination tab from the trusted `sender.tab.id` and
 * ignores any payload `tabId` — the test confirms a mismatched payload tabId is
 * NOT honored.
 *
 * This test imports the REAL `background-main.ts` entry point, so it is RED
 * until that entry actually installs the relay (release blocker B1) and GREEN
 * once wired. It replaces any design that assumed the toolbar's
 * runtime.sendMessage reached the content script directly without the SW relay.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POPUP_MESSAGE_SOURCE } from '../../src/ui-popup';
import { createContentScript, type ContentScriptDeps } from '../../src/content-script';
import {
  createPageBridgeResponder,
  type PageBridgeEnv,
  type PageBridgeResponderEnv,
} from '../../src/page-bridge';
import { createGhostStateAdapter, type GhostLiveSurface } from '../../src/ghost-state';
import { STORAGE_KEY } from '../../src/preset-store';

let storageArea: Record<string, unknown> = {};

/** Tab id the toolbar / co-resident content script live on. */
const TOOLBAR_TAB_ID = 42;

/** In-process replica of the MV3 extension message bus. */
function makeChromeBus(presetSeed: unknown) {
  const swOnMessageListeners: Array<
    (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean
  > = [];
  // tabId -> content-script listener
  const tabListeners = new Map<
    number,
    (msg: unknown, sender: unknown, sr: (r: unknown) => void) => boolean
  >();

  // In-memory chrome.storage.local so preset-store can resolve the preset.
  storageArea = {
    [STORAGE_KEY]: presetSeed,
  };
  const chrome = {
    storage: {
      local: {
        get: async (key: string) => (key in storageArea ? { [key]: storageArea[key] } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storageArea[k] = v;
        },
      },
    },
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: {
        /** SW-side registration (the relay registers here via background-main). */
        addListener(
          cb: (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean,
        ) {
          swOnMessageListeners.push(cb);
        },
      },
      /** Toolbar → SW. Synthesizes the trusted sender tab id. */
      sendMessage(msg: unknown): Promise<unknown> {
        return new Promise((resolve) => {
          let responded = false;
          const finish = (r: unknown) => {
            if (!responded) {
              responded = true;
              resolve(r);
            }
          };
          for (const cb of swOnMessageListeners) {
            const keepOpen = cb(msg, { tab: { id: TOOLBAR_TAB_ID } }, finish);
            if (keepOpen) return; // async reply via sendResponse
          }
          finish(undefined);
        });
      },
    },
    tabs: {
      /** SW relay → co-resident content script on the same tab. */
      sendMessage(tabId: number, msg: unknown): Promise<unknown> {
        return new Promise((resolve) => {
          const listener = tabListeners.get(tabId);
          if (!listener) {
            resolve(undefined);
            return;
          }
          let responded = false;
          const finish = (r: unknown) => {
            if (!responded) {
              responded = true;
              resolve(r);
            }
          };
          const keepOpen = listener(msg, { tab: { id: tabId } }, finish);
          if (!keepOpen) finish(undefined);
        });
      },
    },
  };

  return { chrome, tabListeners };
}

/** A controllable MAIN-world surface the ghost-state adapter drives. */
function makeSurface(): GhostLiveSurface {
  return {
    getResourceType: () => 'post',
    getResourceId: () => 'post-1',
    isDirty: () => false,
    getUpdatedAt: () => '2026-08-21T00:00:00.000Z',
    getLexical: () => '{"root":{"children":[]}}',
    isBodyEmpty: () => true,
    getExcerpt: () => null,
    getTitle: () => null,
    getCustomTemplate: () => null,
    getTags: () => [],
    setField: () => {},
    setLexical: () => {},
    nativeSave: async () => ({ updatedAt: '2026-08-21T01:00:00.000Z' }),
    captureRollback: () => ({ token: 'snap' }),
    restoreRollback: () => {},
  };
}

/** A content-script listener that answers discover/apply over a real bridge. */
function makeContentScriptListener(): {
  register: (tabListeners: Map<number, unknown>, tabId: number) => void;
  reached: () => boolean;
  lastOp: () => string | null;
} {
  let reachedCount = 0;
  let lastOp: string | null = null;

  function register(tabListeners: Map<number, unknown>, tabId: number) {
    const surface = makeSurface();
    const adapter = createGhostStateAdapter(surface);
    const responderEnv: PageBridgeResponderEnv = {
      discover: () => adapter.discover(),
      snapshot: () => adapter.snapshot(),
      planApply: (payload) => adapter.planApply(payload['plan'] as never),
      apply: (payload) => adapter.apply(payload['plan'] as never),
      save: () => surface.nativeSave().then((r) => r),
      rollback: (payload) => adapter.rollback(payload['token'] as never),
    };
    const responder = createPageBridgeResponder(responderEnv);

    // In-process MAIN world: receives window messages, answers via responder.
    let postToIsolated: ((msg: unknown) => void) | null = null;
    let onMainMessage: ((event: MessageEvent) => void) | null = null;

    const bridgeEnv: PageBridgeEnv = {
      addEventListener: (cb) => {
        onMainMessage = cb;
      },
      removeEventListener: () => {},
      postMessage: (message) => {
        const reply = responder.handle(message);
        Promise.resolve(reply).then((r) => postToIsolated?.(r));
      },
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms) as unknown,
      clearTimeoutFn: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
    postToIsolated = (msg) => onMainMessage?.(new MessageEvent('message', { data: msg }));

    const deps: ContentScriptDeps = {
      isGhostAdminPage: () => true,
      addRuntimeMessageListener: (cb) => {
        (
          tabListeners as Map<number, (m: unknown, s: unknown, sr: (r: unknown) => void) => boolean>
        ).set(tabId, (msg, _sender, sendResponse) => {
          reachedCount += 1;
          const m = msg as Record<string, unknown>;
          lastOp = (m['op'] as string) ?? null;
          void Promise.resolve(cb(msg, sendResponse)).then(
            (response) => sendResponse(response),
            () => sendResponse(undefined),
          );
          return true;
        });
      },
      createBridgeEnv: () => bridgeEnv,
      getAdminApiBase: () => ({ base: 'https://ghost.test/ghost/api/admin/' }),
      createApiClient: () => ({}) as never,
    };
    createContentScript(deps).init();
  }

  return {
    register,
    reached: () => reachedCount > 0,
    lastOp: () => lastOp,
  };
}

describe('Phase-5 same-tab relay integration (toolbar → SW → content-script)', () => {
  let bus: ReturnType<typeof makeChromeBus>;
  let globalChrome: { chrome?: unknown };

  // Seed preset for the apply path (mirrors the production software-review seed).
  const presetSeed = {
    schemaVersion: 1,
    version: 1,
    presets: [
      {
        schemaVersion: 1 as const,
        id: 'software-review',
        name: 'Software Review',
        content: {
          source: 'inline-lexical' as const,
          mode: 'replace' as const,
          lexical: '{"root":{"children":[],"type":"root","version":1}}',
        },
        metadata: {
          excerpt: { mode: 'only-if-empty' as const, value: 'A hands-on review.' },
          tags: { mode: 'merge' as const, values: ['Reviews'] },
        },
      },
    ],
  };

  beforeEach(() => {
    bus = makeChromeBus(presetSeed);
    globalChrome = globalThis as unknown as { chrome?: unknown };
    globalChrome.chrome = bus.chrome;
    vi.resetModules();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalChrome, 'chrome');
    vi.resetModules();
  });

  it('forwards a toolbar runtime.sendMessage to the co-resident content script and returns its reply (GREEN once background-main installs the relay)', async () => {
    // Register the real content-script listener for the toolbar tab.
    const cs = makeContentScriptListener();
    cs.register(bus.tabListeners, TOOLBAR_TAB_ID);

    // Import the REAL production service-worker entry — this is what proves
    // background-main wires the relay. If it does not, no SW onMessage listener
    // exists and the toolbar's sendMessage resolves undefined (RED).
    await import('../../src/background-main');

    const reply = (await bus.chrome.runtime.sendMessage({
      source: POPUP_MESSAGE_SOURCE,
      op: 'discover',
      tabId: 'payload-tab-id-must-be-ignored',
    })) as Record<string, unknown> | undefined;

    expect(cs.reached()).toBe(true);
    expect(cs.lastOp()).toBe('discover');
    expect(reply).toBeDefined();
    expect(reply?.['source']).toBe(POPUP_MESSAGE_SOURCE);
    expect(reply?.['ok']).toBe(true);
  });

  it('does NOT honor a mismatched payload tabId — the relay uses sender.tab.id', async () => {
    const cs = makeContentScriptListener();
    cs.register(bus.tabListeners, TOOLBAR_TAB_ID);

    await import('../../src/background-main');

    // Payload tabId points at a different (non-existent) tab; the relay must
    // ignore it and forward to the trusted sender.tab.id (42).
    const reply = (await bus.chrome.runtime.sendMessage({
      source: POPUP_MESSAGE_SOURCE,
      op: 'apply',
      tabId: '999-unrelated',
      presetId: 'software-review',
    })) as Record<string, unknown> | undefined;

    expect(cs.reached()).toBe(true);
    expect(cs.lastOp()).toBe('apply');
    expect(reply?.['source']).toBe(POPUP_MESSAGE_SOURCE);
  });

  it('rejects a non-popup message at the SW relay (no forwarding to the content script)', async () => {
    const cs = makeContentScriptListener();
    cs.register(bus.tabListeners, TOOLBAR_TAB_ID);

    await import('../../src/background-main');

    const reply = (await bus.chrome.runtime.sendMessage({
      source: 'evil-origin',
      op: 'discover',
    })) as Record<string, unknown> | undefined;

    expect(cs.reached()).toBe(false);
    expect(reply).toMatchObject({ relay: 'rejected', reason: 'SCHEMA_MISMATCH' });
  });
});
