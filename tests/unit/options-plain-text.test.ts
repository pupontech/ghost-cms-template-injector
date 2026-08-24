import { describe, expect, it } from 'vitest';
import {
  fillFormForEdit,
  readFormPreset,
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

function view(): OptionsView {
  return {
    form: {
      id: input(),
      name: input(),
      title: input(),
      description: input(),
      source: input(),
      mode: input(),
      body: input(),
      snippet: input(),
      group: input(),
      icon: input(),
      tags: input(),
      tagMode: input(),
      excerpt: input(),
      excerptMode: input(),
      customTemplate: input(),
      customTemplateMode: input(),
    },
    listEl: input(),
    statusEl: input(),
    importArea: input(),
    exportArea: input(),
    document: { createElement: () => input(), getElementById: () => null },
    download: () => undefined,
    resetForm: () => undefined,
  };
}

describe('options plain-text body source', () => {
  it('round-trips text and metadata without exposing serialized Lexical JSON', () => {
    const preset: Preset = {
      schemaVersion: 1,
      id: 'plain',
      name: 'Plain',
      content: { source: 'inline-text', mode: 'replace', text: 'Intro\n\nDetails' },
      metadata: {
        tags: { mode: 'merge', values: ['Existing', 'New'] },
        excerpt: { mode: 'replace', value: 'Summary' },
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
    const form = view();
    fillFormForEdit(form, item);
    expect(form.form.body.value).toBe('Intro\n\nDetails');
    expect(readFormPreset(form)).toEqual(preset);
  });
});
