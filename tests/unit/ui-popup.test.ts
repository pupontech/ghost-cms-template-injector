import { describe, expect, it, vi } from 'vitest';

import type { DetectedRoute } from '../../src/route-detection';
import {
  createPopupController,
  POPUP_MESSAGE_SOURCE,
  type ContentReply,
  type PopupRuntime,
} from '../../src/ui-popup';

const editorRoute: DetectedRoute = {
  kind: 'editor',
  resourceType: 'post',
  savedId: 'abc123',
  isNew: false,
};

const newRoute: DetectedRoute = {
  kind: 'editor',
  resourceType: 'page',
  savedId: null,
  isNew: true,
};

function makeRuntime(overrides: Partial<PopupRuntime> = {}): PopupRuntime {
  return {
    getActiveTabId: vi.fn().mockReturnValue('tab-1'),
    findTab: vi.fn().mockImplementation((_id: string) => ({
      url: 'https://example.com/ghost/#/editor/edit/post/abc123',
    })),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    loadPresets: vi.fn().mockResolvedValue([
      {
        schemaVersion: 1,
        id: 'p1',
        name: 'Preset One',
        content: { source: 'inline-html', mode: 'replace', html: '<p></p>' },
      },
    ]),
    ...overrides,
  } as unknown as PopupRuntime;
}

/** Build a reply carrying the popup source identity. */
function reply(ok: boolean, result?: unknown, error?: string): ContentReply {
  return { source: POPUP_MESSAGE_SOURCE, ok, result, error } as ContentReply;
}

describe('popup controller — capability reporting', () => {
  it('reports unsupported when no Ghost admin tab is found', async () => {
    const rt = makeRuntime({ findTab: vi.fn().mockReturnValue(undefined) });
    const ctrl = createPopupController(makeRuntime(rt) as PopupRuntime);
    const status = await ctrl.refresh(editorRoute);
    expect(status.state).toBe('unsupported');
    if (status.state !== 'unsupported') throw new Error('expected unsupported');
    expect(status.reason).toMatch(/ghost admin/i);
  });

  it('reports unsupported when the active tab is not an editor route', async () => {
    const rt = makeRuntime({
      findTab: vi.fn().mockReturnValue({ url: 'https://example.com/ghost/#/posts' }),
    });
    const ctrl = createPopupController(rt);
    const status = await ctrl.refresh({ kind: 'list', resourceType: 'post' });
    expect(status.state).toBe('unsupported');
  });

  it('delegates a discover probe to the content script and reports capability', async () => {
    const sendMessage = vi.fn().mockResolvedValue(
      reply(true, {
        supported: true,
        capability: {
          resourceType: 'post',
          resourceId: 'abc123',
          dirty: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    const rt = makeRuntime({ sendMessage });
    const ctrl = createPopupController(rt);
    const status = await ctrl.refresh(editorRoute);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[1] as { op: string };
    expect(sent.op).toBe('discover');
    expect(status.state).toBe('capable');
    if (status.state !== 'capable') throw new Error('expected capable');
    expect(status.capability?.dirty).toBe(true);
    expect(status.capability?.resourceId).toBe('abc123');
  });

  it('reports unsupported when the bridge replies UNSUPPORTED_CAPABILITY', async () => {
    const rt = makeRuntime({
      sendMessage: vi.fn().mockResolvedValue(reply(false, undefined, 'UNSUPPORTED_CAPABILITY')),
    });
    const ctrl = createPopupController(rt);
    const status = await ctrl.refresh(editorRoute);
    expect(status.state).toBe('unsupported');
    if (status.state !== 'unsupported') throw new Error('expected unsupported');
    expect(status.reason).toMatch(/capability/i);
  });

  it('treats a missing/undefined reply as unsupported without throwing', async () => {
    const rt = makeRuntime({ sendMessage: vi.fn().mockResolvedValue(undefined) });
    const ctrl = createPopupController(rt);
    const status = await ctrl.refresh(editorRoute);
    expect(status.state).toBe('unsupported');
  });

  it('flags a fresh unsaved draft accurately on the capability report', async () => {
    const rt = makeRuntime({
      sendMessage: vi.fn().mockResolvedValue(
        reply(true, {
          supported: true,
          capability: { resourceType: 'page', resourceId: null, dirty: true, updatedAt: null },
        }),
      ),
      findTab: vi.fn().mockReturnValue({ url: 'https://example.com/ghost/#/editor/new/page' }),
    });
    const ctrl = createPopupController(rt);
    const status = await ctrl.refresh(newRoute);
    expect(status.state).toBe('capable');
    if (status.state !== 'capable') throw new Error('expected capable');
    expect(status.capability?.resourceId).toBeNull();
    expect(status.capability?.updatedAt).toBeNull();
  });

  it('surfaces a bridge transport error as a failed status', async () => {
    const rt = makeRuntime({ sendMessage: vi.fn().mockRejectedValue(new Error('boom')) });
    const ctrl = createPopupController(rt);
    const status = await ctrl.refresh(editorRoute);
    expect(status.state).toBe('error');
    if (status.state !== 'error') throw new Error('expected error');
    expect(status.reason).toMatch(/boom/);
  });
});

describe('popup controller — preset listing', () => {
  it('loads validated presets via the injected loader', async () => {
    const rt = makeRuntime();
    const ctrl = createPopupController(rt);
    const presets = await ctrl.loadPresets();
    expect(rt.loadPresets).toHaveBeenCalledTimes(1);
    expect(presets.map((p) => p.id)).toEqual(['p1']);
  });

  it('propagates preset load failures without swallowing', async () => {
    const rt = makeRuntime({ loadPresets: vi.fn().mockRejectedValue(new Error('corrupt')) });
    const ctrl = createPopupController(rt);
    await expect(ctrl.loadPresets()).rejects.toThrow(/corrupt/);
  });
});

describe('popup controller — apply delegation (survives popup closure)', () => {
  it('delegates apply to the content script with the preset id and never awaits a long operation', async () => {
    const sendMessage = vi.fn().mockResolvedValue(reply(true, { delegated: true }));
    const rt = makeRuntime({ sendMessage });
    const ctrl = createPopupController(rt);
    const result = await ctrl.applyPreset('p1');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[1] as { op: string; presetId: string };
    expect(sent.op).toBe('apply');
    expect(sent.presetId).toBe('p1');
    // The popup returns as soon as the content script acknowledges delegation.
    expect(result.delegated).toBe(true);
  });

  it('passes prompt answers when resolving a needs-prompt plan', async () => {
    const sendMessage = vi.fn().mockResolvedValue(reply(true, { delegated: true }));
    const rt = makeRuntime({ sendMessage });
    const ctrl = createPopupController(rt);
    await ctrl.applyPreset('p1', { body: true, customTemplate: false });
    const sent = sendMessage.mock.calls[0]?.[1] as {
      op: string;
      promptAnswers?: Record<string, boolean>;
    };
    expect(sent.promptAnswers).toEqual({ body: true, customTemplate: false });
  });

  it('reports a delegation failure from the content script', async () => {
    const sendMessage = vi.fn().mockResolvedValue(reply(false, undefined, 'APPLY_FAILED'));
    const rt = makeRuntime({ sendMessage });
    const ctrl = createPopupController(rt);
    const result = await ctrl.applyPreset('p1');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('APPLY_FAILED');
  });

  it('fails closed when the content script reply lacks the popup identity', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ source: 'other', ok: true, result: {} });
    const rt = makeRuntime({ sendMessage });
    const ctrl = createPopupController(rt);
    const result = await ctrl.applyPreset('p1');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/identity|source/i);
  });

  it('surfaces NEEDS_PROMPT prompts so the UI can collect answers (C1)', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValue(
        reply(false, [{ field: 'body', question: 'Overwrite the body?' }], 'NEEDS_PROMPT'),
      );
    const rt = makeRuntime({ sendMessage });
    const ctrl = createPopupController(rt);
    const result = await ctrl.applyPreset('p1');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('NEEDS_PROMPT');
    expect(result.prompts).toEqual([{ field: 'body', question: 'Overwrite the body?' }]);
  });

  it('ignores a malformed NEEDS_PROMPT result as a generic failure', async () => {
    // A NEEDS_PROMPT error without a usable prompt list must not be reported as
    // a prompt decision; it falls through to a plain failure.
    const sendMessage = vi
      .fn()
      .mockResolvedValue(reply(false, [{ notAField: 'x' }], 'NEEDS_PROMPT'));
    const rt = makeRuntime({ sendMessage });
    const ctrl = createPopupController(rt);
    const result = await ctrl.applyPreset('p1');
    expect(result.ok).toBe(false);
    expect(result.prompts).toBeUndefined();
    expect(result.error).toBe('NEEDS_PROMPT');
  });
});

describe('popup controller — status snapshot', () => {
  it('exposes the last known capability after a refresh', async () => {
    const rt = makeRuntime({
      sendMessage: vi.fn().mockResolvedValue(
        reply(true, {
          supported: true,
          capability: {
            resourceType: 'post',
            resourceId: 'abc123',
            dirty: false,
            updatedAt: 'x',
          },
        }),
      ),
    });
    const ctrl = createPopupController(rt);
    await ctrl.refresh(editorRoute);
    expect(ctrl.lastStatus().state).toBe('capable');
  });

  it('returns an initial unknown status before any refresh', () => {
    const ctrl = createPopupController(makeRuntime());
    const initial = ctrl.lastStatus();
    expect(initial.state).toBe('unsupported');
    if (initial.state !== 'unsupported') throw new Error('expected unsupported');
    expect(initial.reason).toMatch(/not yet/i);
  });
});
