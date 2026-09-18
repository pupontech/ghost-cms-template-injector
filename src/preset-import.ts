/**
 * Post-import runtime logic, shared by every surface that offers the import.
 *
 * The owner's workflow keeps the import UI in the Options page (the popup only
 * carries a button that opens it), so this module owns the transport-agnostic
 * half: validating what a Ghost tab returned, reading a capture, and saving the
 * built preset through the shared store. The caller supplies the transport
 * (popup → its own tab's content script; options page → service-worker routed
 * Ghost tab), which is the only part that differs.
 */
import type { CapturedSource, CaptureOptions, CaptureResult } from './preset-capture';
import { buildPresetFromCapture } from './preset-capture';
import { deriveIdFromName, nextAvailablePresetId } from './preset-naming';
import type { Preset } from './preset-schema';

/** One row of the import picker. */
export interface CapturableEntry {
  id: string;
  title: string;
  status: string;
  updatedAt: string | null;
  resourceType: 'post' | 'page';
}

/** What a content script replies with when it read a post for the import. */
export interface CaptureOutcome {
  source: CapturedSource;
  warnings: string[];
  readFrom: 'admin-api' | 'live-editor';
  siteOrigin: string | null;
}

export interface CaptureListResult {
  ok: boolean;
  entries: CapturableEntry[];
  error?: string;
}

export interface CaptureReadResult {
  ok: boolean;
  outcome?: CaptureOutcome;
  error?: string;
}

export interface CaptureSaveResult {
  ok: boolean;
  preset?: Preset;
  warnings: string[];
  error?: string;
}

/** Transport seam: send one read-only operation and return the raw reply. */
export type ImportSender = (message: {
  op: 'listPosts' | 'capture' | 'capturePost';
  resourceType?: 'post' | 'page';
  resourceId?: string;
}) => Promise<unknown>;

/** Structural validation of a capture-source payload from a Ghost tab. */
export function asCapturedSource(value: unknown): CapturedSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw['resourceType'] !== 'post' && raw['resourceType'] !== 'page') return null;
  const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const tags = raw['tags'];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) return null;
  return {
    resourceType: raw['resourceType'],
    title: strOrNull(raw['title']),
    excerpt: strOrNull(raw['excerpt']),
    customTemplate: strOrNull(raw['customTemplate']),
    featureImage: strOrNull(raw['featureImage']),
    lexical: strOrNull(raw['lexical']),
    tags: tags as string[],
  };
}

export function asCaptureOutcome(value: unknown): CaptureOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const source = asCapturedSource(raw['source']);
  if (!source) return null;
  const warnings = Array.isArray(raw['warnings'])
    ? (raw['warnings'] as unknown[]).filter((w): w is string => typeof w === 'string')
    : [];
  const readFrom = raw['readFrom'] === 'admin-api' ? 'admin-api' : 'live-editor';
  return {
    source,
    warnings,
    readFrom,
    siteOrigin: typeof raw['siteOrigin'] === 'string' ? raw['siteOrigin'] : null,
  };
}

/** Unwrap the `{ok, result}` envelope a content script replies with. */
function unwrap(reply: unknown): { ok: true; result: unknown } | { ok: false; error: string } {
  const outer = reply as { ok?: boolean; error?: string; result?: unknown } | undefined;
  if (!outer || typeof outer !== 'object') {
    return { ok: false, error: 'no reply from the Ghost tab' };
  }
  if (outer.ok !== true) return { ok: false, error: outer.error ?? 'the Ghost tab refused' };
  return { ok: true, result: outer.result };
}

export async function listCapturable(send: ImportSender): Promise<CaptureListResult> {
  let reply: unknown;
  try {
    reply = await send({ op: 'listPosts' });
  } catch (err) {
    return { ok: false, entries: [], error: err instanceof Error ? err.message : 'read failed' };
  }
  const checked = unwrap(reply);
  if (!checked.ok) return { ok: false, entries: [], error: checked.error };
  const raw = checked.result as Record<string, unknown> | null;
  const entries = raw && Array.isArray(raw['entries']) ? raw['entries'] : null;
  if (!entries) return { ok: false, entries: [], error: 'the Ghost tab returned no post list' };
  const parsed: CapturableEntry[] = [];
  for (const item of entries as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry['id'] !== 'string' || typeof entry['title'] !== 'string') continue;
    if (entry['resourceType'] !== 'post' && entry['resourceType'] !== 'page') continue;
    parsed.push({
      id: entry['id'],
      title: entry['title'],
      status: typeof entry['status'] === 'string' ? entry['status'] : 'unknown',
      updatedAt: typeof entry['updatedAt'] === 'string' ? entry['updatedAt'] : null,
      resourceType: entry['resourceType'],
    });
  }
  return { ok: true, entries: parsed };
}

export async function captureCurrent(send: ImportSender): Promise<CaptureReadResult> {
  let reply: unknown;
  try {
    reply = await send({ op: 'capture' });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'read failed' };
  }
  const checked = unwrap(reply);
  if (!checked.ok) return { ok: false, error: checked.error };
  const outcome = asCaptureOutcome(checked.result);
  if (!outcome) return { ok: false, error: 'the Ghost tab returned an unusable capture payload' };
  return { ok: true, outcome };
}

export async function capturePost(
  send: ImportSender,
  resourceType: 'post' | 'page',
  resourceId: string,
): Promise<CaptureReadResult> {
  if (resourceType !== 'post' && resourceType !== 'page') {
    return { ok: false, error: 'invalid resource type' };
  }
  if (typeof resourceId !== 'string' || resourceId.trim().length === 0) {
    return { ok: false, error: 'a post must be selected first' };
  }
  let reply: unknown;
  try {
    reply = await send({ op: 'capturePost', resourceType, resourceId });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'read failed' };
  }
  const checked = unwrap(reply);
  if (!checked.ok) return { ok: false, error: checked.error };
  const outcome = asCaptureOutcome(checked.result);
  if (!outcome) return { ok: false, error: 'the Ghost tab returned an unusable capture payload' };
  return { ok: true, outcome };
}

export interface SaveCaptureDeps {
  /** Existing preset ids, used to keep the derived id free. */
  loadPresets: () => Promise<Array<{ id: string }>>;
  savePreset: (input: unknown) => Promise<Preset>;
}

/** Build the preset from a capture and store it under a fresh id. */
export async function saveCapturedPreset(
  outcome: CaptureOutcome,
  options: CaptureOptions,
  deps: SaveCaptureDeps,
): Promise<CaptureSaveResult> {
  let built: CaptureResult;
  try {
    built = buildPresetFromCapture(outcome.source, options, outcome.siteOrigin);
  } catch (err) {
    return {
      ok: false,
      warnings: [],
      error: err instanceof Error ? err.message : 'the captured post could not be used',
    };
  }

  // Never shadow an existing preset: derive a fresh id from the name.
  let existing: Set<string>;
  try {
    existing = new Set((await deps.loadPresets()).map((preset) => preset.id));
  } catch {
    existing = new Set<string>();
  }
  const baseId = options.id ?? deriveIdFromName(built.preset.name);
  const id = nextAvailablePresetId(baseId, existing);

  try {
    const saved = await deps.savePreset({ ...built.preset, id });
    return { ok: true, preset: saved, warnings: [...outcome.warnings, ...built.warnings] };
  } catch (err) {
    return {
      ok: false,
      warnings: built.warnings,
      error: err instanceof Error ? err.message : 'the preset could not be saved',
    };
  }
}
