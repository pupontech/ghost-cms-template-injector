import { describe, expect, it, vi } from 'vitest';

import {
  FROM_POST_CURRENT,
  importFromPost,
  loadFromPostSource,
  refreshFromPostSources,
  renderFromPostSources,
  type OptionsControllerDeps,
  type OptionsView,
  type RenderInput,
} from '../../src/options-main';
import type { OptionsRuntime } from '../../src/options-crud';
import type { Preset } from '../../src/preset-schema';

const BODY =
  '{"root":{"children":[{"children":[{"text":"Imported body","type":"extended-text","version":1}],"type":"paragraph","version":1}],"type":"root","version":1}}';

const CAPTURE = {
  source: {
    resourceType: 'post' as const,
    title: 'Reviewing software',
    excerpt: 'How I review things',
    tags: ['Reviews'],
    customTemplate: null,
    featureImage: null,
    lexical: BODY,
  },
  warnings: [] as string[],
  readFrom: 'admin-api' as const,
  siteOrigin: 'https://example.com',
};

interface TestInput extends RenderInput {
  children: TestInput[];
  listeners: Record<string, () => void>;
}

/** The view is built from test inputs, so exposes their richer shape. */
interface TestFromPostView {
  source: TestInput;
  name: TestInput;
  includeTitle: TestInput;
  save: TestInput;
  refresh: TestInput;
  status: TestInput;
  captured: typeof CAPTURE | null;
}

function input(value = ''): TestInput {
  const el: TestInput = {
    value,
    checked: false,
    disabled: false,
    textContent: null,
    children: [],
    listeners: {},
    setAttribute: () => undefined,
    getAttribute: () => null,
    removeAttribute: () => undefined,
    appendChild: (child: RenderInput) => {
      el.children.push(child as TestInput);
    },
    addEventListener: (type: string, cb: (ev?: unknown) => void) => {
      el.listeners[type] = cb as () => void;
    },
  } as unknown as TestInput;
  return el;
}

function makeFromPost(): TestFromPostView {
  const section = {
    source: input(),
    name: input(),
    includeTitle: input(),
    save: input(),
    refresh: input(),
    status: input(),
    captured: null,
  };
  return section as unknown as TestFromPostView;
}

function view(): OptionsView & { fromPost: TestFromPostView } {
  const fromPost = makeFromPost();
  return {
    listEl: input(),
    statusEl: input(),
    form: {
      id: input(),
      name: input(),
      title: input(),
      description: input(),
      source: input('inline-text'),
      mode: input('replace'),
      body: input(),
      snippet: input(),
      group: input(),
      icon: input(),
      tags: input(),
      tagMode: input('merge'),
      excerpt: input(),
      excerptMode: input('only-if-empty'),
      customTemplate: input(),
      customTemplateMode: input('replace'),
      featureImageMode: input('only-if-empty'),
      featureImageUrl: input(),
      featureImageAsset: input(),
    },
    importArea: input(),
    exportArea: input(),
    fromPost,
    document: { createElement: () => input(), getElementById: () => null },
    download: () => undefined,
    resetForm: () => undefined,
  } as unknown as OptionsView & { fromPost: TestFromPostView };
}

function runtime(overrides: Partial<OptionsRuntime> = {}): OptionsRuntime {
  return {
    loadPresets: async () => [],
    loadBundledDefaults: async () => [],
    savePreset: async (value) => value as Preset,
    importPresetsIntoStore: async () => [],
    exportPresets: () => '[]',
    ...overrides,
  };
}

function deps(
  overrides: Partial<OptionsControllerDeps> = {},
): OptionsControllerDeps & { view: ReturnType<typeof view> } {
  const v = view();
  return { ...overrides, rt: overrides.rt ?? runtime(), view: v } as OptionsControllerDeps & {
    view: ReturnType<typeof view>;
  };
}

describe('renderFromPostSources', () => {
  it('offers the open editor plus stored posts, selecting the editor by default', () => {
    const section = makeFromPost();
    renderFromPostSources(
      section,
      [
        {
          id: 'p1',
          title: 'First post',
          status: 'published',
          updatedAt: null,
          resourceType: 'post',
        },
        { id: 'x1', title: 'About page', status: 'draft', updatedAt: null, resourceType: 'page' },
      ],
      true,
      () => input(),
    );

    expect(section.source.children.map((child) => child.value)).toEqual([
      FROM_POST_CURRENT,
      'post:p1',
      'page:x1',
    ]);
    expect(section.source.children[0]?.textContent).toBe('The post open in the editor');
    expect(section.source.value).toBe(FROM_POST_CURRENT);
  });

  it('selects the first stored post when there is no editor to read', () => {
    const section = makeFromPost();
    renderFromPostSources(
      section,
      [{ id: 'p1', title: 'First', status: 'draft', updatedAt: null, resourceType: 'post' }],
      false,
      () => input(),
    );
    expect(section.source.children).toHaveLength(1);
    expect(section.source.value).toBe('post:p1');
  });
});

describe('the options-page import reads through the service-worker transport', () => {
  it('lists posts and immediately reads the selected source', async () => {
    const d = deps({
      sendImportMessage: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          result: {
            entries: [
              {
                id: 'p1',
                title: 'First post',
                status: 'published',
                updatedAt: null,
                resourceType: 'post',
              },
            ],
          },
        })
        .mockResolvedValueOnce({ ok: true, result: CAPTURE }),
    });

    await refreshFromPostSources(d);

    const send = d.sendImportMessage as ReturnType<typeof vi.fn>;
    expect(send.mock.calls[0]?.[0]).toEqual({ op: 'listPosts' });
    // The editor entry exists, so the "current editor" read is the one issued.
    expect(send.mock.calls[1]?.[0]).toEqual({ op: 'capture' });
    expect(d.view.fromPost.name.value).toBe('Reviewing software');
    expect(d.view.fromPost.captured?.source.lexical).toBe(BODY);
    expect(d.view.fromPost.status.textContent).toMatch(/Ready to import: body, excerpt, 1 tag/);
  });

  it('reads a specific post when the picker selects one', async () => {
    const d = deps({
      sendImportMessage: vi.fn().mockResolvedValue({ ok: true, result: CAPTURE }),
    });
    d.view.fromPost.source.value = 'page:x1';

    await loadFromPostSource(d);

    expect((d.sendImportMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      op: 'capturePost',
      resourceType: 'page',
      resourceId: 'x1',
    });
  });

  it('explains the missing Ghost tab instead of showing an empty list', async () => {
    const d = deps({
      sendImportMessage: vi.fn().mockResolvedValue({ ok: false, error: 'NO_GHOST_TAB' }),
    });
    await refreshFromPostSources(d);
    expect(d.view.fromPost.status.textContent).toMatch(/No Ghost Admin tab found/);
    expect(d.view.fromPost.captured ?? null).toBeNull();
  });

  it('says what is missing when the page has no transport at all', async () => {
    const d = deps();
    await refreshFromPostSources(d);
    expect(d.view.fromPost.status.textContent).toMatch(/needs a Ghost Admin tab/);
  });

  it('reports a failed capture without leaving a stale capture behind', async () => {
    const d = deps({
      sendImportMessage: vi.fn().mockResolvedValue({ ok: false, error: 'CAPTURE_NOT_FOUND' }),
    });
    d.view.fromPost.captured = CAPTURE as never;
    await loadFromPostSource(d);
    expect(d.view.fromPost.captured).toBeNull();
    expect(d.view.fromPost.status.textContent).toMatch(/CAPTURE_NOT_FOUND/);
  });
});

describe('importFromPost', () => {
  it('stores the captured post as a preset and refreshes the list', async () => {
    const savePreset = vi.fn().mockImplementation(async (value: unknown) => value);
    const d = deps({
      rt: runtime({
        savePreset,
        loadPresets: async () => [
          {
            schemaVersion: 1,
            id: 'reviewing-software',
            name: 'Existing preset',
            content: { source: 'inline-lexical', mode: 'replace', lexical: BODY },
            metadata: {},
          } as Preset,
        ],
      }),
      sendImportMessage: vi.fn(),
    });
    d.view.fromPost.captured = CAPTURE as never;
    d.view.fromPost.name.value = 'Reviewing software';

    await importFromPost(d);

    const saved = savePreset.mock.calls[0]?.[0] as { id: string; ui?: { group?: string } };
    expect(saved.id).toBe('reviewing-software-2');
    expect(saved.ui?.group).toBe('Imported');
    expect(d.view.fromPost.status.textContent).toMatch(/Saved preset “Reviewing software”/);
    expect(d.view.statusEl.textContent).toMatch(/Imported “Reviewing software”/);
  });

  it('refuses to import before a post was read', async () => {
    const savePreset = vi.fn();
    const d = deps({ rt: runtime({ savePreset }) });
    await importFromPost(d);
    expect(savePreset).not.toHaveBeenCalled();
    expect(d.view.fromPost.status.textContent).toMatch(/Pick a post to import first/);
  });

  it('surfaces a store failure and saves nothing else', async () => {
    const d = deps({
      rt: runtime({ savePreset: vi.fn().mockRejectedValue(new Error('storage full')) }),
    });
    d.view.fromPost.captured = CAPTURE as never;
    await importFromPost(d);
    expect(d.view.fromPost.status.textContent).toMatch(/storage full/);
  });
});
