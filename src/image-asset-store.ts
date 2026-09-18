/**
 * Local image-asset store for preset feature images.
 *
 * WHY A SEPARATE STORE: a preset document lives in chrome.storage.local and is
 * bounded by MAX_IMPORT_BYTES (256 KB) — it is JSON, rewritten in one atomic
 * set() per mutation. A photo cannot live there: base64 inflates bytes by ~33%
 * and one 3 MB photo would exceed the whole document bound. chrome.storage.local
 * itself is also quota-limited (10 MB without `unlimitedStorage`).
 *
 * So the bytes live here, in IndexedDB owned by the EXTENSION origin (the
 * service worker and the options page share it), and the preset document only
 * carries a content-addressed id (`img_<sha256 prefix>`). Content addressing
 * means re-picking the same photo yields the same id, so presets referencing it
 * keep working and no duplicate copy is written.
 *
 * The content script cannot read this store directly (a content script's
 * storage belongs to the PAGE origin); it asks the service worker for the bytes
 * over the asset message channel. See `feature-image.ts`.
 */

/** Hard bound for one cached photo. Ghost's own upload limit is larger. */
export const MAX_IMAGE_ASSET_BYTES = 8 * 1024 * 1024;

/** Image types accepted both here and by Ghost's `images` upload endpoint. */
export const IMAGE_ASSET_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type ImageAssetErrorCode =
  | 'EMPTY_IMAGE'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'IMAGE_TOO_LARGE'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_STORE_UNAVAILABLE';

export class ImageAssetError extends Error {
  readonly code: ImageAssetErrorCode;
  constructor(code: ImageAssetErrorCode, message: string) {
    super(`image-asset-store: ${message}`);
    this.name = 'ImageAssetError';
    this.code = code;
  }
}

/** One cached photo. `data` is the raw image container (never base64). */
export interface ImageAssetRecord {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  data: ArrayBuffer;
}

/** Metadata view handed to the UI (no bytes). */
export interface ImageAssetMeta {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

/** Pluggable persistence so the store is testable without IndexedDB. */
export interface ImageAssetBackend {
  get(id: string): Promise<ImageAssetRecord | null>;
  put(record: ImageAssetRecord): Promise<void>;
  remove(id: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface ImageAssetStoreDeps {
  /** SHA-256 digest over the bytes; defaults to WebCrypto. */
  digest?: (data: ArrayBuffer) => Promise<ArrayBuffer>;
  /** Clock seam for deterministic tests. */
  now?: () => Date;
}

export interface ImageAssetStore {
  /** Validate + persist a photo, returning its content-addressed metadata. */
  putImage(input: {
    data: ArrayBuffer | Uint8Array;
    name: string;
    mimeType: string;
  }): Promise<ImageAssetMeta>;
  getRecord(id: string): Promise<ImageAssetRecord | null>;
  getMeta(id: string): Promise<ImageAssetMeta | null>;
  remove(id: string): Promise<void>;
  listMeta(): Promise<ImageAssetMeta[]>;
}

function toMeta(record: ImageAssetRecord): ImageAssetMeta {
  return {
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    bytes: record.bytes,
    sha256: record.sha256,
    createdAt: record.createdAt,
  };
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function defaultDigest(data: ArrayBuffer): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ImageAssetError('ASSET_STORE_UNAVAILABLE', 'WebCrypto digest is unavailable');
  }
  return subtle.digest('SHA-256', data);
}

/**
 * Normalize a client-supplied MIME type. Browsers sometimes report
 * `image/jpg`; Ghost treats it as JPEG, so accept the alias explicitly instead
 * of rejecting a legitimate photo.
 */
export function normalizeImageMimeType(value: string): string | null {
  const mime = value.trim().toLowerCase();
  const normalized = mime === 'image/jpg' ? 'image/jpeg' : mime;
  return (IMAGE_ASSET_MIME_TYPES as readonly string[]).includes(normalized) ? normalized : null;
}

export function createImageAssetStore(
  backend: ImageAssetBackend,
  deps: ImageAssetStoreDeps = {},
): ImageAssetStore {
  const digest = deps.digest ?? defaultDigest;
  const now = deps.now ?? (() => new Date());

  /** Validate one candidate photo; throws a typed ImageAssetError. */
  function validate(input: { data: ArrayBuffer | Uint8Array; mimeType: string }): {
    bytes: Uint8Array;
    mimeType: string;
  } {
    const bytes = toBytes(input.data);
    if (bytes.byteLength === 0) {
      throw new ImageAssetError('EMPTY_IMAGE', 'image is empty');
    }
    if (bytes.byteLength > MAX_IMAGE_ASSET_BYTES) {
      throw new ImageAssetError(
        'IMAGE_TOO_LARGE',
        `image is ${bytes.byteLength} bytes; the limit is ${MAX_IMAGE_ASSET_BYTES}`,
      );
    }
    const mimeType = normalizeImageMimeType(input.mimeType);
    if (!mimeType) {
      throw new ImageAssetError(
        'UNSUPPORTED_IMAGE_TYPE',
        `unsupported image type "${input.mimeType}" (use PNG, JPEG, WebP, or GIF)`,
      );
    }
    return { bytes, mimeType };
  }

  return {
    async putImage(input): Promise<ImageAssetMeta> {
      const { bytes, mimeType } = validate(input);
      // Copy into a standalone buffer: callers may hand us a view over a
      // larger ArrayBuffer that they keep mutating.
      const data = bytes.slice().buffer;
      const sha256 = toHex(await digest(data));
      const id = `img_${sha256.slice(0, 16)}`;
      const existing = await backend.get(id);
      if (existing) return toMeta(existing);
      const record: ImageAssetRecord = {
        id,
        name: input.name.trim().length > 0 ? input.name.trim() : `${id}.bin`,
        mimeType,
        bytes: data.byteLength,
        sha256,
        createdAt: now().toISOString(),
        data,
      };
      await backend.put(record);
      return toMeta(record);
    },

    getRecord(id) {
      return backend.get(id);
    },

    async getMeta(id) {
      const record = await backend.get(id);
      return record ? toMeta(record) : null;
    },

    remove(id) {
      return backend.remove(id);
    },

    async listMeta() {
      const keys = await backend.keys();
      const records = await Promise.all(keys.map((key) => backend.get(key)));
      return records.filter((r): r is ImageAssetRecord => r !== null).map(toMeta);
    },
  };
}

/* ------------------------------------------------------------------ */
/* IndexedDB backend (extension contexts only)                         */
/* ------------------------------------------------------------------ */

export const IMAGE_ASSET_DB_NAME = 'gcti-image-assets';
export const IMAGE_ASSET_DB_VERSION = 1;
export const IMAGE_ASSET_TABLE = 'images';

interface IdbLike {
  open(name: string, version: number): IDBOpenDBRequest;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
  });
}

/**
 * Build the real IndexedDB backend. Only valid in an extension context (the
 * service worker or an extension page) — never in a content script, whose
 * storage belongs to the page origin.
 */
export function createIndexedDbAssetBackend(idb?: IdbLike): ImageAssetBackend {
  const factory = idb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) {
    throw new ImageAssetError(
      'ASSET_STORE_UNAVAILABLE',
      'IndexedDB is unavailable in this context',
    );
  }
  const open: IdbLike = factory;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = open.open(IMAGE_ASSET_DB_NAME, IMAGE_ASSET_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IMAGE_ASSET_TABLE)) {
          db.createObjectStore(IMAGE_ASSET_TABLE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('could not open asset database'));
    });
    return dbPromise;
  }

  async function withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await openDb();
    const tx = db.transaction(IMAGE_ASSET_TABLE, mode);
    const result = await run(tx.objectStore(IMAGE_ASSET_TABLE));
    if (mode !== 'readonly') await transactionDone(tx);
    return result;
  }

  return {
    async get(id) {
      const record = await withStore('readonly', (store) =>
        requestToPromise<ImageAssetRecord | undefined>(store.get(id)),
      );
      return record ?? null;
    },
    async put(record) {
      await withStore('readwrite', async (store) => {
        await requestToPromise(store.put(record));
      });
    },
    async remove(id) {
      await withStore('readwrite', async (store) => {
        await requestToPromise(store.delete(id));
      });
    },
    async keys() {
      return withStore('readonly', (store) =>
        requestToPromise<IDBValidKey[]>(store.getAllKeys()).then((keys) => keys.map(String)),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Service-worker asset channel                                        */
/* ------------------------------------------------------------------ */

/**
 * Message identity for the asset channel. A content script runs in the PAGE's
 * storage origin, so it cannot read the extension's IndexedDB itself; it asks
 * the service worker (which owns the extension origin) for the bytes.
 *
 * chrome.runtime messaging is JSON-serialized, so bytes travel base64-encoded.
 * Only this extension's own contexts can send these messages (no
 * `externally_connectable` is declared), and the handler accepts exactly one
 * operation for one asset id.
 */
export const ASSET_MESSAGE_SOURCE = 'ghost-cms-template-injector/asset/v1';

export interface ImageAssetRequest {
  source: typeof ASSET_MESSAGE_SOURCE;
  op: 'getImageAsset';
  assetId: string;
}

export interface ImageAssetReply {
  ok: boolean;
  name?: string;
  mimeType?: string;
  base64?: string;
  error?: string;
}

export function isImageAssetRequest(value: unknown): value is ImageAssetRequest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m['source'] === ASSET_MESSAGE_SOURCE &&
    m['op'] === 'getImageAsset' &&
    typeof m['assetId'] === 'string' &&
    (m['assetId'] as string).length > 0
  );
}

/**
 * Build the service-worker-side responder for asset requests. Returns
 * `undefined` for anything that is not an asset request so the caller can fall
 * through to the popup/toolbar relay.
 */
export function createImageAssetResponder(
  store: ImageAssetStore,
): (message: unknown) => Promise<ImageAssetReply> | undefined {
  return (message: unknown) => {
    if (!isImageAssetRequest(message)) return undefined;
    return (async (): Promise<ImageAssetReply> => {
      try {
        const record = await store.getRecord(message.assetId);
        if (!record) {
          return { ok: false, error: `photo ${message.assetId} is not cached in this browser` };
        }
        return {
          ok: true,
          name: record.name,
          mimeType: record.mimeType,
          base64: bytesToBase64(new Uint8Array(record.data)),
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'asset store unavailable',
        };
      }
    })();
  };
}

/* ------------------------------------------------------------------ */
/* Base64 transport helpers (chrome.runtime messaging is JSON-safe)     */
/* ------------------------------------------------------------------ */

/** Encode bytes for a message payload (Chrome messaging is not byte-safe). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Decode a base64 payload back to bytes; throws on malformed input. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
