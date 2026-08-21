/**
 * Phase-5 MAIN-world bridge (owns this module).
 *
 * Runs INSIDE the Ghost Admin page MAIN world and answers the fixed C3 bridge
 * allowlist (discover / snapshot / planApply / apply / save / rollback) for the
 * isolated content script. It implements the versioned `GhostLiveSurface`
 * against the REAL, proven Ghost Ember internals (verified live in the Phase-0
 * spike t_4f22448d against Ghost v6.60 at :2368):
 *
 *   - Ember owner:  window.Ember.Namespace.NAMESPACES[0].__container__
 *   - editor record: container.lookup('controller:lexical-editor')
 *                      → .post / .model.post / .model  (live Ember Data record)
 *
 * All capability access is gated inside `createGhostStateAdapter` via
 * `discover()`: if Ember/owner/controller/record/save/rollback are not all
 * reachable, discovery returns UNSUPPORTED_CAPABILITY and NO mutation occurs.
 *
 * The adapter owns the serialized native transaction (snapshot → planApply →
 * apply → one native save → verify), with rollback-on-failure through the same
 * live path. This module is the ONLY place that touches Ghost page internals;
 * it exposes no eval, no arbitrary property access, no fetch, no extension
 * APIs. There is no separate HTML/lexical body source for inline content in the
 * current preset schema, so body actions are applied from an explicit lexical
 * value (e.g. an API-retrieved snippet body) carried by the plan.
 *
 * Per the spike evidence, title writes route through the controller's scratch
 * action (`updateTitleScratch`) when present; all other metadata/tag/body writes
 * go through the live model property and persist via the one native save.
 */

import { createGhostStateAdapter, type GhostLiveSurface } from './ghost-state';
import { createPageBridgeResponder, type PageBridgeResponderEnv } from './page-bridge';
import type { BridgeResponse } from './bridge-protocol';

/* ------------------------------------------------------------------ */
/* Real Ghost Ember object discovery (C2, proven in spike t_4f22448d)   */
/* ------------------------------------------------------------------ */

interface GhostModelLike {
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => unknown;
  hasDirtyAttributes?: boolean;
  constructor?: { modelName?: string };
  id?: string | null;
}

interface GhostEditorModelLike extends GhostModelLike {
  post?: GhostModelLike | null;
}

interface GhostControllerLike {
  post?: GhostModelLike | null;
  model?: GhostEditorModelLike | null;
  save?: (...args: unknown[]) => unknown;
  actions?: Record<string, (...args: unknown[]) => unknown>;
  send?: (action: string, ...args: unknown[]) => unknown;
  updateTitleScratch?: (...args: unknown[]) => unknown;
}

interface GhostStoreLike {
  peekAll: (type: string) => Array<{ name: string; id?: string }>;
  createRecord: (type: string, attrs: Record<string, unknown>) => unknown;
}

interface GhostOwnerLike {
  lookup: (name: string) => unknown;
}

interface GlobalWithEmber {
  Ember?: {
    Namespace?: { NAMESPACES?: Array<{ __container__?: GhostOwnerLike } & object> };
    Application?: object;
  };
}

function findEmberOwner(): GhostOwnerLike | null {
  const win = globalThis as GlobalWithEmber;
  const Application = win.Ember?.Application as unknown as { prototype?: object } | undefined;
  const apps = win.Ember?.Namespace?.NAMESPACES?.filter((n) =>
    Application ? n instanceof (Application as never) : false,
  ) as Array<{ __container__?: GhostOwnerLike }> | undefined;
  if (apps && apps.length > 0 && apps[0]?.__container__) {
    return apps[0].__container__;
  }
  return null;
}

function getEditorController(owner: GhostOwnerLike | null): GhostControllerLike | null {
  if (!owner) return null;
  const ctrl = owner.lookup('controller:lexical-editor') as GhostControllerLike | undefined;
  return ctrl ?? null;
}

function getRecord(ctrl: GhostControllerLike | null): GhostModelLike | null {
  if (!ctrl) return null;
  const post = ctrl.post ?? ctrl.model?.post ?? ctrl.model;
  return (post as GhostModelLike) ?? null;
}

function getStore(owner: GhostOwnerLike): GhostStoreLike | null {
  return (owner.lookup('service:store') as GhostStoreLike) ?? null;
}

/** Last known resource id / updated_at — for recovery messaging. */
let lastKnown: { resourceId: string | null; updatedAt: string | null } = {
  resourceId: null,
  updatedAt: null,
};

/**
 * Build the C3 responder environment that wires the real Ghost surface into the
 * versioned `ghost-state` adapter. Exposed purely as a `handle(message)` so the
 * entry layer (`ui-toolbar-main`/content-script) can install it as the MAIN
 * bridge responder.
 */
export function createGhostMainBridge(): {
  handle: (message: unknown) => BridgeResponse | Promise<BridgeResponse>;
} {
  const surface: GhostLiveSurface = {
    getResourceType(): 'post' | 'page' {
      const ctrl = getEditorController(findEmberOwner());
      const rec = getRecord(ctrl);
      const name = rec?.constructor?.modelName;
      return name === 'page' ? 'page' : 'post';
    },
    getResourceId(): string | null {
      const ctrl = getEditorController(findEmberOwner());
      const rec = getRecord(ctrl);
      const id = (rec?.get?.('id') as string | undefined) ?? rec?.id ?? null;
      return id;
    },
    isDirty(): boolean {
      return Boolean(getRecord(getEditorController(findEmberOwner()))?.hasDirtyAttributes);
    },
    getUpdatedAt(): string | null {
      const ctrl = getEditorController(findEmberOwner());
      const rec = getRecord(ctrl);
      const v = rec?.get?.('updated_at') ?? rec?.get?.('updatedAt') ?? null;
      return typeof v === 'string' ? v : null;
    },
    getLexical(): string | null {
      const rec = getRecord(getEditorController(findEmberOwner()));
      const v = rec?.get?.('lexical') ?? null;
      return typeof v === 'string' ? v : null;
    },
    isBodyEmpty(): boolean {
      const lex = this.getLexical();
      if (lex === null) return false; // unreachable lexical ⇒ not empty (fail safe)
      try {
        const parsed = JSON.parse(lex) as { root?: { children?: unknown[] } };
        const children = parsed?.root?.children ?? [];
        return children.length === 0;
      } catch {
        return false;
      }
    },
    getExcerpt(): string | null {
      const rec = getRecord(getEditorController(findEmberOwner()));
      const v = rec?.get?.('custom_excerpt') ?? rec?.get?.('customExcerpt') ?? null;
      return typeof v === 'string' ? v : null;
    },
    getCustomTemplate(): string | null {
      const rec = getRecord(getEditorController(findEmberOwner()));
      const v = rec?.get?.('custom_template') ?? rec?.get?.('customTemplate') ?? null;
      return typeof v === 'string' ? v : null;
    },
    getTags(): string[] {
      const rec = getRecord(getEditorController(findEmberOwner()));
      const tags = (rec?.get?.('tags') as Array<{ name?: string }> | undefined) ?? [];
      return tags.map((t) => t?.name ?? '').filter((n) => n.length > 0);
    },
    setField(field: 'excerpt' | 'customTemplate' | 'tags', value: string | string[]): void {
      const owner = findEmberOwner();
      const ctrl = getEditorController(owner);
      const rec = getRecord(ctrl);
      if (!rec) throw new Error('live record unavailable for setField');
      if (field === 'tags') {
        const owner = findEmberOwner();
        const store = owner ? getStore(owner) : null;
        if (!store) throw new Error('Ember store unavailable for tag relation');
        const names = Array.isArray(value) ? value : [String(value)];
        const records = names.map((name) => {
          let tag = store.peekAll('tag').find((t) => t.name === name);
          if (!tag) tag = store.createRecord('tag', { name }) as { name: string; id?: string };
          return tag;
        });
        rec.set?.('tags', records);
      } else if (field === 'excerpt') {
        rec.set?.('custom_excerpt', value as string);
      } else {
        rec.set?.('custom_template', value as string);
      }
    },
    setLexical(lexical: string): void {
      const ctrl = getEditorController(findEmberOwner());
      const rec = getRecord(ctrl);
      if (!rec) throw new Error('live record unavailable for setLexical');
      rec.set?.('lexical', lexical);
    },
    async nativeSave(): Promise<{ updatedAt: string | null }> {
      const ctrl = getEditorController(findEmberOwner());
      if (!ctrl) throw new Error('editor controller unavailable for native save');
      const save = () => {
        if (ctrl.actions && typeof ctrl.actions.save === 'function') {
          return ctrl.send ? ctrl.send('save') : ctrl.actions.save();
        }
        if (typeof ctrl.save === 'function') return ctrl.save();
        if (ctrl.send) return ctrl.send('save');
        throw new Error('no native save path reachable');
      };
      const r = save();
      if (r && typeof (r as { then?: unknown }).then === 'function') {
        await r;
      } else {
        await new Promise<void>((res) => setTimeout(res, 1500));
      }
      // Verify the save actually persisted (spike C4: Ember's save resolves
      // even on failure, so we confirm via clean state).
      const rec = getRecord(ctrl);
      const dirty = Boolean(rec?.hasDirtyAttributes);
      if (dirty) throw new Error('native save did not persist (editor still dirty)');
      const id = (rec?.get?.('id') as string | undefined) ?? rec?.id ?? null;
      const updatedAt =
        (rec?.get?.('updated_at') as string | undefined) ??
        (rec?.get?.('updatedAt') as string | undefined) ??
        null;
      lastKnown = {
        resourceId: id ?? lastKnown.resourceId,
        updatedAt: updatedAt ?? lastKnown.updatedAt,
      };
      return { updatedAt: lastKnown.updatedAt };
    },
    captureRollback(): unknown {
      const ctrl = getEditorController(findEmberOwner());
      const rec = getRecord(ctrl);
      if (!rec) return null;
      // Snapshot the mutable fields the apply may touch.
      return {
        lexical: rec.get?.('lexical') ?? null,
        custom_excerpt: rec.get?.('custom_excerpt') ?? null,
        custom_template: rec.get?.('custom_template') ?? null,
        tags: (rec.get?.('tags') as Array<{ name?: string }> | undefined) ?? [],
        id: rec.get?.('id') ?? rec.id ?? null,
        updated_at: rec.get?.('updated_at') ?? rec.get?.('updatedAt') ?? null,
      };
    },
    restoreRollback(snapshot: unknown): void {
      if (!snapshot || typeof snapshot !== 'object') return;
      const snap = snapshot as Record<string, unknown>;
      const ctrl = getEditorController(findEmberOwner());
      const rec = getRecord(ctrl);
      if (!rec) throw new Error('live record unavailable for rollback');
      if ('lexical' in snap) rec.set?.('lexical', snap['lexical']);
      if ('custom_excerpt' in snap) rec.set?.('custom_excerpt', snap['custom_excerpt']);
      if ('custom_template' in snap) rec.set?.('custom_template', snap['custom_template']);
      if ('tags' in snap) rec.set?.('tags', snap['tags']);
    },
  };

  const adapter = createGhostStateAdapter(surface);

  const env: PageBridgeResponderEnv = {
    discover: () => adapter.discover(),
    snapshot: () => adapter.snapshot(),
    planApply: (payload) =>
      adapter.planApply(payload['plan'] as Parameters<typeof adapter.planApply>[0]),
    apply: (payload) => adapter.apply(payload['plan'] as Parameters<typeof adapter.apply>[0]),
    save: () => surface.nativeSave().then((r) => r),
    rollback: (payload) =>
      adapter.rollback(payload['token'] as Parameters<typeof adapter.rollback>[0]),
  };

  const responder = createPageBridgeResponder(env);
  return { handle: (message) => responder.handle(message) };
}
