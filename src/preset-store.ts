/**
 * Phase-2 preset storage repository.
 *
 * The packaged presets/presets.json is read-only seed data: it is loaded and
 * validated but never rewritten (an extension cannot modify its own installed
 * files). User edits, imports, and new presets persist to a single
 * chrome.storage.local document under STORAGE_KEY with:
 *   - schemaVersion pinning + forward-compatible migration table;
 *   - full revalidation through preset-schema before any write;
 *   - one atomic set() per mutation (document replaced in a single call);
 *   - fail-closed reads (corrupt/invalid stored data falls back to seeds);
 *   - bounded imports via the C5 size limit;
 *   - no secrets or credentials stored — presets are content templates only.
 *
 * SEED-LOADING INVARIANT (release blocker t_f2218c98): the bundled seed array
 * is inlined at build time (`BUNDLED_SEED_PRESETS`, substituted via esbuild
 * `define` in scripts/build.mjs from the real presets/presets.json). A content
 * script (dist/toolbar.js / dist/content-script.js) runs in the page's
 * ISOLATED world; fetching `chrome.runtime.getURL('presets/presets.json')`
 * there is treated by Chromium as a cross-origin web request to the extension
 * origin and is blocked (net::ERR_FAILED / chrome-extension://invalid/) unless
 * the file is listed in `web_accessible_resources` — which the minimal
 * permission contract deliberately omits (no broad surface). Inlining removes
 * the runtime fetch entirely: the seed is part of the bundle, so a content
 * script can load defaults with no network/extension-resource request. In
 * Node/test there is no `BUNDLED_SEED_PRESETS` (esbuild define is build-only),
 * so we fall back to reading the file from disk relative to cwd; that path is
 * never taken in a browser bundle.
 */

import {
  MAX_IMPORT_BYTES,
  PRESET_SCHEMA_VERSION,
  validatePreset,
  validatePresets,
  type Preset,
} from './preset-schema';

/**
 * Build-time-inlined bundled seed array. Compiled out to `undefined` in a
 * normal (non-define) TypeScript compile, and replaced with the real
 * presets/presets.json contents by esbuild `define` during `npm run build`.
 * The value is a JSON string (so `define` can substitute it as a string
 * literal) and is parsed lazily on first use.
 */
declare const BUNDLED_SEED_PRESETS: string | undefined;

/** Single chrome.storage.local key holding the whole user preset document. */
export const STORAGE_KEY = 'presetStore';

export interface PresetStoreDoc {
  /** Document schema version (independent of individual preset schemaVersion). */
  schemaVersion: number;
  /** Monotonic mutation counter for change detection. */
  version: number;
  presets: Preset[];
}

let bundledDefaults: Preset[] | null = null;

function getLocalStorage(): chrome.storage.StorageArea {
  const area = (globalThis as { chrome?: { storage?: { local?: chrome.storage.StorageArea } } })
    .chrome?.storage?.local;
  if (!area) throw new Error('preset-store: chrome.storage.local is unavailable');
  return area;
}

/**
 * Load the packaged defaults from the build-time-inlined seed preset array.
 *
 * `BUNDLED_SEED_PRESETS` is substituted at build time (esbuild `define`) with
 * the JSON contents of presets/presets.json, so the seed is embedded directly
 * in the bundle. This eliminates the runtime `fetch(getURL('presets/...'))`
 * that content scripts are forbidden from performing (Chromium blocks a
 * content-script fetch of an extension resource unless it is listed in
 * `web_accessible_resources`, which the minimal-permission contract omits).
 *
 * In Node/tests `BUNDLED_SEED_PRESETS` is undefined (esbuild `define` only runs
 * during `npm run build`), so we fall back to reading the file from disk
 * relative to cwd — the same read-only seed array, validated before caching.
 * Storage is never written by this loader (read-only seed).
 */
export async function loadBundledDefaults(): Promise<Preset[]> {
  if (bundledDefaults) return bundledDefaults;
  const raw = await readBundledPresetsRaw();
  const presets = validatePresets(asArray(raw));
  bundledDefaults = presets;
  return presets;
}

/**
 * Read the packaged presets/presets.json seed.
 *
 * In a production browser bundle, the seed is already inlined as a JSON string
 * (`BUNDLED_SEED_PRESETS`), so there is no network/extension-resource request
 * at runtime — this is the fix for the release-blocking content-script fetch
 * failure (t_f2218c98).
 *
 * In Node/test, `BUNDLED_SEED_PRESETS` is `undefined`, so we read the packaged
 * file directly from disk relative to process.cwd() (the repo root, where
 * `presets/` lives). The result is identical: the read-only seed array.
 */
async function readBundledPresetsRaw(): Promise<unknown> {
  const inlined = typeof BUNDLED_SEED_PRESETS !== 'undefined' ? BUNDLED_SEED_PRESETS : undefined;
  if (inlined) {
    return JSON.parse(inlined) as unknown;
  }

  // Test/Node fallback: read the packaged file directly from disk. `presets/`
  // ships at the package root, so resolve relative to process.cwd() (the repo
  // root under vitest). This path is never taken in a built browser bundle.
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const file = resolve(process.cwd(), 'presets', 'presets.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function asArray(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) {
    throw new TypeError('preset-store: presets/presets.json must contain an array of presets');
  }
  return validatePresets(raw);
}

/**
 * Read and migrate the stored document. Returns null when nothing valid is
 * stored; never throws for corrupt data (read callers fall back to defaults).
 * Write callers use `readStoredDocForWrite`, which FAILS CLOSED on an
 * unreadable document instead of treating it as empty (an empty read-modify-
 * write would silently destroy every other stored preset).
 */
async function readStoredDoc(): Promise<PresetStoreDoc | null> {
  const area = getLocalStorage();
  try {
    const result = await area.get(STORAGE_KEY);
    const raw = result[STORAGE_KEY];
    if (raw === undefined) return null;

    const migrated = migrateDocument(raw);
    // Revalidate every stored preset — storage contents are untrusted input.
    validatePresets(migrated.presets);
    return migrated;
  } catch (error) {
    console.error(
      'preset-store: stored presets unavailable or invalid, ignoring local overrides',
      error,
    );
    return null;
  }
}

/**
 * Read the stored document for a WRITE (save/import). Unlike the read path
 * (which fails over to defaults), a write must never proceed from an empty
 * base when a stored document exists but cannot be parsed/migrated/validated:
 * the read-modify-write would replace the whole `presetStore` document with a
 * single new preset and permanently destroy every other user override.
 */
async function readStoredDocForWrite(): Promise<PresetStoreDoc | null> {
  const area = getLocalStorage();
  const result = await area.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY];
  if (raw === undefined) return null;
  const migrated = migrateDocument(raw); // throws on unreadable
  validatePresets(migrated.presets); // throws on invalid content
  return migrated;
}

/**
 * Schema-version migrations. Each step upgrades a document one version.
 * Unknown future versions fail closed (return null upstream → defaults).
 */
const MIGRATIONS: Record<
  number,
  (raw: Record<string, unknown>) => { schemaVersion: number; version: number; presets: unknown[] }
> = {
  // v1 documents originally lacked the mutation counter; normalize it to 0.
  1: (raw) => ({
    schemaVersion: PRESET_SCHEMA_VERSION,
    version:
      typeof raw['version'] === 'number' && Number.isInteger(raw['version']) ? raw['version'] : 0,
    presets: Array.isArray(raw['presets']) ? raw['presets'] : [],
  }),
};

function migrateDocument(raw: unknown): PresetStoreDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('preset-store: stored document must be an object');
  }
  const record = raw as Record<string, unknown>;
  const schemaVersion = record['schemaVersion'];
  const migrate = MIGRATIONS[schemaVersion as number];
  if (typeof schemaVersion !== 'number' || !migrate) {
    throw new TypeError(`preset-store: unsupported store schemaVersion ${String(schemaVersion)}`);
  }
  const migrated = migrate(record);
  // Presets are revalidated by the caller before use; cast here is safe.
  return {
    schemaVersion: migrated.schemaVersion,
    version: migrated.version,
    presets: migrated.presets as Preset[],
  };
}

async function writeStoredDoc(presets: Preset[]): Promise<void> {
  const existing = await readStoredDoc();
  const doc: PresetStoreDoc = {
    schemaVersion: PRESET_SCHEMA_VERSION,
    version: (existing?.version ?? 0) + 1,
    presets,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc)).length;
  if (bytes > MAX_IMPORT_BYTES) {
    throw new RangeError(
      `preset-store: stored preset document too large (${bytes} > ${MAX_IMPORT_BYTES} bytes)`,
    );
  }
  // Single atomic replacement of the whole document.
  await getLocalStorage().set({ [STORAGE_KEY]: doc });
}

/**
 * Merge stored overrides with the packaged defaults: a stored preset sharing
 * an id with a seed shadows it at its original position; user-only presets
 * follow in stored order.
 */
export async function listPresets(): Promise<Preset[]> {
  const defaults = await loadBundledDefaults();
  const stored = await readStoredDoc();
  if (!stored) return defaults;

  const overrideById = new Map(stored.presets.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const merged: Preset[] = [];
  // Bundled seeds first (shadowed in place by same-id overrides).
  for (const preset of defaults) {
    if (seen.has(preset.id)) continue;
    seen.add(preset.id);
    merged.push(overrideById.get(preset.id) ?? preset);
  }
  // User-only presets follow in stored order.
  for (const preset of stored.presets) {
    if (seen.has(preset.id)) continue;
    seen.add(preset.id);
    merged.push(preset);
  }
  return merged;
}

/**
 * Load a single validated preset by id (bundled seeds + chrome.storage.local
 * overrides). Returns null when no preset matches — callers surface a blocked
 * outcome rather than throwing on an unknown id.
 */
export async function loadPreset(id: string): Promise<Preset | null> {
  const presets = await listPresets();
  return presets.find((p) => p.id === id) ?? null;
}

/**
 * Validate and upsert one preset by id (atomic single-key write).
 * Throws without writing anything when validation fails. Also FAILS CLOSED
 * when the existing stored document is unreadable (corrupt/migrated-future):
 * writing from an empty base would silently destroy every other stored preset.
 */
export async function savePreset(input: unknown): Promise<Preset> {
  const preset = validatePreset(input); // throws before any I/O
  const stored = (await readStoredDocForWrite())?.presets ?? [];
  const next = [...stored];
  const index = next.findIndex((p) => p.id === preset.id);
  if (index >= 0) next[index] = preset;
  else next.push(preset);
  await writeStoredDoc(next);
  return preset;
}

/**
 * Serialize a collection for export (options-page JSON download).
 */
export function exportPresets(presets: Preset[]): string {
  return JSON.stringify(
    { kind: 'ghost-preset-toolbar-presets', schemaVersion: PRESET_SCHEMA_VERSION, presets },
    null,
    2,
  );
}

function extractCollection(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>)['presets'])
  ) {
    return (parsed as Record<string, unknown>)['presets'] as unknown[];
  }
  throw new TypeError('preset-schema: import payload must be a preset array or {presets: []}');
}

/**
 * Parse, size-bound, and fully validate an import payload (pure — no writes).
 */
export function importPresets(serialized: string): Preset[] {
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > MAX_IMPORT_BYTES) {
    throw new RangeError(`preset-store: import too large (${bytes} > ${MAX_IMPORT_BYTES} bytes)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new SyntaxError(`preset-store: import is not valid JSON (${String(error)})`);
  }
  return validatePresets(extractCollection(parsed));
}

/**
 * Validate an imported collection and replace the stored document with it in
 * one atomic write. FAILS CLOSED when a pre-existing stored document is
 * unreadable (corrupt/migrated-future): replacing it would destroy existing
 * user overrides that the new import does not carry.
 */
export async function importPresetsIntoStore(serialized: string): Promise<Preset[]> {
  const presets = importPresets(serialized); // validates before any write
  // Touch the existing document WITHOUT falling back to an empty base: an
  // unreadable (corrupt/future-schema) stored doc must surface an error, not
  // be silently destroyed by a replace that starts from nothing.
  await readStoredDocForWrite();
  await writeStoredDoc(presets);
  return presets;
}
