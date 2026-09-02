import { describe, expect, it, vi } from 'vitest';

import { createGhostMainBridge, EDITOR_RELOAD_DELAY_MS } from '../../src/main-bridge';
import { BRIDGE_SOURCE_ID } from '../../src/bridge-protocol';
import type { ApplicationPlan } from '../../src/preset-engine';

/**
 * RED regression coverage for the real headed-MV3 partial-application defect
 * (t_ef2721b1). The fake below mirrors the ACTUAL Ghost 6.60 Ember semantics
 * verified against the live monorepo source.
 */
interface FakeTag {
  name: string;
  id?: string | null;
}

const BLANK_LEXICAL =
  '{"root":{"children":[{"children":[],"direction":null,"format":"","indent":0,"type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"root","version":1}}';

function serializeRecord(rec: FakeEmberPost): Record<string, unknown> {
  return {
    id: rec.id ?? null,
    lexical: rec.attrs['lexical'] ?? null,
    custom_excerpt: rec.attrs['customExcerpt'] ?? null,
    custom_template: rec.attrs['customTemplate'] ?? null,
    tags: (rec.attrs['tags'] as FakeTag[] | undefined)?.map((t) => t.name) ?? [],
  };
}

class FakeEmberPost {
  readonly attrs: Record<string, unknown> = {
    lexical: BLANK_LEXICAL,
    customExcerpt: null,
    customTemplate: null,
    tags: [],
  };
  readonly junkSets: string[] = [];
  id: string | null = null;
  hasDirtyAttributes = false;
  isNew = true;
  readonly modelName = 'post';
  savedCount = 0;
  lexicalScratch: string | null = null;

  get(key: string): unknown {
    return this.attrs[key];
  }

  set(key: string, value: unknown): unknown {
    if (key in this.attrs || key === 'tags' || key === 'lexical') {
      this.attrs[key] = value;
    } else if (key in this) {
      (this as unknown as Record<string, unknown>)[key] = value;
    } else {
      this.junkSets.push(key);
    }
    this.hasDirtyAttributes = true;
    return value;
  }

  save(): Promise<FakeEmberPost> {
    this.savedCount += 1;
    this.attrs['lexical'] = this.lexicalScratch || null;
    if (!this.id) this.id = 'fake-post-id-1';
    this.isNew = false;
    this.hasDirtyAttributes = false;
    return Promise.resolve(this);
  }
}

function makeOwnerHarness(post: FakeEmberPost, storeTags: FakeTag[] = []) {
  const store = {
    peekAll: (_type: string) => storeTags,
    createRecord: (_type: string, attrs: Record<string, unknown>) => {
      const tag: FakeTag = { name: String(attrs['name']), id: null };
      storeTags.push(tag);
      return tag;
    },
  };
  const ctrl = {
    post,
    actions: { save: () => {} },
    send: (action: string) => {
      // Real Ghost save actions RETURN the save promise (nativeSave awaits it);
      // `return` (not `void`) lets a rejection propagate to the transaction's
      // failure path instead of being swallowed into the poll fallback.
      if (action === 'save') return post.save();
      return undefined;
    },
    save: () => post.save(),
  };
  const owner = {
    lookup: (name: string) =>
      name === 'controller:lexical-editor' ? ctrl : name === 'service:store' ? store : null,
  };

  class FakeApp {
    __container__ = owner;
  }
  (globalThis as Record<string, unknown>)['Ember'] = {
    Namespace: { NAMESPACES: [new FakeApp()] },
    Application: FakeApp,
  };
  return () => {
    delete (globalThis as Record<string, unknown>)['Ember'];
  };
}

function readyPlan(overrides?: Partial<ApplicationPlan>): ApplicationPlan {
  return {
    presetId: 'software-review',
    status: 'ready',
    actions: [
      {
        field: 'body',
        status: 'apply',
        value: BLANK_LEXICAL.replace(
          '"children":[]',
          '"children":[{"children":[],"direction":"ltr","format":"","indent":0,"type":"paragraph","version":1,"text":"A hands-on review.","mode":"normal","style":""}]',
        ),
      },
      { field: 'excerpt', status: 'apply', value: 'A hands-on review.' },
      { field: 'tags', status: 'apply', value: ['Reviews'] },
      ...(overrides?.actions ?? []),
    ],
    problems: [],
  } as ApplicationPlan;
}

describe('MAIN bridge live transaction vs real Ghost 6.60 semantics (t_ef2721b1)', () => {
  it('RED: setField writes camelCase Ember attributes so excerpt serializes', async () => {
    const post = new FakeEmberPost();
    const cleanup = makeOwnerHarness(post);
    try {
      const { handle } = createGhostMainBridge();
      const res = await handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-000000000001',
        op: 'apply',
        payload: { plan: readyPlan() },
      });
      expect(res.ok).toBe(true);
      expect(post.junkSets).toEqual([]);
      const serialized = serializeRecord(post);
      expect(serialized['custom_excerpt']).toBe('A hands-on review.');
    } finally {
      cleanup();
    }
  });

  it('RED: body survives the native-save scratch pipeline (not clobbered to blank)', async () => {
    const post = new FakeEmberPost();
    const cleanup = makeOwnerHarness(post);
    try {
      const { handle } = createGhostMainBridge();
      const res = await handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-000000000002',
        op: 'apply',
        payload: { plan: readyPlan() },
      });
      expect(res.ok).toBe(true);
      const serialized = serializeRecord(post);
      const lexical = serialized['lexical'] as string;
      expect(lexical).toBeTruthy();
      const parsed = JSON.parse(lexical as string) as { root?: { children?: unknown[] } };
      expect(parsed.root?.children?.length ?? 0).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('RED: one apply atomically persists body + excerpt + tags through one native save', async () => {
    const post = new FakeEmberPost();
    const cleanup = makeOwnerHarness(post);
    try {
      const { handle } = createGhostMainBridge();
      const res = await handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-000000000003',
        op: 'apply',
        payload: { plan: readyPlan() },
      });
      expect(res.ok).toBe(true);
      expect(post.savedCount).toBe(1);
      const s = serializeRecord(post);
      expect(s['custom_excerpt']).toBe('A hands-on review.');
      expect(s['tags']).toEqual(['Reviews']);
      const parsed = JSON.parse(s['lexical'] as string) as { root?: { children?: unknown[] } };
      expect((parsed.root?.children ?? []).length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  it('schedules the editor auto-reload after a successful apply (saved record)', async () => {
    const post = new FakeEmberPost();
    const cleanup = makeOwnerHarness(post);
    const afterApply = vi.fn();
    try {
      const { handle } = createGhostMainBridge({ afterApply });
      const res = await handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-00000000000b',
        op: 'apply',
        payload: { plan: readyPlan() },
      });
      expect(res.ok).toBe(true);
      // The saved record now has a server id → the bridge reloads the editor
      // so the applied text is visible without a manual refresh.
      expect(afterApply).toHaveBeenCalledTimes(1);
      expect(afterApply).toHaveBeenCalledWith('post', post.id);
    } finally {
      cleanup();
    }
  });

  it('does NOT schedule a reload when apply fails (rollback path — nothing persisted)', async () => {
    const post = new FakeEmberPost();
    post.save = () => {
      // Save fails and leaves the record dirty → adapter.apply throws after
      // rollback; no reload may fire for content that was never persisted.
      post.hasDirtyAttributes = true;
      return Promise.reject(new Error('save failed'));
    };
    const cleanup = makeOwnerHarness(post);
    const afterApply = vi.fn();
    try {
      const { handle } = createGhostMainBridge({ afterApply });
      const res = await handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-00000000000c',
        op: 'apply',
        payload: { plan: readyPlan() },
      });
      expect(res.ok).toBe(false);
      expect(afterApply).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('RED: snapshot reads camelCase attributes so only-if-empty planning sees live truth', async () => {
    const post = new FakeEmberPost();
    post.attrs['customExcerpt'] = 'Existing excerpt';
    const cleanup = makeOwnerHarness(post);
    try {
      const { handle } = createGhostMainBridge();
      const res = handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-000000000004',
        op: 'snapshot',
        payload: {},
      }) as { ok: boolean; result: { excerpt: string | null; bodyEmpty: boolean } };
      expect(res.ok).toBe(true);
      expect(res.result.excerpt).toBe('Existing excerpt');
    } finally {
      cleanup();
    }
  });

  it('isBodyEmpty treats a single empty paragraph as EMPTY so only-if-empty fires', async () => {
    const post = new FakeEmberPost();
    post.attrs['lexical'] = BLANK_LEXICAL;
    const cleanup = makeOwnerHarness(post);
    try {
      const { handle } = createGhostMainBridge();
      const res = handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-00000000000a',
        op: 'snapshot',
        payload: {},
      }) as { ok: boolean; result: { bodyEmpty: boolean } };
      expect(res.ok).toBe(true);
      expect(res.result.bodyEmpty).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('preserves ROLLBACK_FAILED (not collapsed to APPLY_FAILED) when rollback throws', async () => {
    const post = new FakeEmberPost();
    const cleanup = makeOwnerHarness(post);
    // Simulate a save failure where the editor record is also unrecoverable
    // (e.g. the live record vanished), so restoreRollback cannot prove a
    // clean revert — the bridge must surface ROLLBACK_FAILED, not APPLY_FAILED.
    post.save = () => {
      post.hasDirtyAttributes = true;
      // Tear down the Ember owner so rollback cannot find the record.
      delete (globalThis as Record<string, unknown>)['Ember'];
      throw new Error('simulated save failure');
    };
    try {
      const { handle } = createGhostMainBridge();
      const res = await handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-00000000000b',
        op: 'apply',
        payload: { plan: readyPlan() },
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('expected failure response');
      expect(res.error).toBe('ROLLBACK_FAILED');
    } finally {
      cleanup();
    }
  });

  it('undoes the last successful apply through the MAIN bridge', async () => {
    const post = new FakeEmberPost();
    post.attrs['customExcerpt'] = 'before';
    const cleanup = makeOwnerHarness(post);
    try {
      const { handle } = createGhostMainBridge({ afterApply: vi.fn() });
      const applied = await handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-00000000000d',
        op: 'apply',
        payload: { plan: readyPlan() },
      });
      expect(applied.ok).toBe(true);
      const undone = await handle({
        v: 1,
        source: BRIDGE_SOURCE_ID,
        nonce: '00000000-0000-4000-8000-00000000000e',
        op: 'undo',
        payload: {},
      });
      expect(undone).toMatchObject({ ok: true, result: { saved: true } });
      expect(post.savedCount).toBe(2);
      expect(post.attrs['customExcerpt']).toBe('before');
    } finally {
      cleanup();
    }
  });

  it('cancels the default reload after a successful Undo', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.stubGlobal('location', { hash: '', reload });
    const post = new FakeEmberPost();
    const cleanup = makeOwnerHarness(post);
    try {
      const { handle } = createGhostMainBridge();
      const base = {
        v: 1 as const,
        source: BRIDGE_SOURCE_ID,
        op: 'apply' as const,
        payload: { plan: readyPlan() },
      };
      expect((await handle({ ...base, nonce: '00000000-0000-4000-8000-00000000000f' })).ok).toBe(
        true,
      );
      expect(
        (
          await handle({
            v: 1,
            source: BRIDGE_SOURCE_ID,
            nonce: '00000000-0000-4000-8000-000000000010',
            op: 'undo',
            payload: {},
          })
        ).ok,
      ).toBe(true);
      vi.advanceTimersByTime(EDITOR_RELOAD_DELAY_MS + 1);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
