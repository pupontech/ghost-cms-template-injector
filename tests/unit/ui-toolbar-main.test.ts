import { describe, expect, it, vi } from 'vitest';

import type { CreateEl } from '../../src/ui-popup-main';
import {
  createToolbarElement,
  importPresetFromEditor,
  initToolbar,
  renderToolbarPresets,
  TOOLBAR_IMPORT_LABEL,
  type ToolbarDomElement,
  type ToolbarEnv,
} from '../../src/ui-toolbar-main';
import type { ToolbarPreset } from '../../src/toolbar-controller';

interface TestEl extends ToolbarDomElement {
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
    appendChild(child: ToolbarDomElement) {
      this.children.push(child as TestEl);
    },
    addEventListener(type: string, cb: () => void) {
      this.listeners[type] = cb;
    },
  };
  return el;
}

const samplePresets: ToolbarPreset[] = [
  { id: 'p1', name: 'Software Review', icon: '💻' },
  { id: 'p2', name: 'Newsletter', icon: '' },
];

function makeEnv(overrides: Partial<ToolbarEnv> = {}): ToolbarEnv {
  const createElement = overrides.createElement ?? (() => makeEl());
  return {
    isGhostAdminPage: vi.fn().mockReturnValue(true),
    getHref: vi.fn().mockReturnValue('https://example.com/ghost/'),
    getHash: vi.fn().mockReturnValue('#/editor/edit/post/abc123'),
    onHashChange: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    listPresets: vi.fn().mockResolvedValue(samplePresets),
    createElement,
    appendToBody: vi.fn(),
    removeElement: vi.fn(),
    ...overrides,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function firstList(root: unknown): TestEl {
  return (root as TestEl).children.find((c) => c.attrs['aria-label'] === 'Presets')!;
}

function statusRegion(root: unknown): TestEl {
  return (root as TestEl).children.find((c) => c.attrs['role'] === 'status')!;
}

describe('renderToolbarPresets', () => {
  it('renders one button per preset with accessible attributes', () => {
    const list = makeEl();
    const createEl: CreateEl = () => makeEl();
    renderToolbarPresets(list, samplePresets, () => {}, createEl);
    expect(list.children).toHaveLength(2);
    const btn = list.children[0]!.children[0] as unknown as {
      attrs: Record<string, string>;
      textContent: string;
    };
    expect(btn.attrs['data-preset-id']).toBe('p1');
    expect(btn.attrs['type']).toBe('button');
    expect(btn.attrs['aria-label']).toBe('Software Review');
    expect(btn.textContent).toBe('💻 Software Review');
  });

  it('fires the apply callback with the preset id on click', () => {
    const list = makeEl();
    const onApply = vi.fn();
    renderToolbarPresets(list, samplePresets, onApply, () => makeEl());
    const btn = list.children[1]!.children[0] as unknown as {
      listeners: Record<string, () => void>;
    };
    btn.listeners['click']?.();
    expect(onApply).toHaveBeenCalledWith('p2');
  });

  it('renders nothing for an empty preset list', () => {
    const list = makeEl();
    renderToolbarPresets(
      list,
      [],
      () => {},
      () => makeEl(),
    );
    expect(list.children).toHaveLength(0);
  });
});

describe('createToolbarElement', () => {
  it('builds an accessible toolbar root with a labelled list and a status region', () => {
    const handle = createToolbarElement(() => makeEl());
    const root = handle.root as unknown as TestEl;
    expect(root.attrs['role']).toBe('toolbar');
    expect(root.attrs['aria-label']).toMatch(/ghost-cms template injector/i);
    expect(root.attrs['data-gcti-toolbar']).toBeDefined();
    expect(statusRegion(root).attrs['role']).toBe('status');
    expect(statusRegion(root).attrs['aria-live']).toBe('polite');
    expect((handle.listEl as unknown as TestEl).attrs['aria-label']).toBe('Presets');
  });
});

describe('initToolbar — mount/unmount lifecycle', () => {
  it('does not mount or watch routes when not on a Ghost Admin page', async () => {
    const onHashChange = vi.fn();
    const appendToBody = vi.fn();
    const env = makeEnv({
      isGhostAdminPage: vi.fn().mockReturnValue(false),
      onHashChange,
      appendToBody,
    });
    await initToolbar(env);
    expect(onHashChange).not.toHaveBeenCalled();
    expect(appendToBody).not.toHaveBeenCalled();
  });

  it('mounts the toolbar on an editor route and renders preset buttons', async () => {
    const onHashChange = vi.fn();
    const appendToBody = vi.fn();
    const env = makeEnv({ onHashChange, appendToBody });
    await initToolbar(env);
    expect(onHashChange).toHaveBeenCalledTimes(1);
    expect(appendToBody).toHaveBeenCalledTimes(1);
    const root = appendToBody.mock.calls[0]?.[0] as unknown as TestEl;
    const list = firstList(root);
    expect(list.children).toHaveLength(2);
  });

  it('unmounts when the route leaves the editor screen', async () => {
    const getHash = vi.fn().mockReturnValue('#/editor/edit/post/abc123');
    const onHashChange = vi.fn();
    const appendToBody = vi.fn();
    const removeElement = vi.fn();
    const env = makeEnv({ getHash, onHashChange, appendToBody, removeElement });
    await initToolbar(env);
    expect(appendToBody).toHaveBeenCalledTimes(1);

    const hashChangeCb = onHashChange.mock.calls[0]?.[0] as () => void;
    getHash.mockReturnValue('#/posts');
    hashChangeCb();
    await flush();
    expect(removeElement).toHaveBeenCalledTimes(1);
  });

  it('re-mounts when the route returns to an editor screen', async () => {
    const getHash = vi.fn().mockReturnValue('#/editor/edit/post/abc123');
    const onHashChange = vi.fn();
    const appendToBody = vi.fn();
    const removeElement = vi.fn();
    const env = makeEnv({ getHash, onHashChange, appendToBody, removeElement });
    await initToolbar(env);

    const hashChangeCb = onHashChange.mock.calls[0]?.[0] as () => void;
    getHash.mockReturnValue('#/posts');
    hashChangeCb();
    await flush();
    expect(removeElement).toHaveBeenCalledTimes(1);

    getHash.mockReturnValue('#/editor/new/page');
    hashChangeCb();
    await flush();
    expect(appendToBody).toHaveBeenCalledTimes(2);
  });

  it('does not mount on a non-editor Ghost Admin route', async () => {
    const appendToBody = vi.fn();
    const env = makeEnv({ getHash: vi.fn().mockReturnValue('#/posts'), appendToBody });
    await initToolbar(env);
    expect(appendToBody).not.toHaveBeenCalled();
  });
});

describe('initToolbar — apply delegation through the mounted toolbar', () => {
  it('delegates a preset click to the content script via the popup protocol', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const appendToBody = vi.fn();
    const env = makeEnv({ sendMessage, appendToBody });
    await initToolbar(env);

    const root = appendToBody.mock.calls[0]?.[0] as unknown as TestEl;
    const list = firstList(root);
    const btn = list.children[1]!.children[0] as unknown as {
      listeners: Record<string, () => void>;
    };
    btn.listeners['click']?.();
    // delegation is fire-and-forget; allow the promise to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0] as unknown as {
      op: string;
      source: string;
      presetId: string;
    };
    expect(sent.op).toBe('apply');
    expect(sent.source).toBe('ghost-cms-template-injector/popup/v1');
    expect(sent.presetId).toBe('p2');
  });

  it('announces applying status into the live region before delegation settles', async () => {
    let resolveSend: () => void = () => {};
    const sendMessage = vi.fn().mockReturnValue(new Promise<void>((res) => (resolveSend = res)));
    const appendToBody = vi.fn();
    const env = makeEnv({ sendMessage, appendToBody });
    await initToolbar(env);

    const root = appendToBody.mock.calls[0]?.[0] as unknown as TestEl;
    const status = statusRegion(root);
    const list = firstList(root);
    const btn = list.children[1]!.children[0] as unknown as {
      listeners: Record<string, () => void>;
    };
    btn.listeners['click']?.();
    await flush();
    expect((status.textContent as string) ?? '').toMatch(/applying/i);

    resolveSend();
    await flush();
    // Delegation acknowledged: the toolbar announces the imminent editor
    // reload (the MAIN bridge refreshes so applied text is visible).
    expect((status.textContent as string) ?? '').toMatch(/reloading/i);
  });
});

describe('initToolbar — apply uses chrome.runtime.sendMessage (no chrome.tabs)', () => {
  it('delegates through chrome.runtime.sendMessage in the browser bootstrap path', async () => {
    // Simulate the real content-script bootstrap: chrome global present,
    // chrome.runtime.sendMessage wired, no chrome.tabs. Re-import the module so
    // its top-level bootstrap runs against our stubbed chrome.
    const runtimeSend = vi.fn().mockResolvedValue(undefined);
    const store = globalThis as unknown as { chrome?: unknown };
    store.chrome = {
      runtime: { sendMessage: (msg: unknown) => runtimeSend(msg) },
    };

    // Import the module fresh so the `if (isBrowserContext())` block executes.
    vi.resetModules();
    const mod = await import('../../src/ui-toolbar-main');
    expect(typeof mod.initToolbar).toBe('function');

    // The browser bootstrap path (the one that matters for F1) wires
    // chrome.runtime.sendMessage directly. The static source must contain no
    // runtime chrome.tabs method access (a content script without the `tabs`
    // permission would throw). The built dist artifact is additionally asserted
    // by validate-manifest.mjs (no `chrome.tabs` anywhere in the bundle).
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/ui-toolbar-main.ts', 'utf8');
    expect(source).not.toMatch(/chrome\.tabs\.(sendMessage|query|get)/);
    expect(source).toMatch(/chrome\.runtime\.sendMessage/);

    Reflect.deleteProperty(store, 'chrome');
    vi.resetModules();
  });
});

describe('toolbar import — save the open post as a preset', () => {
  const CAPTURED = {
    resourceType: 'post' as const,
    title: 'Reviewing software',
    excerpt: 'How I review things',
    tags: ['Reviews'],
    customTemplate: null,
    featureImage: null,
    lexical:
      '{"root":{"children":[{"children":[{"text":"Hello","type":"extended-text","version":1}],"type":"paragraph","version":1}],"type":"root","version":1}}',
  };

  type ImportEnv = Parameters<typeof importPresetFromEditor>[0];
  function importEnv(overrides: Partial<ImportEnv> = {}) {
    return {
      sendMessage: vi.fn().mockResolvedValue({
        source: 'ghost-cms-template-injector/popup/v1',
        ok: true,
        result: { source: CAPTURED, warnings: [], readFrom: 'admin-api', siteOrigin: null },
      }),
      promptText: vi.fn().mockReturnValue('My review template'),
      savePreset: vi.fn().mockImplementation(async (input: unknown) => input),
      listPresets: vi
        .fn()
        .mockResolvedValue([{ id: 'my-review-template', name: 'Taken', icon: '' }]),
      ...overrides,
    };
  }

  it('builds and stores a preset from the captured post', async () => {
    const env = importEnv();
    const result = await importPresetFromEditor(env);

    expect(result.ok).toBe(true);
    expect(result.name).toBe('My review template');
    expect(env.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ op: 'capture' }));
    const saved = (env.savePreset as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      id: string;
      metadata: Record<string, unknown>;
      content: Record<string, unknown>;
    };
    expect(saved.id).toBe('my-review-template-2');
    expect(saved.content.mode).toBe('replace');
    expect(saved.metadata.tags).toEqual({ mode: 'merge', values: ['Reviews'] });
  });

  it('does nothing when the name prompt is cancelled', async () => {
    const env = importEnv({ promptText: vi.fn().mockReturnValue(null) });
    const result = await importPresetFromEditor(env);
    expect(result).toEqual({ ok: false, error: 'cancelled' });
    expect(env.savePreset).not.toHaveBeenCalled();
  });

  it('refuses a blank name', async () => {
    const env = importEnv({ promptText: vi.fn().mockReturnValue('   ') });
    const result = await importPresetFromEditor(env);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/name is required/);
    expect(env.savePreset).not.toHaveBeenCalled();
  });

  it('reports a failed or unusable capture instead of saving junk', async () => {
    const failed = importEnv({
      sendMessage: vi.fn().mockResolvedValue({ source: 'x', ok: false, error: 'NOT_ON_EDITOR' }),
    });
    await expect(importPresetFromEditor(failed)).resolves.toMatchObject({
      ok: false,
      error: 'NOT_ON_EDITOR',
    });

    const junk = importEnv({
      sendMessage: vi.fn().mockResolvedValue({ source: 'x', ok: true, result: { nope: true } }),
    });
    await expect(importPresetFromEditor(junk)).resolves.toMatchObject({
      ok: false,
      error: 'unrecognized capture payload',
    });

    const thrown = importEnv({
      sendMessage: vi.fn().mockRejectedValue(new Error('no content script')),
    });
    await expect(importPresetFromEditor(thrown)).resolves.toMatchObject({
      ok: false,
      error: 'no content script',
    });
  });

  it('refuses a post whose body is not readable', async () => {
    const env = importEnv({
      sendMessage: vi.fn().mockResolvedValue({
        source: 'x',
        ok: true,
        result: { source: { ...CAPTURED, lexical: null }, warnings: [], siteOrigin: null },
      }),
    });
    const result = await importPresetFromEditor(env);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no readable body/);
    expect(env.savePreset).not.toHaveBeenCalled();
  });

  it('still saves when the preset list cannot be read (id falls back to the base slug)', async () => {
    const env = importEnv({ listPresets: vi.fn().mockRejectedValue(new Error('storage gone')) });
    const result = await importPresetFromEditor(env);
    expect(result.ok).toBe(true);
    expect(
      ((env.savePreset as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { id: string }).id,
    ).toBe('my-review-template');
  });

  it('adds the import button to the toolbar DOM', () => {
    const handle = createToolbarElement(() => makeEl());
    const button = (handle.root as TestEl).children.find(
      (child) => child.attrs['data-gcti-save-preset'] === '1',
    );
    expect(button).toBeDefined();
    expect(button?.textContent).toBe(TOOLBAR_IMPORT_LABEL);
    expect(button?.attrs['type']).toBe('button');
  });

  it('triggers the import when the toolbar button is clicked', async () => {
    const importPreset = vi.fn().mockReturnValue(null);
    const env = makeEnv({
      sendMessage: vi.fn().mockResolvedValue({
        source: 'ghost-cms-template-injector/popup/v1',
        ok: true,
        result: { source: CAPTURED, warnings: [], siteOrigin: null },
      }),
      promptText: importPreset,
    });
    await initToolbar(env);
    await flush();
    const root = (env.appendToBody as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as TestEl;
    const button = root.children.find((child) => child.attrs['data-gcti-save-preset'] === '1');
    button?.listeners['click']?.();
    await flush();
    expect(importPreset).toHaveBeenCalled();
  });
});
