import { describe, expect, it, vi } from 'vitest';

import type {
  ApplicationPlan,
  GhostLiveSurface,
  GhostSnapshot,
  GhostStateAdapter,
} from '../../src/ghost-state';
import { createGhostStateAdapter } from '../../src/ghost-state';

/** Build a fully-capable surface with spyable no-op mutations. */
function capableSurface(overrides: Partial<GhostLiveSurface> = {}): GhostLiveSurface {
  return {
    getResourceType: () => 'post',
    getResourceId: () => 'post-1',
    hasRecord: () => true,
    isDirty: () => false,
    getUpdatedAt: () => '2026-08-21T00:00:00.000Z',
    getLexical: () => '{"root":{}}',
    isBodyEmpty: () => true,
    getExcerpt: () => null,
    getTitle: () => null,
    getCustomTemplate: () => null,
    getTags: () => [],
    setField: vi.fn(),
    setLexical: vi.fn(),
    nativeSave: vi.fn(async () => ({ updatedAt: '2026-08-21T01:00:00.000Z' })),
    captureRollback: vi.fn(() => ({ token: 'snap' })),
    restoreRollback: vi.fn(),
    ...overrides,
  };
}

function readyPlan(actions: ApplicationPlan['actions']): ApplicationPlan {
  return { presetId: 'p1', status: 'ready', actions, problems: [] };
}

describe('C2 capability discovery', () => {
  it('returns a versioned capability object when all capabilities are proven', () => {
    const adapter = createGhostStateAdapter(capableSurface());
    const outcome = adapter.discover();
    expect(outcome.supported).toBe(true);
    if (!outcome.supported) throw new Error('unexpected unsupported');
    expect(outcome.capability.adapterVersion).toBe(1);
    expect(outcome.capability.resourceType).toBe('post');
    expect(outcome.capability.resourceId).toBe('post-1');
    expect(outcome.capability.hasLexical).toBe(true);
    expect(outcome.capability.canMutateRelations).toBe(true);
    expect(outcome.capability.canNativeSave).toBe(true);
    expect(outcome.capability.canRollback).toBe(true);
  });

  it('returns UNSUPPORTED_CAPABILITY (no mutation) when native save is unreachable', () => {
    const surface = capableSurface({ nativeSave: undefined as never });
    const setField = vi.fn();
    (surface as { setField: unknown }).setField = setField;
    const adapter = createGhostStateAdapter(surface);
    const outcome = adapter.discover();
    expect(outcome.supported).toBe(false);
    if (outcome.supported) throw new Error('expected unsupported');
    expect(outcome.reason).toMatch(/native save/i);
    // Discovery must not mutate.
    expect(setField).not.toHaveBeenCalled();
  });

  it('returns UNSUPPORTED_CAPABILITY when no live editor record is reachable (M4)', () => {
    // A page where Ember internals exist but the editor record is not yet
    // hydrated (e.g. mid-navigation) must fail closed, not report a phantom
    // capability that later throws deep inside apply().
    const surface = capableSurface({ hasRecord: () => false });
    const adapter = createGhostStateAdapter(surface);
    const outcome = adapter.discover();
    expect(outcome.supported).toBe(false);
    if (outcome.supported) throw new Error('expected unsupported');
    expect(outcome.reason).toMatch(/no live editor record/i);
  });

  it('returns UNSUPPORTED_CAPABILITY when rollback path is unreachable', () => {
    const surface = capableSurface({
      captureRollback: undefined as never,
      restoreRollback: undefined as never,
    });
    const adapter = createGhostStateAdapter(surface);
    const outcome = adapter.discover();
    expect(outcome.supported).toBe(false);
  });
});

describe('C4 live snapshot', () => {
  it('captures type, id, metadata, tags, lexical, dirty, and updated_at', () => {
    const surface = capableSurface({
      getExcerpt: () => 'sum',
      getTitle: () => 'Old Title',
      getCustomTemplate: () => 'tpl.hbs',
      getTags: () => ['A', 'B'],
      getLexical: () => '{"nodes":[]}',
      isBodyEmpty: () => false,
      isDirty: () => true,
      getUpdatedAt: () => '2026-08-21T02:00:00.000Z',
    });
    const snap: GhostSnapshot = createGhostStateAdapter(surface).snapshot();
    expect(snap).toMatchObject({
      resourceType: 'post',
      resourceId: 'post-1',
      excerpt: 'sum',
      customTemplate: 'tpl.hbs',
      tags: ['A', 'B'],
      lexical: '{"nodes":[]}',
      bodyEmpty: false,
      dirty: true,
      updatedAt: '2026-08-21T02:00:00.000Z',
    });
  });
});

describe('C4 planApply validation', () => {
  it('accepts a ready plan', () => {
    const adapter = createGhostStateAdapter(capableSurface());
    const res = adapter.planApply(
      readyPlan([{ field: 'excerpt', op: 'set', status: 'apply', value: 'x' }]),
    );
    expect(res.ok).toBe(true);
  });

  it('rejects a non-ready plan', () => {
    const adapter = createGhostStateAdapter(capableSurface());
    const res = adapter.planApply({
      presetId: 'p',
      status: 'needs-prompt',
      actions: [],
      problems: [],
    });
    expect(res.ok).toBe(false);
  });

  it('accepts a ready plan containing legitimate skip+reason actions (only-if-empty)', () => {
    const setField = vi.fn();
    const adapter = createGhostStateAdapter(capableSurface({ setField }));
    const res = adapter.planApply(
      readyPlan([
        { field: 'excerpt', op: 'set', status: 'skip', reason: 'excerpt already has a value' },
        { field: 'tags', op: 'set', status: 'skip', reason: 'post already has tags' },
        { field: 'customTemplate', op: 'set', status: 'apply', value: 'tpl.hbs' },
      ]),
    );
    expect(res.ok).toBe(true);
    // A skip+reason plan must not be treated as a block, and no mutation must
    // occur during validation.
    expect(setField).not.toHaveBeenCalled();
  });

  it('rejects a genuinely blocked-status plan', () => {
    const setField = vi.fn();
    const adapter = createGhostStateAdapter(capableSurface({ setField }));
    const res = adapter.planApply({
      presetId: 'p',
      status: 'blocked',
      actions: [],
      problems: [],
    });
    expect(res.ok).toBe(false);
    expect(setField).not.toHaveBeenCalled();
  });
});

describe('C4 apply → save → verify (single native transaction)', () => {
  it('rejects HTML body actions before setLexical or native save', async () => {
    const surface = capableSurface();
    const adapter = createGhostStateAdapter(surface);

    await expect(
      adapter.apply(
        readyPlan([{ field: 'body', op: 'set', status: 'apply', value: '<p>body</p>' }]),
      ),
    ).rejects.toMatchObject({
      code: 'APPLY_FAILED',
      message: expect.stringMatching(/invalid lexical/i),
    });
    expect(surface.setLexical).not.toHaveBeenCalled();
    expect(surface.nativeSave).not.toHaveBeenCalled();
    expect(surface.restoreRollback).toHaveBeenCalledTimes(1);
  });

  it('rejects structurally invalid serialized Lexical before native save', async () => {
    const surface = capableSurface();
    const adapter = createGhostStateAdapter(surface);

    await expect(
      adapter.apply(
        readyPlan([{ field: 'body', op: 'set', status: 'apply', value: '{"root":{}}' }]),
      ),
    ).rejects.toMatchObject({ code: 'APPLY_FAILED' });
    expect(surface.setLexical).not.toHaveBeenCalled();
    expect(surface.nativeSave).not.toHaveBeenCalled();
  });

  it('validates every action before mutating when a later body payload is invalid', async () => {
    const surface = capableSurface();
    const adapter = createGhostStateAdapter(surface);
    await expect(
      adapter.apply(
        readyPlan([
          { field: 'excerpt', op: 'set', status: 'apply', value: 'must not persist' },
          { field: 'body', op: 'set', status: 'apply', value: '{"root":{}}' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'APPLY_FAILED' });
    expect(surface.setField).not.toHaveBeenCalled();
    expect(surface.setLexical).not.toHaveBeenCalled();
    expect(surface.nativeSave).not.toHaveBeenCalled();
  });

  it('mutates live fields, invokes exactly one native save, and returns clean state', async () => {
    const surface = capableSurface();
    const adapter = createGhostStateAdapter(surface);
    const result = await adapter.apply(
      readyPlan([
        { field: 'excerpt', op: 'set', status: 'apply', value: 'hello' },
        { field: 'customTemplate', op: 'set', status: 'apply', value: 'tpl.hbs' },
        { field: 'tags', op: 'set', status: 'apply', value: ['X', 'Y'] },
      ]),
    );
    expect(surface.setField).toHaveBeenCalledWith('excerpt', 'hello');
    expect(surface.setField).toHaveBeenCalledWith('customTemplate', 'tpl.hbs');
    expect(surface.setField).toHaveBeenCalledWith('tags', ['X', 'Y']);
    expect(surface.nativeSave).toHaveBeenCalledTimes(1);
    expect(surface.captureRollback).toHaveBeenCalledTimes(2);
    expect(result.saved).toBe(true);
    expect(result.updatedAt).toBe('2026-08-21T01:00:00.000Z');
  });

  it('replaces the body via setLexical when a body action is present', async () => {
    const surface = capableSurface();
    const adapter = createGhostStateAdapter(surface);
    await adapter.apply(
      readyPlan([
        {
          field: 'body',
          op: 'set',
          status: 'apply',
          value: '{"root":{"children":[],"type":"root","version":1}}',
        },
      ]),
    );
    expect(surface.setLexical).toHaveBeenCalledWith(
      '{"root":{"children":[],"type":"root","version":1}}',
    );
  });
});

describe('C4 rollback on failure', () => {
  it('rolls back through the live path when native save throws and proves recovery', async () => {
    const surface = capableSurface({
      nativeSave: vi.fn(async () => {
        throw new Error('save conflict');
      }),
    });
    const adapter = createGhostStateAdapter(surface);
    await expect(
      adapter.apply(readyPlan([{ field: 'excerpt', op: 'set', status: 'apply', value: 'x' }])),
    ).rejects.toMatchObject({ code: 'APPLY_FAILED' });
    expect(surface.restoreRollback).toHaveBeenCalledTimes(1);
  });

  it('escalates to ROLLBACK_FAILED when restore itself cannot be proven', async () => {
    const surface = capableSurface({
      nativeSave: vi.fn(async () => {
        throw new Error('save conflict');
      }),
      restoreRollback: vi.fn(() => {
        throw new Error('restore broken');
      }),
    });
    const adapter = createGhostStateAdapter(surface);
    await expect(
      adapter.apply(readyPlan([{ field: 'excerpt', op: 'set', status: 'apply', value: 'x' }])),
    ).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' });
  });

  it('escalates to ROLLBACK_FAILED when restore returns but readback verification fails', async () => {
    const surface = capableSurface({
      nativeSave: vi.fn(async () => {
        throw new Error('save conflict');
      }),
      verifyRollback: vi.fn(() => false),
    });
    const adapter = createGhostStateAdapter(surface);
    await expect(
      adapter.apply(readyPlan([{ field: 'excerpt', op: 'set', status: 'apply', value: 'x' }])),
    ).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' });
    expect(surface.verifyRollback).toHaveBeenCalledTimes(1);
  });

  it('escalates SAVE_FAILED when native save is clean but applied fields fail readback', async () => {
    const surface = capableSurface({ verifyApplied: vi.fn(() => false) });
    const adapter = createGhostStateAdapter(surface);
    await expect(
      adapter.apply(readyPlan([{ field: 'excerpt', op: 'set', status: 'apply', value: 'x' }])),
    ).rejects.toMatchObject({ code: 'SAVE_FAILED' });
    expect(surface.nativeSave).toHaveBeenCalledTimes(1);
    expect(surface.restoreRollback).toHaveBeenCalledTimes(1);
  });
});

describe('C4 unsupported abort', () => {
  it('completes the native transaction for an unsaved record (resourceId null)', async () => {
    const surface = capableSurface({ getResourceId: () => null });
    const adapter = createGhostStateAdapter(surface);
    const result = await adapter.apply(
      readyPlan([{ field: 'excerpt', op: 'set', status: 'apply', value: 'x' }]),
    );
    expect(result.resourceId).toBeNull();
    expect(result.saved).toBe(true);
  });
});

describe('adapter exposes a cohesive interface type', () => {
  it('createGhostStateAdapter returns a GhostStateAdapter', () => {
    const adapter: GhostStateAdapter = createGhostStateAdapter(capableSurface());
    expect(typeof adapter.discover).toBe('function');
    expect(typeof adapter.snapshot).toBe('function');
    expect(typeof adapter.planApply).toBe('function');
    expect(typeof adapter.apply).toBe('function');
    expect(typeof adapter.rollback).toBe('function');
    expect(typeof adapter.undoLastApply).toBe('function');
  });
});

describe('last successful apply undo', () => {
  function statefulSurface() {
    const state = {
      excerpt: 'old excerpt',
      title: 'old title',
      customTemplate: null as string | null,
      tags: [] as string[],
      lexical: '{"root":{}}',
      updatedAt: 'before',
    };
    let saves = 0;
    const snapshot = () => ({
      lexical: state.lexical,
      updated_at: state.updatedAt,
      customExcerpt: state.excerpt,
      customTemplate: state.customTemplate,
      title: state.title,
      tags: state.tags.map((name) => ({ name })),
    });
    const surface = capableSurface({
      getRecordIdentity: () => 'record-a',
      getUpdatedAt: () => state.updatedAt,
      getLexical: () => state.lexical,
      getExcerpt: () => state.excerpt,
      getTitle: () => state.title,
      getCustomTemplate: () => state.customTemplate,
      getTags: () => [...state.tags],
      setField: vi.fn((field, value) => {
        if (field === 'excerpt') state.excerpt = String(value);
        if (field === 'title') state.title = String(value);
        if (field === 'customTemplate') state.customTemplate = String(value);
        if (field === 'tags') state.tags = [...(value as string[])];
      }),
      setLexical: vi.fn((value) => {
        state.lexical = value;
      }),
      nativeSave: vi.fn(async () => {
        saves += 1;
        state.updatedAt = `after-${saves}`;
        return { updatedAt: state.updatedAt };
      }),
      captureRollback: vi.fn(snapshot),
      restoreRollback: vi.fn((raw: unknown) => {
        const value = raw as ReturnType<typeof snapshot>;
        state.lexical = value.lexical;
        state.updatedAt = value.updated_at;
        state.excerpt = value.customExcerpt;
        state.customTemplate = value.customTemplate;
        state.title = value.title;
        state.tags = value.tags.map((tag) => tag.name);
      }),
      verifyRollback: vi.fn((raw: unknown) => {
        const value = raw as ReturnType<typeof snapshot>;
        return (
          state.lexical === value.lexical &&
          state.updatedAt === value.updated_at &&
          state.excerpt === value.customExcerpt &&
          state.title === value.title &&
          state.customTemplate === value.customTemplate &&
          state.tags.join('\\u0000') === value.tags.map((tag) => tag.name).join('\\u0000')
        );
      }),
    });
    return { state, surface };
  }

  it('undoes the last successful apply through one explicit second native save', async () => {
    const { state, surface } = statefulSurface();
    const adapter = createGhostStateAdapter(surface);
    await adapter.apply(
      readyPlan([{ field: 'excerpt', op: 'set', status: 'apply', value: 'new excerpt' }]),
    );
    expect(state.excerpt).toBe('new excerpt');
    const result = await adapter.undoLastApply();
    expect(result).toMatchObject({ saved: true, resourceId: 'post-1', updatedAt: 'after-2' });
    expect(state.excerpt).toBe('old excerpt');
    expect(surface.nativeSave).toHaveBeenCalledTimes(2);
    expect(surface.restoreRollback).toHaveBeenCalledTimes(1);
  });

  it('refuses undo after the editor changed since the successful apply', async () => {
    const { state, surface } = statefulSurface();
    const adapter = createGhostStateAdapter(surface);
    await adapter.apply(
      readyPlan([{ field: 'excerpt', op: 'set', status: 'apply', value: 'new excerpt' }]),
    );
    state.excerpt = 'user edit';
    await expect(adapter.undoLastApply()).rejects.toMatchObject({ code: 'STALE_EDITOR' });
    expect(surface.restoreRollback).not.toHaveBeenCalled();
    expect(surface.nativeSave).toHaveBeenCalledTimes(1);
  });

  it('reports ROLLBACK_UNPROVEN when there is no successful apply to undo', async () => {
    const adapter = createGhostStateAdapter(capableSurface());
    await expect(adapter.undoLastApply()).rejects.toMatchObject({ code: 'ROLLBACK_UNPROVEN' });
  });
});
