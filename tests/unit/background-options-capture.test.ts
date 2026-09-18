import { describe, expect, it, vi } from 'vitest';

import { createOptionsCaptureHandler, pickGhostTab } from '../../src/background';
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
  } = {},
) {
  const sendTabMessage = overrides.sendTabMessage ?? vi.fn().mockResolvedValue({ ok: true });
  const queryTabs = overrides.queryTabs ?? vi.fn().mockResolvedValue(tabs);
  const handler = createOptionsCaptureHandler({
    extensionId: 'abc',
    queryTabs,
    sendTabMessage,
  }) as Handler;
  return { handler, sendTabMessage, queryTabs };
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
    const { handler, sendTabMessage, queryTabs } = makeHandler([
      { id: 7, url: 'https://blog.example.com/ghost/#/editor/post/abc123' },
    ]);

    const response = await invoke(handler, request, OPTIONS_SENDER);

    expect(queryTabs).toHaveBeenCalledTimes(1);
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

  it('keeps the message channel open for the async reply', () => {
    const { handler } = makeHandler([{ id: 7, url: 'https://blog.example.com/ghost/#/posts' }]);
    expect(handler(request, OPTIONS_SENDER, () => {})).toBe(true);
  });
});
