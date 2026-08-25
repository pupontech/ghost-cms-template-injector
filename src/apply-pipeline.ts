/**
 * Phase-5 atomic end-to-end apply pipeline (owns this module).
 *
 * Pure orchestration glue that ties the proven, independently-tested building
 * blocks into ONE atomic apply:
 *
 *   1. capability gate      → adapter.discover()  (UNSUPPORTED_CAPABILITY fails closed)
 *   2. load preset          → loadPreset(id)
 *   3. live snapshot        → adapter.snapshot()  (C4 live-editor state)
 *   4. dependency context   → resolveContext()     (snippets / active-theme templates)
 *   5. plan (per-field mode)→ planPresetApplication (C4/C5/C6, pure, fail-closed)
 *   6. prompt resolution    → resolvePrompts when the plan awaits user answers
 *   7. atomic apply         → adapter.apply(plan)  (one native transaction, locked)
 *
 * The pipeline never touches chrome.* or fetch directly — every side effect is
 * injected, so the whole flow is unit-testable with fakes. The adapter is the
 * ONLY mutation surface; in production it is a thin proxy over the C3 MAIN-world
 * bridge (`createBridgeStateAdapter`), which forwards to the versioned
 * `ghost-state` adapter that owns the serialized native transaction.
 *
 * Double-apply safety: the underlying bridge responder and the `ghost-state`
 * adapter both serialize transactional ops (BUSY / #busy), so a second
 * concurrent `apply` is refused without partial mutation.
 */

import type { Preset } from './preset-schema';
import {
  planPresetApplication,
  resolvePrompts,
  type ApplicationPlan,
  type EditorSnapshot,
  type PlanContext,
  type PlannedField,
} from './preset-engine';
import type { ApplyResult, DiscoverOutcome, GhostSnapshot } from './ghost-state';

/**
 * Async-capable adapter the pipeline drives. `discover`/`snapshot` may be sync
 * (the real `ghost-state` adapter) or async (the C3 bridge proxy); the pipeline
 * awaits both so either shape works.
 */
export interface ApplyPipelineAdapter {
  discover(): DiscoverOutcome | Promise<DiscoverOutcome>;
  snapshot(): GhostSnapshot | Promise<GhostSnapshot>;
  apply(plan: ApplicationPlan, expected?: GhostSnapshot): Promise<ApplyResult>;
}

export interface ApplyPipelineDeps {
  adapter: ApplyPipelineAdapter;
  /** Load a validated preset by id (bundled seeds + chrome.storage overrides). */
  loadPreset: (id: string) => Promise<Preset | null>;
  /** Resolve dependency allowlists (snippet names, active-theme templates). */
  resolveContext: () => Promise<PlanContext>;
}

export interface ApplyPrompt {
  field: PlannedField;
  question: string;
}

export type ApplyOutcome =
  | { status: 'applied'; result: ApplyResult }
  | { status: 'needs-prompt'; prompts: ApplyPrompt[] }
  | { status: 'blocked'; problems: readonly string[] }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; error: string };

function toEditorSnapshot(s: GhostSnapshot): EditorSnapshot {
  return {
    bodyEmpty: s.bodyEmpty,
    excerpt: s.excerpt,
    customTemplate: s.customTemplate,
    title: s.title ?? null,
    tags: s.tags,
  };
}

/**
 * Run the full atomic apply for a preset. `promptAnswers`, when supplied,
 * resolves a plan that is awaiting user confirmation; when omitted and the plan
 * still needs prompts, the caller is told which fields to ask about.
 */
export async function runApplyPipeline(
  deps: ApplyPipelineDeps,
  presetId: string,
  promptAnswers?: Partial<Record<PlannedField, boolean>>,
): Promise<ApplyOutcome> {
  // 1. Capability gate — fail closed before any preset/state work.
  const disc = await deps.adapter.discover();
  if (!disc.supported) {
    return { status: 'unsupported', reason: disc.reason };
  }

  // 2. Load the preset.
  const preset = await deps.loadPreset(presetId);
  if (!preset) {
    return { status: 'blocked', problems: [`preset "${presetId}" not found`] };
  }

  // 3 + 4. Live snapshot + dependency context (parallel, independent reads).
  const [snapshot, context] = await Promise.all([deps.adapter.snapshot(), deps.resolveContext()]);

  // 5. Pure plan — every dependency/mode resolved before any mutation.
  const plan = planPresetApplication(preset, toEditorSnapshot(snapshot), context);
  if (plan.status === 'blocked') {
    return { status: 'blocked', problems: plan.problems };
  }

  // 6. Prompt resolution.
  let exec: ApplicationPlan = plan;
  if (exec.status === 'needs-prompt') {
    if (!promptAnswers) {
      const prompts: ApplyPrompt[] = plan.actions
        .filter((a) => a.status === 'prompt')
        .map((a) => ({ field: a.field, question: a.question ?? '' }));
      return { status: 'needs-prompt', prompts };
    }
    try {
      exec = resolvePrompts(plan, promptAnswers);
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : 'prompt resolution failed',
      };
    }
  }

  // 7. Atomic apply — single native transaction, recoverable on failure.
  try {
    const result = await deps.adapter.apply(exec, snapshot);
    return { status: 'applied', result };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : 'apply failed' };
  }
}
