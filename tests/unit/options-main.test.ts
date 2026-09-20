import { describe, expect, it, vi } from 'vitest';
import {
  clearFeatureImage,
  deriveIdFromName,
  handleFeatureImageFile,
  nextAvailablePresetId,
  readFormPreset,
  refreshFeatureImagePreview,
  fillFormForEdit,
  handleDelete,
  handleExport,
  type OptionsView,
  type RenderInput,
} from '../../src/options-main';
import type { OptionsPresetView, OptionsRuntime } from '../../src/options-crud';
import type { Preset } from '../../src/preset-schema';

function input(value = ''): RenderInput {
  const attrs = new Map<string, string>();
  return {
    value,
    disabled: false,
    textContent: null,
    setAttribute: (name, val) => attrs.set(name, val),
    getAttribute: (name) => attrs.get(name) ?? null,
    removeAttribute: (name) => attrs.delete(name),
    appendChild: () => undefined,
    addEventListener: () => undefined,
  };
}

function formView(): OptionsView {
  const form = {
    id: input(),
    name: input('Review'),
    title: input(),
    description: input(),
    source: input('inline-text'),
    mode: input('replace'),
    body: input('Intro\n\nDetails'),
    snippet: input(),
    group: input(),
    icon: input(),
    tags: input('Existing, Reviews'),
    tagMode: input('merge'),
    excerpt: input(),
    excerptMode: input('replace'),
    customTemplate: input(),
    customTemplateMode: input('replace'),
    featureImageMode: input('only-if-empty'),
    featureImageUrl: input(),
    featureImageAsset: input(),
  };
  return {
    form,
    listEl: input(),
    statusEl: input(),
    importArea: input(),
    exportArea: input(),
    document: { createElement: () => input(), getElementById: () => null },
    download: () => undefined,
    resetForm: () => undefined,
  } as OptionsView;
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

describe('simplified options form', () => {
  it('derives a slug id from the visible name for new presets', () => {
    expect(deriveIdFromName('Review checklist!')).toBe('review-checklist');
    expect(deriveIdFromName('   ')).toMatch(/^preset-/);
  });

  it('creates a bounded unique id instead of shadowing an existing preset', () => {
    expect(nextAvailablePresetId('life-update', new Set(['life-update', 'life-update-2']))).toBe(
      'life-update-3',
    );
    const long = 'x'.repeat(64);
    expect(nextAvailablePresetId(long, new Set([long]))).toBe(`${'x'.repeat(62)}-2`);
  });

  it('surfaces storage failures when deleting instead of rejecting the UI handler', async () => {
    const view = formView();
    const rt = runtime({ loadPresets: vi.fn().mockRejectedValue(new Error('storage offline')) });

    await expect(handleDelete({ rt, view }, 'missing', false)).resolves.toBeUndefined();
    expect(view.statusEl.textContent).toContain('Delete failed: storage offline');
    expect(view.statusEl.getAttribute('role')).toBe('alert');
  });

  it('exports through the injected runtime instead of bypassing the testable storage seam', async () => {
    const view = formView();
    const download = vi.fn();
    view.download = download;
    const preset: Preset = {
      schemaVersion: 1,
      id: 'export-me',
      name: 'Export me',
      content: { source: 'inline-text', mode: 'replace', text: 'Body' },
    };
    const exportPresets = vi.fn(() => '{"presets":[]}');
    const rt = runtime({ loadPresets: async () => [preset], exportPresets });

    await expect(handleExport({ rt, view })).resolves.toBeUndefined();
    expect(exportPresets).toHaveBeenCalledWith([preset]);
    expect(download).toHaveBeenCalledWith(
      'ghost-cms-template-injector-presets.json',
      '{"presets":[]}',
    );
  });

  it('creates a preset with only name, template text, and tags', () => {
    const view = formView();
    const preset = readFormPreset(view) as {
      id: string;
      content: { source: string; text?: string };
      metadata?: { tags?: unknown };
      description?: string;
      ui?: Record<string, string>;
    };
    expect(preset.id).toBe('review');
    expect(preset.content.source).toBe('inline-text');
    expect(preset.content.text).toBe('Intro\n\nDetails');
    expect(preset.metadata).toBeDefined();
    expect(preset.description).toBeUndefined();
    expect(preset.ui).toBeUndefined();
  });

  it('editing preserves hidden legacy fields it no longer shows', () => {
    const view = formView();
    const preset: Preset = {
      schemaVersion: 1,
      id: 'legacy',
      name: 'Legacy',
      description: 'Old description',
      ui: { group: 'Blog', icon: '📝' },
      content: {
        source: 'inline-lexical',
        mode: 'only-if-empty',
        lexical: '{"root":{"type":"root","version":1,"children":[]}}',
      },
      metadata: {
        excerpt: { mode: 'only-if-empty', value: 'An excerpt' },
        customTemplate: { mode: 'prompt', value: 'custom-review.hbs' },
        tags: { mode: 'replace', values: ['Software', 'Reviews'] },
      },
    };
    const item: OptionsPresetView = {
      id: preset.id,
      name: preset.name,
      source: preset.content.source,
      mode: preset.content.mode,
      preset,
      seeded: false,
    };
    fillFormForEdit(view, item);
    const roundTrip = readFormPreset(view) as Preset;
    expect(roundTrip).toEqual(preset);
  });

  it('captures an optional post title as a replace-mode title field', () => {
    const view = formView();
    view.form.title.value = 'My Review Title';
    const preset = readFormPreset(view) as {
      metadata?: { title?: { mode: string; value: string } };
    };
    expect(preset.metadata?.title).toEqual({ mode: 'replace', value: 'My Review Title' });
  });

  it('omits the title field when left empty', () => {
    const view = formView();
    view.form.title.value = '   ';
    const preset = readFormPreset(view) as { metadata?: { title?: unknown } };
    expect(preset.metadata?.title).toBeUndefined();
  });

  it('rehydrates a saved title and excerpt when editing', () => {
    const view = formView();
    const preset: Preset = {
      schemaVersion: 1,
      id: 'titled',
      name: 'Titled',
      content: { source: 'inline-text', mode: 'replace', text: 'Body' },
      metadata: {
        title: { mode: 'replace', value: 'Saved title' },
        excerpt: { mode: 'only-if-empty', value: 'Saved excerpt' },
      },
    };
    fillFormForEdit(view, {
      id: preset.id,
      name: preset.name,
      source: preset.content.source,
      mode: preset.content.mode,
      preset,
      seeded: false,
    });
    expect(view.form.title.value).toBe('Saved title');
    expect(view.form.excerpt.value).toBe('Saved excerpt');
    expect(readFormPreset(view)).toEqual(preset);
  });
});

describe('options page — feature image (top image)', () => {
  const presetView = (preset: Preset): OptionsPresetView => ({
    id: preset.id,
    name: preset.name,
    source: preset.content.source,
    mode: preset.content.mode,
    preset,
    seeded: false,
  });

  const presetWithPhoto = (field: Record<string, unknown> | undefined): Preset => ({
    schemaVersion: 1,
    id: 'with-photo',
    name: 'With photo',
    content: { source: 'inline-text', mode: 'replace', text: 'Body' },
    ...(field ? { metadata: { featureImage: field as never } } : {}),
  });

  it('saves a cached photo reference (not the bytes) with the chosen mode', () => {
    const view = formView();
    view.form.featureImageAsset.value = 'img_0123456789abcdef';
    view.form.featureImageMode.value = 'replace';

    const preset = readFormPreset(view) as {
      metadata?: { featureImage?: { mode: string; assetId?: string; url?: string } };
    };
    expect(preset.metadata?.featureImage).toEqual({
      mode: 'replace',
      assetId: 'img_0123456789abcdef',
    });
  });

  it('saves an image URL when no photo was picked', () => {
    const view = formView();
    view.form.featureImageUrl.value = '/content/images/2026/09/hero.png';

    const preset = readFormPreset(view) as {
      metadata?: { featureImage?: { mode: string; assetId?: string; url?: string } };
    };
    expect(preset.metadata?.featureImage).toEqual({
      mode: 'only-if-empty',
      url: '/content/images/2026/09/hero.png',
    });
  });

  it('prefers the picked photo over a typed URL and omits the field when empty', () => {
    const view = formView();
    view.form.featureImageAsset.value = 'img_0123456789abcdef';
    view.form.featureImageUrl.value = '/content/images/stale.png';
    const preset = readFormPreset(view) as { metadata?: { featureImage?: { assetId?: string } } };
    expect(preset.metadata?.featureImage?.assetId).toBe('img_0123456789abcdef');

    const empty = formView();
    const emptyPreset = readFormPreset(empty) as { metadata?: { featureImage?: unknown } };
    expect(emptyPreset.metadata?.featureImage).toBeUndefined();
  });

  it('rehydrates a saved photo reference and mode when editing', () => {
    const view = formView();
    const preset = presetWithPhoto({ mode: 'prompt', assetId: 'img_0123456789abcdef' });
    fillFormForEdit(view, presetView(preset));

    expect(view.form.featureImageMode.value).toBe('prompt');
    expect(view.form.featureImageAsset.value).toBe('img_0123456789abcdef');
    expect(view.form.featureImageUrl.value).toBe('');
    expect(readFormPreset(view)).toEqual(preset);
  });

  it('rehydrates a saved image URL when editing', () => {
    const view = formView();
    const preset = presetWithPhoto({ mode: 'replace', url: 'https://cdn.example.com/a.png' });
    fillFormForEdit(view, presetView(preset));

    expect(view.form.featureImageUrl.value).toBe('https://cdn.example.com/a.png');
    expect(view.form.featureImageAsset.value).toBe('');
    expect(readFormPreset(view)).toEqual(preset);
  });

  it('caches a picked photo and points the preset at it', async () => {
    const view = formView();
    view.featureImageStatus = {
      textContent: null,
      setAttribute: () => undefined,
      getAttribute: () => null,
      removeAttribute: () => undefined,
      appendChild: () => undefined,
      addEventListener: () => undefined,
    };
    const putImage = vi.fn(async () => ({
      id: 'img_0123456789abcdef',
      name: 'hero.png',
      mimeType: 'image/png',
      bytes: 4096,
      sha256: 'a'.repeat(64),
      createdAt: '2026-09-17T10:00:00.000Z',
    }));

    await handleFeatureImageFile(
      { rt: stubRuntime(), view, imageAssets: { putImage, getRecord: async () => null } },
      {
        name: 'hero.png',
        type: 'image/png',
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      },
    );

    expect(putImage).toHaveBeenCalledTimes(1);
    expect(view.form.featureImageAsset.value).toBe('img_0123456789abcdef');
    expect(view.featureImageStatus.textContent).toMatch(/cached in this browser/i);
  });

  it('reports a rejected photo without touching the preset', async () => {
    const view = formView();
    view.featureImageStatus = {
      textContent: null,
      setAttribute: () => undefined,
      getAttribute: () => null,
      removeAttribute: () => undefined,
      appendChild: () => undefined,
      addEventListener: () => undefined,
    };

    await handleFeatureImageFile(
      {
        rt: stubRuntime(),
        view,
        imageAssets: {
          putImage: async () => {
            throw new Error('image-asset-store: unsupported image type "image/svg+xml"');
          },
          getRecord: async () => null,
        },
      },
      { name: 'x.svg', type: 'image/svg+xml', arrayBuffer: async () => new ArrayBuffer(2) },
    );

    expect(view.form.featureImageAsset.value).toBe('');
    expect(view.featureImageStatus.textContent).toMatch(/could not be stored/i);
  });

  it('warns when a preset references a photo this browser does not have', async () => {
    const view = formView();
    view.featureImageStatus = {
      textContent: null,
      setAttribute: () => undefined,
      getAttribute: () => null,
      removeAttribute: () => undefined,
      appendChild: () => undefined,
      addEventListener: () => undefined,
    };

    await refreshFeatureImagePreview(
      { rt: stubRuntime(), view, imageAssets: { putImage: vi.fn(), getRecord: async () => null } },
      { mode: 'replace', assetId: 'img_0123456789abcdef' },
    );

    expect(view.featureImageStatus.textContent).toMatch(/not cached in this browser/i);
  });

  it('clears every feature-image control', () => {
    const view = formView();
    view.featureImageStatus = {
      textContent: 'Photo cached',
      setAttribute: () => undefined,
      getAttribute: () => null,
      removeAttribute: () => undefined,
      appendChild: () => undefined,
      addEventListener: () => undefined,
    };
    view.form.featureImageAsset.value = 'img_0123456789abcdef';
    view.form.featureImageUrl.value = '/content/images/a.png';

    clearFeatureImage(view);

    expect(view.form.featureImageAsset.value).toBe('');
    expect(view.form.featureImageUrl.value).toBe('');
    expect(view.featureImageStatus.textContent).toBe('No photo selected.');
  });
});

function stubRuntime(): OptionsRuntime {
  return {
    loadPresets: async () => [],
    loadBundledDefaults: async () => [],
    savePreset: async (input) => input as Preset,
    importPresetsIntoStore: async () => [],
    exportPresets: () => '[]',
  };
}
