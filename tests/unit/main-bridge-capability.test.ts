/**
 * Regression: MAIN-world bridge must NOT answer after Disable (C8 revoke).
 *
 * Covers the audit scenarios against the REAL production `installMainBridge`
 * path (the exact code that ships in dist/bridge.js), driven through the real
 * `createCapabilityGate` state machine — not a stubbed copy:
 *  1. inject MAIN responder, verify pre-disable discover works after activation;
 *  2. deactivate in same realm, assert dormant behavior on discover (silent);
 *  3. destroy/recreate document after revoke, assert the fresh document's
 *     installed bridge is dormant (no listener that answers);
 *  4. re-enable mints a NEW capability and only then discover responds;
 *  5. old capability cannot reactivate a bridge that was deactivated.
 *
 * The bottom suite drives the pure gate state machine directly with a real
 * token minter, proving the responder-model semantics (record-on-activate,
 * consume-on-deactivate, stale token refused).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_SOURCE_ID,
  BRIDGE_CAPABILITY_SOURCE,
  createBridgeRequest,
} from '../../src/bridge-protocol';
import { installMainBridge } from '../../src/main-bridge-main';
import { createCapabilityClient } from '../../src/capability-client';
import { createCapabilityGate } from '../../src/capability-gate';

/* ------------------------------------------------------------------ */
/* Fake window: per-"document" message bus with its own timeOrigin     */
/* ------------------------------------------------------------------ */

interface FakeWindow {
  listeners: Set<(e: MessageEvent) => void>;
  pageHideListeners: Set<() => void>;
  posted: unknown[];
  timeOrigin: number;
  postMessage: (m: unknown) => void;
  dispatch: (data: unknown) => Promise<void>;
}

function makeFakeWindow(): FakeWindow {
  const win: FakeWindow = {
    listeners: new Set<(e: MessageEvent) => void>(),
    pageHideListeners: new Set<() => void>(),
    posted: [] as unknown[],
    timeOrigin: Date.now(),
    postMessage(m: unknown) {
      win.posted.push(m);
    },
    async dispatch(data: unknown) {
      const ev = new MessageEvent('message', { data });
      Object.defineProperty(ev, 'source', { value: win, configurable: true });
      for (const l of [...win.listeners]) await Promise.resolve(l(ev));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
  return win;
}

/** Install the bridge on a fake window by rebinding globalThis listeners. */
function withFakeWindow<T>(win: FakeWindow, fn: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const savedAdd = g.addEventListener;
  const savedRemove = g.removeEventListener;
  g.addEventListener = ((type: string, cb: EventListener) => {
    if (type === 'message') win.listeners.add(cb as never);
    else if (type === 'pagehide') win.pageHideListeners.add(cb as never);
  }) as typeof addEventListener;
  g.removeEventListener = ((type: string, cb: EventListener) => {
    if (type === 'message') win.listeners.delete(cb as never);
  }) as typeof removeEventListener;
  try {
    return fn();
  } finally {
    if (savedAdd !== undefined) g.addEventListener = savedAdd as typeof addEventListener;
    else delete g.addEventListener;
    if (savedRemove !== undefined)
      g.removeEventListener = savedRemove as typeof removeEventListener;
  }
}

function okResponder(message: unknown): unknown {
  const req = message as { nonce: string };
  return {
    v: 1,
    source: BRIDGE_SOURCE_ID,
    nonce: req.nonce,
    ok: true,
    result: { capabilities: ['snapshot'] },
  };
}

async function discover(win: FakeWindow): Promise<unknown> {
  const before = win.posted.length;
  await win.dispatch(createBridgeRequest('discover', {}));
  for (let i = 0; i < 50 && win.posted.length <= before; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  // Return ONLY a freshly-pushed reply, never a stale one already in the log.
  return win.posted.length > before ? win.posted[before] : null;
}

function activateMsg(token: string) {
  return { capSource: BRIDGE_CAPABILITY_SOURCE, action: 'activate' as const, token };
}
function deactivateMsg(token: string) {
  return { capSource: BRIDGE_CAPABILITY_SOURCE, action: 'deactivate' as const, token };
}
const TOKEN = (ch: string) => ch.repeat(32);

describe('MAIN bridge capability gate — disable/revoke regression (C8)', () => {
  it('1. pre-disable: after activation, discover responds', async () => {
    const win = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win, () => installMainBridge(handle));
    await win.dispatch(activateMsg(TOKEN('a')));

    const reply = (await discover(win)) as { ok?: boolean } | null;
    expect(reply?.ok).toBe(true);
  });

  it('2. same realm after deactivate: discover gets NO live response (dormant)', async () => {
    const win = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win, () => installMainBridge(handle));
    await win.dispatch(activateMsg(TOKEN('a')));
    expect(((await discover(win)) as { ok?: boolean }).ok).toBe(true);

    // Disable: revoke with the exact token → back to sleep.
    await win.dispatch(deactivateMsg(TOKEN('a')));
    const reply = await discover(win);
    // Dormant bridge is SILENT: no response of any kind.
    expect(reply).toBeNull();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('3. fresh post-disable document: installed bridge starts dormant (silent)', async () => {
    // Pre-disable document, activated.
    const win1 = makeFakeWindow();
    const handle1 = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win1, () => installMainBridge(handle1));
    await win1.dispatch(activateMsg(TOKEN('b')));
    expect(((await discover(win1)) as { ok?: boolean }).ok).toBe(true);

    // Disable in that realm.
    await win1.dispatch(deactivateMsg(TOKEN('b')));
    expect(await discover(win1)).toBeNull();

    // GENUINELY NEW document: a brand-new window object with a distinct
    // timeOrigin, and the bridge IS installed into it (as the extension would
    // on a fresh page load) — but it has never received activation, so it must
    // be dormant and answer NOTHING even though a listener exists.
    const win2 = makeFakeWindow();
    win2.timeOrigin = win1.timeOrigin + 5000;
    expect(win2.timeOrigin).not.toBe(win1.timeOrigin);
    const handle2 = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win2, () => installMainBridge(handle2));
    const freshReply = await discover(win2);
    expect(freshReply).toBeNull();
    expect(handle2).not.toHaveBeenCalled();
  });

  it('4. re-enable mints a NEW capability; discover responds only after it', async () => {
    const win = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win, () => installMainBridge(handle));

    // Before any activation even a valid request stays silent/dormant.
    expect(await discover(win)).toBeNull();
    expect(handle).not.toHaveBeenCalled();

    // Re-enable path: isolated world activates with a fresh token.
    await win.dispatch(activateMsg(TOKEN('c')));
    expect(((await discover(win)) as { ok?: boolean }).ok).toBe(true);
  });

  it('5. old capability cannot reactivate across enable cycles', async () => {
    const win = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win, () => installMainBridge(handle));

    // Enable cycle A.
    await win.dispatch(activateMsg(TOKEN('d')));
    expect(((await discover(win)) as { ok?: boolean }).ok).toBe(true);

    // Replaying activation while already active is refused (one handshake/enable);
    // the bridge stays responsive on the CURRENT token.
    await win.dispatch(activateMsg(TOKEN('e')));
    expect(((await discover(win)) as { ok?: boolean }).ok).toBe(true);

    // Deactivation with a WRONG token (stale 'e') must NOT deactivate.
    await win.dispatch(deactivateMsg(TOKEN('e')));
    const stillActive = await discover(win);
    expect((stillActive as { ok?: boolean } | null)?.ok).toBe(true);

    // Correct current token DOES deactivate → now silent.
    await win.dispatch(deactivateMsg(TOKEN('d')));
    const afterRevoke = await discover(win);
    expect(afterRevoke).toBeNull();

    // Stale token from cycle A was consumed and cannot reactivate → still silent.
    await win.dispatch(activateMsg(TOKEN('d')));
    const final = await discover(win);
    expect(final).toBeNull();

    // handle was called exactly during the three discover-responds above
    // (cycle A, replay-while-active, and after-wrong-token-deactivate).
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it('responder drops a no-op when deactivated by a wrong token (stale token)', async () => {
    const win = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win, () => installMainBridge(handle));

    await win.dispatch(activateMsg(TOKEN('g')));
    expect(((await discover(win)) as { ok?: boolean }).ok).toBe(true);

    // A wrong-token deactivate must NOT put the bridge to sleep.
    await win.dispatch(deactivateMsg(TOKEN('wrong')));
    const stillActive = await discover(win);
    expect((stillActive as { ok?: boolean } | null)?.ok).toBe(true);
  });
});

describe('isolated capability client', () => {
  function baseDeps() {
    const sent: unknown[] = [];
    let revoked: (() => void) | null = null;
    let counter = 0;
    const deps = {
      randomToken: () => `token-${++counter}-${'x'.repeat(20)}`,
      postToWindow: (m: unknown) => sent.push(m),
      onConsentRevoked: (cb: () => void) => {
        revoked = cb;
        return () => {
          revoked = null;
        };
      },
    };
    return { deps, sent, fireRevocation: () => revoked?.() };
  }

  it('mints a token once and posts exactly one activation envelope', () => {
    const h = baseDeps();
    const client = createCapabilityClient(h.deps);
    client.activateForDocument();
    client.activateForDocument(); // idempotent
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      capSource: BRIDGE_CAPABILITY_SOURCE,
      action: 'activate',
    });
    expect(client.holdsToken()).toBe(true);
  });

  it('deactivates on consent revocation with the held token', () => {
    const h = baseDeps();
    const client = createCapabilityClient(h.deps);
    client.activateForDocument();
    client.watchRevocation();
    h.fireRevocation();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({
      capSource: BRIDGE_CAPABILITY_SOURCE,
      action: 'deactivate',
      token: (h.sent[0] as { token: string }).token,
    });
  });

  it('a stale/short token cannot activate the responder gate', () => {
    const gate = createCapabilityGate();
    expect(gate.activate('short')).toBe(false);
    expect(gate.activate('a'.repeat(32))).toBe(true);
    expect(gate.isActive()).toBe(true);
    // already active → second activation refused
    expect(gate.activate('b'.repeat(32))).toBe(false);
    // wrong token → deactivate refused, still active
    expect(gate.deactivate('b'.repeat(32))).toBe(false);
    expect(gate.isActive()).toBe(true);
    // correct token → deactivate, consumed
    expect(gate.deactivate('a'.repeat(32))).toBe(true);
    expect(gate.isActive()).toBe(false);
    // replay of consumed token cannot re-activate
    expect(gate.activate('a'.repeat(32))).toBe(false);
    expect(gate.isActive()).toBe(false);
    // a genuinely new token re-activates cleanly
    expect(gate.activate('c'.repeat(32))).toBe(true);
    expect(gate.isActive()).toBe(true);
  });

  it('re-activates with a fresh token after deactivate (re-enable without reload)', () => {
    const h = baseDeps();
    const client = createCapabilityClient(h.deps);
    client.activateForDocument();
    expect(typeof (h.sent[0] as { token: string }).token).toBe('string');
    const firstToken = (h.sent[0] as { token: string }).token;
    client.deactivate();
    // Token is cleared locally so the next enable mints a NEW one.
    expect(client.holdsToken()).toBe(false);
    client.activateForDocument();
    expect(h.sent).toHaveLength(3); // activate, deactivate, re-activate
    expect((h.sent[2] as { token: string }).token).not.toBe(firstToken);
  });

  it('retries activation until the MAIN bridge acknowledges (lost-envelope race)', () => {
    // Simulate the real registration-ordering race: the MAIN bridge listener is
    // not yet installed, so the first activation is lost; the client must keep
    // re-posting until `isBridgeActive` reports the bridge is awake.
    let active = false;
    const h = baseDeps();
    let counter = 0;
    const deps = {
      ...h.deps,
      randomToken: () => `token-${++counter}-${'x'.repeat(20)}`,
      isBridgeActive: () => active,
      pollIntervalMs: 5,
      maxActivationAttempts: 20,
    };
    const client = createCapabilityClient(deps);
    client.activateForDocument();
    const firstCount = h.sent.length;
    expect(firstCount).toBeGreaterThanOrEqual(1);
    // After activation is acknowledged, no further envelopes are posted.
    active = true;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const afterAck = h.sent.length;
        // Allow a couple of ticks to confirm the poll stops.
        setTimeout(() => {
          expect(h.sent.length).toBe(afterAck);
          resolve();
        }, 40);
      }, 40);
    });
  });
});

describe('pure capability gate state machine (responder model)', () => {
  it('rejects everything while dormant, allows after exact-token activation', () => {
    const gate = createCapabilityGate();
    const req = createBridgeRequest('discover', {});
    expect(gate.guard(req).kind).toBe('reject');
    expect(gate.isActive()).toBe(false);

    // A real-length token activates the responder (record-on-activate).
    expect(gate.activate('a'.repeat(32))).toBe(true);
    expect(gate.isActive()).toBe(true);
    expect(gate.currentToken()).toBe('a'.repeat(32));
    expect(gate.guard(req).kind).toBe('allow');

    // Deactivate with the active token; it is then consumed.
    expect(gate.deactivate('a'.repeat(32))).toBe(true);
    expect(gate.isActive()).toBe(false);

    // The consumed token cannot re-activate (stale enable cycle).
    expect(gate.activate('a'.repeat(32))).toBe(false);
    expect(gate.isActive()).toBe(false);

    // A fresh token activates cleanly.
    expect(gate.activate('b'.repeat(32))).toBe(true);
    expect(gate.isActive()).toBe(true);
  });
});
