import { describe, expect, it } from 'vitest';

import {
  ASSET_MESSAGE_SOURCE,
  base64ToBytes,
  bytesToBase64,
  createImageAssetResponder,
  createImageAssetStore,
  ImageAssetError,
  isImageAssetRequest,
  MAX_IMAGE_ASSET_BYTES,
  normalizeImageMimeType,
  type ImageAssetBackend,
  type ImageAssetRecord,
} from '../../src/image-asset-store';
import { IMAGE_ASSET_ID_PATTERN } from '../../src/preset-schema';

/** In-memory backend mirroring the IndexedDB contract. */
function memoryBackend(): ImageAssetBackend & { records: Map<string, ImageAssetRecord> } {
  const records = new Map<string, ImageAssetRecord>();
  return {
    records,
    get: async (id) => records.get(id) ?? null,
    put: async (record) => {
      records.set(record.id, record);
    },
    remove: async (id) => {
      records.delete(id);
    },
    keys: async () => [...records.keys()],
  };
}

function store() {
  const backend = memoryBackend();
  return { backend, api: createImageAssetStore(backend) };
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('image asset store — content-addressed photo cache', () => {
  it('stores a photo under a content-addressed id and reads the exact bytes back', async () => {
    const { api } = store();
    const meta = await api.putImage({ data: PNG_BYTES, name: 'hero.png', mimeType: 'image/png' });

    expect(meta.id).toMatch(IMAGE_ASSET_ID_PATTERN);
    expect(meta.bytes).toBe(PNG_BYTES.byteLength);
    expect(meta.mimeType).toBe('image/png');
    expect(meta.name).toBe('hero.png');
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);

    const record = await api.getRecord(meta.id);
    expect(record).not.toBeNull();
    expect([...new Uint8Array(record!.data)]).toEqual([...PNG_BYTES]);
  });

  it('deduplicates identical photos so repeat picks reuse one cached copy', async () => {
    const { backend, api } = store();
    const first = await api.putImage({ data: PNG_BYTES, name: 'a.png', mimeType: 'image/png' });
    const second = await api.putImage({ data: PNG_BYTES, name: 'b.png', mimeType: 'image/png' });

    expect(second.id).toBe(first.id);
    expect(backend.records.size).toBe(1);
    // The first name wins; the id is what presets reference.
    expect((await api.getRecord(first.id))?.name).toBe('a.png');
  });

  it('does not expose bytes the caller mutates after storing', async () => {
    const { api } = store();
    const source = new Uint8Array(PNG_BYTES);
    const meta = await api.putImage({ data: source, name: 'x.png', mimeType: 'image/png' });
    source[0] = 0xff;

    const record = await api.getRecord(meta.id);
    expect(new Uint8Array(record!.data)[0]).toBe(0x89);
  });

  it('rejects empty, oversized, and non-image payloads with typed errors', async () => {
    const { api } = store();
    const code = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        throw new Error('expected rejection');
      } catch (error) {
        if (!(error instanceof ImageAssetError)) throw error;
        return error.code;
      }
    };

    expect(
      await code(() =>
        api.putImage({ data: new Uint8Array(0), name: 'e.png', mimeType: 'image/png' }),
      ),
    ).toBe('EMPTY_IMAGE');
    expect(
      await code(() =>
        api.putImage({
          data: new Uint8Array(MAX_IMAGE_ASSET_BYTES + 1),
          name: 'big.png',
          mimeType: 'image/png',
        }),
      ),
    ).toBe('IMAGE_TOO_LARGE');
    expect(
      await code(() => api.putImage({ data: PNG_BYTES, name: 'x.svg', mimeType: 'image/svg+xml' })),
    ).toBe('UNSUPPORTED_IMAGE_TYPE');
  });

  it('normalizes the browser image/jpg alias and lists metadata without bytes', async () => {
    expect(normalizeImageMimeType('image/jpg')).toBe('image/jpeg');
    expect(normalizeImageMimeType('image/svg+xml')).toBeNull();

    const { api } = store();
    const meta = await api.putImage({ data: PNG_BYTES, name: 'photo.jpg', mimeType: 'image/jpg' });
    const list = await api.listMeta();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(meta.id);
    expect(Object.keys(list[0] ?? {})).not.toContain('data');
  });

  it('removes a cached photo', async () => {
    const { api } = store();
    const meta = await api.putImage({ data: PNG_BYTES, name: 'gone.png', mimeType: 'image/png' });
    await api.remove(meta.id);
    expect(await api.getRecord(meta.id)).toBeNull();
  });
});

describe('image asset channel — service worker ↔ content script', () => {
  it('accepts only the fixed asset request shape', () => {
    expect(
      isImageAssetRequest({ source: ASSET_MESSAGE_SOURCE, op: 'getImageAsset', assetId: 'img_1' }),
    ).toBe(true);
    expect(
      isImageAssetRequest({ source: ASSET_MESSAGE_SOURCE, op: 'other', assetId: 'img_1' }),
    ).toBe(false);
    expect(isImageAssetRequest({ source: 'popup', op: 'getImageAsset', assetId: 'img_1' })).toBe(
      false,
    );
    expect(isImageAssetRequest({ source: ASSET_MESSAGE_SOURCE, op: 'getImageAsset' })).toBe(false);
    expect(isImageAssetRequest('nope')).toBe(false);
  });

  it('answers an asset request with base64 bytes and metadata', async () => {
    const { api } = store();
    const meta = await api.putImage({ data: PNG_BYTES, name: 'hero.png', mimeType: 'image/png' });
    const respond = createImageAssetResponder(api);

    const reply = await respond({
      source: ASSET_MESSAGE_SOURCE,
      op: 'getImageAsset',
      assetId: meta.id,
    });
    expect(reply?.ok).toBe(true);
    expect(reply?.mimeType).toBe('image/png');
    expect([...base64ToBytes(reply?.base64 ?? '')]).toEqual([...PNG_BYTES]);
  });

  it('reports a missing photo instead of a silent empty reply', async () => {
    const { api } = store();
    const respond = createImageAssetResponder(api);
    const reply = await respond({
      source: ASSET_MESSAGE_SOURCE,
      op: 'getImageAsset',
      assetId: 'img_0000000000000000',
    });
    expect(reply?.ok).toBe(false);
    expect(reply?.error).toMatch(/not cached/i);
  });

  it('ignores non-asset messages so the popup/toolbar relay can handle them', () => {
    const { api } = store();
    const respond = createImageAssetResponder(api);
    expect(respond({ source: 'popup', op: 'discover' })).toBeUndefined();
  });
});

describe('base64 transport helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    const decoded = base64ToBytes(bytesToBase64(bytes));
    expect(decoded.byteLength).toBe(bytes.byteLength);
    expect(decoded[0]).toBe(0);
    expect(decoded[69_999]).toBe(69_999 % 256);
  });

  it('throws on malformed base64', () => {
    expect(() => base64ToBytes('not base64!!')).toThrow();
  });
});
