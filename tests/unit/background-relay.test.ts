import { describe, expect, it, vi } from 'vitest';
import { createRelay } from '../../src/background';
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
