/**
 * "Import a Ghost post as a preset" — pure capture logic.
 *
 * A preset is built from an EXISTING Ghost post/page: its Lexical body plus the
 * metadata worth templating (excerpt, tags, custom template, feature image).
 * The caller supplies a `CapturedSource` produced either from the open editor's
 * live record (MAIN-world bridge snapshot) or from the Admin API, so this
 * module stays free of storage, API, bridge, and DOM concerns.
 *
 * DEFAULT POSTURE — capture must be safe to re-apply:
 *   - the body is captured as `inline-lexical` in `replace` mode (that is the
 *     template);
 *   - the TITLE is NOT captured unless explicitly asked for — a title belongs to
 *     the post you are writing, not to a template;
 *   - excerpt, custom template, and feature image default to `only-if-empty`, so
 *     importing a post never silently overwrites text or an image the owner
 *     already put on the target post;
 *   - tags default to `merge`.
 *
 * Everything is validated with the real preset schema before it is returned, and
 * any loss (a trimmed excerpt, a dropped non-`.hbs` template) is reported as a
 * warning rather than applied silently.
 */

import {
  PRESET_SCHEMA_VERSION,
  isAcceptableImageUrl,
  isSerializedLexical,
  validatePreset,
  type BodyMode,
  type Preset,
  type TagMode,
} from './preset-schema';
import { deriveIdFromName } from './preset-naming';

/** Ghost's `custom_excerpt` display bound enforced by the preset schema. */
const EXCERPT_MAX = 300;

/** Fields read off a post/page to build a preset. */
export interface CapturedSource {
  resourceType: 'post' | 'page';
  /** Live/post title, or null when unset. */
  title: string | null;
  excerpt: string | null;
  /** Tag display names, in post order. */
  tags: readonly string[];
  /** Full active-theme template filename including `.hbs`, when set. */
  customTemplate: string | null;
  /** Feature image URL exactly as stored (absolute or root-relative). */
  featureImage: string | null;
  /** Serialized Lexical body. */
  lexical: string | null;
}

export interface CaptureOptions {
  /** Preset display name (required, non-empty). */
  name: string;
  /** Explicit id; defaults to a slug of `name`. */
  id?: string;
  /** Capture the post title too (default false — titles are per-post). */
  includeTitle?: boolean;
  /** Capture the feature image (default true, `only-if-empty`). */
  includeFeatureImage?: boolean;
  bodyMode?: BodyMode;
  excerptMode?: 'replace' | 'only-if-empty' | 'prompt';
  tagMode?: TagMode;
  customTemplateMode?: 'replace' | 'only-if-empty' | 'prompt';
  featureImageMode?: 'replace' | 'only-if-empty' | 'prompt';
  /** Provenance label; defaults to the captured title. */
  description?: string;
}

export interface CaptureResult {
  preset: Preset;
  /** Lossy-but-safe adjustments the caller should surface to the owner. */
  warnings: string[];
}

/**
 * A body worth templating: a serialized Lexical document that actually carries
 * content.
 *
 * `isSerializedLexical` alone is not enough — a blank Ghost draft serializes to
 * a valid document holding a single empty paragraph, and capturing that would
 * build a preset whose `replace` body mode wipes the body of every post it is
 * applied to. A body counts as content when any root child has children of its
 * own (text runs, cards, images) or is a non-paragraph node.
 */
export function isCapturableLexical(lexical: string): boolean {
  if (!isSerializedLexical(lexical)) return false;
  let rootChildren: unknown[];
  try {
    const doc = JSON.parse(lexical) as { root?: { children?: unknown } };
    const children = doc?.root?.children;
    rootChildren = Array.isArray(children) ? children : [];
  } catch {
    return false;
  }
  return rootChildren.some((child) => {
    if (!child || typeof child !== 'object') return false;
    const node = child as { type?: unknown; children?: unknown };
    if (Array.isArray(node.children) && node.children.length > 0) return true;
    // A childless non-paragraph node is a card/atom (image, embed, divider…).
    return typeof node.type === 'string' && node.type !== 'paragraph';
  });
}

/** Normalize a captured image URL: same-origin absolute -> portable `/content/…`. */
export function normalizeCapturedImageUrl(
  url: string | null,
  origin: string | null,
): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/')) return trimmed;
  if (origin) {
    try {
      const parsed = new URL(trimmed);
      const site = new URL(origin);
      if (parsed.origin === site.origin) return `${parsed.pathname}${parsed.search}`;
    } catch {
      /* fall through and keep the absolute URL */
    }
  }
  return trimmed;
}

/** Accept only titles a preset can carry (`(Untitled)` is Ghost's placeholder). */
function capturedTitle(title: string | null): string | null {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed === '(Untitled)') return null;
  return trimmed;
}

function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Default preset name for a captured post/page (shared by every surface). */
export function defaultImportName(source: {
  title: string | null;
  resourceType: 'post' | 'page';
}): string {
  const title = (source.title ?? '').trim();
  if (title.length > 0 && title !== '(Untitled)') return title;
  return source.resourceType === 'page' ? 'Page template' : 'Post template';
}

/**
 * Map a Ghost Admin API post/page record onto a capture source. Tags arrive
 * either as names or as embedded `{name}` objects; both shapes are accepted.
 */
export function sourceFromGhostRecord(
  resourceType: 'post' | 'page',
  record: {
    title?: unknown;
    custom_excerpt?: unknown;
    custom_template?: unknown;
    feature_image?: unknown;
    lexical?: unknown;
    tags?: unknown;
  },
): CapturedSource {
  const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  const tags: string[] = [];
  if (Array.isArray(record.tags)) {
    for (const tag of record.tags) {
      if (typeof tag === 'string') tags.push(tag);
      else if (typeof tag === 'object' && tag !== null) {
        const name = (tag as { name?: unknown }).name;
        if (typeof name === 'string') tags.push(name);
      }
    }
  }
  return {
    resourceType,
    title: asString(record.title),
    excerpt: asString(record.custom_excerpt),
    tags,
    customTemplate: asString(record.custom_template),
    featureImage: asString(record.feature_image),
    lexical: asString(record.lexical),
  };
}

/** Human-readable summary of what a capture would keep (for the UI). */
export function describeCapture(
  source: CapturedSource,
  options: CaptureOptions = { name: '' },
): string[] {
  const parts: string[] = ['body'];
  const title = capturedTitle(source.title);
  if (options.includeTitle === true && title) parts.push('title');
  if ((source.excerpt ?? '').trim().length > 0) parts.push('excerpt');
  const tags = normalizeTags(source.tags);
  if (tags.length > 0) parts.push(`${tags.length} tag${tags.length === 1 ? '' : 's'}`);
  if ((source.customTemplate ?? '').trim().length > 0) parts.push('custom template');
  if (options.includeFeatureImage !== false && (source.featureImage ?? '').trim().length > 0) {
    parts.push('feature image');
  }
  return parts;
}

/**
 * Turn a captured post/page into a validated preset.
 *
 * Throws `TypeError` (with an actionable message) when the source cannot make a
 * usable preset — the caller surfaces that as a blocked import instead of
 * writing a half-formed preset.
 */
export function buildPresetFromCapture(
  source: CapturedSource,
  options: CaptureOptions,
  origin: string | null = null,
): CaptureResult {
  const name = (options.name ?? '').trim();
  if (name.length === 0) {
    throw new TypeError('preset-capture: the preset needs a name');
  }
  const id = (options.id ?? deriveIdFromName(name)).trim();
  if (id.length === 0) {
    throw new TypeError('preset-capture: the preset needs an id');
  }

  const lexical = source.lexical;
  if (typeof lexical !== 'string' || !isSerializedLexical(lexical)) {
    throw new TypeError(
      `preset-capture: this ${source.resourceType} has no readable body to capture`,
    );
  }
  if (!isCapturableLexical(lexical)) {
    throw new TypeError(
      `preset-capture: this ${source.resourceType} has no body content to capture (the post is empty)`,
    );
  }

  const warnings: string[] = [];
  const metadata: Record<string, unknown> = {};

  const title = capturedTitle(source.title);
  if (options.includeTitle === true && title) {
    metadata['title'] = { mode: 'replace', value: title };
  }

  const excerpt = (source.excerpt ?? '').trim();
  if (excerpt.length > 0) {
    if (excerpt.length > EXCERPT_MAX) {
      warnings.push(`the excerpt was trimmed to ${EXCERPT_MAX} characters (Ghost's display limit)`);
    }
    metadata['excerpt'] = {
      mode: options.excerptMode ?? 'only-if-empty',
      value: excerpt.slice(0, EXCERPT_MAX),
    };
  }

  const tags = normalizeTags(source.tags);
  if (tags.length > 0) {
    metadata['tags'] = { mode: options.tagMode ?? 'merge', values: tags };
  }

  const customTemplate = (source.customTemplate ?? '').trim();
  if (customTemplate.length > 0) {
    if (customTemplate.endsWith('.hbs')) {
      metadata['customTemplate'] = {
        mode: options.customTemplateMode ?? 'only-if-empty',
        value: customTemplate,
      };
    } else {
      warnings.push(
        `the custom template “${customTemplate}” was skipped (Ghost's custom_template must include .hbs)`,
      );
    }
  }

  if (options.includeFeatureImage !== false) {
    const image = normalizeCapturedImageUrl(source.featureImage, origin);
    if (image !== null) {
      if (isAcceptableImageUrl(image)) {
        metadata['featureImage'] = {
          mode: options.featureImageMode ?? 'only-if-empty',
          url: image,
        };
      } else {
        warnings.push(`the feature image URL “${image}” was skipped (unsupported URL)`);
      }
    }
  }

  const description =
    options.description?.trim() ??
    (title
      ? `Imported from ${source.resourceType} “${title}”.`
      : `Imported ${source.resourceType}.`);

  const preset = validatePreset({
    schemaVersion: PRESET_SCHEMA_VERSION,
    id,
    name,
    description,
    content: {
      source: 'inline-lexical',
      mode: options.bodyMode ?? 'replace',
      lexical,
    },
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ui: { group: 'Imported' },
  });

  return { preset, warnings };
}
