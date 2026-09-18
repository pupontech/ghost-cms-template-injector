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

describe('feature image — Ghost admin image upload', () => {
  const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  it('POSTs multipart to images/upload/ and returns the served URL', async () => {
    const fake = makeFetch([
      jsonResponse(201, {
        images: [{ url: 'https://example.com/content/images/2026/09/a.png', ref: null }],
      }),
    ]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');

    const url = await client.uploadImage({ data: BYTES, name: 'a.png', mimeType: 'image/png' });

    expect(url).toBe('https://example.com/content/images/2026/09/a.png');
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.input).toBe('https://example.com/ghost/api/admin/images/upload/');
    expect(call.init?.method).toBe('POST');
    // Same-origin cookie auth, exactly like the reads/writes above.
    expect(call.init?.credentials).toBe('same-origin');
    expect(call.init?.headers).toEqual({ accept: 'application/json' });
    const body = call.init?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const file = body.get('file') as File;
    expect(file.name).toBe('a.png');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(BYTES);
    expect(body.get('purpose')).toBe('image');
  });

  it('surfaces a rejected upload as IMAGE_UPLOAD_FAILED with the Ghost error text', async () => {
    const fake = makeFetch([
      jsonResponse(422, {
        errors: [{ type: 'ValidationError', message: 'The file type is not supported' }],
      }),
    ]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');

    await expect(
      client.uploadImage({ data: BYTES, name: 'a.png', mimeType: 'image/png' }),
    ).rejects.toThrow(/IMAGE_UPLOAD_FAILED.*file type is not supported/s);
  });

  it('rejects a response without an images[] url', async () => {
    const fake = makeFetch([jsonResponse(201, { images: [] })]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
    await expect(
      client.uploadImage({ data: BYTES, name: 'a.png', mimeType: 'image/png' }),
    ).rejects.toThrow(/INVALID_IMAGE_UPLOAD_RESPONSE/);
  });

  it('surfaces transport failures as NETWORK_ERROR and never sends an empty upload', async () => {
    const failing = makeFetch([new Error('offline')]);
    const client = new GhostAdminClient(failing.fetch, 'https://example.com/ghost/api/admin/');
    await expect(
      client.uploadImage({ data: BYTES, name: 'a.png', mimeType: 'image/png' }),
    ).rejects.toThrow(/NETWORK_ERROR/);

    const idle = makeFetch([]);
    const emptyClient = new GhostAdminClient(idle.fetch, 'https://example.com/ghost/api/admin/');
    await expect(
      emptyClient.uploadImage({ data: new Uint8Array(0), name: 'a.png', mimeType: 'image/png' }),
    ).rejects.toThrow(/non-empty bytes/);
    await expect(
      emptyClient.uploadImage({ data: BYTES, name: '  ', mimeType: 'image/png' }),
    ).rejects.toThrow(/file name/);
    expect(idle.calls).toHaveLength(0);
  });

  it('writes feature_image in a plural envelope on the clean-editor fallback', async () => {
    const fake = makeFetch([
      jsonResponse(200, {
        posts: [{ ...postFixture, feature_image: 'https://example.com/content/images/a.png' }],
      }),
    ]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');

    await applyCleanEditorFallback({
      client,
      resource: 'posts',
      record: { id: 'p1', updated_at: 'x', feature_image: '/content/images/a.png' },
      liveState: { dirty: false, savedResourceId: 'p1' },
      reconcile: () => {},
    });

    const body = JSON.parse(String(fake.calls[0]!.init?.body)) as {
      posts: Array<Record<string, unknown>>;
    };
    expect(body.posts[0]?.['feature_image']).toBe('/content/images/a.png');
  });
});

describe('post import — reading existing posts through the Admin API', () => {
  it('lists posts for the import picker with a narrow field set, newest first', async () => {
    const fake = makeFetch([
      jsonResponse(200, {
        posts: [
          { id: 'p1', title: 'First', status: 'published', updated_at: '2026-09-01T00:00:00.000Z' },
          { id: 'p2', title: '   ', status: 'draft', updated_at: '2026-09-02T00:00:00.000Z' },
          { title: 'no id' },
        ],
      }),
    ]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');

    const entries = await client.listCapturableIndex('posts');

    expect(fake.calls[0]!.input).toContain('fields=id,title,slug,status,updated_at');
    expect(fake.calls[0]!.input).toContain('limit=all');
    expect(entries).toEqual([
      { id: 'p1', title: 'First', status: 'published', updatedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'p2', title: '(Untitled)', status: 'draft', updatedAt: '2026-09-02T00:00:00.000Z' },
    ]);
  });

  it('reads one record with the lexical format and the tag relation', async () => {
    const fake = makeFetch([
      jsonResponse(200, {
        pages: [
          {
            ...pageFixture,
            custom_excerpt: 'Summary',
            custom_template: 'custom-x.hbs',
            feature_image: '/content/images/x.png',
            tags: [{ name: 'Alpha' }],
          },
        ],
      }),
    ]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');

    const record = await client.getCapturableRecord('pages', 'page-1');

    expect(fake.calls[0]!.input).toBe(
      'https://example.com/ghost/api/admin/pages/page-1/?formats=lexical&include=tags',
    );
    expect(record?.custom_excerpt).toBe('Summary');
  });

  it('encodes the id and reports a missing record as null', async () => {
    const missing = makeFetch([
      jsonResponse(404, { errors: [{ type: 'NotFoundError', message: 'Resource not found' }] }),
    ]);
    const client = new GhostAdminClient(missing.fetch, 'https://example.com/ghost/api/admin/');

    expect(await client.getCapturableRecord('posts', 'a/b')).toBeNull();
    expect(missing.calls[0]!.input).toContain('posts/a%2Fb/');
  });

  it('rejects an empty id before any request and surfaces other API errors', async () => {
    const fake = makeFetch([]);
    const client = new GhostAdminClient(fake.fetch, 'https://example.com/ghost/api/admin/');
    await expect(client.getCapturableRecord('posts', '  ')).rejects.toThrow(/resource id/);
    expect(fake.calls).toHaveLength(0);

    const failing = makeFetch([jsonResponse(500, { errors: [{ message: 'boom' }] })]);
    const failingClient = new GhostAdminClient(
      failing.fetch,
      'https://example.com/ghost/api/admin/',
    );
    await expect(failingClient.getCapturableRecord('posts', 'p1')).rejects.toThrow(/boom/);
  });
});
