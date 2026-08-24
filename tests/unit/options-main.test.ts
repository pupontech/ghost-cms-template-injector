import { describe, expect, it } from 'vitest';
import {
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
    id: input('review'),
    name: input('Review'),
    description: input('desc'),
    source: input('inline-lexical'),
    mode: input('replace'),
    body: input('{"root":{"type":"root","version":1,"children":[]}}'),
    snippet: input(),
    group: input(),
    icon: input(),
    tags: input('Existing, Reviews'),
    tagMode: input('merge'),
    excerpt: input('An excerpt'),
    excerptMode: input('only-if-empty'),
    customTemplate: input('custom-review.hbs'),
    customTemplateMode: input('prompt'),
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

describe('options form tags', () => {
  it('rehydrates body and tag metadata when an existing preset is edited', () => {
    const view = formView();
    const preset: Preset = {
      schemaVersion: 1,
      id: 'review',
      name: 'Review',
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
    const roundTrip = readFormPreset(view) as {
      content: unknown;
      metadata: { tags: unknown };
    };
    expect(roundTrip.content).toEqual(preset.content);
    expect(roundTrip.metadata).toEqual(preset.metadata);
  });
});
