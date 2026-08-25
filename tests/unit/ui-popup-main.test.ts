import { describe, expect, it, vi } from 'vitest';

import {
  buildPopupRuntime,
  renderPresetList,
  resolveActiveTab,
  statusSummary,
  type RenderEl,
} from '../../src/ui-popup-main';
import { createPopupController } from '../../src/ui-popup';
import type { Preset } from '../../src/preset-schema';

interface TestEl extends RenderEl {
  attrs: Record<string, string>;
  children: TestEl[];
  listeners: Record<string, () => void>;
}

function makeEl(): TestEl {
  const el: TestEl = {
    textContent: null,
    attrs: {},
    children: [],
    listeners: {},
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    appendChild(child: RenderEl) {
      this.children.push(child as TestEl);
    },
    addEventListener(type: string, cb: () => void) {
      this.listeners[type] = cb;
    },
  };
  return el;
}

const samplePresets: Preset[] = [
  {
    schemaVersion: 1,
    id: 'p1',
    name: 'Preset One',
    content: { source: 'inline-html', mode: 'replace', html: '<p></p>' },
    ui: { icon: '💡' },
  },
  {
    schemaVersion: 1,
    id: 'p2',
    name: 'Preset Two',
    content: { source: 'ghost-snippet', mode: 'only-if-empty', snippet: 'x' },
  },
];

describe('ui-popup-main — status summary', () => {
  function ctrlWithCapability(capability: Record<string, unknown> | null) {
    const runtime = {
      getActiveTabId: () => '1',
      findTab: () => ({ url: 'https://example.com/ghost/#/editor/edit/post/abc' }),
      sendMessage: async () =>
        capability
          ? ({
              source: 'ghost-cms-template-injector/popup/v1',
              ok: true,
              result: { supported: true, capability },
            } as never)
          : ({
              source: 'ghost-cms-template-injector/popup/v1',
              ok: false,
              error: 'UNSUPPORTED_CAPABILITY',
            } as never),
      loadPresets: async () => [],
    };
    return createPopupController(runtime);
  }

  it('summarizes a saved post editor', async () => {
    const ctrl = ctrlWithCapability({
      resourceType: 'post',
      resourceId: 'abc',
      dirty: false,
      updatedAt: 'x',
      hasLexical: true,
      canMutateRelations: true,
      canNativeSave: true,
      canRollback: true,
      adapterVersion: 1,
    });
    await ctrl.refresh({ kind: 'editor', resourceType: 'post', savedId: 'abc', isNew: false });
    expect(statusSummary(ctrl.lastStatus())).toBe('Editing: saved post abc · clean');
  });

  it('summarizes a new unsaved draft', async () => {
    const ctrl = ctrlWithCapability({
      resourceType: 'page',
      resourceId: null,
      dirty: true,
      updatedAt: null,
      hasLexical: true,
      canMutateRelations: true,
      canNativeSave: true,
      canRollback: true,
      adapterVersion: 1,
    });
    await ctrl.refresh({ kind: 'editor', resourceType: 'page', savedId: null, isNew: true });
    expect(statusSummary(ctrl.lastStatus())).toMatch(/new unsaved draft/);
  });

  it('summarizes an unsupported state with its reason', async () => {
    const ctrl = ctrlWithCapability(null);
    await ctrl.refresh({ kind: 'editor', resourceType: 'post', savedId: 'abc', isNew: false });
    expect(statusSummary(ctrl.lastStatus())).toMatch(/capability/i);
  });
});

describe('ui-popup-main — preset list rendering', () => {
  it('renders one button per preset with the icon and name', () => {
    const list = makeEl();
    const createEl = (): TestEl => makeEl();
    renderPresetList(list as RenderEl, samplePresets, () => {}, createEl);
    expect(list.children).toHaveLength(2);
    const firstButton = list.children[0]!.children[0] as unknown as {
      attrs: Record<string, string>;
      textContent: string;
    };
    expect(firstButton.attrs['data-preset-id']).toBe('p1');
    expect(firstButton.textContent).toBe('💡 Preset One');
  });

  it('fires the apply callback with the preset id on click', () => {
    const list = makeEl();
    const onApply = vi.fn();
    renderPresetList(list as RenderEl, samplePresets, onApply, () => makeEl());
    const button = list.children[1]!.children[0] as unknown as {
      listeners: Record<string, () => void>;
    };
    button.listeners['click']?.();
    expect(onApply).toHaveBeenCalledWith('p2');
  });

  it('renders an empty message when there are no presets', () => {
    const list = makeEl();
    renderPresetList(
      list as RenderEl,
      [],
      () => {},
      () => makeEl(),
    );
    expect(list.children).toHaveLength(1);
    expect((list.children[0] as unknown as { textContent: string }).textContent).toBe(
      'No presets available.',
    );
  });
});

describe('ui-popup-main — active tab resolution + runtime', () => {
  it('resolves the active tab id from chrome.tabs.query', async () => {
    const api = {
      tabs: {
        query: vi
          .fn()
          .mockResolvedValue([{ id: 42, url: 'https://example.com/ghost/#/editor/edit/post/x' }]),
        sendMessage: vi.fn(),
      },
    };
    const resolved = await resolveActiveTab(api);
    expect(resolved?.tabId).toBe('42');
    expect(resolved?.tab.url).toBe('https://example.com/ghost/#/editor/edit/post/x');
  });

  it('returns null when no tab has an id', async () => {
    const api = { tabs: { query: vi.fn().mockResolvedValue([{}]), sendMessage: vi.fn() } };
    expect(await resolveActiveTab(api)).toBeNull();
  });

  it('buildPopupRuntime forwards sendMessage to the resolved tab only', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ source: 'ghost-cms-template-injector/popup/v1', ok: true });
    const api = { tabs: { query: vi.fn(), sendMessage } };
    const runtime = buildPopupRuntime(api as never, {
      tabId: '7',
      tab: { url: 'https://example.com/ghost/' },
    });
    expect(runtime.getActiveTabId()).toBe('7');
    await runtime.sendMessage('7', { source: 'x', op: 'discover', tabId: '7' });
    expect(sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ tabId: '7' }));
  });

  it('buildPopupRuntime loadPresets delegates to the storage repository', async () => {
    const store = new Map<string, unknown>([
      ['presetStore', { schemaVersion: 1, version: 0, presets: [] }],
    ]);
    (
      globalThis as {
        chrome?: {
          storage?: {
            local?: {
              get: (k: string) => Promise<Record<string, unknown>>;
              set: (v: Record<string, unknown>) => Promise<void>;
            };
          };
        };
      }
    ).chrome = {
      storage: {
        local: {
          get: async (k: string) => ({ [k]: store.get(k) }),
          set: async (v) => {
            for (const [k, val] of Object.entries(v)) store.set(k, val);
          },
        },
      },
    };
    const api = { tabs: { query: vi.fn(), sendMessage: vi.fn() } };
    const runtime = buildPopupRuntime(api as never, {
      tabId: '7',
      tab: { url: 'https://example.com/ghost/' },
    });
    const presets = await runtime.loadPresets();
    expect(Array.isArray(presets)).toBe(true);
  });
});
