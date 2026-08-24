import { describe, expect, it } from 'vitest';
import {
  deriveIdFromName,
  readFormPreset,
  fillFormForEdit,
  type OptionsView,
  type RenderInput,
} from '../../src/options-main';
import type { OptionsPresetView } from '../../src/options-crud';
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

describe('simplified options form', () => {
  it('derives a slug id from the visible name for new presets', () => {
    expect(deriveIdFromName('Review checklist!')).toBe('review-checklist');
    expect(deriveIdFromName('   ')).toMatch(/^preset-/);
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
});
