import { describe, expect, it } from 'vitest';

import {
  buildPresetFromCapture,
  isCapturableLexical,
  defaultImportName,
  describeCapture,
  normalizeCapturedImageUrl,
  sourceFromGhostRecord,
  type CapturedSource,
} from '../../src/preset-capture';
import { validatePreset } from '../../src/preset-schema';

const BODY =
  '{"root":{"children":[{"children":[{"text":"Hello","type":"extended-text","version":1}],"type":"paragraph","version":1}],"type":"root","version":1}}';

function source(overrides: Partial<CapturedSource> = {}): CapturedSource {
  return {
    resourceType: 'post',
    title: 'How I review software',
    excerpt: 'A short summary of the post.',
    tags: ['Software', 'Reviews'],
    customTemplate: 'custom-review.hbs',
    featureImage: 'https://blog.example.com/content/images/2026/09/hero.png',
    lexical: BODY,
    ...overrides,
  };
}

describe('buildPresetFromCapture — importing an existing post', () => {
  it('captures the body plus the metadata worth templating', () => {
    const { preset, warnings } = buildPresetFromCapture(source(), { name: 'Review template' });

    expect(warnings).toEqual([]);
    expect(preset.id).toBe('review-template');
    expect(preset.name).toBe('Review template');
    expect(preset.ui?.group).toBe('Imported');
    expect(preset.content).toEqual({ source: 'inline-lexical', mode: 'replace', lexical: BODY });
    expect(preset.metadata?.excerpt).toEqual({
      mode: 'only-if-empty',
      value: 'A short summary of the post.',
    });
    expect(preset.metadata?.tags).toEqual({ mode: 'merge', values: ['Software', 'Reviews'] });
    expect(preset.metadata?.customTemplate).toEqual({
      mode: 'only-if-empty',
      value: 'custom-review.hbs',
    });
    expect(preset.metadata?.featureImage).toEqual({
      mode: 'only-if-empty',
      url: 'https://blog.example.com/content/images/2026/09/hero.png',
    });
    // The title is deliberately NOT captured: re-applying a preset must never
    // rename the post being written.
    expect(preset.metadata?.title).toBeUndefined();
    expect(preset.description).toContain('Imported from post');
    // The result is schema-valid on its own.
    expect(validatePreset(preset)).toEqual(preset);
  });

  it('captures the title only when explicitly asked', () => {
    const { preset } = buildPresetFromCapture(source(), {
      name: 'Titled template',
      includeTitle: true,
    });
    expect(preset.metadata?.title).toEqual({ mode: 'replace', value: 'How I review software' });

    const untitled = buildPresetFromCapture(source({ title: '(Untitled)' }), {
      name: 'Draft template',
      includeTitle: true,
    });
    expect(untitled.preset.metadata?.title).toBeUndefined();
  });

  it('stores same-origin media as a portable /content path', () => {
    const { preset } = buildPresetFromCapture(
      source(),
      { name: 'Portable' },
      'https://blog.example.com',
    );
    expect(preset.metadata?.featureImage?.url).toBe('/content/images/2026/09/hero.png');
  });

  it('honours explicit modes and omits empty fields', () => {
    const { preset } = buildPresetFromCapture(
      source({
        excerpt: null,
        tags: [],
        customTemplate: null,
        featureImage: null,
      }),
      { name: 'Body only', excerptMode: 'replace', tagMode: 'replace' },
    );
    expect(preset.metadata).toBeUndefined();
    expect(preset.content.source).toBe('inline-lexical');
  });

  it('dedupes tags case-insensitively and drops blanks', () => {
    const { preset } = buildPresetFromCapture(
      source({ tags: ['Reviews', ' reviews ', '', 'Software'] }),
      { name: 'Tagged' },
    );
    expect(preset.metadata?.tags?.values).toEqual(['Reviews', 'Software']);
  });

  it('trims an over-long excerpt and says so', () => {
    const long = 'x'.repeat(400);
    const { preset, warnings } = buildPresetFromCapture(source({ excerpt: long }), {
      name: 'Long excerpt',
    });
    expect(preset.metadata?.excerpt?.value).toHaveLength(300);
    expect(warnings.join(' ')).toMatch(/trimmed to 300 characters/);
  });

  it('skips a custom template that is not an .hbs filename, with a warning', () => {
    const { preset, warnings } = buildPresetFromCapture(
      source({ customTemplate: 'custom-review' }),
      {
        name: 'No template',
      },
    );
    expect(preset.metadata?.customTemplate).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/was skipped/);
  });

  it('skips a feature image URL the preset schema cannot accept, with a warning', () => {
    const { preset, warnings } = buildPresetFromCapture(
      source({ featureImage: 'data:image/png;base64,AAAA' }),
      { name: 'Odd image' },
    );
    expect(preset.metadata?.featureImage).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/unsupported URL/);
  });

  it('can leave the feature image out entirely', () => {
    const { preset } = buildPresetFromCapture(source(), {
      name: 'No image',
      includeFeatureImage: false,
    });
    expect(preset.metadata?.featureImage).toBeUndefined();
  });

  it('refuses a post with no usable body instead of writing a broken preset', () => {
    expect(() => buildPresetFromCapture(source({ lexical: null }), { name: 'Empty' })).toThrow(
      /no readable body/,
    );
    expect(() => buildPresetFromCapture(source({ lexical: 'not json' }), { name: 'Bad' })).toThrow(
      /no readable body/,
    );
    expect(() =>
      buildPresetFromCapture(source({ lexical: null, resourceType: 'page' }), { name: 'Page' }),
    ).toThrow(/this page has no readable body/);
  });

  it('refuses a blank draft body (a valid document with no content)', () => {
    const blank =
      '{"root":{"children":[{"children":[],"type":"paragraph","version":1}],"type":"root","version":1}}';
    expect(() => buildPresetFromCapture(source({ lexical: blank }), { name: 'Blank' })).toThrow(
      /no body content/,
    );
    // A text-less body that still carries a card IS content worth templating.
    const withCard =
      '{"root":{"children":[{"type":"image","version":1,"src":"/content/images/x.png"}],"type":"root","version":1}}';
    expect(
      buildPresetFromCapture(source({ lexical: withCard }), { name: 'Card' }).preset.content
        .lexical,
    ).toBe(withCard);
  });

  it('requires a name and derives the id from it', () => {
    expect(() => buildPresetFromCapture(source(), { name: '   ' })).toThrow(/needs a name/);
    const { preset } = buildPresetFromCapture(source(), { name: '  My Review  ' });
    expect(preset.name).toBe('My Review');
    expect(preset.id).toBe('my-review');
  });

  it('uses an explicit id when given one', () => {
    const { preset } = buildPresetFromCapture(source(), { name: 'Named', id: 'explicit-id' });
    expect(preset.id).toBe('explicit-id');
  });
});

describe('isCapturableLexical', () => {
  it('accepts a body with text and rejects a blank paragraph', () => {
    expect(
      isCapturableLexical(
        '{"root":{"children":[{"children":[{"text":"hi","type":"extended-text","version":1}],"type":"paragraph","version":1}],"type":"root","version":1}}',
      ),
    ).toBe(true);
    expect(
      isCapturableLexical(
        '{"root":{"children":[{"children":[],"type":"paragraph"}],"type":"root"}}',
      ),
    ).toBe(false);
    expect(isCapturableLexical('{"root":{"children":[]}}')).toBe(false);
    expect(isCapturableLexical('nope')).toBe(false);
  });
});

describe('normalizeCapturedImageUrl', () => {
  it('turns a same-origin absolute URL into a root-relative path', () => {
    expect(
      normalizeCapturedImageUrl(
        'https://blog.example.com/content/images/a.png',
        'https://blog.example.com',
      ),
    ).toBe('/content/images/a.png');
  });

  it('keeps cross-origin and relative URLs as they are', () => {
    expect(
      normalizeCapturedImageUrl('https://cdn.example.net/a.png', 'https://blog.example.com'),
    ).toBe('https://cdn.example.net/a.png');
    expect(normalizeCapturedImageUrl('/content/images/a.png', 'https://blog.example.com')).toBe(
      '/content/images/a.png',
    );
  });

  it('returns null for empty or missing values', () => {
    expect(normalizeCapturedImageUrl(null, 'https://blog.example.com')).toBeNull();
    expect(normalizeCapturedImageUrl('   ', null)).toBeNull();
  });

  it('keeps a URL that cannot be parsed', () => {
    expect(normalizeCapturedImageUrl('not a url', 'not-an-origin')).toBe('not a url');
  });
});

describe('sourceFromGhostRecord', () => {
  it('reads an API record, including embedded tag objects', () => {
    const captured = sourceFromGhostRecord('post', {
      title: 'From the API',
      custom_excerpt: 'Summary',
      custom_template: 'custom-x.hbs',
      feature_image: '/content/images/x.png',
      lexical: BODY,
      tags: ['Alpha', { name: 'Beta' }, { nope: true }],
    });
    expect(captured).toEqual({
      resourceType: 'post',
      title: 'From the API',
      excerpt: 'Summary',
      customTemplate: 'custom-x.hbs',
      featureImage: '/content/images/x.png',
      lexical: BODY,
      tags: ['Alpha', 'Beta'],
    });
  });

  it('normalizes missing/odd fields to null', () => {
    const captured = sourceFromGhostRecord('page', { title: 42, tags: 'nope' });
    expect(captured).toEqual({
      resourceType: 'page',
      title: null,
      excerpt: null,
      customTemplate: null,
      featureImage: null,
      lexical: null,
      tags: [],
    });
  });
});

describe('describeCapture / defaultImportName', () => {
  it('lists what would be captured', () => {
    expect(describeCapture(source())).toEqual([
      'body',
      'excerpt',
      '2 tags',
      'custom template',
      'feature image',
    ]);
    expect(
      describeCapture(
        source({ tags: ['One'], excerpt: null, customTemplate: null, featureImage: null }),
        { name: '' },
      ),
    ).toEqual(['body', '1 tag']);

    // The feature image is reported unless the import was told to skip it.
    expect(describeCapture(source(), { name: '', includeFeatureImage: false })).not.toContain(
      'feature image',
    );
  });

  it('includes the title only when requested', () => {
    expect(describeCapture(source(), { name: '', includeTitle: true })).toContain('title');
  });

  it('derives a default name from the title, falling back per resource type', () => {
    expect(defaultImportName({ title: 'My post', resourceType: 'post' })).toBe('My post');
    expect(defaultImportName({ title: '(Untitled)', resourceType: 'post' })).toBe('Post template');
    expect(defaultImportName({ title: null, resourceType: 'page' })).toBe('Page template');
  });
});
