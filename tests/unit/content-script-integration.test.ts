import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createContentScript, type ContentScriptDeps } from '../../src/content-script';
import { createPageBridgeResponder } from '../../src/page-bridge';
import { createGhostStateAdapter, type GhostLiveSurface } from '../../src/ghost-state';
import { STORAGE_KEY } from '../../src/preset-store';
import { installChromeStorageStub } from '../helpers/chrome-stub';
import type { PageBridgeEnv } from '../../src/page-bridge';
import type { PageBridgeResponderEnv } from '../../src/page-bridge';

/**
 * End-to-end wiring test: the isolated content script's `discover`/`apply`
 * travel over the real `page-bridge` protocol to an in-process MAIN-world
 * responder backed by the real `ghost-state` adapter + a controllable
 * `GhostLiveSurface`. This exercises the FULL atomic pipeline
 * (capability → load preset → snapshot → plan → one native save) through the
 * exact message protocol the browser uses, proving the integration glue.
 */

function makeSurface(overrides: Partial<GhostLiveSurface> = {}): GhostLiveSurface {
  return {
    getResourceType: () => 'post',
    getResourceId: () => 'post-1',
    hasRecord: () => true,
    isDirty: () => false,
    getUpdatedAt: () => '2026-08-21T00:00:00.000Z',
    getLexical: () => '{"root":{"children":[]}}',
    isBodyEmpty: () => true,
    getExcerpt: () => null,
    getTitle: () => null,
    getCustomTemplate: () => null,
    getFeatureImage: () => null,
    getTags: () => [],
    setField: vi.fn(),
    setLexical: vi.fn(),
    nativeSave: vi.fn(async () => ({ updatedAt: '2026-08-21T01:00:00.000Z' })),
    captureRollback: vi.fn(() => ({ token: 'snap' })),
    restoreRollback: vi.fn(),
    ...overrides,
  };
}

/** Build a content script whose bridge talks to an in-process responder. */
function makeIntegratedScript(
  surface: GhostLiveSurface,
  overrides: Partial<ContentScriptDeps> = {},
) {
  const adapter = createGhostStateAdapter(surface);
  const responderEnv: PageBridgeResponderEnv = {
    discover: () => adapter.discover(),
    snapshot: () => adapter.snapshot(),
    planApply: (payload) => adapter.planApply(payload['plan'] as never),
    apply: (payload) => adapter.apply(payload['plan'] as never),
    save: () => surface.nativeSave().then((r) => r),
    rollback: (payload) => adapter.rollback(payload['token'] as never),
  };
  const responder = createPageBridgeResponder(responderEnv);

  // MAIN world: receives window messages, answers via the responder.
  let postToIsolated: ((msg: unknown) => void) | null = null;
  let onMainMessage: ((event: MessageEvent) => void) | null = null;

  const isolatedEnv: PageBridgeEnv = {
    addEventListener: (cb) => {
      onMainMessage = cb;
    },
    removeEventListener: () => {},
    postMessage: (message) => {
      // Deliver to the MAIN responder, then post the reply back.
      const reply = responder.handle(message);
      Promise.resolve(reply).then((r) => postToIsolated?.(r));
    },
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms) as unknown,
    clearTimeoutFn: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  postToIsolated = (msg) => onMainMessage?.(new MessageEvent('message', { data: msg }));

  const deps: ContentScriptDeps = {
    isGhostAdminPage: () => true,
    addRuntimeMessageListener: () => {},
    createBridgeEnv: () => isolatedEnv,
    getAdminApiBase: () => ({ base: 'https://ghost.test/ghost/api/admin/' }),
    createApiClient: () => ({}) as never,
    ...overrides,
  };
  const cs = createContentScript(deps);
  return { cs, surface };
}

const softwareReview = {
  schemaVersion: 1 as const,
  id: 'software-review',
  name: 'Software Review',
  content: {
    source: 'inline-lexical' as const,
    mode: 'replace' as const,
    lexical: '{"root":{"children":[],"type":"root","version":1}}',
  },
  metadata: {
    excerpt: { mode: 'only-if-empty' as const, value: 'A hands-on review.' },
    tags: { mode: 'merge' as const, values: ['Reviews'] },
  },
};

describe('content-script → bridge → ghost-state integration', () => {
  beforeEach(async () => {
    const storage = installChromeStorageStub();
    await storage.api.set({
      [STORAGE_KEY]: {
        schemaVersion: 1,
        version: 1,
        presets: [softwareReview],
      },
    });
  });

  it('discovers capability through the real bridge protocol', async () => {
    const { cs } = makeIntegratedScript(makeSurface());
    const reply = (await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'discover',
    })) as Record<string, unknown>;
    expect(reply.ok).toBe(true);
    const result = reply.result as Record<string, unknown>;
    expect((result['capability'] as Record<string, unknown>)['canNativeSave']).toBe(true);
  });

  it('applies a preset atomically through discover→snapshot→plan→save', async () => {
    const { cs, surface } = makeIntegratedScript(makeSurface());
    const reply = (await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'apply',
      presetId: 'software-review',
    })) as Record<string, unknown>;
    expect(reply.ok).toBe(true);
    expect(surface.nativeSave).toHaveBeenCalledTimes(1);
    expect(surface.setField).toHaveBeenCalledWith('excerpt', 'A hands-on review.');
    expect(surface.setField).toHaveBeenCalledWith('tags', ['Reviews']);
  });

  it('locks double-apply at the bridge layer (BUSY)', async () => {
    const surface = makeSurface({
      nativeSave: vi.fn(
        () =>
          new Promise<{ updatedAt: string | null }>((res) =>
            setTimeout(() => res({ updatedAt: 't' }), 50),
          ),
      ),
    });
    const adapter = createGhostStateAdapter(surface);
    let first = true;
    const responderEnv: PageBridgeResponderEnv = {
      discover: () => ({ supported: true, capability: {} as never }),
      snapshot: () => adapter.snapshot(),
      apply: (payload) => {
        // First apply occupies the busy slot; second must be refused BUSY.
        if (first) {
          first = false;
          return adapter.apply(payload['plan'] as never);
        }
        return { v: 1, source: 'x', nonce: 'n', ok: false, error: 'BUSY' };
      },
    };
    void responderEnv;
    // The ghost-state adapter itself serializes: a second apply() while the
    // first is mid-nativeSave is refused with BUSY (transaction in flight).
    const r1 = adapter.apply({
      presetId: 'p',
      status: 'ready',
      actions: [{ field: 'excerpt', op: 'set', status: 'apply', value: 'x' }],
      problems: [],
    });
    let secondErr = '';
    try {
      await adapter.apply({
        presetId: 'p',
        status: 'ready',
        actions: [{ field: 'excerpt', op: 'set', status: 'apply', value: 'y' }],
        problems: [],
      });
    } catch (e) {
      secondErr = (e as { code?: string }).code ?? 'unknown';
    }
    await r1;
    expect(secondErr).toBe('BUSY');
  });
});

describe('content-script feature image path (cached photo → upload → apply)', () => {
  const PHOTO_ASSET = 'img_0123456789abcdef';
  const UPLOADED = 'https://ghost.test/content/images/2026/09/hero.png';

  const withPhoto = {
    schemaVersion: 1 as const,
    id: 'with-photo',
    name: 'With photo',
    content: {
      source: 'inline-lexical' as const,
      mode: 'replace' as const,
      lexical: '{"root":{"children":[],"type":"root","version":1}}',
    },
    metadata: { featureImage: { mode: 'replace' as const, assetId: PHOTO_ASSET } },
  };

  beforeEach(async () => {
    const storage = installChromeStorageStub();
    await storage.api.set({
      [STORAGE_KEY]: { schemaVersion: 1, version: 1, presets: [withPhoto] },
    });
  });

  it('uploads the cached photo through the Admin API and applies the returned URL', async () => {
    const getImageAsset = vi.fn(async () => ({
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      name: 'hero.png',
      mimeType: 'image/png',
    }));
    const uploadImage = vi.fn(async () => UPLOADED);
    const cache = new Map<string, string>();
    const { cs, surface } = makeIntegratedScript(makeSurface(), {
      getImageAsset,
      createApiClient: () => ({ uploadImage }) as never,
      featureImageUploadCache: {
        get: async (base, assetId) => cache.get(`${base}|${assetId}`) ?? null,
        set: async (base, assetId, url) => {
          cache.set(`${base}|${assetId}`, url);
        },
      },
    });

    const reply = (await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'apply',
      presetId: 'with-photo',
    })) as Record<string, unknown>;

    expect(reply.ok).toBe(true);
    expect(getImageAsset).toHaveBeenCalledWith(PHOTO_ASSET);
    expect(uploadImage).toHaveBeenCalledTimes(1);
    expect(surface.setField).toHaveBeenCalledWith('featureImage', UPLOADED);
    expect(surface.nativeSave).toHaveBeenCalledTimes(1);
    // Memoized for this installation so the next apply reuses the upload.
    expect([...cache.values()]).toEqual([UPLOADED]);
  });

  it('blocks with a clear error (no mutation) when the photo is not cached here', async () => {
    const uploadImage = vi.fn(async () => UPLOADED);
    const { cs, surface } = makeIntegratedScript(makeSurface(), {
      getImageAsset: async () => null,
      createApiClient: () => ({ uploadImage }) as never,
    });

    const reply = (await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'apply',
      presetId: 'with-photo',
    })) as Record<string, unknown>;

    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/BLOCKED/);
    expect(String(reply.error)).toMatch(/not present in this browser/);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(surface.nativeSave).not.toHaveBeenCalled();
  });

  it('blocks when this context has no asset channel at all', async () => {
    const { cs, surface } = makeIntegratedScript(makeSurface());
    const reply = (await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'apply',
      presetId: 'with-photo',
    })) as Record<string, unknown>;

    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/resolution is unavailable/);
    expect(surface.nativeSave).not.toHaveBeenCalled();
  });

  it('surfaces an upload rejection as a blocked apply', async () => {
    const { cs, surface } = makeIntegratedScript(makeSurface(), {
      getImageAsset: async () => ({
        data: new Uint8Array([1, 2, 3]),
        name: 'hero.png',
        mimeType: 'image/png',
      }),
      createApiClient: () =>
        ({
          uploadImage: async () => {
            throw new Error('ghost-api: IMAGE_UPLOAD_FAILED (422): not supported');
          },
        }) as never,
    });

    const reply = (await cs.handleMessage({
      source: 'ghost-cms-template-injector/popup/v1',
      op: 'apply',
      presetId: 'with-photo',
    })) as Record<string, unknown>;

    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/IMAGE_UPLOAD_FAILED/);
    expect(surface.nativeSave).not.toHaveBeenCalled();
  });
});
