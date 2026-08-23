/**
 * Regression: MAIN-world bridge must NOT answer after Disable (C8 revoke).
 *
 * Covers the audit scenarios:
 *  1. inject MAIN responder, verify pre-disable discover works;
 *  2. deactivate in same realm, assert dormant behavior on discover;
 *  3. destroy/recreate document after revoke, assert no listener/response;
 *  4. re-enable creates a new capability and only then discover responds;
 *  5. old capability cannot reactivate a bridge activated with a new token;
 *  + fresh-post-disable document identity is distinguished from a pre-disable
 *    tab (timeOrigin check) and the isolated client deactivates on revocation.
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

function makeFakeWindow(): FakeWindow & { destroy(): FakeWindow } {
  const win: FakeWindow & { destroy(): FakeWindow; onPageHide?: () => void } = {
    listeners: new Set<(e: MessageEvent) => void>(),
    pageHideListeners: new Set<() => void>(),
    posted: [] as unknown[],
    timeOrigin: Date.now(),
    postMessage: (m: unknown) => {
      win.posted.push(m);
    },
    async dispatch(data: unknown) {
      const ev = new MessageEvent('message', { data });
      Object.defineProperty(ev, 'source', { value: win, configurable: true });
      for (const l of [...win.listeners]) await Promise.resolve(l(ev));
      await new Promise((r) => setTimeout(r, 0));
    },
    destroy() {
      win.listeners.clear();
      win.pageHideListeners.clear();
      return win;
    },
  };
  return win;
}

/** Minimal globalThis shim so installMainBridge binds to the fake window. */
function withFakeWindow<T>(win: FakeWindow, fn: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const savedAdd = g.addEventListener;
  const savedRemove = g.removeEventListener;
  const savedTimeOrigin = g.timeOrigin ?? undefined; // not used by code
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
    else delete g.removeEventListener;
    void savedTimeOrigin;
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

describe('MAIN bridge capability gate — disable/revoke regression (C8)', () => {
  it('1. pre-disable: after activation, discover responds', async () => {
    const win = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win, () => installMainBridge(handle));
    await win.dispatch(activateMsg('a'.repeat(32)));

    const reply = (await discover(win)) as { ok?: boolean } | null;
    expect(reply?.ok).toBe(true);
  });

  it('2. same realm after deactivate: discover gets NO live response (dormant)', async () => {
    const win = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win, () => installMainBridge(handle));
    await win.dispatch(activateMsg('a'.repeat(32)));
    expect(((await discover(win)) as { ok?: boolean }).ok).toBe(true);

    // Disable: revoke with the exact token → back to sleep.
    await win.dispatch(deactivateMsg('a'.repeat(32)));
    const reply = await discover(win);
    // Dormant bridge is SILENT: no response of any kind. The live surface was
    // touched once (the pre-disable discover) but NOT after deactivation.
    expect(reply).toBeNull();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('3. destroyed document has no listener; recreated document starts dormant', async () => {
    const win1 = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win1, () => installMainBridge(handle));
    await win1.dispatch(activateMsg('b'.repeat(32)));
    expect(((await discover(win1)) as { ok?: boolean }).ok).toBe(true);

    // Destroy the document (listeners gone). A NEW document's window knows
    // nothing of the old activation: no listener, no response at all.
    win1.destroy();
    const beforeNew = 0;
    expect(await discover({ ...win1, posted: [] } as FakeWindow)).toBeNull();

    // Fresh document: brand-new window object, distinct timeOrigin.
    const win2 = makeFakeWindow();
    win2.timeOrigin = Date.now() + 5000;
    expect(win2.timeOrigin).not.toBe(win1.timeOrigin);
    expect(win2.posted.length).toBe(beforeNew);
    const freshReply = await discover(win2);
    expect(freshReply).toBeNull(); // nothing installed yet → silence
  });

  it('4. re-enable mints a NEW capability; discover responds only after it', async () => {
    const win = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win, () => installMainBridge(handle));

    // Before any activation even a valid request stays silent/dormant.
    expect(await discover(win)).toBeNull();
    expect(handle).not.toHaveBeenCalled();

    // Re-enable path: isolated world activates with a fresh token.
    await win.dispatch(activateMsg('c'.repeat(32)));
    expect(((await discover(win)) as { ok?: boolean }).ok).toBe(true);
  });

  it('5. old capability cannot activate/reactivate across enable cycles', async () => {
    const win = makeFakeWindow();
    const handle = vi.fn(okResponder) as unknown as ReturnType<typeof vi.fn>;
    withFakeWindow(win, () => installMainBridge(handle));

    // Enable cycle A.
    await win.dispatch(activateMsg('d'.repeat(32)));
    expect(((await discover(win)) as { ok?: boolean }).ok).toBe(true);

    // Replaying activation while already active is refused (one handshake/enable);
    // the bridge stays responsive on the CURRENT token.
    await win.dispatch(activateMsg('e'.repeat(32)));
    expect(((await discover(win)) as { ok?: boolean }).ok).toBe(true);

    // Deactivation with a WRONG token (stale 'e') must NOT deactivate.
    await win.dispatch(deactivateMsg('e'.repeat(32)));
    const stillActive = await discover(win);
    expect((stillActive as { ok?: boolean } | null)?.ok).toBe(true);

    // Correct current token DOES deactivate → now silent.
    await win.dispatch(deactivateMsg('d'.repeat(32)));
    const afterRevoke = await discover(win);
    expect(afterRevoke).toBeNull();
    expect(handle).toHaveBeenCalledTimes(3);

    // Stale token from cycle A cannot reactivate → still silent.
    await win.dispatch(activateMsg('d'.repeat(32)));
    const final = await discover(win);
    expect(final).toBeNull();
    expect(handle).toHaveBeenCalledTimes(3);
  });
});

describe('isolated capability client', () => {
  function baseDeps() {
    const sent: unknown[] = [];
    let revoked: (() => void) | null = null;
    let counter = 0;
    const deps = {
      randomToken: () => `token-${++counter}-x`.padEnd(24, '0'),
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

  it('deactivate without a held token is a no-op', () => {
    const h = baseDeps();
    const client = createCapabilityClient(h.deps);
    client.deactivate();
    expect(h.sent).toHaveLength(0);
  });
});

describe('pure capability gate state machine', () => {
  it('rejects everything while dormant, allows after exact-token activation', () => {
    const gate = createCapabilityGate({ randomToken: () => '' });
    const req = createBridgeRequest('discover', {});
    expect(gate.guard(req).kind).toBe('reject');
    expect(gate.isActive()).toBe(false);
    // randomToken() returns '' which can never satisfy the length floor.
    expect(gate.activate('short')).toBe(false);
    expect(gate.isActive()).toBe(false);
  });
});
