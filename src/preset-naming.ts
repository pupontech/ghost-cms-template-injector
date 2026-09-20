/**
 * Preset naming helpers, shared by the options page and by post import
 * (`preset-capture.ts`).
 *
 * These live in their own module because `options-main.ts` performs a browser
 * bootstrap at import time (it wires the options DOM when `chrome` is present),
 * so a content script or the popup must never import that module just to reuse
 * an id helper. `options-main.ts` re-exports these for its existing callers.
 */

/** Derive a slug id from the visible name ("Review checklist" -> "review-checklist"). */
export function deriveIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : `preset-${Date.now()}`;
}

/**
 * Return the next unused preset id when `base` already exists in `existing`,
 * so a newly-created preset never shadows a name already in the list. Appends
 * an increasing numeric suffix (`...-2`, `...-3`, …) and keeps the result
 * within the 64-char id bound by trimming the stem for the suffix.
 */
export function nextAvailablePresetId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    // Reserve room for `-` + the numeric suffix within the 64-char bound.
    const stem = base.slice(0, 64 - suffix.length - 1);
    const candidate = `${stem}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}
