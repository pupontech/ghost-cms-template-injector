import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_BYTES,
  PRESET_SCHEMA_VERSION,
  validateImportSize,
  validatePreset,
  validatePresets,
  type Preset,
} from '../../src/preset-schema';

function basePreset(): Record<string, unknown> {
  return {
    schemaVersion: PRESET_SCHEMA_VERSION,
    id: 'software-review',
    name: 'Software Review',
    description: 'Standard structure for software reviews.',
    content: {
      source: 'inline-html',
      mode: 'replace',
      html: '<h2>Overview</h2>',
    },
    metadata: {
      excerpt: { mode: 'replace', value: 'A review.' },
      customTemplate: {
        mode: 'replace',
        value: 'custom-software-review.hbs',
      },
      tags: { mode: 'merge', values: ['Software', 'Reviews'] },
    },
    ui: { icon: '💻', group: 'Reviews' },
  };
}

describe('validatePreset — valid input', () => {
  it('accepts a fully-formed preset and normalizes types', () => {
    const preset: Preset = validatePreset(basePreset());
    expect(preset.id).toBe('software-review');
    expect(preset.content.mode).toBe('replace');
    expect(preset.metadata?.tags?.mode).toBe('merge');
  });

  it('accepts a ghost-snippet body source with a snippet name', () => {
    const raw = basePreset();
    raw.content = { source: 'ghost-snippet', mode: 'only-if-empty', snippet: 'review-snippet' };
    expect(validatePreset(raw).content).toMatchObject({
      source: 'ghost-snippet',
      snippet: 'review-snippet',
    });
  });

  it('accepts a preset without metadata or ui blocks', () => {
    const raw = {
      schemaVersion: PRESET_SCHEMA_VERSION,
      id: 'minimal',
      name: 'Minimal',
      content: {
        source: 'inline-lexical',
        mode: 'prompt',
        lexical: '{"root":{"type":"root","version":1,"children":[]}}',
      },
    };
    expect(validatePreset(raw).metadata).toBeUndefined();
  });
});

describe('validatePreset — envelope and versioning (C5)', () => {
  it('rejects non-object input', () => {
    expect(() => validatePreset(null)).toThrow(/object/i);
    expect(() => validatePreset(42)).toThrow(/object/i);
  });

  it.each(['0', '2', 99])('rejects unsupported schemaVersion %p', (v) => {
    const raw = basePreset();
    raw.schemaVersion = v;
    expect(() => validatePreset(raw)).toThrow(/schemaVersion/i);
  });

  it('rejects an id that is not a lowercase slug of [a-z0-9-]', () => {
    const raw = basePreset();
    raw.id = 'Bad Id!';
    expect(() => validatePreset(raw)).toThrow(/id/i);
  });
});

describe('validatePreset — body modes (C5: replace | only-if-empty | prompt only)', () => {
  it.each(['append', 'merge'])('rejects forbidden content mode "%s"', (mode) => {
    const raw = basePreset();
    (raw.content as Record<string, unknown>).mode = mode;
    expect(() => validatePreset(raw)).toThrow(/content\.mode/i);
  });

  it('rejects a missing content mode', () => {
    const raw = basePreset();
    delete (raw.content as Record<string, unknown>).mode;
    expect(() => validatePreset(raw)).toThrow(/content\.mode/i);
  });
});

describe('validatePreset — body source validation (C5/C6 inline & snippet)', () => {
  it.each(['url', 'file', 'remote-js'])('rejects unknown content source "%s"', (source) => {
    const raw = basePreset();
    (raw.content as Record<string, unknown>).source = source;
    expect(() => validatePreset(raw)).toThrow(/content\.source/i);
  });

  it('requires snippet name for ghost-snippet source and forbids stray html', () => {
    const raw = basePreset();
    raw.content = { source: 'ghost-snippet', mode: 'replace' };
    expect(() => validatePreset(raw)).toThrow(/snippet/i);

    raw.content = { source: 'ghost-snippet', mode: 'replace', snippet: 'x', html: '<b>' };
    expect(() => validatePreset(raw)).toThrow(/html|snippet|field/i);
  });

  it('requires html payload for inline-html source', () => {
    const raw = basePreset();
    raw.content = { source: 'inline-html', mode: 'replace' };
    expect(() => validatePreset(raw)).toThrow(/html/i);
  });

  it('requires lexical payload for inline-lexical source', () => {
    const raw = basePreset();
    raw.content = { source: 'inline-lexical', mode: 'replace' };
    expect(() => validatePreset(raw)).toThrow(/lexical/i);
  });

  it('rejects non-string body payloads', () => {
    const raw = basePreset();
    raw.content = { source: 'inline-html', mode: 'replace', html: { evil: true } };
    expect(() => validatePreset(raw)).toThrow(/html/i);
  });

  it('rejects malformed inline Lexical before storage or import can accept it', () => {
    const raw = basePreset();
    raw.content = { source: 'inline-lexical', mode: 'replace', lexical: '{"root":{}}' };
    expect(() => validatePreset(raw)).toThrow(/lexical|root|structur/i);
  });

  it('rejects invalid nested Lexical nodes instead of accepting arbitrary recursion', () => {
    const raw = basePreset();
    raw.content = {
      source: 'inline-lexical',
      mode: 'replace',
      lexical: JSON.stringify({
        root: {
          type: 'root',
          version: 1,
          children: [{ type: 'paragraph', version: 1, children: [null] }],
        },
      }),
    };
    expect(() => validatePreset(raw)).toThrow(/lexical|node|structur/i);
  });
});

describe('validatePreset — metadata modes (C5 safe modes, no append)', () => {
  it.each([['excerpt', ['append', 'merge']]] as const)(
    'rejects forbidden %s modes',
    (field, badModes) => {
      for (const mode of badModes) {
        const raw = basePreset();
        const meta = raw.metadata as Record<string, Record<string, unknown>>;
        (meta[field] as Record<string, unknown>).mode = mode;
        expect(() => validatePreset(raw), `${field}:${mode}`).toThrow(new RegExp(field, 'i'));
      }
    },
  );

  it('allows exactly replace | merge | only-if-empty | prompt for tags', () => {
    const raw = basePreset();
    const tags = (raw.metadata as Record<string, Record<string, unknown>>).tags as Record<
      string,
      unknown
    >;
    tags.mode = 'nonsense';
    expect(() => validatePreset(raw)).toThrow(/tags/i);
  });

  it('requires excerpt.value to be a bounded string', () => {
    const raw = basePreset();
    const excerpt = (raw.metadata as Record<string, Record<string, unknown>>).excerpt as Record<
      string,
      unknown
    >;
    excerpt.value = 123;
    expect(() => validatePreset(raw)).toThrow(/excerpt/i);

    excerpt.value = 'x'.repeat(301);
    expect(() => validatePreset(raw)).toThrow(/excerpt/i);
  });

  it('requires custom_template to include .hbs (C6)', () => {
    const raw = basePreset();
    const template = (raw.metadata as Record<string, Record<string, unknown>>)
      .customTemplate as Record<string, unknown>;
    template.value = 'custom-review';
    expect(() => validatePreset(raw)).toThrow(/\.(hbs)|customTemplate|template/i);
  });

  it('requires tags.values to be a non-empty array of non-empty strings', () => {
    const raw = basePreset();
    const tags = (raw.metadata as Record<string, Record<string, unknown>>).tags as Record<
      string,
      unknown
    >;
    tags.values = [];
    expect(() => validatePreset(raw)).toThrow(/tags/i);
    tags.values = ['ok', ''];
    expect(() => validatePreset(raw)).toThrow(/tags/i);
    tags.values = 'Software';
    expect(() => validatePreset(raw)).toThrow(/tags/i);
  });

  it('rejects unknown metadata fields (fail closed)', () => {
    const raw = basePreset();
    (raw.metadata as Record<string, unknown>).body = { mode: 'replace' };
    expect(() => validatePreset(raw)).toThrow(/metadata/i);
  });

  it('requires a mode on every present metadata field', () => {
    const raw = basePreset();
    const excerpt = (raw.metadata as Record<string, Record<string, unknown>>).excerpt as Record<
      string,
      unknown
    >;
    delete excerpt.mode;
    expect(() => validatePreset(raw)).toThrow(/excerpt/i);
  });
});

describe('validatePresets — collection-level uniqueness (C5 unique ids)', () => {
  it('accepts distinct ids and rejects duplicates', () => {
    const a = basePreset();
    const b = basePreset();
    b.id = 'other-preset';
    expect(validatePresets([a, b])).toHaveLength(2);

    b.id = 'software-review';
    expect(() => validatePresets([a, b])).toThrow(/duplicate.*id|unique/i);
  });
});

describe('validateImportSize — bounded imports (C5 size limits)', () => {
  it('exposes the configured byte limit', () => {
    expect(MAX_IMPORT_BYTES).toBeGreaterThan(0);
  });

  it('accepts payloads under the limit and rejects oversized ones', () => {
    expect(validateImportSize('{}')).toBe(true);
    const oversized = JSON.stringify(basePreset()).padEnd(MAX_IMPORT_BYTES + 1, 'a');
    expect(() => validateImportSize(oversized)).toThrow(/too large|size/i);
  });
});
