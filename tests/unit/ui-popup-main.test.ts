import { describe, expect, it, vi } from 'vitest';

import {
  buildPopupRuntime,
  buildPromptAnswers,
  initPopup,
  renderPromptPanel,
  renderPlanPanel,
  renderPresetList,
  resolveActiveTab,
  statusSummary,
  type PopupView,
  type RenderEl,
} from '../../src/ui-popup-main';
import { createPopupController } from '../../src/ui-popup';
import type { Preset } from '../../src/preset-schema';
import type { ApplicationPlan } from '../../src/preset-engine';

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
    removeAttribute(name: string) {
      delete this.attrs[name];
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

describe('ui-popup-main — prompt panel', () => {
  it('buildPromptAnswers maps every prompt field to the chosen answer', () => {
    const prompts = [
      { field: 'body', question: 'Overwrite body?' },
      { field: 'customTemplate', question: 'Set template?' },
    ];
    expect(buildPromptAnswers(prompts, true)).toEqual({ body: true, customTemplate: true });
    expect(buildPromptAnswers(prompts, false)).toEqual({ body: false, customTemplate: false });
  });

  it('renderPromptPanel lists questions and leaves the panel hidden', () => {
    const panel = makeEl();
    const list = makeEl();
    renderPromptPanel(
      panel as RenderEl,
      list as RenderEl,
      [{ field: 'body', question: 'Overwrite body?' }],
      () => makeEl(),
    );
    expect(list.children).toHaveLength(1);
    expect(list.children[0]?.textContent).toBe('Overwrite body?');
    expect(panel.attrs['hidden']).toBe('');
  });

  it('initPopup shows NEEDS_PROMPT and retries with answers on confirm', async () => {
    let applyReply: Record<string, unknown> = {
      source: 'ghost-cms-template-injector/popup/v1',
      ok: false,
      error: 'NEEDS_PROMPT',
      result: [{ field: 'body', question: 'Overwrite body?' }],
    };
    const sendMessage = vi
      .fn()
      .mockImplementation(async (_tabId: unknown, message: { op: string }) => {
        if (message.op === 'discover') {
          return {
            source: 'ghost-cms-template-injector/popup/v1',
            ok: true,
            result: {
              supported: true,
              capability: {
                resourceType: 'post',
                resourceId: 'abc',
                dirty: false,
                updatedAt: 'x',
                hasLexical: true,
                canMutateRelations: true,
                canNativeSave: true,
                canRollback: true,
                adapterVersion: 1,
              },
            },
          };
        }
        return applyReply;
      });
    const api = {
      tabs: {
        query: vi
          .fn()
          .mockResolvedValue([{ id: 1, url: 'https://example.com/ghost/#/editor/edit/post/abc' }]),
        sendMessage,
      },
    };
    const statusEl = makeEl();
    const listEl = makeEl();
    const promptPanel = makeEl();
    const promptListEl = makeEl();
    const promptYes = makeEl();
    const promptNo = makeEl();
    const view: PopupView = {
      statusEl: statusEl as RenderEl,
      listEl: listEl as RenderEl,
      promptPanel: promptPanel as RenderEl,
      promptListEl: promptListEl as RenderEl,
      promptYes: promptYes as RenderEl,
      promptNo: promptNo as RenderEl,
      document: { createElement: () => makeEl() },
    };
    await initPopup(api as never, view);
    const button = listEl.children[0]?.children[0] as unknown as TestEl;
    button.listeners['click']?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(promptPanel.attrs['hidden']).toBeUndefined();
    expect(promptListEl.children).toHaveLength(1);
    applyReply = { source: 'ghost-cms-template-injector/popup/v1', ok: true, result: {} };
    promptYes.listeners['click']?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2]?.[1]).toMatchObject({
      op: 'apply',
      promptAnswers: { body: true },
    });
    expect(promptPanel.attrs['hidden']).toBe('');
  });
});

describe('ui-popup-main — read-only plan preview', () => {
  it('renders applied, skipped, and prompt actions without mutation', () => {
    const panel = makeEl();
    const list = makeEl();
    const plan: ApplicationPlan = {
      presetId: 'p1',
      status: 'needs-prompt',
      actions: [
        { field: 'body', op: 'set', status: 'apply', value: '{}' },
        { field: 'excerpt', op: 'skip', status: 'skip', reason: 'excerpt already has a value' },
        {
          field: 'title',
          op: 'skip',
          status: 'prompt',
          value: 'New title',
          question: 'Set title?',
        },
      ],
      problems: [],
    };
    renderPlanPanel(panel, list, plan, () => makeEl());
    expect(list.children).toHaveLength(3);
    expect(list.children[0]?.textContent).toMatch(/body.*apply/i);
    expect(list.children[1]?.textContent).toMatch(/excerpt.*skip/i);
    expect(list.children[2]?.textContent).toMatch(/title.*prompt/i);
    expect(panel.attrs['hidden']).toBe('');
  });

  it('previews before apply and enables Undo only after apply succeeds', async () => {
    const sendMessage = vi
      .fn()
      .mockImplementation(async (_tabId: unknown, message: { op: string }) => {
        if (message.op === 'discover') {
          return {
            source: 'ghost-cms-template-injector/popup/v1',
            ok: true,
            result: {
              supported: true,
              capability: {
                resourceType: 'post',
                resourceId: 'abc',
                dirty: false,
                updatedAt: 'x',
                hasLexical: true,
                canMutateRelations: true,
                canNativeSave: true,
                canRollback: true,
                adapterVersion: 1,
              },
            },
          };
        }
        if (message.op === 'preview') {
          return {
            source: 'ghost-cms-template-injector/popup/v1',
            ok: true,
            result: {
              status: 'preview',
              plan: {
                presetId: 'starter-post',
                status: 'ready',
                actions: [{ field: 'body', op: 'set', status: 'apply', value: '{}' }],
                problems: [],
              },
              snapshot: {},
            },
          };
        }
        return {
          source: 'ghost-cms-template-injector/popup/v1',
          ok: true,
          result: { saved: true },
        };
      });
    const api = {
      tabs: {
        query: vi
          .fn()
          .mockResolvedValue([{ id: 1, url: 'https://example.com/ghost/#/editor/edit/post/abc' }]),
        sendMessage,
      },
    };
    const statusEl = makeEl();
    const listEl = makeEl();
    const planPanel = makeEl();
    const planListEl = makeEl();
    const planApply = makeEl();
    const planCancel = makeEl();
    const undoButton = makeEl();
    await initPopup(api as never, {
      statusEl: statusEl as RenderEl,
      listEl: listEl as RenderEl,
      planPanel: planPanel as RenderEl,
      planListEl: planListEl as RenderEl,
      planApply: planApply as RenderEl,
      planCancel: planCancel as RenderEl,
      undoButton: undoButton as RenderEl,
      document: { createElement: () => makeEl() },
    });
    (listEl.children[0]?.children[0] as unknown as TestEl).listeners['click']?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(planPanel.attrs['hidden']).toBeUndefined();
    expect(planListEl.children).toHaveLength(1);
    expect(undoButton.attrs['disabled']).toBe('');
    planApply.listeners['click']?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessage.mock.calls.map((call) => (call[1] as { op: string }).op)).toEqual([
      'discover',
      'preview',
      'apply',
    ]);
    expect(undoButton.attrs['disabled']).toBeUndefined();
    undoButton.listeners['click']?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessage.mock.calls[3]?.[1]).toMatchObject({ op: 'undo' });
    expect(undoButton.attrs['disabled']).toBe('');
  });
});
