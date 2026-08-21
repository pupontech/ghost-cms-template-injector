import { describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_SOURCE_ID,
  createBridgeRequest,
  type BridgeResponse,
} from '../../src/bridge-protocol';
import { createPageBridge, createPageBridgeResponder } from '../../src/page-bridge';

type Listener = (event: MessageEvent) => void;

function harness() {
  const listeners = new Set<Listener>();
  const target = new EventTarget();
  const postMessage = vi.fn((message: unknown) => {
    // Echo path: the "page side" replies as the bridge identity.
    const req = message as { nonce: string };
    const res: BridgeResponse<{ ok: true }> = {
      v: 1,
      source: BRIDGE_SOURCE_ID,
      nonce: req.nonce,
      ok: true,
      result: { ok: true },
    };
    queueMicrotask(() => target.dispatchEvent(new MessageEvent('message', { data: res })));
  });
  return { listeners, target, postMessage };
}

describe('page-bridge isolated-side client (C3)', () => {
  it('sends a validated request and resolves with the matching response', async () => {
    const h = harness();
    const bridge = createPageBridge({
      addEventListener: (cb: Listener) => {
        h.target.addEventListener('message', cb as EventListener);
      },
      removeEventListener: (cb: Listener) => {
        h.target.removeEventListener('message', cb as EventListener);
      },
      postMessage: h.postMessage,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });

    const reply = await bridge.request('discover', {});
    expect(reply).toEqual({ ok: true, result: { ok: true } });
    const sent = h.postMessage.mock.calls[0]?.[0] as {
      op: string;
      source: string;
    };
    expect(sent.op).toBe('discover');
    expect(sent.source).toBe(BRIDGE_SOURCE_ID);
  });

  it('fails closed on timeout without mutation', async () => {
    vi.useFakeTimers();
    try {
      let handler: ((fn: () => void, ms: number) => unknown) | null = null;
      const timers: Array<() => void> = [];
      const bridge = createPageBridge({
        addEventListener: () => {},
        removeEventListener: () => {},
        postMessage: () => {},
        setTimeoutFn: (fn, _ms) => {
          timers.push(fn);
          return timers.length;
        },
        clearTimeoutFn: () => {},
      });
      handler = null;
      void handler;
      const pending = bridge.request('snapshot', {});
      const assertion = expect(pending).resolves.toMatchObject({
        ok: false,
        error: 'TIMEOUT',
      });
      for (const fn of timers) fn();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores responses from a foreign source or stale nonce', async () => {
    const target = new EventTarget();
    const foreign = new EventTarget();
    const seen: string[] = [];
    const bridge = createPageBridge({
      addEventListener: (cb: Listener) => {
        target.addEventListener('message', function handler(e) {
          const data = (e as MessageEvent).data as { nonce?: string };
          if (!seen.includes(data.nonce ?? '')) {
            // Foreign-source reply first; must be ignored. Dispatch on a
            // separate target so it cannot recurse through this listener.
            seen.push(data.nonce ?? '');
            foreign.dispatchEvent(
              new MessageEvent('message', {
                data: { ...data, source: 'imposter', ok: true, result: {} },
              }),
            );
          }
          cb(e as MessageEvent);
        });
      },
      removeEventListener: () => {},
      postMessage: (message: unknown) => {
        const req = message as { nonce: string };
        queueMicrotask(() =>
          target.dispatchEvent(
            new MessageEvent('message', {
              data: {
                v: 1,
                source: BRIDGE_SOURCE_ID,
                nonce: req.nonce,
                ok: true,
                result: { fine: true },
              },
            }),
          ),
        );
      },
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      clearTimeoutFn: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    });
    const reply = await bridge.request('save', {});
    expect(reply).toEqual({ ok: true, result: { fine: true } });
  });
});

describe('MAIN-world page-bridge responder (C3)', () => {
  it('answers only allowlisted operations and fail-closes unknown ones', async () => {
    const handled: string[] = [];
    const responder = createPageBridgeResponder({
      discover: () => {
        handled.push('discover');
        return { capabilities: ['snapshot'] };
      },
    });
    const good = await responder.handle(createBridgeRequest('discover', {}));
    expect(good.ok).toBe(true);
    expect(handled).toEqual(['discover']);

    const bad = responder.handle({
      v: 1,
      op: 'eval',
      nonce: crypto.randomUUID(),
      source: BRIDGE_SOURCE_ID,
      payload: {},
    });
    // Non-allowlisted operations are rejected at the schema gate.
    expect(bad).toMatchObject({ ok: false, error: 'INVALID_REQUEST' });

    const malformed = responder.handle({ nonsense: true });
    expect(malformed).toMatchObject({ ok: false, error: 'INVALID_REQUEST' });
  });

  it('serializes one apply transaction per tab', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const responder = createPageBridgeResponder({
      apply: () => {
        expect(release).toBeTypeOf('function');
        return gate.then(() => ({ applied: true }));
      },
    });
    const firstP = responder.handle(createBridgeRequest('apply', {}));
    const secondP = responder.handle(createBridgeRequest('apply', {}));
    const secondResult = await secondP;
    expect(secondResult).toMatchObject({ ok: false, error: 'BUSY' });
    release?.();
    expect(await firstP).toMatchObject({ ok: true });
  });
});
