/**
 * Phase-4 options CRUD / import / export controller (owns this module only).
 *
 * This module is the pure, DOM-free brain behind the options page. It never
 * touches `chrome.*`, the DOM, or `presets.json` directly. All persistence is
 * delegated to the Phase-2 `preset-store` through an injected `OptionsRuntime`,
 * so the storage/schema/import-bounds contracts (C5/C6) stay owned by that
 * module and are reused verbatim here.
 *
 * CRUD mapping onto the validated store:
 *   - Read    → listViewPresets (defaults merged with user overrides)
 *   - Create/Update → createOrUpdatePreset → store.savePreset (validated + atomic)
 *   - Delete  → deletePreset: recomputes the *override set* (user presets plus
 *               edited seeds) and replaces the stored document. Bundled seeds are
 *               never written, so they remain live and read-only (no bundled
 *               preset mutation). A pristine seed has no override and simply
 *               disappears from the list when "deleted".
 *   - Import  → importPresetsFromString → store.importPresetsIntoStore
 *               (size-bounded + fully validated; fails closed)
 *   - Export  → exportPresetsToString → store.exportPresets
 *
 * Security: every preset name/description is rendered as untrusted text by the
 * view layer; this controller only passes validated data through. No secrets,
 * no eval, no bundled-file mutation.
 */

import type { BodyMode, BodySource, Preset } from './preset-schema';

/** Shape the options list view consumes; `seeded` marks a bundled default. */
export interface OptionsPresetView {
  id: string;
  name: string;
  description?: string;
  group?: string;
  icon?: string;
  source: BodySource;
  mode: BodyMode;
  /** True when this entry is a pristine bundled default with no user override. */
  seeded: boolean;
}

/** Persistence seams the controller depends on (wired from preset-store). */
export interface OptionsRuntime {
  loadPresets: () => Promise<Preset[]>;
  loadBundledDefaults: () => Promise<Preset[]>;
  savePreset: (input: unknown) => Promise<Preset>;
  importPresetsIntoStore: (serialized: string) => Promise<Preset[]>;
  exportPresets: (presets: Preset[]) => string;
}

export interface SaveOutcome {
  ok: boolean;
  preset?: Preset;
  error?: string;
}

export interface ImportOutcome {
  ok: boolean;
  count?: number;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Equality + override-set helpers                                     */
/* ------------------------------------------------------------------ */

/** Deterministic JSON serialization so two semantically equal presets match. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function presetsEqual(a: Preset, b: Preset): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * Reduce the merged preset list to the *override set*: user-created presets
 * plus bundled seeds the user has edited. Pristine seeds are dropped so they
 * keep flowing from the read-only bundle.
 */
function computeOverrideSet(
  merged: readonly Preset[],
  defaults: readonly Preset[],
  excludeId: string | null,
): Preset[] {
  const out: Preset[] = [];
  for (const preset of merged) {
    if (excludeId !== null && preset.id === excludeId) continue;
    const seed = defaults.find((d) => d.id === preset.id);
    if (!seed) {
      out.push(preset);
      continue;
    }
    if (!presetsEqual(preset, seed)) out.push(preset);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Read                                                                */
/* ------------------------------------------------------------------ */

/** Load presets for display, flagging which are bundled (unedited) defaults. */
export async function listViewPresets(rt: OptionsRuntime): Promise<OptionsPresetView[]> {
  const [merged, defaults] = await Promise.all([rt.loadPresets(), rt.loadBundledDefaults()]);
  return merged.map((preset) => {
    const seed = defaults.find((d) => d.id === preset.id);
    const view: OptionsPresetView = {
      id: preset.id,
      name: preset.name,
      source: preset.content.source,
      mode: preset.content.mode,
      seeded: seed !== undefined && presetsEqual(preset, seed),
    };
    if (preset.description !== undefined) view.description = preset.description;
    if (preset.ui?.group !== undefined) view.group = preset.ui.group;
    if (preset.ui?.icon !== undefined) view.icon = preset.ui.icon;
    return view;
  });
}

/* ------------------------------------------------------------------ */
/* Create / Update                                                     */
/* ------------------------------------------------------------------ */

/** Validate and persist a preset (create or upsert by id). Never throws. */
export async function createOrUpdatePreset(
  rt: OptionsRuntime,
  input: unknown,
): Promise<SaveOutcome> {
  try {
    const preset = await rt.savePreset(input);
    return { ok: true, preset };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------------ */
/* Delete                                                              */
/* ------------------------------------------------------------------ */

/**
 * Delete a preset by rewriting the override set without it. Bundled seeds are
 * preserved (a deleted seed override simply reverts to the bundle). Atomic and
 * validated through the store.
 */
export async function deletePreset(rt: OptionsRuntime, id: string): Promise<void> {
  const [merged, defaults] = await Promise.all([rt.loadPresets(), rt.loadBundledDefaults()]);
  const next = computeOverrideSet(merged, defaults, id);
  await rt.importPresetsIntoStore(rt.exportPresets(next));
}

/* ------------------------------------------------------------------ */
/* Import / Export                                                     */
/* ------------------------------------------------------------------ */

/** Parse, size-bound, and fully validate an import; replace the store atomically. */
export async function importPresetsFromString(
  rt: OptionsRuntime,
  serialized: string,
): Promise<ImportOutcome> {
  try {
    const presets = await rt.importPresetsIntoStore(serialized);
    return { ok: true, count: presets.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Serialize a collection for export (options-page JSON download). */
export function exportPresetsToString(rt: OptionsRuntime, presets: Preset[]): string {
  return rt.exportPresets(presets);
}
