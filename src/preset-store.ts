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
 */

import {
  MAX_IMPORT_BYTES,
  PRESET_SCHEMA_VERSION,
  validatePreset,
  validatePresets,
  type Preset,
} from './preset-schema';

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
 * Load the packaged defaults from presets/presets.json. The file ships inside
 * the extension package and is validated once per session; results are cached
 * in memory only. Storage is never written by this loader (read-only seed).
 */
export async function loadBundledDefaults(): Promise<Preset[]> {
  if (bundledDefaults) return bundledDefaults;
  const raw = await readBundledPresetsRaw();
  const presets = validatePresets(asArray(raw));
  bundledDefaults = presets;
  return presets;
}

/**
 * Read the packaged presets/presets.json seed file.
 *
 * The browser bundle (content script / toolbar) is executed by Chrome as a
 * *classic* script via `chrome.scripting.registerContentScripts`, which forbids
 * module-only syntax. `import.meta.url` is therefore illegal here, so we
 * resolve the packaged file through `chrome.runtime.getURL` (the correct,
 * extension-native URL resolver) instead of a module-relative URL.
 *
 * In Node/tests there is no `chrome.runtime`, so we fall back to reading the
 * file directly from disk relative to the Node process working directory
 * (the repo root, where `presets/` lives). The result is identical: the
 * read-only seed array, validated before caching.
 */
async function readBundledPresetsRaw(): Promise<unknown> {
  const isNodeLike =
    typeof process !== 'undefined' &&
    typeof (process as { versions?: { node?: string } }).versions?.node === 'string';

  if (!isNodeLike) {
    const { chrome } = globalThis as {
      chrome?: { runtime?: { getURL?: (p: string) => string } };
    };
    const getURL = chrome?.runtime?.getURL;
    if (!getURL) {
      throw new Error('preset-store: chrome.runtime.getURL unavailable in browser context');
    }
    const response = await fetch(getURL('presets/presets.json'));
    if (!response.ok) {
      throw new Error(`preset-store: bundled presets/presets.json unreadable (${response.status})`);
    }
    return response.json();
  }

  // Test/Node fallback: read the packaged file directly from disk. `presets/`
  // ships at the package root, so resolve relative to process.cwd() (the repo
  // root under vitest).
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
 * stored; never throws for corrupt data (callers fall back to defaults).
 */
async function readStoredDoc(): Promise<PresetStoreDoc | null> {
  const area = getLocalStorage();
  const result = await area.get(STORAGE_KEY);
  const raw = result[STORAGE_KEY];
  if (raw === undefined) return null;

  try {
    const migrated = migrateDocument(raw);
    // Revalidate every stored preset — storage contents are untrusted input.
    validatePresets(migrated.presets);
    return migrated;
  } catch (error) {
    console.error('preset-store: stored presets invalid, ignoring local overrides', error);
    return null;
  }
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
 * Throws without writing anything when validation fails.
 */
export async function savePreset(input: unknown): Promise<Preset> {
  const preset = validatePreset(input); // throws before any I/O
  const stored = (await readStoredDoc())?.presets ?? [];
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
 * one atomic write.
 */
export async function importPresetsIntoStore(serialized: string): Promise<Preset[]> {
  const presets = importPresets(serialized); // validates before any write
  await writeStoredDoc(presets);
  return presets;
}
