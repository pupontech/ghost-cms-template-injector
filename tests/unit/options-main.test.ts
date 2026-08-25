import { describe, expect, it, vi } from 'vitest';
import {
  deriveIdFromName,
  nextAvailablePresetId,
  readFormPreset,
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
    expect(download).toHaveBeenCalledWith('ghost-preset-toolbar-presets.json', '{"presets":[]}');
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
