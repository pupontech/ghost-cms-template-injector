/**
 * Phase-2 preset schema and validator (Contracts C5/C6).
 *
 * Pure validation only: no storage, planner, UI, API, or bridge. Every preset
 * is versioned, has a unique id, carries an explicit body mode
 * (replace | only-if-empty | prompt — never append/merge), a validated body
 * source (ghost-snippet | inline-html | inline-text | inline-lexical), and explicitly
 * validated metadata modes. Imports are size-bounded and fail closed.
 */

import { plainTextToLexical } from './plain-text-lexical';

export const PRESET_SCHEMA_VERSION = 1;

/** Import size limit for serialized preset collections (C5). */
export const MAX_IMPORT_BYTES = 256 * 1024;

const BODY_MODES = ['replace', 'only-if-empty', 'prompt'] as const;
export type BodyMode = (typeof BODY_MODES)[number];

const TAG_MODES = ['replace', 'merge', 'only-if-empty', 'prompt'] as const;
export type TagMode = (typeof TAG_MODES)[number];

const METADATA_MODES = ['replace', 'only-if-empty', 'prompt'] as const;

const BODY_SOURCES = ['ghost-snippet', 'inline-html', 'inline-text', 'inline-lexical'] as const;
export type BodySource = (typeof BODY_SOURCES)[number];

/** Ghost's accepted custom_excerpt bound (C6). */
const EXCERPT_MAX = 300;

export interface BodyContent {
  source: BodySource;
  mode: BodyMode;
  snippet?: string;
  html?: string;
  text?: string;
  lexical?: string;
}

/**
 * Minimum structural contract accepted by Ghost's Lexical serializer. This is
 * deliberately not a hand-written HTML converter or a full node-schema clone:
 * it only proves that a value is serialized Lexical JSON with a root node and
 * node-shaped children. Ghost itself remains authoritative for node details.
 */
export function isSerializedLexical(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return false;
    const root = parsed['root'];
    if (!isRecord(root) || root['type'] !== 'root' || typeof root['version'] !== 'number') {
      return false;
    }
    const rootChildren = root['children'];
    if (!Array.isArray(rootChildren)) return false;

    // Iterative traversal avoids stack overflows on hostile/deep imported JSON.
    const pending: unknown[] = [...rootChildren];
    let visited = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      visited += 1;
      if (
        visited > 10000 ||
        !isRecord(node) ||
        typeof node['type'] !== 'string' ||
        typeof node['version'] !== 'number'
      )
        return false;
      const children = node['children'];
      if (children !== undefined) {
        if (!Array.isArray(children)) return false;
        pending.push(...children);
      }
    }
    return true;
  } catch {
    return false;
  }
}

export interface ExcerptField {
  mode: (typeof METADATA_MODES)[number];
  value: string;
}

export interface CustomTemplateField {
  mode: (typeof METADATA_MODES)[number];
  /** Full active-theme filename, including `.hbs` (C6). */
  value: string;
}

export interface TagsField {
  mode: TagMode;
  values: string[];
}

export interface PresetMetadata {
  excerpt?: ExcerptField;
  customTemplate?: CustomTemplateField;
  tags?: TagsField;
}

export interface PresetUi {
  icon?: string;
  group?: string;
}

export interface Preset {
  schemaVersion: number;
  id: string;
  name: string;
  description?: string;
  content: BodyContent;
  metadata?: PresetMetadata;
  ui?: PresetUi;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(field: string, reason: string): never {
  throw new TypeError(`preset-schema: invalid ${field}: ${reason}`);
}

function requireString(obj: Record<string, unknown>, field: string, what: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    fail(field, `${what} must be a non-empty string`);
  }
  return value;
}

function validateContent(raw: unknown): BodyContent {
  if (!isRecord(raw)) fail('content', 'must be an object');

  const source = raw['source'];
  if (typeof source !== 'string' || !(BODY_SOURCES as readonly string[]).includes(source)) {
    fail('content.source', `must be one of ${BODY_SOURCES.join(', ')}`);
  }

  const mode = raw['mode'];
  if (typeof mode !== 'string' || !(BODY_MODES as readonly string[]).includes(mode)) {
    fail('content.mode', `must be one of ${BODY_MODES.join(', ')} (append/merge are forbidden)`);
  }

  const content: BodyContent = {
    source: source as BodySource,
    mode: mode as BodyMode,
  };

  if (source === 'ghost-snippet') {
    content.snippet = requireString(raw, 'snippet', 'snippet name');
    if ('html' in raw || 'lexical' in raw) {
      fail('content', 'ghost-snippet source must not carry inline html/lexical fields');
    }
  } else if (source === 'inline-html') {
    content.html = requireString(raw, 'html', 'html payload');
  } else if (source === 'inline-text') {
    content.text = requireString(raw, 'text', 'plain text template');
    if ('html' in raw || 'lexical' in raw) {
      fail('content', 'inline-text source must not carry html/lexical fields');
    }
    try {
      plainTextToLexical(content.text);
    } catch (error) {
      fail('content.text', error instanceof Error ? error.message : 'must be non-empty plain text');
    }
  } else {
    const lexical = requireString(raw, 'lexical', 'lexical payload');
    if (!isSerializedLexical(lexical)) {
      fail('content.lexical', 'must be structurally valid serialized Lexical with a root node');
    }
    content.lexical = lexical;
  }

  return content;
}

function validateExcerpt(raw: Record<string, unknown>): ExcerptField {
  const mode = raw['mode'];
  if (typeof mode !== 'string' || !(METADATA_MODES as readonly string[]).includes(mode)) {
    fail('metadata.excerpt.mode', `must be one of ${METADATA_MODES.join(', ')}`);
  }
  const value = raw['value'];
  if (typeof value !== 'string') fail('metadata.excerpt.value', 'must be a string');
  if (value.length > EXCERPT_MAX) {
    fail('metadata.excerpt.value', `exceeds Ghost limit of ${EXCERPT_MAX} characters`);
  }
  return { mode: mode as ExcerptField['mode'], value };
}

function validateCustomTemplate(raw: Record<string, unknown>): CustomTemplateField {
  const mode = raw['mode'];
  if (typeof mode !== 'string' || !(METADATA_MODES as readonly string[]).includes(mode)) {
    fail('metadata.customTemplate.mode', `must be one of ${METADATA_MODES.join(', ')}`);
  }
  const value = requireString(raw, 'value', 'custom template filename');
  if (!value.endsWith('.hbs')) {
    fail(
      'metadata.customTemplate.value',
      'must be a full theme template filename including .hbs (C6)',
    );
  }
  return { mode: mode as CustomTemplateField['mode'], value };
}

function validateTags(raw: Record<string, unknown>): TagsField {
  const mode = raw['mode'];
  if (typeof mode !== 'string' || !(TAG_MODES as readonly string[]).includes(mode)) {
    fail('metadata.tags.mode', `must be one of ${TAG_MODES.join(', ')}`);
  }
  const values = raw['values'];
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((v) => typeof v !== 'string' || v.trim().length === 0)
  ) {
    fail('metadata.tags.values', 'must be a non-empty array of non-empty strings');
  }
  return { mode: mode as TagMode, values: values as string[] };
}

function validateMetadata(raw: unknown): PresetMetadata {
  if (!isRecord(raw)) fail('metadata', 'must be an object');

  const metadata: PresetMetadata = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (!isRecord(value)) fail(`metadata.${key}`, 'must be an object with a mode');
    if (key === 'excerpt') {
      metadata.excerpt = validateExcerpt(value);
    } else if (key === 'customTemplate') {
      metadata.customTemplate = validateCustomTemplate(value);
    } else if (key === 'tags') {
      metadata.tags = validateTags(value);
    } else {
      fail('metadata', `unknown field "${key}" (fail closed)`);
    }
  }
  return metadata;
}

function validateUi(raw: unknown): PresetUi {
  if (!isRecord(raw)) fail('ui', 'must be an object');
  const ui: PresetUi = {};
  if ('icon' in raw) {
    const icon = raw['icon'];
    if (typeof icon !== 'string') fail('ui.icon', 'must be a string');
    ui.icon = icon;
  }
  if ('group' in raw) {
    ui.group = requireString(raw, 'group', 'ui group');
  }
  return ui;
}

/** Validate one untrusted preset object. Throws TypeError on any violation. */
export function validatePreset(input: unknown): Preset {
  if (!isRecord(input)) fail('preset', 'must be an object');

  const schemaVersion = input['schemaVersion'];
  if (schemaVersion !== PRESET_SCHEMA_VERSION) {
    fail('schemaVersion', `must be ${PRESET_SCHEMA_VERSION}`);
  }

  const id = requireString(input, 'id', 'preset id');
  if (!/^[a-z0-9-]+$/.test(id)) {
    fail('id', 'must be a lowercase slug of [a-z0-9-]');
  }

  const name = requireString(input, 'name', 'display name');
  const content = validateContent(input['content']);

  const preset: Preset = { schemaVersion, id, name, content };
  if ('description' in input) {
    const description = input['description'];
    if (typeof description !== 'string') fail('description', 'must be a string');
    preset.description = description;
  }
  if ('metadata' in input) preset.metadata = validateMetadata(input['metadata']);
  if ('ui' in input) preset.ui = validateUi(input['ui']);

  return preset;
}

/**
 * Validate a collection of presets, enforcing unique ids across the set (C5).
 */
export function validatePresets(input: unknown[]): Preset[] {
  const seen = new Set<string>();
  return input.map((raw) => {
    const preset = validatePreset(raw);
    if (seen.has(preset.id)) {
      fail('id', `duplicate preset id "${preset.id}" — ids must be unique`);
    }
    seen.add(preset.id);
    return preset;
  });
}

/**
 * Enforce the C5 import size limit on a serialized payload.
 * Returns true when the payload fits; throws when it exceeds the bound.
 */
export function validateImportSize(serialized: string): boolean {
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_IMPORT_BYTES) {
    throw new RangeError(`preset-schema: import too large (${bytes} > ${MAX_IMPORT_BYTES} bytes)`);
  }
  return true;
}
