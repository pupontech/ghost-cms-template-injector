/**
 * Preset feature-image resolution (apply-time).
 *
 * Ghost's feature image is a plain URL on the post record (`feature_image`),
 * so a preset that carries a locally cached photo must first get that photo
 * onto the Ghost installation being edited. That happens here:
 *
 *   cached photo bytes (extension asset store)
 *     → POST `<admin>/images/upload/` with the session cookie (same-origin)
 *     → `images[0].url`, an absolute URL served by THIS Ghost install
 *     → written to the post record by the MAIN-world bridge
 *
 * The uploaded URL is memoized per Ghost installation, so applying the same
 * preset again (or on another post of the same site) reuses the already
 * uploaded media instead of piling up duplicate files. The photo bytes
 * themselves never enter the preset document — see `image-asset-store.ts`.
 */

import type { FeatureImageField } from './preset-schema';

/** Storage key for the per-installation upload memo (chrome.storage.local). */
export const FEATURE_IMAGE_UPLOAD_CACHE_KEY = 'featureImageUploads';

/** Bound the memo so it can never grow unbounded in extension storage. */
export const MAX_UPLOAD_CACHE_ENTRIES = 200;

export interface CachedImageBytes {
  data: Uint8Array;
  name: string;
  mimeType: string;
}

export interface FeatureImageUploadCache {
  get(base: string, assetId: string): Promise<string | null>;
  set(base: string, assetId: string, url: string): Promise<void>;
}

export interface FeatureImageRuntime {
  /** Read a cached photo's bytes from the extension asset store. */
  getAsset(assetId: string): Promise<CachedImageBytes | null>;
  /** Upload to the current Ghost install; resolves to the served image URL. */
  uploadImage(input: CachedImageBytes): Promise<string>;
  cache: FeatureImageUploadCache;
  /**
   * Optional existence check for a memoized URL (the owner may have deleted
   * the media in Ghost). A false result triggers a fresh upload.
   */
  verifyUrl?(url: string): Promise<boolean>;
}

export type ResolveFeatureImageResult = { ok: true; url: string } | { ok: false; reason: string };

/** Turn a Ghost-root-relative image path into an absolute URL for `base`. */
export function absoluteImageUrl(url: string, base: string): string {
  const trimmed = url.trim();
  if (!trimmed.startsWith('/')) return trimmed;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}

/**
 * Resolve a preset's feature-image field to a URL served by the Ghost install
 * at `adminBase`. Fails closed with a human-readable reason (the caller turns
 * it into a blocked plan, never a partial apply).
 */
export async function resolveFeatureImage(
  field: FeatureImageField,
  adminBase: string,
  rt: FeatureImageRuntime,
): Promise<ResolveFeatureImageResult> {
  // A preset that already names a URL needs no upload — just make it absolute
  // so the value written to the record matches what Ghost returns on readback.
  if (typeof field.url === 'string') {
    return { ok: true, url: absoluteImageUrl(field.url, adminBase) };
  }

  const assetId = field.assetId;
  if (typeof assetId !== 'string') {
    return { ok: false, reason: 'feature image field carries neither a url nor an assetId' };
  }

  // 1. Reuse a previous upload to this installation when it is still valid.
  let memoized: string | null = null;
  try {
    memoized = await rt.cache.get(adminBase, assetId);
  } catch {
    memoized = null; // a broken memo must never block the apply
  }
  if (memoized) {
    if (!rt.verifyUrl) return { ok: true, url: memoized };
    try {
      if (await rt.verifyUrl(memoized)) return { ok: true, url: memoized };
    } catch {
      // Verification failure (offline/blocked) falls through to a fresh upload.
    }
  }

  // 2. Upload the cached photo.
  let asset: CachedImageBytes | null;
  try {
    asset = await rt.getAsset(assetId);
  } catch (err) {
    return {
      ok: false,
      reason: `cached photo ${assetId} could not be read (${err instanceof Error ? err.message : 'asset store error'})`,
    };
  }
  if (!asset) {
    return {
      ok: false,
      reason: `cached photo ${assetId} is not present in this browser — open the extension options and re-select the image (photos are kept locally and are not included in preset exports)`,
    };
  }

  let url: string;
  try {
    url = await rt.uploadImage(asset);
  } catch (err) {
    return {
      ok: false,
      reason: `uploading the feature image failed (${err instanceof Error ? err.message : 'unknown error'})`,
    };
  }
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { ok: false, reason: 'the Ghost image upload returned no URL' };
  }
  const absolute = absoluteImageUrl(url, adminBase);

  // 3. Memoize for this installation; a failed memo write must not fail the apply.
  try {
    await rt.cache.set(adminBase, assetId, absolute);
  } catch {
    /* memoization is best-effort */
  }
  return { ok: true, url: absolute };
}

/* ------------------------------------------------------------------ */
/* chrome.storage.local-backed memo                                    */
/* ------------------------------------------------------------------ */

export interface UploadCacheStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface UploadCacheEntry {
  url: string;
  at: string;
}

type UploadCacheDoc = Record<string, Record<string, UploadCacheEntry>>;

function readDoc(raw: unknown): UploadCacheDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const doc: UploadCacheDoc = {};
  for (const [base, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue;
    const perBase: Record<string, UploadCacheEntry> = {};
    for (const [assetId, entry] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const url = (entry as Record<string, unknown>)['url'];
      const at = (entry as Record<string, unknown>)['at'];
      if (typeof url === 'string' && url.length > 0) {
        perBase[assetId] = { url, at: typeof at === 'string' ? at : '' };
      }
    }
    if (Object.keys(perBase).length > 0) doc[base] = perBase;
  }
  return doc;
}

/** Count every memoized entry across installations. */
function countEntries(doc: UploadCacheDoc): number {
  return Object.values(doc).reduce((total, perBase) => total + Object.keys(perBase).length, 0);
}

/** Drop the oldest entries (by `at`) until the document fits the bound. */
function pruneDoc(doc: UploadCacheDoc): UploadCacheDoc {
  const flat: Array<{ base: string; assetId: string; at: string }> = [];
  for (const [base, perBase] of Object.entries(doc)) {
    for (const [assetId, entry] of Object.entries(perBase)) {
      flat.push({ base, assetId, at: entry.at });
    }
  }
  if (flat.length <= MAX_UPLOAD_CACHE_ENTRIES) return doc;
  flat.sort((a, b) => a.at.localeCompare(b.at));
  const drop = new Set(
    flat.slice(0, flat.length - MAX_UPLOAD_CACHE_ENTRIES).map((e) => `${e.base}\u0000${e.assetId}`),
  );
  const pruned: UploadCacheDoc = {};
  for (const [base, perBase] of Object.entries(doc)) {
    for (const [assetId, entry] of Object.entries(perBase)) {
      if (drop.has(`${base}\u0000${assetId}`)) continue;
      pruned[base] = { ...(pruned[base] ?? {}), [assetId]: entry };
    }
  }
  return pruned;
}

/**
 * Build the memo over chrome.storage.local. Read/write failures are swallowed
 * by callers — the memo is an optimization, never a correctness requirement.
 */
export function createFeatureImageUploadCache(
  storage: UploadCacheStorage,
  now: () => Date = () => new Date(),
): FeatureImageUploadCache {
  return {
    async get(base: string, assetId: string): Promise<string | null> {
      const result = await storage.get(FEATURE_IMAGE_UPLOAD_CACHE_KEY);
      const doc = readDoc(result[FEATURE_IMAGE_UPLOAD_CACHE_KEY]);
      return doc[base]?.[assetId]?.url ?? null;
    },
    async set(base: string, assetId: string, url: string): Promise<void> {
      const result = await storage.get(FEATURE_IMAGE_UPLOAD_CACHE_KEY);
      const doc = readDoc(result[FEATURE_IMAGE_UPLOAD_CACHE_KEY]);
      const next = pruneDoc({
        ...doc,
        [base]: { ...(doc[base] ?? {}), [assetId]: { url, at: now().toISOString() } },
      });
      await storage.set({ [FEATURE_IMAGE_UPLOAD_CACHE_KEY]: next });
    },
  };
}

/** Test/telemetry helper: how many entries a raw stored document holds. */
export function countUploadCacheEntries(raw: unknown): number {
  return countEntries(readDoc(raw));
}
