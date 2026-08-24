/**
 * Phase-2 field-mode planning engine (Contracts C4/C5/C6).
 *
 * Pure planner: given a validated Preset, a live editor snapshot, and a
 * dependency context, it resolves every field's mode into an immutable,
 * ordered plan BEFORE any mutation. No storage, API, bridge, schema parsing,
 * or UI lives here. All decisions are made against the live snapshot — never
 * stale server data. Body modes are only replace | only-if-empty | prompt;
 * there is no append or merge.
 */

import type {
  BodyContent,
  BodyMode,
  CustomTemplateField,
  ExcerptField,
  Preset,
  TagsField,
  TitleField,
} from './preset-schema';
import { isSerializedLexical } from './preset-schema';
import { plainTextToLexical } from './plain-text-lexical';

/** Live per-field state captured by a C4 `snapshot` on the open editor. */
export interface EditorSnapshot {
  bodyEmpty: boolean;
  excerpt: string | null;
  customTemplate: string | null;
  /** Live post title, or null when not reachable. */
  title: string | null;
  /** Existing tag display names in live relation order. */
  tags: string[];
}

/** Dependency lookups resolved from validated Ghost Admin API responses (C6). */
export interface PlanContext {
  /** Exact snippet names available locally (validated plural snippets[]). */
  snippets?: string[];
  /** Exact-name lookup to the snippet's serialized Lexical body. */
  snippetLexical?: Record<string, string>;
  /**
   * Active-theme custom template filenames (blank-slug templates[] entries),
   * including `.hbs`. Absent/empty means the allowlist is unknown and any
   * customTemplate write must fail closed.
   */
  templates?: string[];
}

export type PlannedField = 'body' | 'excerpt' | 'customTemplate' | 'tags' | 'title';

export type PlanActionOp = 'set' | 'skip';

export type PlanActionStatus = 'apply' | 'skip' | 'prompt';

export interface PlanAction {
  field: PlannedField;
  op: PlanActionOp;
  status: PlanActionStatus;
  /** Resolved full replacement value. Tags carry the complete ordered list. */
  value?: string | string[];
  /** Human-readable prompt question when status is 'prompt'. */
  question?: string;
  reason?: string;
}

export type PlanStatus = 'ready' | 'needs-prompt' | 'blocked';

export interface ApplicationPlan {
  presetId: string;
  status: PlanStatus;
  actions: readonly PlanAction[];
  problems: readonly string[];
}

/** Build a live-editor snapshot with sensible defaults for tests/callers. */
export function createEditorSnapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return Object.freeze({
    bodyEmpty: true,
    excerpt: null,
    customTemplate: null,
    title: null,
    tags: [],
    ...overrides,
  });
}

/** Build a dependency context from validated API lookups. */
export function createPlanContext(overrides: Partial<PlanContext> = {}): PlanContext {
  return Object.freeze({ ...overrides });
}

function freezePlan(plan: ApplicationPlan): ApplicationPlan {
  Object.freeze(plan.actions);
  for (const action of plan.actions) Object.freeze(action);
  if (Array.isArray(plan.problems)) Object.freeze(plan.problems);
  return Object.freeze(plan);
}

const BODY_MODES: readonly BodyMode[] = ['replace', 'only-if-empty', 'prompt'];

/**
 * Normalize tag values: trim, drop empties, dedupe case-insensitively while
 * preserving first-seen casing and order.
 */
export function normalizeTagValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function planBody(
  content: BodyContent,
  snapshot: EditorSnapshot,
  context: PlanContext,
): PlanAction {
  const mode: BodyMode = content.mode;
  if (!BODY_MODES.includes(mode)) {
    throw new TypeError(`preset-engine: unsupported body mode "${mode}"`);
  }
  const lexical =
    content.source === 'inline-lexical'
      ? content.lexical
      : content.source === 'inline-text'
        ? plainTextToLexical(content.text ?? '')
        : content.source === 'ghost-snippet'
          ? context.snippetLexical?.[content.snippet ?? '']
          : undefined;
  if (!lexical || !isSerializedLexical(lexical)) {
    throw new TypeError(
      content.source === 'inline-html'
        ? 'inline HTML cannot be applied to the live Lexical editor without an official conversion path'
        : 'body source did not resolve to structurally valid serialized Lexical',
    );
  }
  if (mode === 'prompt') {
    return {
      field: 'body',
      op: 'skip',
      status: 'prompt',
      value: lexical,
      question: 'Replace the current post body with this preset’s content?',
    };
  }
  if (mode === 'only-if-empty' && !snapshot.bodyEmpty) {
    return { field: 'body', op: 'skip', status: 'skip', reason: 'body is not empty' };
  }
  return { field: 'body', op: 'set', status: 'apply', value: lexical };
}

function planExcerpt(field: ExcerptField, snapshot: EditorSnapshot): PlanAction {
  if (field.mode === 'prompt') {
    return {
      field: 'excerpt',
      op: 'skip',
      status: 'prompt',
      value: field.value,
      question: `Set the excerpt to “${field.value}”?`,
    };
  }
  if (field.mode === 'only-if-empty' && (snapshot.excerpt ?? '').length > 0) {
    return {
      field: 'excerpt',
      op: 'skip',
      status: 'skip',
      reason: 'excerpt already has a value',
    };
  }
  return { field: 'excerpt', op: 'set', status: 'apply', value: field.value };
}

function planTitle(field: TitleField, _snapshot: EditorSnapshot): PlanAction {
  // Titles always replace; the schema enforces mode === 'replace'.
  return { field: 'title', op: 'set', status: 'apply', value: field.value };
}

function planCustomTemplate(field: CustomTemplateField, context: PlanContext): PlanAction {
  const templates = context.templates;
  // C6 fail-close: without a proven active-theme allowlist we cannot verify
  // the filename, so no mutation is planned.
  if (!Array.isArray(templates)) {
    return {
      field: 'customTemplate',
      op: 'skip',
      status: 'skip',
      reason: 'active-theme template allowlist unavailable; refusing to plan a write',
    };
  }
  const valid = templates.includes(field.value);
  return valid
    ? { field: 'customTemplate', op: 'set', status: 'apply', value: field.value }
    : {
        field: 'customTemplate',
        op: 'skip',
        status: 'skip',
        reason: `"${field.value}" is not in the active theme's templates`,
      };
}

function planTags(field: TagsField, snapshot: EditorSnapshot): PlanAction {
  const presetTags = normalizeTagValues(field.values);

  let resolved: string[];
  switch (field.mode) {
    case 'replace':
      resolved = presetTags;
      break;
    case 'merge': {
      // Start from the live relation order, append only non-duplicates
      // (case-insensitive), and emit ONE full-list replacement (C6).
      resolved = [...normalizeTagValues(snapshot.tags)];
      const existing = new Set(resolved.map((t) => t.toLowerCase()));
      for (const tag of presetTags) {
        if (!existing.has(tag.toLowerCase())) {
          existing.add(tag.toLowerCase());
          resolved.push(tag);
        }
      }
      break;
    }
    case 'only-if-empty':
      if (snapshot.tags.length > 0) {
        return { field: 'tags', op: 'skip', status: 'skip', reason: 'post already has tags' };
      }
      resolved = presetTags;
      break;
    case 'prompt':
      return {
        field: 'tags',
        op: 'skip',
        status: 'prompt',
        value: presetTags,
        question: `Replace all tags with [${presetTags.join(', ')}]?`,
      };
    default: {
      const exhaustive: never = field.mode;
      throw new TypeError(`preset-engine: unsupported tag mode "${String(exhaustive)}"`);
    }
  }

  return { field: 'tags', op: 'set', status: 'apply', value: resolved };
}

/**
 * Resolve every field of the preset into a complete plan before any mutation.
 * Dependency failures abort the entire plan with zero actions (C4/C6).
 */
export function planPresetApplication(
  preset: Preset,
  snapshot: EditorSnapshot,
  context: PlanContext = {},
): ApplicationPlan {
  // ---- Phase A: resolve dependencies; any failure aborts everything (C4).
  const problems: string[] = [];

  if (preset.content.source === 'ghost-snippet') {
    const wanted = preset.content.snippet as string;
    const snippets = context.snippets;
    if (!Array.isArray(snippets)) {
      problems.push(`content.source: snippet allowlist unavailable for "${wanted}"`);
    } else if (!snippets.includes(wanted)) {
      problems.push(`content.source: snippet "${wanted}" not found`);
    } else if (!context.snippetLexical || !isSerializedLexical(context.snippetLexical[wanted])) {
      problems.push(
        `content.source: snippet "${wanted}" did not resolve to valid serialized Lexical`,
      );
    }
  } else if (preset.content.source === 'inline-html') {
    problems.push(
      'content.source: inline HTML is unsupported for live Lexical writes; provide inline-lexical or a Ghost snippet',
    );
  } else if (preset.content.source === 'inline-text') {
    try {
      if (!isSerializedLexical(plainTextToLexical(preset.content.text ?? ''))) {
        problems.push(
          'content.source: plain text template could not be converted to serialized Lexical',
        );
      }
    } catch (error) {
      problems.push(
        error instanceof Error
          ? `content.source: ${error.message}`
          : 'content.source: invalid plain text template',
      );
    }
  } else if (!isSerializedLexical(preset.content.lexical)) {
    problems.push(
      'content.source: inline-lexical payload is not structurally valid serialized Lexical',
    );
  }

  if (preset.metadata?.customTemplate) {
    const templates = context.templates;
    if (!Array.isArray(templates)) {
      problems.push('metadata.customTemplate: active-theme template allowlist unavailable');
    } else if (!templates.includes(preset.metadata.customTemplate.value)) {
      problems.push(
        `metadata.customTemplate: "${preset.metadata.customTemplate.value}" is not an active-theme template`,
      );
    }
  }

  if (problems.length > 0) {
    return freezePlan({
      presetId: preset.id,
      status: 'blocked',
      actions: [],
      problems,
    });
  }

  // ---- Phase B: plan every requested field in schema order.
  let body: PlanAction;
  try {
    body = planBody(preset.content, snapshot, context);
  } catch (error) {
    return freezePlan({
      presetId: preset.id,
      status: 'blocked',
      actions: [],
      problems: [error instanceof Error ? error.message : 'body source could not be resolved'],
    });
  }
  const actions: PlanAction[] = [body];

  const metadata = preset.metadata;
  if (metadata?.title) actions.push(planTitle(metadata.title, snapshot));
  if (metadata?.excerpt) actions.push(planExcerpt(metadata.excerpt, snapshot));
  if (metadata?.customTemplate) {
    actions.push(planCustomTemplate(metadata.customTemplate, context));
  }
  if (metadata?.tags) actions.push(planTags(metadata.tags, snapshot));

  // ---- Phase C: aggregate.
  const status: PlanStatus = actions.some((a) => a.status === 'prompt') ? 'needs-prompt' : 'ready';

  return freezePlan({ presetId: preset.id, status, actions, problems });
}

/**
 * Turn a needs-prompt plan into an executable one using explicit user answers
 * keyed by field name. Only plans awaiting prompts may be resolved.
 */
export function resolvePrompts(
  plan: ApplicationPlan,
  answers: Partial<Record<PlannedField, boolean>>,
): ApplicationPlan {
  if (plan.status === 'blocked') {
    throw new Error('preset-engine: cannot resolve prompts on a blocked plan');
  }
  if (plan.status !== 'needs-prompt') {
    throw new Error('preset-engine: plan is not awaiting prompt resolution');
  }

  const actions = plan.actions.map((action) => {
    if (action.status !== 'prompt') return action;
    const accepted = answers[action.field];
    if (typeof accepted !== 'boolean') {
      throw new Error(`preset-engine: missing answer for prompted field "${action.field}"`);
    }
    return accepted
      ? { ...action, status: 'apply' as const, op: 'set' as const }
      : { ...action, status: 'skip' as const, reason: 'declined by user' };
  });

  const unresolved = actions.some((a) => a.status === 'prompt');
  if (unresolved) throw new Error('preset-engine: unresolved prompts remain');

  const status: PlanStatus = 'ready';
  return freezePlan({
    presetId: plan.presetId,
    status,
    actions,
    problems: plan.problems,
  });
}
