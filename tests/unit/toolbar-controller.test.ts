import { describe, expect, it, vi } from 'vitest';

import type { DetectedRoute } from '../../src/route-detection';
import {
  computeVisibility,
  createToolbarController,
  TOOLBAR_ARIA_LABEL,
  type ToolbarControllerDeps,
  type ToolbarPreset,
} from '../../src/toolbar-controller';

const editorRoute: DetectedRoute = {
  kind: 'editor',
  resourceType: 'post',
  savedId: 'abc123',
  isNew: false,
};

const listRoute: DetectedRoute = { kind: 'list', resourceType: 'post' };
const unknownRoute: DetectedRoute = { kind: 'unknown' };

function makePresets(): ToolbarPreset[] {
  return [
    { id: 'p1', name: 'Software Review', icon: '💻' },
    { id: 'p2', name: 'Newsletter', icon: '' },
  ];
}

function makeDeps(overrides: Partial<ToolbarControllerDeps> = {}): ToolbarControllerDeps {
  return {
    isGhostAdminPage: vi.fn().mockReturnValue(true),
    detectRoute: vi.fn().mockReturnValue(editorRoute),
    listPresets: vi.fn().mockResolvedValue(makePresets()),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('computeVisibility', () => {
  it('shows the toolbar only on editor routes', () => {
    expect(computeVisibility(editorRoute).visible).toBe(true);
    expect(computeVisibility(listRoute).visible).toBe(false);
    expect(computeVisibility(unknownRoute).visible).toBe(false);
  });

  it('does not show on a Ghost Admin page that is not an editor route', () => {
    const vis = computeVisibility({ kind: 'list', resourceType: 'page' });
    expect(vis.visible).toBe(false);
    expect(vis.reason).toMatch(/editor/i);
  });
});

describe('toolbar controller — initialization', () => {
  it('initializes only on a Ghost Admin page and attaches the route watcher', () => {
    const deps = makeDeps({ isGhostAdminPage: vi.fn().mockReturnValue(false) });
    const ctrl = createToolbarController(deps);
    const watch = vi.fn();
    ctrl.init(watch);
    expect(deps.isGhostAdminPage).toHaveBeenCalledTimes(1);
    expect(watch).not.toHaveBeenCalled();
    expect(ctrl.isMounted()).toBe(false);
  });

  it('attaches the route watcher when on a Ghost Admin page', () => {
    const deps = makeDeps();
    const ctrl = createToolbarController(deps);
    const watch = vi.fn();
    ctrl.init(watch);
    expect(deps.isGhostAdminPage).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(ctrl.isMounted()).toBe(false);
  });

  it('initializes idempotently (second init is a no-op)', () => {
    const deps = makeDeps();
    const ctrl = createToolbarController(deps);
    const watch = vi.fn();
    ctrl.init(watch);
    ctrl.init(watch);
    expect(watch).toHaveBeenCalledTimes(1);
  });
});

describe('toolbar controller — visibility-driven mount/unmount', () => {
  it('mounts the toolbar on an editor route during the initial sync', async () => {
    const deps = makeDeps();
    const ctrl = createToolbarController(deps);
    await ctrl.sync();
    expect(ctrl.isMounted()).toBe(true);
    expect(ctrl.currentPresets()).toHaveLength(2);
  });

  it('does not mount on a non-editor route and reports the reason', async () => {
    const deps = makeDeps({ detectRoute: vi.fn().mockReturnValue(listRoute) });
    const ctrl = createToolbarController(deps);
    await ctrl.sync();
    expect(ctrl.isMounted()).toBe(false);
    expect(ctrl.visibilityReason()).toMatch(/editor/i);
  });

  it('unmounts when the route leaves the editor screen', async () => {
    const detectRoute = vi.fn().mockReturnValue(editorRoute);
    const deps = makeDeps({ detectRoute });
    const ctrl = createToolbarController(deps);
    await ctrl.sync();
    expect(ctrl.isMounted()).toBe(true);

    detectRoute.mockReturnValue(listRoute);
    await ctrl.sync();
    expect(ctrl.isMounted()).toBe(false);
  });

  it('re-renders only when the editor route identity changes', async () => {
    const detectRoute = vi
      .fn()
      .mockReturnValueOnce(editorRoute)
      .mockReturnValueOnce({ ...editorRoute, savedId: 'abc123' }) // same identity
      .mockReturnValueOnce({ ...editorRoute, savedId: 'def456' }); // new identity
    const deps = makeDeps({ detectRoute });
    const ctrl = createToolbarController(deps);
    await ctrl.sync();
    const rendersAfterFirst = ctrl.renderCount();
    await ctrl.sync(); // same identity — no re-render
    expect(ctrl.renderCount()).toBe(rendersAfterFirst);
    await ctrl.sync(); // new identity — re-render
    expect(ctrl.renderCount()).toBe(rendersAfterFirst + 1);
  });
});

describe('toolbar controller — apply delegation', () => {
  it('delegates apply to the content script with the popup protocol op and source', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ sendMessage });
    const ctrl = createToolbarController(deps);
    await ctrl.sync();

    const result = await ctrl.applyPreset('p1');
    expect(result.ok).toBe(true);
    expect(result.delegated).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0] as unknown as {
      op: string;
      source: string;
      presetId: string;
    };
    expect(sent.op).toBe('apply');
    expect(sent.source).toBe('ghost-cms-template-injector/popup/v1');
    expect(sent.presetId).toBe('p1');
  });

  it('does not delegate when the toolbar is unmounted', async () => {
    const deps = makeDeps({ detectRoute: vi.fn().mockReturnValue(listRoute) });
    const ctrl = createToolbarController(deps);
    await ctrl.sync();
    const result = await ctrl.applyPreset('p1');
    expect(result.ok).toBe(false);
    expect(result.delegated).toBe(false);
    expect(result.error).toMatch(/not available/i);
  });

  it('surfaces a structured content-script failure instead of treating it as success', async () => {
    const deps = makeDeps({
      sendMessage: vi.fn().mockResolvedValue({
        source: 'ghost-cms-template-injector/popup/v1',
        ok: false,
        error: 'BLOCKED: editor is saving',
      }),
    });
    const ctrl = createToolbarController(deps);
    await ctrl.sync();

    const result = await ctrl.applyPreset('p1');

    expect(result).toMatchObject({ ok: false, delegated: true });
    expect(result.error).toMatch(/editor is saving/i);
  });

  it('resolves prompt-mode fields and retries with explicit answers', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        source: 'ghost-cms-template-injector/popup/v1',
        ok: false,
        error: 'NEEDS_PROMPT',
        result: [{ field: 'body', question: 'Replace the existing body?' }],
      })
      .mockResolvedValueOnce({
        source: 'ghost-cms-template-injector/popup/v1',
        ok: true,
        result: { saved: true },
      });
    const confirmPrompt = vi.fn().mockResolvedValue(true);
    const ctrl = createToolbarController(makeDeps({ sendMessage, confirmPrompt }));
    await ctrl.sync();

    const result = await ctrl.applyPreset('p1');

    expect(result).toMatchObject({ ok: true, delegated: true });
    expect(confirmPrompt).toHaveBeenCalledWith('Replace the existing body?', 'body');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[0]).toMatchObject({
      op: 'apply',
      presetId: 'p1',
      promptAnswers: { body: true },
    });
  });

  it('surfaces a transport error from the content script as a failed delegation', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('bridge busy'));
    const deps = makeDeps({ sendMessage });
    const ctrl = createToolbarController(deps);
    await ctrl.sync();
    const result = await ctrl.applyPreset('p1');
    expect(result.ok).toBe(false);
    expect(result.delegated).toBe(false);
    expect(result.error).toMatch(/bridge busy/);
  });

  it('reports applying status to the live region before and after delegation', async () => {
    const deps = makeDeps();
    const ctrl = createToolbarController(deps);
    await ctrl.sync();
    const statuses: string[] = [];
    ctrl.onStatus((msg) => {
      statuses.push(msg);
    });
    await ctrl.applyPreset('p1');
    expect(statuses.some((s) => /applying/i.test(s))).toBe(true);
    // After a successful delegation the toolbar announces the imminent
    // editor reload (the MAIN bridge refreshes the page so the applied text
    // is visible without a manual refresh).
    expect(statuses.at(-1)).toMatch(/reloading/i);
  });

  it('clears the applying status once delegation is acknowledged', async () => {
    const deps = makeDeps();
    const ctrl = createToolbarController(deps);
    await ctrl.sync();
    const statuses: string[] = [];
    ctrl.onStatus((msg) => statuses.push(msg));
    await ctrl.applyPreset('p1');
    // The final status no longer says "applying" (the pre-reload message is
    // emitted instead of a plain empty string).
    expect(statuses.at(-1)).not.toMatch(/applying/i);
  });
});

describe('toolbar controller — accessibility contract', () => {
  it('exposes a stable ARIA label constant', () => {
    expect(TOOLBAR_ARIA_LABEL).toMatch(/ghost-cms template injector/i);
  });

  it('exposes preset rows carrying id, name, and a possibly-empty icon', async () => {
    const deps = makeDeps();
    const ctrl = createToolbarController(deps);
    await ctrl.sync();
    const presets = ctrl.currentPresets();
    expect(presets[0]).toMatchObject({ id: 'p1', name: 'Software Review', icon: '💻' });
    expect(presets[1]?.icon).toBe('');
  });
});
