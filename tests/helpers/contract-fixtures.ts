export type Resource = 'posts' | 'pages' | 'snippets' | 'themes';

export type GhostFixture = Record<string, unknown>;

export const postFixture = {
  id: 'post-fixture-001',
  uuid: '00000000-0000-4000-8000-000000000001',
  type: 'post',
  status: 'draft',
  title: 'Fixture post',
  custom_excerpt: 'A deterministic post excerpt.',
  custom_template: 'custom-review.hbs',
  lexical: '{"root":{"children":[],"type":"root","version":1}}',
  tags: [{ name: 'Existing' }],
  updated_at: '2026-01-01T00:00:00.000Z',
} as const;

export const pageFixture = {
  id: 'page-fixture-001',
  uuid: '00000000-0000-4000-8000-000000000002',
  type: 'page',
  status: 'draft',
  title: 'Fixture page',
  custom_excerpt: 'A deterministic page excerpt.',
  custom_template: 'custom-landing.hbs',
  lexical: '{"root":{"children":[],"type":"root","version":1}}',
  tags: [],
  updated_at: '2026-01-01T00:00:00.000Z',
} as const;

export const snippetFixture = {
  id: 'snippet-fixture-001',
  name: 'review-snippet',
  lexical: '{"root":{"children":[{"type":"paragraph"}],"type":"root","version":1}}',
  mobiledoc: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as const;

export const themeFixture = {
  id: 'theme-fixture-001',
  name: 'Fixture theme',
  active: true,
  templates: [
    { filename: 'custom-review.hbs', slug: '' },
    { filename: 'custom-landing.hbs', slug: '' },
    { filename: 'default.hbs', slug: 'default' },
  ],
} as const;

export type EditorSnapshot = {
  dirty: boolean;
  bodyChildren: readonly string[];
  title: string;
  custom_excerpt: string;
  custom_template: string | null;
  tags: readonly string[];
};

export const cleanEditorSnapshot: EditorSnapshot = {
  dirty: false,
  bodyChildren: [],
  title: '',
  custom_excerpt: '',
  custom_template: null,
  tags: [],
};

export const dirtyEditorSnapshot: EditorSnapshot = {
  dirty: true,
  bodyChildren: ['paragraph'],
  title: 'Unsaved title',
  custom_excerpt: 'Unsaved excerpt.',
  custom_template: 'custom-review.hbs',
  tags: ['Existing'],
};

export const modePromptCases = [
  { mode: 'replace', hasContent: true, decision: 'apply' },
  { mode: 'only-if-empty', hasContent: false, decision: 'apply' },
  { mode: 'prompt', hasContent: false, decision: 'apply' },
  { mode: 'prompt', hasContent: true, decision: 'cancel' },
] as const;

export const failureResponses = {
  missingSnippet: {
    status: 404,
    body: { errors: [{ type: 'NotFoundError', message: 'Snippet not found.' }] },
  },
  invalidTemplate: {
    status: 422,
    body: {
      errors: [{ type: 'ValidationError', message: 'Unknown custom template.' }],
    },
  },
  nativeSaveFailed: {
    status: 409,
    body: {
      errors: [{ type: 'UpdateCollisionError', message: 'Record changed.' }],
    },
  },
} as const;

export function rootAdminPath(adminPath: string): string {
  return `${normalizePath(adminPath)}api/admin/`;
}

export function subdirectoryAdminPath(adminPath: string): string {
  return rootAdminPath(adminPath);
}

function normalizePath(path: string): string {
  const normalized = `/${path.replace(/^\/+|\/+$/g, '')}/`;
  return normalized.endsWith('/ghost/') ? normalized : `${normalized}ghost/`;
}

export function pluralEnvelope<T extends GhostFixture>(
  resource: Resource,
  fixture: T,
): Partial<Record<Resource, readonly T[]>> {
  return { [resource]: [fixture] };
}
