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

import type { FeatureImageField, Preset } from './preset-schema';
import {
  planPresetApplication,
  resolvePrompts,
  shouldResolveFeatureImage,
  type ApplicationPlan,
  type EditorSnapshot,
  type PlanContext,
  type PlannedField,
} from './preset-engine';
import type { ResolveFeatureImageResult } from './feature-image';
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
  /**
   * Resolve a preset's feature-image field to a URL this Ghost install serves
   * (uploading a cached photo when the preset carries one). When a preset asks
   * for a feature image and this is absent or fails, the plan is blocked —
   * a preset never saves a post with a missing or broken image.
   */
  resolveFeatureImage?: (field: FeatureImageField) => Promise<ResolveFeatureImageResult>;
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

/** Read-only preview produced by the same fresh snapshot/planning path as apply. */
export type PreviewOutcome =
  | { status: 'preview'; plan: ApplicationPlan; snapshot: GhostSnapshot }
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
    featureImage: s.featureImage ?? null,
  };
}

/**
 * Resolve the preset's feature-image field (uploading a cached photo when
 * needed) and fold the result into the planning context. Failures block the
 * whole plan — a preset must never half-apply because its photo was missing.
 */
async function withResolvedFeatureImage(
  deps: ApplyPipelineDeps,
  preset: Preset,
  snapshot: EditorSnapshot,
  context: PlanContext,
  answers?: Partial<Record<PlannedField, boolean>>,
): Promise<{ ok: true; context: PlanContext } | { ok: false; reason: string }> {
  const field = preset.metadata?.featureImage;
  if (!field) return { ok: true, context };
  if (!shouldResolveFeatureImage(field, snapshot, answers)) return { ok: true, context };
  if (!deps.resolveFeatureImage) {
    return {
      ok: false,
      reason: 'metadata.featureImage: feature-image resolution is unavailable in this context',
    };
  }
  try {
    const resolved = await deps.resolveFeatureImage(field);
    if (!resolved.ok) return { ok: false, reason: `metadata.featureImage: ${resolved.reason}` };
    return { ok: true, context: { ...context, featureImageUrl: resolved.url } };
  } catch (err) {
    return {
      ok: false,
      reason: `metadata.featureImage: ${err instanceof Error ? err.message : 'resolution failed'}`,
    };
  }
}

/** Produce a field-aware plan without invoking the adapter mutation surface. */
export async function previewApplyPipeline(
  deps: ApplyPipelineDeps,
  presetId: string,
): Promise<PreviewOutcome> {
  try {
    const disc = await deps.adapter.discover();
    if (!disc.supported) return { status: 'unsupported', reason: disc.reason };
    const preset = await deps.loadPreset(presetId);
    if (!preset) return { status: 'blocked', problems: [`preset "${presetId}" not found`] };
    const [snapshot, context] = await Promise.all([deps.adapter.snapshot(), deps.resolveContext()]);
    const editorSnapshot = toEditorSnapshot(snapshot);
    const resolvedContext = await withResolvedFeatureImage(deps, preset, editorSnapshot, context);
    if (!resolvedContext.ok) return { status: 'blocked', problems: [resolvedContext.reason] };
    const plan = planPresetApplication(preset, editorSnapshot, resolvedContext.context);
    if (plan.status === 'blocked') return { status: 'blocked', problems: plan.problems };
    return { status: 'preview', plan, snapshot };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : 'preview failed' };
  }
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

  const editorSnapshot = toEditorSnapshot(snapshot);
  // 4b. Feature image: resolve a cached photo to a Ghost-served URL (upload)
  // only when the field can actually apply. A failure blocks the whole plan.
  const resolvedContext = await withResolvedFeatureImage(
    deps,
    preset,
    editorSnapshot,
    context,
    promptAnswers,
  );
  if (!resolvedContext.ok) {
    return { status: 'blocked', problems: [resolvedContext.reason] };
  }

  // 5. Pure plan — every dependency/mode resolved before any mutation.
  const plan = planPresetApplication(preset, editorSnapshot, resolvedContext.context);
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
