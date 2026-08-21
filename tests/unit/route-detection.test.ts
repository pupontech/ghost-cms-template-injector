import { describe, expect, it } from 'vitest';

import {
  detectEditorUrl,
  detectGhostRoute,
  type EditorRoute,
  type DetectedRoute,
} from '../../src/route-detection';

/**
 * Ghost Admin uses `trailing-hash` location type, so editor routes live in the
 * URL hash (e.g. `#/editor/edit/post/<id>`). The decision document and legacy
 * acceptance tests also use the hash-less form (`/editor/post/<id>`); both are
 * recognised. Path-reading is independent of the tool's own origin.
 */

describe('detectGhostRoute — page classification', () => {
  it('classifies a non-Ghost path as unknown', () => {
    const r = detectGhostRoute('https://example.com/', '');
    expect(r.kind).toBe('unknown');
  });

  it('classifies the posts list', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/posts') as Extract<
      DetectedRoute,
      { kind: 'list' }
    >;
    expect(r.kind).toBe('list');
    expect(r.resourceType).toBe('post');
  });

  it('classifies the pages list', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/pages') as Extract<
      DetectedRoute,
      { kind: 'list' }
    >;
    expect(r.kind).toBe('list');
    expect(r.resourceType).toBe('page');
  });

  it('classifies a non-editor admin screen as unknown', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/settings');
    expect(r.kind).toBe('unknown');
  });

  it('classifies a subdirectory install path', () => {
    const r = detectGhostRoute('https://example.com/blog/ghost/', '#/posts') as Extract<
      DetectedRoute,
      { kind: 'list' }
    >;
    expect(r.kind).toBe('list');
    expect(r.resourceType).toBe('post');
  });
});

describe('detectGhostRoute — editor routes (hash form)', () => {
  it('new post (hash form)', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/new/post');
    expect(r.kind).toBe('editor');
    const e = r as EditorRoute;
    expect(e.resourceType).toBe('post');
    expect(e.savedId).toBeNull();
    expect(e.isNew).toBe(true);
  });

  it('new page (hash form)', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/new/page');
    expect(r.kind).toBe('editor');
    const e = r as EditorRoute;
    expect(e.resourceType).toBe('page');
    expect(e.savedId).toBeNull();
  });

  it('editing a saved post (hash form)', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/edit/post/abc123');
    expect(r.kind).toBe('editor');
    const e = r as EditorRoute;
    expect(e.resourceType).toBe('post');
    expect(e.savedId).toBe('abc123');
    expect(e.isNew).toBe(false);
  });

  it('editing a saved page (hash form)', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/edit/page/pg-9');
    expect(r.kind).toBe('editor');
    const e = r as EditorRoute;
    expect(e.resourceType).toBe('page');
    expect(e.savedId).toBe('pg-9');
  });

  it('subdirectory install editor (hash form)', () => {
    const r = detectGhostRoute('https://example.com/blog/ghost/', '#/editor/new/post');
    expect(r.kind).toBe('editor');
    const e = r as EditorRoute;
    expect(e.resourceType).toBe('post');
    expect(e.savedId).toBeNull();
  });
});

describe('detectGhostRoute — editor routes (legacy/decision-doc form)', () => {
  it('new post (legacy form)', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/post');
    expect(r.kind).toBe('editor');
    const e = r as EditorRoute;
    expect(e.resourceType).toBe('post');
    expect(e.savedId).toBeNull();
    expect(e.isNew).toBe(true);
  });

  it('editing a saved post (legacy form)', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/post/abc123');
    expect(r.kind).toBe('editor');
    const e = r as EditorRoute;
    expect(e.resourceType).toBe('post');
    expect(e.savedId).toBe('abc123');
    expect(e.isNew).toBe(false);
  });

  it('editing a saved page (legacy form)', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/page/pg-9');
    expect(r.kind).toBe('editor');
    const e = r as EditorRoute;
    expect(e.resourceType).toBe('page');
    expect(e.savedId).toBe('pg-9');
  });
});

describe('detectGhostRoute — rejection of invalid routes', () => {
  it('rejects unknown editor resource type', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/new/email');
    expect(r.kind).toBe('unknown');
  });

  it('rejects an editor route with a malformed id segment', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/edit/post/');
    expect(r.kind).toBe('unknown');
  });

  it('rejects a type that is neither post nor page', () => {
    const r = detectGhostRoute('https://example.com/ghost/', '#/editor/edit/tag/x');
    expect(r.kind).toBe('unknown');
  });

  it('rejects a non-hash editor guess made against the path (only hash is read)', () => {
    const r = detectGhostRoute('https://example.com/ghost/editor/post/abc', '');
    expect(r.kind).toBe('unknown');
  });
});

describe('detectEditorUrl — chase active tab + hash change', () => {
  it('returns null when a tab is not found', () => {
    const found = (): { url?: string; hash?: string } | undefined => undefined;
    expect(detectEditorUrl(found, 'tab-1')).toBeNull();
  });

  it('returns null when the active tab URL is not a Ghost admin page', () => {
    const found = () => ({ id: 1, url: 'https://example.com/' });
    expect(detectEditorUrl(found, 'tab-1')).toBeNull();
  });

  it('detects an editor from the active tab hash', () => {
    const found = () => ({
      id: 7,
      url: 'https://example.com/ghost/#/editor/edit/post/zzz',
    });
    const r = detectEditorUrl(found, 'tab-7') as EditorRoute;
    expect(r.kind).toBe('editor');
    expect(r.resourceType).toBe('post');
    expect(r.savedId).toBe('zzz');
  });

  it('treats the last-seen hash as authoritative when the live tab hash is empty', () => {
    const found = () => ({ id: 9, url: 'https://example.com/ghost/' });
    const r = detectEditorUrl(found, 'tab-9', '#/editor/new/page') as EditorRoute;
    expect(r.kind).toBe('editor');
    expect(r.resourceType).toBe('page');
    expect(r.isNew).toBe(true);
  });

  it('prefers the live tab hash over a stale last-seen hash', () => {
    const found = () => ({
      id: 11,
      url: 'https://example.com/ghost/#/editor/edit/post/live',
    });
    const r = detectEditorUrl(found, 'tab-11', '#/editor/new/post') as EditorRoute;
    expect(r.savedId).toBe('live');
  });

  it('classifies a list screen from the active tab hash', () => {
    const found = () => ({ id: 13, url: 'https://example.com/ghost/#/pages' });
    const r = detectEditorUrl(found, 'tab-13') as DetectedRoute;
    expect(r.kind).toBe('list');
  });
});
