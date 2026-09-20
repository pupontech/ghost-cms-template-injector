/**
 * Phase-3 Ghost Admin API client (Contracts C1/C6/C7).
 *
 * Cookie-authenticated, same-origin Admin REST access only: no API keys, no
 * secrets, no bridge/UI code. The base URL is derived from an authenticated
 * admin URL containing `/ghost/` (C1); reads validate plural resource roots;
 * mutations use exactly one plural envelope with optimistic-concurrency
 * `updated_at`. Theme/snippet dependency lookups follow C6. The clean-editor
 * API-only fallback (C7) refuses dirty or unsaved editors and requires
 * reconciliation of the returned resource before editing resumes.
 */

/** Resources this client may touch (C1/C6). */
export type ApiResource = 'posts' | 'pages' | 'snippets' | 'themes' | 'images';

export interface GhostTagRef {
  name?: string;
}

/** Minimal shape of a post/page record this client reads or writes. */
export interface GhostPostRecord {
  id?: string;
  uuid?: string;
  title?: string;
  custom_excerpt?: string;
  custom_template?: string | null;
  lexical?: string;
  mobiledoc?: string | null;
  tags?: readonly (string | GhostTagRef)[];
  updated_at?: string;
  [key: string]: unknown;
}

export interface GhostSnippetRecord {
  id?: string;
  name?: string;
  lexical?: string;
  [key: string]: unknown;
}

export interface GhostThemeRecord {
  id?: string;
  name?: string;
  active?: boolean;
  templates?: readonly { filename?: string; slug?: string }[];
  [key: string]: unknown;
}

/** Structured failure carrying the HTTP status and Ghost error payload. */
export class GhostApiError extends Error {
  readonly status: number;
  readonly errors: readonly { type?: string; message?: string }[];
  readonly code: string;

  constructor(
    code: string,
    status: number,
    errors: readonly { type?: string; message?: string }[],
  ) {
    const detail = errors.map((e) => e.message ?? e.type ?? 'unknown error').join('; ');
    super(`ghost-api: ${code} (${status}): ${detail}`);
    this.name = 'GhostApiError';
    this.code = code;
    this.status = status;
    this.errors = errors;
  }
}

/**
 * Derive `<origin><subdir>/ghost/api/admin/` from an authenticated admin URL
 * containing exactly one usable `/ghost/` segment (C1). Never defaults to
 * root; rejects non-HTTPS origins.
 */
export function deriveAdminApiBase(adminUrl: string): string {
  let url: URL;
  try {
    url = new URL(adminUrl);
  } catch {
    throw new TypeError('ghost-api: invalid admin URL');
  }
  if (url.protocol !== 'https:') {
    throw new TypeError('ghost-api: admin URL must be HTTPS');
  }

  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  const ghostIndex = segments.indexOf('ghost');
  if (ghostIndex === -1 || segments.lastIndexOf('ghost') !== ghostIndex) {
    throw new TypeError('ghost-api: admin URL must contain exactly one /ghost/ path segment');
  }

  const subdir = segments.slice(0, ghostIndex);
  return `${url.origin}/${[...subdir, 'ghost', 'api', 'admin'].join('/')}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a plural response root and return its resource array (C1). */
function extractPlural<T>(resource: ApiResource, body: unknown): T[] {
  if (!isRecord(body)) {
    throw new GhostApiError('INVALID_RESPONSE', 0, [
      { message: `expected a JSON object for ${resource}` },
    ]);
  }
  const value = body[resource];
  if (!Array.isArray(value)) {
    throw new GhostApiError('INVALID_RESPONSE', 0, [
      { message: `expected plural "${resource}[]" envelope, got ${typeof value}` },
    ]);
  }
  return value as T[];
}

async function parseError(status: number, body: unknown): Promise<GhostApiError> {
  const errors =
    isRecord(body) && Array.isArray(body['errors'])
      ? (body['errors'] as { type?: string; message?: string }[])
      : [{ message: 'unrecognized error payload' }];
  return new GhostApiError('GHOST_ERROR', status, errors);
}

export interface UpdateInput {
  id: string;
  updated_at: string;
  title?: string;
  custom_excerpt?: string;
  custom_template?: string | null;
  lexical?: string;
  tags?: readonly string[];
  /** Absolute or Ghost-root-relative feature image URL. */
  feature_image?: string | null;
}

/** One image handed to Ghost's admin upload endpoint. */
export interface ImageUploadInput {
  data: Uint8Array;
  name: string;
  mimeType: string;
}

export interface CleanEditorLiveState {
  /** True when the open editor has any unsaved local change (C7). */
  dirty: boolean;
  /** Server id of the record behind the editor; null while unsaved. */
  savedResourceId: string | null;
}

export type ReconcileFn = (record: GhostPostRecord) => void;

const RESOURCE_TYPES: Readonly<Record<'posts' | 'pages', string>> = {
  posts: 'post',
  pages: 'page',
};

export class GhostAdminClient {
  readonly #fetch: typeof fetch;
  readonly #base: string;

  constructor(fetchImpl: typeof fetch, adminApiBase: string) {
    if (!adminApiBase.endsWith('/')) throw new TypeError('ghost-api: base must end with "/"');
    this.#fetch = fetchImpl;
    this.#base = adminApiBase;
  }

  async #request(resource: ApiResource, path = ''): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${resource}/${path}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      });
    } catch (cause) {
      throw new GhostApiError('NETWORK_ERROR', 0, [
        { message: cause instanceof Error ? cause.message : String(cause) },
      ]);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw await parseError(response.status, body);
    return body;
  }

  async listPosts(): Promise<GhostPostRecord[]> {
    return extractPlural<GhostPostRecord>('posts', await this.#request('posts'));
  }

  async listPages(): Promise<GhostPostRecord[]> {
    return extractPlural<GhostPostRecord>('pages', await this.#request('pages'));
  }

  /**
   * Active-theme custom template filenames: templates of the active themes[]
   * entry whose slug is blank, full filename including `.hbs` (C6).
   */
  async getActiveThemeTemplates(): Promise<string[]> {
    const body = await this.#request('themes');
    const themes = extractPlural<GhostThemeRecord>('themes', body);
    const active = themes.filter((t) => t.active === true);
    if (active.length === 0) {
      throw new GhostApiError('NO_ACTIVE_THEME', 0, [
        { message: 'no active theme in themes[] response' },
      ]);
    }
    const filenames: string[] = [];
    for (const theme of active) {
      for (const template of theme.templates ?? []) {
        // Blank slug marks a custom template; partials/regular files are excluded.
        if ((template.slug ?? '').length === 0 && typeof template.filename === 'string') {
          filenames.push(template.filename);
        }
      }
    }
    return filenames;
  }

  /** Exact local-name snippet lookup over a validated plural snippets[] (C6). */
  async findSnippetByName(name: string): Promise<GhostSnippetRecord> {
    const body = await this.#request('snippets', '?limit=all&formats=lexical');
    const snippets = extractPlural<GhostSnippetRecord>('snippets', body);
    const match = snippets.find((s) => s.name === name);
    if (!match) {
      throw new GhostApiError('SNIPPET_NOT_FOUND', 404, [
        { message: `snippet "${name}" not found` },
      ]);
    }
    return match;
  }

  /**
   * Resolve a snippet's serialized Lexical body by exact name — used to supply
   * a `body` action value for `content.source: ghost-snippet` presets. The
   * matcher runs locally over the validated plural `snippets[]` response; no
   * NQL filter is constructed from preset text.
   */
  async getSnippetLexical(name: string): Promise<string> {
    const snippet = await this.findSnippetByName(name);
    if (typeof snippet.lexical !== 'string') {
      throw new GhostApiError('SNIPPET_NO_LEXICAL', 0, [
        { message: `snippet "${name}" has no lexical body` },
      ]);
    }
    return snippet.lexical;
  }

  async listSnippets(): Promise<GhostSnippetRecord[]> {
    return extractPlural<GhostSnippetRecord>(
      'snippets',
      await this.#request('snippets', '?limit=all&formats=lexical'),
    );
  }

  /**
   * Lightweight index of posts/pages for the "import an existing post" picker:
   * ids, titles and timestamps only. Never used for writes.
   */
  async listCapturableIndex(
    resource: 'posts' | 'pages',
  ): Promise<Array<{ id: string; title: string; status: string; updatedAt: string | null }>> {
    const body = await this.#request(
      resource,
      '?limit=all&fields=id,title,slug,status,updated_at&order=updated_at%20desc',
    );
    return extractPlural<GhostPostRecord>(resource, body)
      .filter((record): record is GhostPostRecord & { id: string } => typeof record.id === 'string')
      .map((record) => ({
        id: record.id,
        title:
          typeof record.title === 'string' && record.title.trim().length > 0
            ? record.title
            : '(Untitled)',
        status: typeof record.status === 'string' ? record.status : 'unknown',
        updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
      }));
  }

  /**
   * Full record for one post/page, with the formats an import needs: serialized
   * Lexical body and the tag relation. Returns null when the id does not exist
   * (Ghost answers 404), so callers can report "not found" without guessing.
   */
  async getCapturableRecord(
    resource: 'posts' | 'pages',
    id: string,
  ): Promise<GhostPostRecord | null> {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new TypeError('ghost-api: a resource id is required');
    }
    let body: unknown;
    try {
      body = await this.#request(
        resource,
        `${encodeURIComponent(id)}/?formats=lexical&include=tags`,
      );
    } catch (err) {
      if (err instanceof GhostApiError && err.status === 404) return null;
      throw err;
    }
    const records = extractPlural<GhostPostRecord>(resource, body);
    return records[0] ?? null;
  }

  /**
   * Upload one image through Ghost's own admin image endpoint
   * (`POST <admin>/images/upload/`, multipart, cookie-authenticated) and
   * return the URL Ghost now serves it from.
   *
   * This is exactly the request Ghost Admin's own uploader makes
   * (`gh-uploader.js`: `apiRoot + 'images/upload/'`, param `file`,
   * `purpose=image`), so the media lands in the site's normal image storage
   * with the usual path (`/content/images/<year>/<month>/<name>`).
   */
  async uploadImage(input: ImageUploadInput): Promise<string> {
    if (!input || !(input.data instanceof Uint8Array) || input.data.byteLength === 0) {
      throw new TypeError('ghost-api: image upload requires non-empty bytes');
    }
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new TypeError('ghost-api: image upload requires a file name');
    }
    const form = new FormData();
    // Copy into a fresh ArrayBuffer-backed view so the Blob part is well typed
    // and cannot alias a buffer the caller keeps mutating.
    const bytes = new Uint8Array(input.data);
    form.append('file', new Blob([bytes], { type: input.mimeType }), input.name);
    form.append('purpose', 'image');

    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}images/upload/`, {
        method: 'POST',
        // Same-origin: the Admin session cookie rides along, exactly like the
        // reads/writes above. No Authorization header, no stored secret.
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        body: form,
      });
    } catch (cause) {
      throw new GhostApiError('NETWORK_ERROR', 0, [
        { message: cause instanceof Error ? cause.message : String(cause) },
      ]);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const errors =
        isRecord(body) && Array.isArray(body['errors'])
          ? (body['errors'] as { type?: string; message?: string }[])
          : [{ message: 'image upload rejected' }];
      throw new GhostApiError('IMAGE_UPLOAD_FAILED', response.status, errors);
    }
    const images = isRecord(body) ? body['images'] : undefined;
    const first = Array.isArray(images)
      ? (images[0] as Record<string, unknown> | undefined)
      : undefined;
    const url = first?.['url'];
    if (typeof url !== 'string' || url.trim().length === 0) {
      throw new GhostApiError('INVALID_IMAGE_UPLOAD_RESPONSE', response.status, [
        { message: 'expected an images[] envelope carrying a url' },
      ]);
    }
    return url;
  }

  async #update(resource: 'posts' | 'pages', input: UpdateInput): Promise<GhostPostRecord> {
    if (!input.updated_at) {
      throw new TypeError('ghost-api: mutation requires optimistic-concurrency updated_at');
    }
    const payload: Record<string, unknown> = {
      id: input.id,
      updated_at: input.updated_at,
    };
    if (input.title !== undefined) payload['title'] = input.title;
    if (input.custom_excerpt !== undefined) payload['custom_excerpt'] = input.custom_excerpt;
    if (input.custom_template !== undefined) payload['custom_template'] = input.custom_template;
    if (input.lexical !== undefined) payload['lexical'] = input.lexical;
    if (input.tags !== undefined) payload['tags'] = input.tags;
    if (input.feature_image !== undefined) payload['feature_image'] = input.feature_image;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${resource}/${encodeURIComponent(input.id)}/`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        // Exactly one plural envelope matching the resource (C1).
        body: JSON.stringify({ [resource]: [payload] }),
      });
    } catch (cause) {
      throw new GhostApiError('NETWORK_ERROR', 0, [
        { message: cause instanceof Error ? cause.message : String(cause) },
      ]);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw await parseError(response.status, body);
    const records = extractPlural<GhostPostRecord>(resource, body);
    const record = records[0];
    if (!record) {
      throw new GhostApiError('INVALID_RESPONSE', response.status, [
        { message: `${resource}[] update returned no records` },
      ]);
    }
    return record;
  }

  updatePost(input: UpdateInput): Promise<GhostPostRecord> {
    return this.#update('posts', input);
  }

  updatePage(input: UpdateInput): Promise<GhostPostRecord> {
    return this.#update('pages', input);
  }
}

/**
 * C7 gate: the API-only fallback is allowed only for a confirmed clean,
 * saved editor. Dirty editors and unsaved drafts (no server id) are refused.
 */
export function assertApiFallbackAllowed(liveState: CleanEditorLiveState): void {
  if (liveState.dirty) {
    throw new GhostApiError('DIRTY_EDITOR', 0, [
      { message: 'API-only write forbidden: the open editor is dirty' },
    ]);
  }
  if (liveState.savedResourceId === null) {
    throw new GhostApiError('UNSAVED_DRAFT', 0, [
      { message: 'API-only write forbidden: draft is unsaved and has no server id' },
    ]);
  }
}

export interface CleanEditorFallbackInput {
  client: GhostAdminClient;
  resource: 'posts' | 'pages';
  record: UpdateInput & { lexical?: string };
  liveState: CleanEditorLiveState;
  /** Reconcile the returned resource into the live Ember store (C7). */
  reconcile?: ReconcileFn;
}

/**
 * C7 clean-editor fallback: gate on live state, perform one plural-envelope
 * PUT, then reconcile the returned resource into the live store so a
 * subsequent edit/autosave cannot revert preset fields.
 */
export async function applyCleanEditorFallback(
  input: CleanEditorFallbackInput,
): Promise<GhostPostRecord> {
  assertApiFallbackAllowed(input.liveState);

  if (typeof input.reconcile !== 'function') {
    throw new GhostApiError('RECONCILIATION_REQUIRED', 0, [
      { message: 'reconciliation callback or controlled reload required before editing resumes' },
    ]);
  }

  const resourceType = RESOURCE_TYPES[input.resource];
  const payload: UpdateInput = { ...input.record };
  if (resourceType && !payload.id) {
    throw new TypeError('ghost-api: fallback requires a saved resource id');
  }

  const updated =
    input.resource === 'posts'
      ? await input.client.updatePost(payload)
      : await input.client.updatePage(payload);

  input.reconcile(updated);
  return updated;
}
