import { describe, expect, it, vi } from 'vitest';

import type { CreateEl } from '../../src/ui-popup-main';
import {
  createToolbarElement,
  initToolbar,
  renderToolbarPresets,
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
    expect(root.attrs['aria-label']).toMatch(/preset/i);
    expect(root.attrs['data-gpt-toolbar']).toBeDefined();
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
    expect(sent.source).toBe('ghost-preset-toolbar/popup/v1');
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
    expect(status.textContent).toBe('');
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
