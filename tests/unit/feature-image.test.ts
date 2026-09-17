import { describe, expect, it, vi } from 'vitest';

import {
  absoluteImageUrl,
  countUploadCacheEntries,
  createFeatureImageUploadCache,
  FEATURE_IMAGE_UPLOAD_CACHE_KEY,
  MAX_UPLOAD_CACHE_ENTRIES,
  resolveFeatureImage,
  type CachedImageBytes,
  type FeatureImageRuntime,
  type FeatureImageUploadCache,
} from '../../src/feature-image';
import { fakeStorageArea } from '../helpers/chrome-stub';

const BASE = 'http://localhost:2368/ghost/api/admin/';
const ASSET_ID = 'img_0123456789abcdef';
const UPLOADED = 'http://localhost:2368/content/images/2026/09/hero.png';

const BYTES: CachedImageBytes = {
  data: new Uint8Array([1, 2, 3]),
  name: 'hero.png',
  mimeType: 'image/png',
};

function memoryCache(initial: Record<string, string> = {}): FeatureImageUploadCache & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  const key = (base: string, assetId: string) => `${base}\u0000${assetId}`;
  return {
    entries,
    get: async (base, assetId) => entries.get(key(base, assetId)) ?? null,
    set: async (base, assetId, url) => {
      entries.set(key(base, assetId), url);
    },
  };
}

function runtime(overrides: Partial<FeatureImageRuntime> = {}): FeatureImageRuntime & {
  uploadImage: ReturnType<typeof vi.fn>;
  getAsset: ReturnType<typeof vi.fn>;
} {
  const uploadImage = vi.fn(async () => UPLOADED);
  const getAsset = vi.fn(async () => BYTES);
  return {
    uploadImage,
    getAsset,
    cache: memoryCache(),
    ...overrides,
  } as FeatureImageRuntime & {
    uploadImage: ReturnType<typeof vi.fn>;
    getAsset: ReturnType<typeof vi.fn>;
  };
}

describe('absoluteImageUrl', () => {
  it('resolves Ghost-root-relative paths and leaves absolute URLs alone', () => {
    expect(absoluteImageUrl('/content/images/a.png', BASE)).toBe(
      'http://localhost:2368/content/images/a.png',
    );
    expect(absoluteImageUrl('https://cdn.example.com/a.png', BASE)).toBe(
      'https://cdn.example.com/a.png',
    );
  });
});

describe('resolveFeatureImage — preset URL', () => {
  it('returns the absolute URL without uploading anything', async () => {
    const rt = runtime();
    const result = await resolveFeatureImage(
      { mode: 'replace', url: '/content/images/2026/09/known.png' },
      BASE,
      rt,
    );
    expect(result).toEqual({
      ok: true,
      url: 'http://localhost:2368/content/images/2026/09/known.png',
    });
    expect(rt.uploadImage).not.toHaveBeenCalled();
    expect(rt.getAsset).not.toHaveBeenCalled();
  });
});

describe('resolveFeatureImage — cached photo', () => {
  it('uploads a cached photo on first use and memoizes the URL per installation', async () => {
    const rt = runtime();
    const result = await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);

    expect(result).toEqual({ ok: true, url: UPLOADED });
    expect(rt.getAsset).toHaveBeenCalledWith(ASSET_ID);
    expect(rt.uploadImage).toHaveBeenCalledWith(BYTES);
    expect(await rt.cache.get(BASE, ASSET_ID)).toBe(UPLOADED);
  });

  it('reuses the memoized upload on the next apply (no duplicate media)', async () => {
    const rt = runtime();
    await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);
    const second = await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);

    expect(second).toEqual({ ok: true, url: UPLOADED });
    expect(rt.uploadImage).toHaveBeenCalledTimes(1);
  });

  it('keeps the memo per installation, so another site uploads its own copy', async () => {
    const rt = runtime();
    await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);
    await resolveFeatureImage(
      { mode: 'replace', assetId: ASSET_ID },
      'https://blog.example.com/ghost/api/admin/',
      rt,
    );
    expect(rt.uploadImage).toHaveBeenCalledTimes(2);
  });

  it('re-uploads when the memoized URL no longer exists', async () => {
    const cache = memoryCache({ [`${BASE}\u0000${ASSET_ID}`]: 'http://localhost:2368/gone.png' });
    const rt = runtime({ cache, verifyUrl: vi.fn(async () => false) });
    const result = await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);

    expect(result).toEqual({ ok: true, url: UPLOADED });
    expect(rt.uploadImage).toHaveBeenCalledTimes(1);
    expect(await cache.get(BASE, ASSET_ID)).toBe(UPLOADED);
  });

  it('trusts a verified memoized URL without re-uploading', async () => {
    const cache = memoryCache({ [`${BASE}\u0000${ASSET_ID}`]: 'http://localhost:2368/kept.png' });
    const verifyUrl = vi.fn(async () => true);
    const rt = runtime({ cache, verifyUrl });
    const result = await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);

    expect(result).toEqual({ ok: true, url: 'http://localhost:2368/kept.png' });
    expect(verifyUrl).toHaveBeenCalledWith('http://localhost:2368/kept.png');
    expect(rt.uploadImage).not.toHaveBeenCalled();
  });

  it('re-uploads when URL verification itself throws (offline/blocked)', async () => {
    const cache = memoryCache({ [`${BASE}\u0000${ASSET_ID}`]: 'http://localhost:2368/kept.png' });
    const rt = runtime({
      cache,
      verifyUrl: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const result = await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);
    expect(result).toEqual({ ok: true, url: UPLOADED });
  });
});

describe('resolveFeatureImage — fail closed', () => {
  it('blocks when the photo is not cached in this browser', async () => {
    const rt = runtime({ getAsset: vi.fn(async () => null) });
    const result = await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/not present in this browser/i);
    expect(result.reason).toMatch(/re-select/i);
    expect(rt.uploadImage).not.toHaveBeenCalled();
  });

  it('blocks when the asset store cannot be read', async () => {
    const rt = runtime({
      getAsset: vi.fn(async () => {
        throw new Error('indexedDB unavailable');
      }),
    });
    const result = await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/could not be read/i);
  });

  it('blocks when the upload fails', async () => {
    const rt = runtime({
      uploadImage: vi.fn(async () => {
        throw new Error('IMAGE_UPLOAD_FAILED (413)');
      }),
    });
    const result = await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/uploading the feature image failed/i);
  });

  it('blocks when the upload returns no URL', async () => {
    const rt = runtime({ uploadImage: vi.fn(async () => '') });
    const result = await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toMatch(/returned no URL/i);
  });

  it('rejects a field that names neither a URL nor a photo', async () => {
    const rt = runtime();
    const result = await resolveFeatureImage(
      { mode: 'replace' } as unknown as Parameters<typeof resolveFeatureImage>[0],
      BASE,
      rt,
    );
    expect(result.ok).toBe(false);
  });

  it('still applies when memoization cannot be written', async () => {
    const rt = runtime({
      cache: {
        get: async () => null,
        set: async () => {
          throw new Error('storage full');
        },
      },
    });
    expect(await resolveFeatureImage({ mode: 'replace', assetId: ASSET_ID }, BASE, rt)).toEqual({
      ok: true,
      url: UPLOADED,
    });
  });
});

describe('feature-image upload memo (chrome.storage.local)', () => {
  it('stores and reads entries per installation', async () => {
    const storage = fakeStorageArea();
    const cache = createFeatureImageUploadCache(
      storage.api,
      () => new Date('2026-09-17T10:00:00Z'),
    );

    expect(await cache.get(BASE, ASSET_ID)).toBeNull();
    await cache.set(BASE, ASSET_ID, UPLOADED);
    expect(await cache.get(BASE, ASSET_ID)).toBe(UPLOADED);
    expect(countUploadCacheEntries(storage.area[FEATURE_IMAGE_UPLOAD_CACHE_KEY])).toBe(1);
    expect(await cache.get('https://other.example.com/ghost/api/admin/', ASSET_ID)).toBeNull();
  });

  it('tolerates a corrupt stored document instead of throwing', async () => {
    const storage = fakeStorageArea({ [FEATURE_IMAGE_UPLOAD_CACHE_KEY]: 'not-an-object' });
    const cache = createFeatureImageUploadCache(storage.api);
    expect(await cache.get(BASE, ASSET_ID)).toBeNull();
    await cache.set(BASE, ASSET_ID, UPLOADED);
    expect(await cache.get(BASE, ASSET_ID)).toBe(UPLOADED);
  });

  it('prunes the oldest entries so the memo cannot grow without bound', async () => {
    const storage = fakeStorageArea();
    let tick = 0;
    const cache = createFeatureImageUploadCache(storage.api, () => {
      tick += 1;
      return new Date(Date.UTC(2026, 0, 1, 0, 0, tick));
    });

    const total = MAX_UPLOAD_CACHE_ENTRIES + 5;
    for (let i = 0; i < total; i += 1) {
      const assetId = `img_${String(i).padStart(16, '0')}`;
      await cache.set(BASE, assetId, `http://localhost:2368/content/images/${i}.png`);
    }

    expect(countUploadCacheEntries(storage.area[FEATURE_IMAGE_UPLOAD_CACHE_KEY])).toBe(
      MAX_UPLOAD_CACHE_ENTRIES,
    );
    // The newest entry survives; the oldest is gone.
    expect(await cache.get(BASE, `img_${String(total - 1).padStart(16, '0')}`)).not.toBeNull();
    expect(await cache.get(BASE, 'img_0000000000000000')).toBeNull();
  });
});
