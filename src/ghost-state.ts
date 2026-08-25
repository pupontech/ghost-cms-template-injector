/**
 * C2/C4 versioned live Ghost state adapter.
 *
 * The single MAIN-world owner of the open Ghost editor's live Ember/React/
 * Lexical record. It exists behind the C3 bridge only — the isolated world
 * never reaches Ghost internals directly. This module is capability-gated:
 * `discover` must prove every capability before any mutation, and
 * `apply`/`save`/`rollback` are one serialized transaction that can recover
 * through the same live path.
 *
 * It depends ONLY on:
 *   - bridge-protocol  (C3 contract types — no transport, no React)
 *   - preset-engine     (ApplicationPlan shape produced by the pure planner)
 *   - preset-schema     (PlanAction value typing for tag lists)
 *
 * No Admin API, no fetch, no DOM automation, no UI here. The actual Ghost
 * object references are injected as opaque `GhostHandles` by the page script
 * that wires the adapter into the C3 responder; the adapter calls a small,
 * fixed, capability-gated `GhostCapability` surface that the page script
 * implements against the real Ember/Lexical internals.
 */

import type { ApplicationPlan, PlanAction } from './preset-engine';
import { isSerializedLexical } from './preset-schema';
export type { ApplicationPlan, PlanAction };

/* ------------------------------------------------------------------ */
/* Versioning                                                          */
/* ------------------------------------------------------------------ */

/** Adapter protocol version. Bumped on any contract change to the surface. */
export const GHOST_STATE_ADAPTER_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Capability discovery (C2)                                           */
/* ------------------------------------------------------------------ */

export type GhostResourceType = 'post' | 'page';

/**
 * Structured capability object returned by `discover` only after every
 * capability is proven reachable. Any failure yields UNSUPPORTED_CAPABILITY
 * and performs no mutation. Discovery is NOT generic property traversal.
 */
export interface GhostCapability {
  adapterVersion: number;
  resourceType: GhostResourceType;
  /** Live record id; null while the editor holds an unsaved client record. */
  resourceId: string | null;
  /** Whether a live Lexical editor state is reachable. */
  hasLexical: boolean;
  /** Whether the relation mutation path (tags/template) is reachable. */
  canMutateRelations: boolean;
  /** Whether exactly one native-save path is reachable. */
  canNativeSave: boolean;
  /** Whether a live rollback snapshot/restore path is reachable. */
  canRollback: boolean;
  /** Current dirty flag (uncommitted local changes). */
  dirty: boolean;
  /** Server `updated_at` if the record is saved, else null. */
  updatedAt: string | null;
}

export type DiscoverOutcome =
  { supported: true; capability: GhostCapability } | { supported: false; reason: string };

/* ------------------------------------------------------------------ */
/* Live snapshot (C4)                                                  */
/* ------------------------------------------------------------------ */

export interface GhostSnapshot {
  resourceType: GhostResourceType;
  resourceId: string | null;
  /** Live metadata — title, excerpt, and custom template exactly as stored. */
  title: string | null;
  excerpt: string | null;
  customTemplate: string | null;
  /** Tags in live relation display order. */
  tags: string[];
  /** Lexical state serialized for emptiness checks and body writes. */
  lexical: string | null;
  /** True when the body holds no content. */
  bodyEmpty: boolean;
  dirty: boolean;
  updatedAt: string | null;
  /** Whether a save is currently in flight (save activity). */
  saving: boolean;
}

/* ------------------------------------------------------------------ */
/* Apply / save / rollback (C4)                                        */
/* ------------------------------------------------------------------ */

export type GhostStateError =
  | 'UNSUPPORTED_CAPABILITY'
  | 'UNSAVED_RECORD'
  | 'CAPABILITY_MISSING'
  | 'APPLY_FAILED'
  | 'SAVE_FAILED'
  | 'ROLLBACK_FAILED'
  | 'ROLLBACK_UNPROVEN';

export class GhostStateException extends Error {
  readonly code: GhostStateError;
  constructor(code: GhostStateError, message: string) {
    super(`ghost-state: ${message}`);
    this.name = 'GhostStateException';
    this.code = code;
  }
}

/**
 * Minimal, fixed, capability-gated surface the page script implements against
 * the real Ghost internals. The adapter never touches DOM or Ember directly.
 * Every method is a proved capability; anything missing fails closed.
 */
export interface GhostLiveSurface {
  getResourceType(): GhostResourceType;
  getResourceId(): string | null;
  isDirty(): boolean;
  getUpdatedAt(): string | null;
  /** Lexical state as serialized JSON, or null if none reachable. */
  getLexical(): string | null;
  isBodyEmpty(): boolean;
  getTitle(): string | null;
  getExcerpt(): string | null;
  getCustomTemplate(): string | null;
  getTags(): string[];
  /** Mutate a single field on the live record. Rejects unsupported fields. */
  setField(field: 'excerpt' | 'customTemplate' | 'tags' | 'title', value: string | string[]): void;
  /** Replace live Lexical state (body). Rejects when unsupported. */
  setLexical(lexical: string): void;
  /** Invoke exactly one Ghost-native save transaction. Resolves on clean. */
  nativeSave(): Promise<{ updatedAt: string | null }>;
  /** Capture a recoverable rollback snapshot through the live path. */
  captureRollback(): unknown;
  /** Restore a previously captured rollback snapshot. */
  restoreRollback(snapshot: unknown): void;
}

export interface ApplyResult {
  resourceId: string | null;
  updatedAt: string | null;
  /** True when the transaction survived and the editor is clean. */
  saved: boolean;
}

/**
 * The full, abstracted live-Ghost state adapter. Constructed in MAIN world
 * with an injected `GhostLiveSurface`. Owns the serialized transaction:
 * snapshot → planApply → apply → save → verify, with rollback on failure.
 */
export interface GhostStateAdapter {
  discover(): DiscoverOutcome;
  snapshot(): GhostSnapshot;
  /** Validate every dependency and mode before mutating (C4 planApply). */
  planApply(plan: ApplicationPlan): { ok: true } | { ok: false; reason: string };
  /** Mutate the live record per the validated plan, then save once. */
  apply(plan: ApplicationPlan): Promise<ApplyResult>;
  /** Pure rollback attempt; throws if recovery cannot be proven. */
  rollback(token: RollbackToken): void;
}

/** Opaque token tying a rollback to a specific pre-apply snapshot. */
export interface RollbackToken {
  readonly resourceId: string | null;
  readonly snapshot: unknown;
}

/* ------------------------------------------------------------------ */
/* Adapter construction                                                */
/* ------------------------------------------------------------------ */

/**
 * Build the live-state adapter over an injected capability surface. The
 * surface itself is the capability to be proven; `discover` returns
 * UNSUPPORTED_CAPABILITY without mutating when any required capability is
 * absent.
 */
export function createGhostStateAdapter(surface: GhostLiveSurface): GhostStateAdapter {
  return new GhostStateAdapterImpl(surface);
}

const FIELDS_REQUIRING_RELATION: ReadonlySet<string> = new Set(['customTemplate', 'tags']);

function validateActionValue(action: PlanAction): string | null {
  switch (action.field) {
    case 'body':
      return isSerializedLexical(action.value)
        ? null
        : 'body value must be structurally valid serialized Lexical; refusing to submit invalid lexical';
    case 'title':
    case 'excerpt':
    case 'customTemplate':
      return typeof action.value === 'string' ? null : `${action.field} value must be a string`;
    case 'tags':
      return Array.isArray(action.value) && action.value.every((tag) => typeof tag === 'string')
        ? null
        : 'tags value must be a string array';
    default:
      return `unknown field ${String(action.field)}`;
  }
}

class GhostStateAdapterImpl implements GhostStateAdapter {
  readonly #surface: GhostLiveSurface;
  #busy = false;
  #rollback: RollbackToken | null = null;

  constructor(surface: GhostLiveSurface) {
    this.#surface = surface;
  }

  discover(): DiscoverOutcome {
    const resourceType = this.#surface.getResourceType();
    const resourceId = this.#surface.getResourceId();
    const hasLexical = this.#surface.getLexical() !== null || this.#surface.isBodyEmpty();
    const canMutateRelations = typeof this.#surface.setField === 'function';
    const canNativeSave = typeof this.#surface.nativeSave === 'function';
    const canRollback =
      typeof this.#surface.captureRollback === 'function' &&
      typeof this.#surface.restoreRollback === 'function';

    // Capability gate: every required capability must be proven reachable.
    if (!hasLexical) {
      return unsupported('live Lexical state unreachable');
    }
    if (!canMutateRelations) {
      return unsupported('relation mutation path unreachable');
    }
    if (!canNativeSave) {
      return unsupported('native save path unreachable');
    }
    if (!canRollback) {
      return unsupported('rollback path unreachable');
    }

    return {
      supported: true,
      capability: {
        adapterVersion: GHOST_STATE_ADAPTER_VERSION,
        resourceType,
        resourceId,
        hasLexical,
        canMutateRelations,
        canNativeSave,
        canRollback,
        dirty: this.#surface.isDirty(),
        updatedAt: this.#surface.getUpdatedAt(),
      },
    };
  }

  snapshot(): GhostSnapshot {
    const lexical = this.#surface.getLexical();
    return {
      resourceType: this.#surface.getResourceType(),
      resourceId: this.#surface.getResourceId(),
      title: this.#surface.getTitle(),
      excerpt: this.#surface.getExcerpt(),
      customTemplate: this.#surface.getCustomTemplate(),
      tags: this.#surface.getTags(),
      lexical,
      bodyEmpty: this.#surface.isBodyEmpty(),
      dirty: this.#surface.isDirty(),
      updatedAt: this.#surface.getUpdatedAt(),
      saving: false,
    };
  }

  planApply(plan: ApplicationPlan): { ok: true } | { ok: false; reason: string } {
    if (plan.status !== 'ready') return { ok: false, reason: `plan not ready (${plan.status})` };
    for (const action of plan.actions) {
      if (action.status !== 'apply') continue;
      if (
        FIELDS_REQUIRING_RELATION.has(action.field) &&
        typeof this.#surface.setField !== 'function'
      ) {
        return { ok: false, reason: `relation mutation unsupported for ${action.field}` };
      }
      const invalid = validateActionValue(action);
      if (invalid) return { ok: false, reason: invalid };
    }
    return { ok: true };
  }

  async apply(plan: ApplicationPlan): Promise<ApplyResult> {
    if (this.#busy) {
      throw new GhostStateException('CAPABILITY_MISSING', 'transaction already in flight');
    }
    this.#busy = true;
    try {
      // Capture rollback BEFORE any mutation.
      const snapshot = this.#surface.captureRollback();
      this.#rollback = {
        resourceId: this.#surface.getResourceId(),
        snapshot,
      };

      const check = this.planApply(plan);
      if (!check.ok) {
        throw new GhostStateException('APPLY_FAILED', check.reason ?? 'plan validation failed');
      }

      for (const action of plan.actions) {
        if (action.status !== 'apply') continue;
        this.#mutate(action);
      }

      // Exactly one native save transaction.
      const result = await this.#surface.nativeSave();
      this.#rollback = null; // success — recovery no longer needed
      return {
        resourceId: this.#surface.getResourceId(),
        updatedAt: result.updatedAt ?? this.#surface.getUpdatedAt(),
        saved: true,
      };
    } catch (err) {
      await this.#attemptRollback();
      if (err instanceof GhostStateException) throw err;
      throw new GhostStateException('APPLY_FAILED', (err as Error).message);
    } finally {
      this.#busy = false;
    }
  }

  #mutate(action: PlanAction): void {
    switch (action.field) {
      case 'excerpt':
        this.#surface.setField('excerpt', String(action.value ?? ''));
        break;
      case 'title':
        this.#surface.setField('title', String(action.value ?? ''));
        break;
      case 'customTemplate':
        this.#surface.setField('customTemplate', String(action.value ?? ''));
        break;
      case 'tags':
        this.#surface.setField('tags', Array.isArray(action.value) ? action.value : []);
        break;
      case 'body':
        if (!isSerializedLexical(action.value)) {
          throw new GhostStateException(
            'APPLY_FAILED',
            'body value must be structurally valid serialized Lexical; refusing to submit invalid lexical',
          );
        }
        this.#surface.setLexical(action.value);
        break;
      default:
        throw new GhostStateException('APPLY_FAILED', `unknown field ${action.field}`);
    }
  }

  async #attemptRollback(): Promise<void> {
    if (!this.#rollback) return;
    try {
      this.#surface.restoreRollback(this.#rollback.snapshot);
      this.#rollback = null;
    } catch {
      // Rollback could not be proven — retain recoverable failure record.
      throw new GhostStateException(
        'ROLLBACK_FAILED',
        'mutation failed and rollback could not be proven; editor left recoverable',
      );
    }
  }

  rollback(token: RollbackToken): void {
    if (!token) {
      throw new GhostStateException('ROLLBACK_UNPROVEN', 'no rollback token supplied');
    }
    try {
      this.#surface.restoreRollback(token.snapshot);
    } catch {
      throw new GhostStateException('ROLLBACK_FAILED', 'rollback restore failed');
    }
  }
}

function unsupported(reason: string): DiscoverOutcome {
  return { supported: false, reason };
}
