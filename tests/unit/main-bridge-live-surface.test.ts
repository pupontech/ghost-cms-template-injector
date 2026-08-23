import { describe, expect, it } from 'vitest';

import { createGhostMainBridge } from '../../src/main-bridge';
import { BRIDGE_SOURCE_ID } from '../../src/bridge-protocol';
import type { ApplicationPlan } from '../../src/preset-engine';

/**
 * RED regression coverage for the real headed-MV3 partial-application defect
 * (t_ef2721b1). The fake below mirrors the ACTUAL Ghost 6.60 Ember semantics
 * verified against the live monorepo source:
 *
 *   - `apps/ember-admin/app/models/post.js` defines camelCase attributes:
 *     `customExcerpt`, `customTemplate`, `lexical`. Setting snake_case
 *     properties on an Ember Data record creates junk plain properties that
 *     are NEVER serialized — the server keeps `custom_excerpt: null`.
 *   - `apps/ember-admin/app/controllers/lexical-editor.js` `beforeSaveTask`
 *     (line ~745) does `this.set('post.lexical', this.post.lexicalScratch ||
 *     null)` before every native save. A body written only to
 *     `post.lexical` is clobbered by the scratch pipeline (new post ⇒
 *     `lexicalScratch` null ⇒ blank Lexical root persisted).
 *   - Tags persist because `'tags'` IS the real relation attribute name,
 *     which matches the observed headed symptom (tag persisted, body and
 *     excerpt did not).
 */

interface FakeTag {
  name: string;
  id?: string | null;
}

const BLANK_LEXICAL =
  '{"root":{"children":[{"children":[],"direction":null,"format":"","indent":0,"type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"root","version":1}}';

/** Serialized attrs an Ember Data record would actually PUT to the server. */
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
  /** Only real Ember attribute names live here; junk sets are recorded separately. */
  readonly attrs: Record<string, unknown> = {
    lexical: BLANK_LEXICAL,
    customExcerpt: null,
    customTemplate: null,
    tags: [],
  };
  /** Plain-property sets that Ember Data would never serialize. */
  readonly junkSets: string[] = [];
  id: string | null = null;
  hasDirtyAttributes = false;
  isNew = true;
  readonly modelName = 'post';
  savedCount = 0;
  /** Plain scratch properties exactly as on the real post model (post.js). */
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

  /** Mirrors controller.saveTask → beforeSaveTask scratch clobber + persist. */
  save(): Promise<FakeEmberPost> {
    this.savedCount += 1;
    // beforeSaveTask: post.set('lexical', post.lexicalScratch || null)
    this.attrs['lexical'] = this.lexicalScratch || null;
    // server assigns an id on first persist
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
      if (action === 'save') void post.save();
    },
    save: () => post.save(),
  };
  const owner = {
    lookup: (name: string) =>
      name === 'controller:lexical-editor' ? ctrl : name === 'service:store' ? store : null,
  };

  // Emulate window.Ember.Namespace.NAMESPACES[0].__container__.
  // findEmberOwner keeps only NAMESPACES entries that are instanceof
  // Ember.Application (true of the real Ghost admin app), so the fake
  // namespace must be constructed from the same class.
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
      // No junk property writes: every mutation must land on a real attr.
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
});
