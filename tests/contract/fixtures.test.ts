import { describe, expect, it } from 'vitest';
import {
  cleanEditorSnapshot,
  dirtyEditorSnapshot,
  failureResponses,
  modePromptCases,
  pageFixture,
  pluralEnvelope,
  postFixture,
  rootAdminPath,
  snippetFixture,
  subdirectoryAdminPath,
  themeFixture,
} from '../helpers/contract-fixtures';

describe('Ghost contract fixtures', () => {
  it('provides stable post and page records with Ghost field names', () => {
    expect(postFixture).toMatchObject({
      id: 'post-fixture-001',
      type: 'post',
      custom_excerpt: 'A deterministic post excerpt.',
      custom_template: 'custom-review.hbs',
      tags: [{ name: 'Existing' }],
      lexical: expect.any(String),
    });
    expect(pageFixture).toMatchObject({
      id: 'page-fixture-001',
      type: 'page',
      custom_template: 'custom-landing.hbs',
    });
  });

  it('provides content-only snippets and active-theme templates', () => {
    expect(snippetFixture).toMatchObject({
      name: 'review-snippet',
      lexical: expect.any(String),
    });
    expect(snippetFixture).not.toHaveProperty('tags');
    expect(themeFixture).toMatchObject({
      active: true,
      templates: expect.arrayContaining([
        { filename: 'custom-review.hbs', slug: '' },
        { filename: 'custom-landing.hbs', slug: '' },
      ]),
    });
  });

  it('derives root and subdirectory Admin API paths', () => {
    expect(rootAdminPath('/ghost/')).toBe('/ghost/api/admin/');
    expect(subdirectoryAdminPath('/magazine/ghost/')).toBe('/magazine/ghost/api/admin/');
  });

  it('models plural browse and mutation envelopes', () => {
    expect(pluralEnvelope('posts', postFixture)).toEqual({ posts: [postFixture] });
    expect(pluralEnvelope('pages', pageFixture)).toEqual({ pages: [pageFixture] });
    expect(pluralEnvelope('snippets', snippetFixture)).toEqual({
      snippets: [snippetFixture],
    });
    expect(pluralEnvelope('themes', themeFixture)).toEqual({
      themes: [themeFixture],
    });
  });

  it('distinguishes clean and dirty live editor snapshots', () => {
    expect(cleanEditorSnapshot.dirty).toBe(false);
    expect(cleanEditorSnapshot.bodyChildren).toHaveLength(0);
    expect(dirtyEditorSnapshot.dirty).toBe(true);
    expect(dirtyEditorSnapshot.bodyChildren).toHaveLength(1);
    expect(dirtyEditorSnapshot.custom_excerpt).toBe('Unsaved excerpt.');
  });

  it('covers prompt decisions without performing mutations', () => {
    expect(modePromptCases).toEqual([
      { mode: 'replace', hasContent: true, decision: 'apply' },
      { mode: 'only-if-empty', hasContent: false, decision: 'apply' },
      { mode: 'prompt', hasContent: false, decision: 'apply' },
      { mode: 'prompt', hasContent: true, decision: 'cancel' },
    ]);
  });

  it('provides deterministic failure responses for contract tests', () => {
    expect(failureResponses.missingSnippet).toMatchObject({
      status: 404,
      body: { errors: [{ type: 'NotFoundError' }] },
    });
    expect(failureResponses.invalidTemplate).toMatchObject({
      status: 422,
      body: { errors: [{ type: 'ValidationError' }] },
    });
    expect(failureResponses.nativeSaveFailed).toMatchObject({
      status: 409,
      body: { errors: [{ type: 'UpdateCollisionError' }] },
    });
  });
});
