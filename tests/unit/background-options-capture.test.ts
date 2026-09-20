import { describe, expect, it, vi } from 'vitest';

import {
  createContentScriptHealer,
  createOptionsCaptureHandler,
  pickGhostTab,
} from '../../src/background';
import { OPTIONS_CAPTURE_SOURCE, POPUP_MESSAGE_SOURCE } from '../../src/message-sources';
import { isOptionsCaptureMessage, toContentScriptMessage } from '../../src/import-protocol';

type Sender = { tab?: { id?: number }; url?: string; id?: string };
type Handler = (
  message: unknown,
  sender: Sender,
  sendResponse: (response: unknown) => void,
) => boolean | null;

/** What the Options page looks like to the service worker. */
const OPTIONS_SENDER: Sender = {
  tab: { id: 3 },
  url: 'chrome-extension://abc/options/options.html',
  id: 'abc',
};

function invoke(handler: Handler, message: unknown, sender: Sender) {
  return new Promise<unknown>((resolve) => {
    handler(message, sender, resolve);
  });
}

function makeHandler(
  tabs: Array<{ id?: number; url?: string }>,
  overrides: {
    sendTabMessage?: ReturnType<typeof vi.fn>;
    queryTabs?: ReturnType<typeof vi.fn>;
    ensureContentScript?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const sendTabMessage = overrides.sendTabMessage ?? vi.fn().mockResolvedValue({ ok: true });
  const queryTabs = overrides.queryTabs ?? vi.fn().mockResolvedValue(tabs);
  const ensureContentScript = overrides.ensureContentScript ?? vi.fn().mockResolvedValue('present');
  const handler = createOptionsCaptureHandler({
    extensionId: 'abc',
    queryTabs,
    sendTabMessage,
    ensureContentScript,
  }) as Handler;
  return { handler, sendTabMessage, queryTabs, ensureContentScript };
}

const request = { source: OPTIONS_CAPTURE_SOURCE, op: 'listPosts' } as const;

describe('options-page capture protocol', () => {
  it('accepts only the fixed identity and the read-only operations', () => {
    expect(isOptionsCaptureMessage(request)).toBe(true);
    expect(isOptionsCaptureMessage({ source: POPUP_MESSAGE_SOURCE, op: 'listPosts' })).toBe(false);
    expect(isOptionsCaptureMessage({ source: OPTIONS_CAPTURE_SOURCE, op: 'apply' })).toBe(false);
    expect(isOptionsCaptureMessage({ source: OPTIONS_CAPTURE_SOURCE })).toBe(false);
    expect(isOptionsCaptureMessage(null)).toBe(false);
  });

  it('re-identifies the request for the content script and keeps validation fields', () => {
    expect(
      toContentScriptMessage({
        source: OPTIONS_CAPTURE_SOURCE,
        op: 'capturePost',
        resourceType: 'page',
        resourceId: 'x1',
      }),
    ).toEqual({
      source: POPUP_MESSAGE_SOURCE,
      op: 'capturePost',
      resourceType: 'page',
      resourceId: 'x1',
    });
    expect(toContentScriptMessage({ source: OPTIONS_CAPTURE_SOURCE, op: 'capture' })).toEqual({
      source: POPUP_MESSAGE_SOURCE,
      op: 'capture',
    });
  });
});

describe('pickGhostTab', () => {
  it('prefers an editor route over other Ghost Admin pages', () => {
    expect(
      pickGhostTab([
        { id: 1, url: 'https://blog.example.com/ghost/#/settings/staff' },
        { id: 2, url: 'https://blog.example.com/ghost/#/editor/post/abc123' },
      ]),
    ).toEqual({ id: 2, url: 'https://blog.example.com/ghost/#/editor/post/abc123' });
  });

  it('falls back to any Ghost Admin tab, then to nothing', () => {
    expect(
      pickGhostTab([
        { id: 1, url: 'https://blog.example.com/' },
        { id: 2, url: 'https://blog.example.com/ghost/#/posts' },
      ]),
    ).toEqual({ id: 2, url: 'https://blog.example.com/ghost/#/posts' });
    expect(pickGhostTab([{ id: 1, url: 'https://blog.example.com/' }])).toBeNull();
    // Untouched tabs expose no url without the `tabs` permission.
    expect(pickGhostTab([{ id: 1 }, { url: 'https://blog.example.com/ghost/' }])).toBeNull();
  });

  it('never targets another extension page', () => {
    expect(
      pickGhostTab([{ id: 1, url: 'chrome-extension://abc/options/options.html' }]),
    ).toBeNull();
  });
});

describe('createOptionsCaptureHandler', () => {
  it('ignores messages that are not options capture requests', async () => {
    const { handler, sendTabMessage } = makeHandler([]);
    expect(
      handler({ source: POPUP_MESSAGE_SOURCE, op: 'listPosts' }, OPTIONS_SENDER, () => {}),
    ).toBeNull();
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it('routes the read to a granted Ghost Admin tab', async () => {
    const { handler, sendTabMessage, queryTabs, ensureContentScript } = makeHandler([
      { id: 7, url: 'https://blog.example.com/ghost/#/editor/post/abc123' },
    ]);

    const response = await invoke(handler, request, OPTIONS_SENDER);

    expect(queryTabs).toHaveBeenCalledTimes(1);
    // A healthy tab needs no injection at all.
    expect(ensureContentScript).not.toHaveBeenCalled();
    expect(sendTabMessage).toHaveBeenCalledWith(7, {
      source: POPUP_MESSAGE_SOURCE,
      op: 'listPosts',
    });
    expect(response).toEqual({ ok: true });
  });

  it('refuses a content script (its sender URL is the web page, not an extension page)', async () => {
    const { handler, sendTabMessage } = makeHandler([
      { id: 7, url: 'https://blog.example.com/ghost/#/posts' },
    ]);

    const response = await invoke(handler, request, {
      tab: { id: 7 },
      url: 'https://blog.example.com/ghost/#/editor/post/abc123',
      id: 'abc',
    });

    expect(sendTabMessage).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, error: 'NOT_AN_EXTENSION_PAGE' });
  });

  it('refuses a sender that is a different extension', async () => {
    const { handler, sendTabMessage } = makeHandler([
      { id: 7, url: 'https://blog.example.com/ghost/#/posts' },
    ]);
    const response = await invoke(handler, request, {
      tab: { id: 3 },
      url: 'chrome-extension://other/options/options.html',
      id: 'other',
    });
    expect(sendTabMessage).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, error: 'NOT_AN_EXTENSION_PAGE' });
  });

  it('reports a missing Ghost tab explicitly', async () => {
    const { handler, sendTabMessage } = makeHandler([{ id: 1, url: 'https://example.com/' }]);
    const response = await invoke(handler, request, OPTIONS_SENDER);
    expect(sendTabMessage).not.toHaveBeenCalled();
    expect(response).toEqual({ ok: false, error: 'NO_GHOST_TAB' });
  });

  it('threads a tab-send failure and a tab-query failure into the reply', async () => {
    const failingSend = makeHandler(
      [{ id: 7, url: 'https://blog.example.com/ghost/#/editor/post/abc123' }],
      { sendTabMessage: vi.fn().mockRejectedValue(new Error('no receiver')) },
    );
    expect(await invoke(failingSend.handler, request, OPTIONS_SENDER)).toEqual({
      ok: false,
      error: 'no receiver',
    });

    const failingQuery = makeHandler([], {
      queryTabs: vi.fn().mockRejectedValue(new Error('tabs unavailable')),
    });
    expect(await invoke(failingQuery.handler, request, OPTIONS_SENDER)).toEqual({
      ok: false,
      error: 'tabs unavailable',
    });
  });

  it("maps Chrome's stale-document error to a stable code the UI can act on", async () => {
    const stale = makeHandler(
      [{ id: 7, url: 'https://blog.example.com/ghost/#/editor/post/abc123' }],
      {
        sendTabMessage: vi
          .fn()
          .mockRejectedValue(
            new Error('Could not establish connection. Receiving end does not exist.'),
          ),
      },
    );
    expect(await invoke(stale.handler, request, OPTIONS_SENDER)).toEqual({
      ok: false,
      error: 'NO_CONTENT_SCRIPT',
    });
  });

  it('recovers a stale document: first send fails, the healer injects, the retry works', async () => {
    const sendTabMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Could not establish connection. Receiving end does not exist.'),
      )
      .mockResolvedValueOnce({ ok: true, result: { entries: [] } });
    const healed = makeHandler(
      [{ id: 7, url: 'https://blog.example.com/ghost/#/editor/post/abc123' }],
      { sendTabMessage, ensureContentScript: vi.fn().mockResolvedValue('injected') },
    );

    expect(await invoke(healed.handler, request, OPTIONS_SENDER)).toEqual({
      ok: true,
      result: { entries: [] },
    });
    expect(sendTabMessage).toHaveBeenCalledTimes(2);
    expect(healed.ensureContentScript).toHaveBeenCalledWith(7);
  });

  it('reports NO_CONTENT_SCRIPT when the self-heal cannot inject either', async () => {
    const stalled = makeHandler(
      [{ id: 7, url: 'https://blog.example.com/ghost/#/editor/post/abc123' }],
      {
        sendTabMessage: vi
          .fn()
          .mockRejectedValue(
            new Error('Could not establish connection. Receiving end does not exist.'),
          ),
        ensureContentScript: vi.fn().mockResolvedValue('unavailable'),
      },
    );

    expect(await invoke(stalled.handler, request, OPTIONS_SENDER)).toEqual({
      ok: false,
      error: 'NO_CONTENT_SCRIPT',
    });
    // No pointless second send when the tab could not be healed.
    expect(stalled.sendTabMessage).toHaveBeenCalledTimes(1);
  });

  it('never retries a failure that is not a missing receiver', async () => {
    const other = makeHandler(
      [{ id: 7, url: 'https://blog.example.com/ghost/#/editor/post/abc123' }],
      { sendTabMessage: vi.fn().mockRejectedValue(new Error('tabs unavailable')) },
    );
    expect(await invoke(other.handler, request, OPTIONS_SENDER)).toEqual({
      ok: false,
      error: 'tabs unavailable',
    });
    expect(other.sendTabMessage).toHaveBeenCalledTimes(1);
    expect(other.ensureContentScript).not.toHaveBeenCalled();
  });

  it('keeps the message channel open for the async reply', () => {
    const { handler } = makeHandler([{ id: 7, url: 'https://blog.example.com/ghost/#/posts' }]);
    expect(handler(request, OPTIONS_SENDER, () => {})).toBe(true);
  });
});

describe('createContentScriptHealer', () => {
  function makeApi(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    return {
      probe: vi.fn().mockResolvedValue(false),
      injectIsolated: vi.fn().mockResolvedValue(undefined),
      injectMain: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('does nothing when the tab already runs the content script', async () => {
    const api = makeApi({ probe: vi.fn().mockResolvedValue(true) });
    const heal = createContentScriptHealer({ api, wait: async () => {} });

    expect(await heal(7)).toBe('present');
    expect(api.injectIsolated).not.toHaveBeenCalled();
    expect(api.injectMain).not.toHaveBeenCalled();
  });

  it('injects the isolated bundles and the MAIN bridge, then settles', async () => {
    const api = makeApi();
    const waits: number[] = [];
    const heal = createContentScriptHealer({
      api,
      settleMs: 250,
      wait: async (ms) => {
        waits.push(ms);
      },
    });

    expect(await heal(7)).toBe('injected');
    expect(api.injectIsolated).toHaveBeenCalledWith(7);
    expect(api.injectMain).toHaveBeenCalledWith(7);
    expect(waits).toEqual([250]);
  });

  it('reports "unavailable" when injection is refused, without throwing', async () => {
    const api = makeApi({
      injectIsolated: vi.fn().mockRejectedValue(new Error('cannot access contents')),
    });
    const heal = createContentScriptHealer({ api, wait: async () => {} });
    await expect(heal(7)).resolves.toBe('unavailable');
  });

  it('still heals when the MAIN bridge cannot be injected (API-only reads)', async () => {
    const api = makeApi({ injectMain: vi.fn().mockRejectedValue(new Error('no MAIN world')) });
    const heal = createContentScriptHealer({ api, wait: async () => {} });
    expect(await heal(7)).toBe('injected');
  });
});
