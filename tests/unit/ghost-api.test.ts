import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GhostAdminClient,
  applyCleanEditorFallback,
  assertApiFallbackAllowed,
  deriveAdminApiBase,
} from '../../src/ghost-api';
import {
  pageFixture,
  postFixture,
  snippetFixture,
  themeFixture,
} from '../helpers/contract-fixtures';

type FetchCall = { input: string; init: RequestInit | undefined };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Fake fetch recording calls and replaying scripted responses in order. */
function makeFetch(responses: Array<Response | Error>): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error('fake-fetch: no scripted response');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('C1 — Admin API base derivation', () => {
  it('derives the root-installation admin API base', () => {
    expect(deriveAdminApiBase('https://example.com/ghost/')).toBe(
      'https://example.com/ghost/api/admin/',
    );
  });

  it('derives a subdirectory installation base', () => {
    expect(deriveAdminApiBase('https://example.com/blog/ghost/')).toBe(
      'https://example.com/blog/ghost/api/admin/',
    );
  });

  it('accepts an admin URL without trailing slash', () => {
    expect(deriveAdminApiBase('https://example.com/blog/ghost')).toBe(
      'https://example.com/blog/ghost/api/admin/',
    );
  });

  it('rejects URLs without a /ghost/ segment', () => {
    expect(() => deriveAdminApiBase('https://example.com/')).toThrow(/\/ghost\//);
  });

  it('rejects non-HTTPS origins', () => {
    expect(() => deriveAdminApiBase('http://example.com/ghost/')).toThrow(/https/i);
  });

  it('rejects a bare origin-only ghost path used as content URL confusion', () => {
    // "/notghost/" must not count as the admin context.
    expect(() => deriveAdminApiBase('https://example.com/notghost/')).toThrow(/\/ghost\//);
  });
});

describe('C1 — plural reads', () => {
  let calls: FetchCall[];
  let client: GhostAdminClient;

  beforeEach(() => {
    const fake = makeFetch([
      jsonResponse(200, { posts: [postFixture], meta: {} }),
      jsonResponse(200, { pages: [pageFixture], meta: {} }),
      jsonResponse(200, { snippets: [snippetFixture], meta: {} }),
      jsonResponse(200, { themes: [themeFixture], meta: {} }),
    ]);
    calls = fake.calls;
    client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
  });

  it('reads posts from the derived browse URL and validates the plural root', async () => {
    const posts = await client.listPosts();
    expect(calls[0]?.input).toBe('https://example.com/ghost/api/admin/posts/');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ id: postFixture.id });
  });

  it('reads pages with the pages resource', async () => {
    const fake = makeFetch([jsonResponse(200, { pages: [pageFixture], meta: {} })]);
    const pagesClient = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
    const pages = await pagesClient.listPages();
    expect(fake.calls[0]?.input).toBe('https://example.com/ghost/api/admin/pages/');
    expect(pages[0]).toMatchObject({ id: pageFixture.id });
  });

  it('rejects a singular response root on read', async () => {
    const bad = makeFetch([jsonResponse(200, { post: [postFixture] })]);
    const singular = new GhostAdminClient(bad.fetch, 'https://example.com/ghost/api/admin/');
    await expect(singular.listPosts()).rejects.toThrow(/plural/i);
  });
});

describe('C1 — plural-envelope mutations', () => {
  it('PUTs a post wrapped in the posts[] envelope with updated_at concurrency data', async () => {
    const updated = {
      ...postFixture,
      custom_excerpt: 'New excerpt.',
      updated_at: '2026-01-02T00:00:00.000Z',
    };
    const fake = makeFetch([jsonResponse(200, { posts: [updated] })]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');

    const result = await client.updatePost({
      id: postFixture.id,
      custom_excerpt: 'New excerpt.',
      updated_at: postFixture.updated_at,
    });

    const call = fake.calls[0];
    expect(call?.input).toBe('https://example.com/ghost/api/admin/posts/' + postFixture.id + '/');
    expect(call?.init?.method).toBe('PUT');
    const body = JSON.parse(String(call?.init?.body));
    expect(Object.keys(body)).toEqual(['posts']);
    expect(body.posts).toHaveLength(1);
    expect(body.posts[0].updated_at).toBe(postFixture.updated_at);
    expect(result.custom_excerpt).toBe('New excerpt.');
  });

  it('PUTs a page wrapped in the pages[] envelope', async () => {
    const fake = makeFetch([jsonResponse(200, { pages: [{ ...pageFixture }] })]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
    await client.updatePage({ id: pageFixture.id, updated_at: pageFixture.updated_at });
    const body = JSON.parse(String(fake.calls[0]?.init?.body));
    expect(Object.keys(body)).toEqual(['pages']);
  });

  it('refuses to mutate without optimistic-concurrency updated_at', async () => {
    const client = new GhostAdminClient(
      makeFetch([]).fetch,
      'https://example.com/ghost/api/admin/',
    );
    await expect(client.updatePost({ id: 'p1', updated_at: '' })).rejects.toThrow(/updated_at/i);
  });

  it('surfaces Ghost error payloads as structured failures', async () => {
    const fake = makeFetch([jsonResponse(409, failureBody())]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
    await expect(
      client.updatePost({ id: 'p1', updated_at: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  function failureBody() {
    return { errors: [{ type: 'UpdateCollisionError', message: 'Record changed.' }] };
  }
});

describe('C6 — themes and snippets lookups', () => {
  it('lists active-theme custom templates as blank-slug filenames including .hbs', async () => {
    const fake = makeFetch([jsonResponse(200, { themes: [themeFixture] })]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
    const templates = await client.getActiveThemeTemplates();
    expect(templates).toEqual(['custom-review.hbs', 'custom-landing.hbs']);
  });

  it('returns no templates when no theme is active', async () => {
    const inactive = { ...themeFixture, active: false };
    const fake = makeFetch([jsonResponse(200, { themes: [inactive] })]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
    await expect(client.getActiveThemeTemplates()).rejects.toThrow(/active theme/i);
  });

  it('finds a snippet by exact local name over a validated plural response', async () => {
    const fake = makeFetch([jsonResponse(200, { snippets: [snippetFixture] })]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
    const snippet = await client.findSnippetByName('review-snippet');
    expect(snippet).toMatchObject({ name: 'review-snippet' });
  });

  it('aborts with a structured miss when the snippet name does not exist', async () => {
    const fake = makeFetch([jsonResponse(200, { snippets: [snippetFixture] })]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
    await expect(client.findSnippetByName('nope')).rejects.toMatchObject({
      code: 'SNIPPET_NOT_FOUND',
    });
  });
});

describe('C7 — clean-editor-only API fallback', () => {
  const base = 'https://example.com/ghost/api/admin/';

  it('forbids the fallback for a dirty open editor', () => {
    expect(() => assertApiFallbackAllowed({ dirty: true, savedResourceId: 'p1' })).toThrow(
      /dirty/i,
    );
  });

  it('forbids the fallback for an unsaved draft without a server id', () => {
    expect(() => assertApiFallbackAllowed({ dirty: false, savedResourceId: null })).toThrow(
      /unsaved/i,
    );
  });

  it('allows the fallback only for a confirmed clean, saved editor', () => {
    expect(() => assertApiFallbackAllowed({ dirty: false, savedResourceId: 'p1' })).not.toThrow();
  });

  it('performs the write and reconciles the returned resource into the live store', async () => {
    const updated = { ...postFixture, custom_excerpt: 'API excerpt.' };
    const fake = makeFetch([jsonResponse(200, { posts: [updated] })]);
    const client = new GhostAdminClient(fake.fetch, base);
    const reconcile = vi.fn();

    const result = await applyCleanEditorFallback({
      client,
      resource: 'posts',
      record: {
        id: postFixture.id,
        custom_excerpt: 'API excerpt.',
        updated_at: postFixture.updated_at,
      },
      liveState: { dirty: false, savedResourceId: postFixture.id },
      reconcile,
    });

    expect(result.custom_excerpt).toBe('API excerpt.');
    expect(reconcile).toHaveBeenCalledWith(updated);
  });

  it('requires reconciliation: refuses to run without a reconcile callback or reload', async () => {
    const client = new GhostAdminClient(makeFetch([]).fetch, base);
    await expect(
      applyCleanEditorFallback({
        client,
        resource: 'posts',
        record: { id: 'p1', updated_at: 'x' },
        liveState: { dirty: false, savedResourceId: 'p1' },
      }),
    ).rejects.toThrow(/reconcil/i);
  });

  it('does not call the API at all when the editor is dirty', async () => {
    const fake = makeFetch([]);
    const client = new GhostAdminClient(fake.fetch, base);
    await expect(
      applyCleanEditorFallback({
        client,
        resource: 'posts',
        record: { id: 'p1', updated_at: 'x' },
        liveState: { dirty: true, savedResourceId: 'p1' },
        reconcile: () => {},
      }),
    ).rejects.toThrow(/dirty/i);
    expect(fake.calls).toHaveLength(0);
  });
});
