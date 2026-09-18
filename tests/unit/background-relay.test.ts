import { describe, expect, it, vi } from 'vitest';
import { createRelay, createRuntimeMessageDispatcher } from '../../src/background';
import {
  ASSET_MESSAGE_SOURCE,
  base64ToBytes,
  createImageAssetStore,
} from '../../src/image-asset-store';
import { POPUP_MESSAGE_SOURCE } from '../../src/ui-popup';

/** Minimal structural sender the relay inspects (only `tab.id` matters). */
type RelaySender = { tab?: { id?: number } };
type RelayHandler = (
  message: unknown,
  sender: RelaySender,
  sendResponse: (response: unknown) => void,
) => boolean;

/** Capture the SW's runtime.onMessage handler and drive it in-process. */
function makeRelay(sendTabMessage: ReturnType<typeof vi.fn>) {
  let handler: RelayHandler | null = null;
  const relay = createRelay({
    addRuntimeMessageListener: (cb) => {
      handler = cb;
    },
    sendTabMessage,
  });
  relay.init();
  return {
    handler: () => handler as RelayHandler,
  };
}

/** Invoke the captured handler the way `chrome` would, resolving sendResponse. */
function invoke(handler: RelayHandler, message: unknown, sender: RelaySender): Promise<unknown> {
  return new Promise((resolve) => {
    handler(message, sender, (response) => resolve(response));
  });
}

const validDiscover = {
  source: POPUP_MESSAGE_SOURCE,
  op: 'discover',
  tabId: 'payload-tab-id-is-ignored',
} as const;

const validApply = {
  source: POPUP_MESSAGE_SOURCE,
  op: 'apply',
  tabId: 'payload-tab-id-is-ignored',
  presetId: 'software-review',
} as const;

describe('background SW runtime.onMessage relay', () => {
  it('returns true to keep the message channel open for async reply', () => {
    const sendTabMessage = vi.fn();
    const { handler } = makeRelay(sendTabMessage);
    const ret = handler()(validDiscover, { tab: { id: 42 } }, () => {});
    expect(ret).toBe(true);
  });

  it('forwards a valid discover message to sender.tab.id (ignoring payload tabId)', async () => {
    const sendTabMessage = vi.fn().mockResolvedValue({ source: POPUP_MESSAGE_SOURCE, ok: true });
    const { handler } = makeRelay(sendTabMessage);
    const response = await invoke(handler(), validDiscover, { tab: { id: 42 } });
    expect(sendTabMessage).toHaveBeenCalledTimes(1);
    expect(sendTabMessage).toHaveBeenCalledWith(42, validDiscover);
    // The content-script reply is threaded straight through to sendResponse.
    expect(response).toEqual({ source: POPUP_MESSAGE_SOURCE, ok: true });
  });

  it('forwards a valid apply message to sender.tab.id', async () => {
    const sendTabMessage = vi
      .fn()
      .mockResolvedValue({ source: POPUP_MESSAGE_SOURCE, ok: true, result: { applied: true } });
    const { handler } = makeRelay(sendTabMessage);
    const response = await invoke(handler(), validApply, { tab: { id: 7 } });
    expect(sendTabMessage).toHaveBeenCalledTimes(1);
    expect(sendTabMessage).toHaveBeenCalledWith(7, validApply);
    expect(response).toEqual({ source: POPUP_MESSAGE_SOURCE, ok: true, result: { applied: true } });
  });

  it('never forwards a message whose source is not the fixed popup identity', async () => {
    const sendTabMessage = vi.fn();
    const { handler } = makeRelay(sendTabMessage);
    const response = await invoke(
      handler(),
      { source: 'evil-origin', op: 'discover' },
      { tab: { id: 42 } },
    );
    expect(sendTabMessage).not.toHaveBeenCalled();
    expect(response).toMatchObject({ relay: 'rejected', reason: 'SCHEMA_MISMATCH' });
  });

  it('never forwards an unknown operation', async () => {
    const sendTabMessage = vi.fn();
    const { handler } = makeRelay(sendTabMessage);
    const response = await invoke(
      handler(),
      { source: POPUP_MESSAGE_SOURCE, op: 'exfiltrate' },
      { tab: { id: 42 } },
    );
    expect(sendTabMessage).not.toHaveBeenCalled();
    expect(response).toMatchObject({ relay: 'rejected', reason: 'SCHEMA_MISMATCH' });
  });

  it('rejects a message with no sender tab (cannot relay same-tab)', async () => {
    const sendTabMessage = vi.fn();
    const { handler } = makeRelay(sendTabMessage);
    const response = await invoke(handler(), validDiscover, {});
    expect(sendTabMessage).not.toHaveBeenCalled();
    expect(response).toMatchObject({ relay: 'rejected', reason: 'NO_SENDER_TAB' });
  });

  it('rejects a message whose sender tab has no numeric id', async () => {
    const sendTabMessage = vi.fn();
    const { handler } = makeRelay(sendTabMessage);
    const response = await invoke(handler(), validDiscover, { tab: {} });
    expect(sendTabMessage).not.toHaveBeenCalled();
    expect(response).toMatchObject({ relay: 'rejected', reason: 'NO_SENDER_TAB' });
  });

  it('forwards the read-only import operations', async () => {
    for (const message of [
      { source: POPUP_MESSAGE_SOURCE, op: 'listPosts' },
      { source: POPUP_MESSAGE_SOURCE, op: 'capture' },
      { source: POPUP_MESSAGE_SOURCE, op: 'capturePost', resourceType: 'page', resourceId: 'x1' },
      { source: POPUP_MESSAGE_SOURCE, op: 'preview', presetId: 'p1' },
      { source: POPUP_MESSAGE_SOURCE, op: 'undo' },
    ]) {
      const sendTabMessage = vi.fn().mockResolvedValue({ source: POPUP_MESSAGE_SOURCE, ok: true });
      const { handler } = makeRelay(sendTabMessage);
      const response = await invoke(handler(), message, { tab: { id: 11 } });
      expect(sendTabMessage).toHaveBeenCalledWith(11, message);
      expect(response).toEqual({ source: POPUP_MESSAGE_SOURCE, ok: true });
    }
  });

  it('threads a tab-send failure into sendResponse as a relay error', async () => {
    const sendTabMessage = vi.fn().mockRejectedValue(new Error('tab gone'));
    const { handler } = makeRelay(sendTabMessage);
    const response = await invoke(handler(), validDiscover, { tab: { id: 42 } });
    expect(response).toMatchObject({ relay: 'error', reason: 'tab gone' });
  });

  it('init is idempotent — installs the listener exactly once', () => {
    let count = 0;
    const relay = createRelay({
      addRuntimeMessageListener: () => {
        count += 1;
      },
      sendTabMessage: vi.fn(),
    });
    relay.init();
    relay.init();
    expect(count).toBe(1);
  });
});

/** One runtime.onMessage listener serves both message families. */
function makeDispatcher(
  assetStore: Parameters<typeof createRuntimeMessageDispatcher>[0]['assetStore'],
) {
  const relayHandler = vi.fn((_m: unknown, _s: unknown, sendResponse: (r: unknown) => void) => {
    sendResponse({ relayed: 'popup' });
    return true;
  });
  const dispatch = createRuntimeMessageDispatcher({
    assetStore,
    relay: { handleMessage: relayHandler },
  });
  return { dispatch, relayHandler };
}

function assetStoreWith(
  record: { name: string; mimeType: string; data: ArrayBuffer } | null,
  failure?: Error,
) {
  return createImageAssetStore({
    get: async () => {
      if (failure) throw failure;
      if (!record) return null;
      return {
        id: 'img_0123456789abcdef',
        name: record.name,
        mimeType: record.mimeType,
        bytes: record.data.byteLength,
        sha256: 'a'.repeat(64),
        createdAt: '2026-09-17T10:00:00.000Z',
        data: record.data,
      };
    },
    put: async () => {},
    remove: async () => {},
    keys: async () => [],
  });
}

describe('service worker dispatcher — asset channel vs popup relay', () => {
  it('answers an asset request with base64 bytes and does not touch the relay', async () => {
    const { dispatch, relayHandler } = makeDispatcher(
      assetStoreWith({
        name: 'hero.png',
        mimeType: 'image/png',
        data: new Uint8Array([1, 2, 3]).buffer,
      }),
    );

    const reply = (await invoke(
      dispatch as RelayHandler,
      { source: ASSET_MESSAGE_SOURCE, op: 'getImageAsset', assetId: 'img_0123456789abcdef' },
      { tab: { id: 7 } },
    )) as Record<string, unknown>;

    expect(reply).toMatchObject({ ok: true, name: 'hero.png', mimeType: 'image/png' });
    expect(base64ToBytes(String(reply['base64']))).toEqual(new Uint8Array([1, 2, 3]));
    expect(relayHandler).not.toHaveBeenCalled();
  });

  it('reports a missing photo and a store failure instead of an empty reply', async () => {
    const missing = makeDispatcher(assetStoreWith(null));
    const missReply = (await invoke(
      missing.dispatch as RelayHandler,
      { source: ASSET_MESSAGE_SOURCE, op: 'getImageAsset', assetId: 'img_0123456789abcdef' },
      {},
    )) as Record<string, unknown>;
    expect(missReply['ok']).toBe(false);
    expect(String(missReply['error'])).toMatch(/not cached/i);

    const broken = makeDispatcher(assetStoreWith(null, new Error('indexedDB unavailable')));
    const brokenReply = (await invoke(
      broken.dispatch as RelayHandler,
      { source: ASSET_MESSAGE_SOURCE, op: 'getImageAsset', assetId: 'img_0123456789abcdef' },
      {},
    )) as Record<string, unknown>;
    expect(brokenReply['ok']).toBe(false);
    expect(String(brokenReply['error'])).toMatch(/indexedDB unavailable/);
  });

  it('still relays the popup/toolbar protocol', async () => {
    const { dispatch, relayHandler } = makeDispatcher(assetStoreWith(null));
    const reply = await invoke(
      dispatch as RelayHandler,
      { source: POPUP_MESSAGE_SOURCE, op: 'discover' },
      { tab: { id: 3 } },
    );
    expect(reply).toEqual({ relayed: 'popup' });
    expect(relayHandler).toHaveBeenCalledTimes(1);
  });
});
