/**
 * Phase-4 popup controller (owns this module exclusively).
 *
 * The popup is a *thin, disposable* surface. Its only durable responsibility is
 * to report the editor's capability and to delegate the apply operation to the
 * long-lived content script — so that closing the popup mid-apply never
 * aborts the transaction (the content script owns the apply lifecycle through
 * the C3 bridge, per the decision document). The popup holds no editor state.
 *
 * Responsibilities:
 *  - read the active tab's Ghost route via the shared route-detection module;
 *  - probe the content script's capability gate (`discover`) and surface an
 *    accurate post/page/unsaved/dirty/capability report;
 *  - list validated presets (loaded from the storage repository);
 *  - delegate read-only `preview`, long-lived `apply`, and private-state `undo` to
 *    the content script; prompt answers are validated before an apply retry.
 *
 * Security: every message carries a fixed popup `source` identity, every reply
 * is validated for that identity, and only the fixed `discover`/`preview`/`apply`/`undo`
 * operations are sent. No eval, no arbitrary property access, no secrets.
 */

import type { DetectedRoute } from './route-detection';
import { detectEditorUrl } from './route-detection';
import type { Preset } from './preset-schema';
import type { CapturedSource, CaptureOptions } from './preset-capture';
import { buildPresetFromCapture } from './preset-capture';
import { deriveIdFromName, nextAvailablePresetId } from './preset-naming';
import type { ApplicationPlan } from './preset-engine';

/** Identity stamped on every popup→content message and accepted on replies. */
export const POPUP_MESSAGE_SOURCE = 'ghost-cms-template-injector/popup/v1';

/** Operations the popup is permitted to send to the content script. */
export type PopupOperation =
  | 'discover'
  | 'preview'
  | 'apply'
  | 'undo'
  /** Import picker: ids + titles of this installation's posts/pages. */
  | 'listPosts'
  /** Capture the post/page open in the editor. */
  | 'capture'
  /** Capture one saved post/page by id. */
  | 'capturePost';

export interface PopupMessage {
  source: string;
  op: PopupOperation;
  /** Target tab id the content script is attached to. */
  tabId: string;
  presetId?: string;
  promptAnswers?: Partial<Record<string, boolean>>;
  /** Import target for `capturePost`. */
  resourceType?: 'post' | 'page';
  resourceId?: string;
}

/** Capability report returned by the content script's discover probe. */
export interface CapabilityReport {
  resourceType: 'post' | 'page';
  resourceId: string | null;
  dirty: boolean;
  updatedAt: string | null;
  hasLexical: boolean;
  canMutateRelations: boolean;
  canNativeSave: boolean;
  canRollback: boolean;
  adapterVersion: number;
}

/** Reply the content script sends back to the popup. */
export interface ContentReply {
  source: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type PopupState =
  | { state: 'unsupported'; reason: string; route?: DetectedRoute }
  | { state: 'capable'; capability: CapabilityReport; route: DetectedRoute }
  | { state: 'error'; reason: string; route?: DetectedRoute };

export interface ApplyResult {
  ok: boolean;
  delegated: boolean;
  error?: string | undefined;
  /** Prompt-mode questions the caller must answer before a retry. */
  prompts?: Array<{ field: string; question: string }>;
}

export interface PreviewResult {
  ok: boolean;
  plan?: ApplicationPlan;
  error?: string | undefined;
}

/** Runtime seams the controller depends on (chrome.* and store injected). */
export interface PopupRuntime {
  /** Resolve the active tab id the popup is operating against. */
  getActiveTabId: () => string | null;
  /** Look up a tab by id (reads `.url`/`.hash` only). */
  findTab: (tabId: string) => { url?: string; hash?: string } | undefined;
  /** Send a structured message to the content script on a tab. */
  sendMessage: (tabId: string, message: PopupMessage) => Promise<ContentReply | undefined>;
  /** Load validated presets (bundled seeds + chrome.storage.local overrides). */
  loadPresets: () => Promise<Preset[]>;
  /** Validate + persist a preset (same repository the options page uses). */
  savePreset: (input: unknown) => Promise<Preset>;
}

/** One entry of the import picker. */
export interface CapturableEntry {
  id: string;
  title: string;
  status: string;
  updatedAt: string | null;
  resourceType: 'post' | 'page';
}

/** A post/page read into capture fields, as reported by the content script. */
export interface CaptureOutcome {
  source: CapturedSource;
  warnings: string[];
  readFrom: 'live-editor' | 'admin-api';
  siteOrigin: string | null;
}

export interface CaptureListResult {
  ok: boolean;
  entries?: CapturableEntry[];
  error?: string;
}

export interface CaptureReadResult {
  ok: boolean;
  outcome?: CaptureOutcome;
  error?: string;
}

export interface CaptureSaveResult {
  ok: boolean;
  preset?: Preset;
  /** Non-fatal losses the owner should see (trimmed excerpt, skipped fields). */
  warnings: string[];
  error?: string;
}

export interface PopupController {
  refresh: (route: DetectedRoute) => Promise<PopupState>;
  loadPresets: () => Promise<Preset[]>;
  applyPreset: (
    presetId: string,
    promptAnswers?: Partial<Record<string, boolean>>,
  ) => Promise<ApplyResult>;
  previewPreset: (presetId: string) => Promise<PreviewResult>;
  undoLastApply: () => Promise<ApplyResult>;
  /** Import: list this installation's posts/pages. */
  listCapturable: () => Promise<CaptureListResult>;
  /** Import: read the open editor's post/page. */
  captureCurrent: () => Promise<CaptureReadResult>;
  /** Import: read one saved post/page. */
  capturePost: (resourceType: 'post' | 'page', resourceId: string) => Promise<CaptureReadResult>;
  /** Import: build a preset from a captured source and store it. */
  saveCapture: (outcome: CaptureOutcome, options: CaptureOptions) => Promise<CaptureSaveResult>;
  lastStatus: () => PopupState;
}

const UNKNOWN_STATUS: PopupState = {
  state: 'unsupported',
  reason: 'capability not yet probed',
};

function asCapability(result: unknown): CapabilityReport | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  if (r['supported'] !== true) return null;
  const cap = r['capability'] as Record<string, unknown> | undefined;
  if (typeof cap !== 'object' || cap === null) return null;
  // Minimal structural validation of the capability shape.
  if (cap['resourceType'] !== 'post' && cap['resourceType'] !== 'page') return null;
  if (typeof cap['resourceId'] !== 'string' && cap['resourceId'] !== null) return null;
  return {
    resourceType: cap['resourceType'] as 'post' | 'page',
    resourceId: cap['resourceId'] as string | null,
    dirty: Boolean(cap['dirty']),
    updatedAt: (cap['updatedAt'] as string | null) ?? null,
    hasLexical: Boolean(cap['hasLexical']),
    canMutateRelations: Boolean(cap['canMutateRelations']),
    canNativeSave: Boolean(cap['canNativeSave']),
    canRollback: Boolean(cap['canRollback']),
    adapterVersion: Number(cap['adapterVersion'] ?? 0),
  };
}

function validateReply(reply: ContentReply | undefined): {
  ok: boolean;
  result?: unknown;
  error?: string;
} {
  if (!reply || typeof reply !== 'object') {
    return { ok: false, error: 'no reply from content script' };
  }
  if (reply.source !== POPUP_MESSAGE_SOURCE) {
    return { ok: false, error: 'reply identity mismatch' };
  }
  if (reply.ok) return { ok: true, result: reply.result };
  return { ok: false, error: reply.error ?? 'UNKNOWN_ERROR' };
}

const PREVIEW_FIELDS = new Set([
  'body',
  'title',
  'excerpt',
  'customTemplate',
  'tags',
  'featureImage',
]);

function asApplicationPlan(value: unknown): ApplicationPlan | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw['status'] !== 'ready' && raw['status'] !== 'needs-prompt') return null;
  if (typeof raw['presetId'] !== 'string' || !Array.isArray(raw['actions'])) return null;
  if (!Array.isArray(raw['problems']) || raw['problems'].some((p) => typeof p !== 'string'))
    return null;
  for (const item of raw['actions']) {
    if (typeof item !== 'object' || item === null) return null;
    const action = item as Record<string, unknown>;
    if (!PREVIEW_FIELDS.has(String(action['field']))) return null;
    if (action['op'] !== 'set' && action['op'] !== 'skip') return null;
    if (
      action['status'] !== 'apply' &&
      action['status'] !== 'skip' &&
      action['status'] !== 'prompt'
    ) {
      return null;
    }
    if (action['status'] === 'prompt' && typeof action['question'] !== 'string') return null;
    if (
      action['status'] === 'skip' &&
      action['reason'] !== undefined &&
      typeof action['reason'] !== 'string'
    ) {
      return null;
    }
  }
  return value as ApplicationPlan;
}

export function createPopupController(runtime: PopupRuntime): PopupController {
  let last: PopupState = UNKNOWN_STATUS;

  async function refresh(route: DetectedRoute): Promise<PopupState> {
    // Only editor routes are supported by the apply flow.
    if (route.kind !== 'editor') {
      last = {
        state: 'unsupported',
        reason: 'Not an editor screen — open a post or page editor.',
        route,
      };
      return last;
    }

    const tabId = runtime.getActiveTabId();
    if (tabId === null) {
      last = { state: 'unsupported', reason: 'No active Ghost Admin tab found.', route };
      return last;
    }

    const tab = runtime.findTab(tabId);
    if (!tab || typeof tab.url !== 'string') {
      last = { state: 'unsupported', reason: 'No Ghost Admin tab to inspect.', route };
      return last;
    }

    // Confirm the active tab is actually on an editor route (the popup's
    // reported route must match the live tab before probing capability).
    const resolved = detectEditorUrl(runtime.findTab, tabId);
    if (!resolved || resolved.kind !== 'editor') {
      last = { state: 'unsupported', reason: 'Active tab is not a Ghost editor.', route };
      return last;
    }

    let reply: ContentReply | undefined;
    try {
      reply = await runtime.sendMessage(tabId, {
        source: POPUP_MESSAGE_SOURCE,
        op: 'discover',
        tabId,
      });
    } catch (err) {
      last = {
        state: 'error',
        reason: err instanceof Error ? err.message : 'discover probe failed',
        route,
      };
      return last;
    }

    const checked = validateReply(reply);
    if (!checked.ok) {
      last = {
        state: 'unsupported',
        reason: `Editor capability unavailable: ${checked.error ?? 'unsupported'}.`,
        route,
      };
      return last;
    }

    const capability = asCapability(checked.result);
    if (!capability) {
      last = {
        state: 'unsupported',
        reason: 'Capability probe returned an unrecognized payload.',
        route,
      };
      return last;
    }

    last = { state: 'capable', capability, route };
    return last;
  }

  async function loadPresets(): Promise<Preset[]> {
    return runtime.loadPresets();
  }

  async function applyPreset(
    presetId: string,
    promptAnswers?: Partial<Record<string, boolean>>,
  ): Promise<ApplyResult> {
    const tabId = runtime.getActiveTabId();
    if (tabId === null) {
      return { ok: false, delegated: false, error: 'No active Ghost Admin tab found.' };
    }

    const message: PopupMessage = {
      source: POPUP_MESSAGE_SOURCE,
      op: 'apply',
      tabId,
      presetId,
    };
    if (promptAnswers !== undefined) message.promptAnswers = promptAnswers;

    let reply: ContentReply | undefined;
    try {
      reply = await runtime.sendMessage(tabId, message);
    } catch (err) {
      return {
        ok: false,
        delegated: false,
        error: err instanceof Error ? err.message : 'apply delegation failed',
      };
    }

    const checked = validateReply(reply);
    if (!checked.ok && checked.error === 'NEEDS_PROMPT') {
      // Prompt-mode preset: the content script refused because one or more
      // fields need an explicit user decision. Surface the questions so the
      // caller (popup UI / toolbar) can collect answers and retry with them.
      const raw = (reply as { result?: unknown } | undefined)?.result;
      const prompts = Array.isArray(raw)
        ? raw
            .filter(
              (p): p is { field: string; question: string } =>
                typeof p === 'object' &&
                p !== null &&
                typeof (p as { field?: unknown }).field === 'string' &&
                typeof (p as { question?: unknown }).question === 'string',
            )
            .map((p) => ({ field: p.field, question: p.question }))
        : [];
      return { ok: false, delegated: true, error: 'NEEDS_PROMPT', prompts };
    }
    return { ok: checked.ok, delegated: checked.ok, error: checked.error };
  }

  async function previewPreset(presetId: string): Promise<PreviewResult> {
    const tabId = runtime.getActiveTabId();
    if (tabId === null) return { ok: false, error: 'No active Ghost Admin tab found.' };
    let reply: ContentReply | undefined;
    try {
      reply = await runtime.sendMessage(tabId, {
        source: POPUP_MESSAGE_SOURCE,
        op: 'preview',
        tabId,
        presetId,
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'preview delegation failed',
      };
    }
    const checked = validateReply(reply);
    if (!checked.ok) return { ok: false, error: checked.error };
    const raw = checked.result;
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: 'invalid preview response' };
    }
    const preview = raw as Record<string, unknown>;
    const plan = asApplicationPlan(preview['plan']);
    if (preview['status'] !== 'preview' || !plan || plan.presetId !== presetId) {
      return { ok: false, error: 'invalid preview plan' };
    }
    return { ok: true, plan };
  }

  async function undoLastApply(): Promise<ApplyResult> {
    const tabId = runtime.getActiveTabId();
    if (tabId === null) {
      return { ok: false, delegated: false, error: 'No active Ghost Admin tab found.' };
    }
    let reply: ContentReply | undefined;
    try {
      reply = await runtime.sendMessage(tabId, {
        source: POPUP_MESSAGE_SOURCE,
        op: 'undo',
        tabId,
      });
    } catch (err) {
      return {
        ok: false,
        delegated: false,
        error: err instanceof Error ? err.message : 'undo delegation failed',
      };
    }
    const checked = validateReply(reply);
    return { ok: checked.ok, delegated: checked.ok, error: checked.error };
  }

  function lastStatus(): PopupState {
    return last;
  }

  /* ---------------- import an existing post as a preset ---------------- */

  /** Structural validation of a capture-source payload from the content script. */
  function asCapturedSource(value: unknown): CapturedSource | null {
    if (typeof value !== 'object' || value === null) return null;
    const raw = value as Record<string, unknown>;
    if (raw['resourceType'] !== 'post' && raw['resourceType'] !== 'page') return null;
    const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const tags = raw['tags'];
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) return null;
    return {
      resourceType: raw['resourceType'],
      title: strOrNull(raw['title']),
      excerpt: strOrNull(raw['excerpt']),
      customTemplate: strOrNull(raw['customTemplate']),
      featureImage: strOrNull(raw['featureImage']),
      lexical: strOrNull(raw['lexical']),
      tags: tags as string[],
    };
  }

  function asCaptureOutcome(value: unknown): CaptureOutcome | null {
    if (typeof value !== 'object' || value === null) return null;
    const raw = value as Record<string, unknown>;
    const source = asCapturedSource(raw['source']);
    if (!source) return null;
    const warnings = Array.isArray(raw['warnings'])
      ? (raw['warnings'] as unknown[]).filter((w): w is string => typeof w === 'string')
      : [];
    const readFrom = raw['readFrom'] === 'admin-api' ? 'admin-api' : 'live-editor';
    return {
      source,
      warnings,
      readFrom,
      siteOrigin: typeof raw['siteOrigin'] === 'string' ? raw['siteOrigin'] : null,
    };
  }

  async function sendToEditor(
    message: Omit<PopupMessage, 'tabId' | 'source'>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const tabId = runtime.getActiveTabId();
    if (tabId === null) return { ok: false, error: 'No active Ghost Admin tab found.' };
    let reply: ContentReply | undefined;
    try {
      reply = await runtime.sendMessage(tabId, {
        ...message,
        source: POPUP_MESSAGE_SOURCE,
        tabId,
      } as PopupMessage);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'message failed' };
    }
    const checked = validateReply(reply);
    if (!checked.ok) return { ok: false, error: checked.error ?? 'UNKNOWN_ERROR' };
    return { ok: true, result: checked.result };
  }

  async function listCapturable(): Promise<CaptureListResult> {
    const reply = await sendToEditor({ op: 'listPosts' });
    if (!reply.ok) return { ok: false, error: reply.error };
    const raw = reply.result as Record<string, unknown> | null;
    const entries = raw && Array.isArray(raw['entries']) ? raw['entries'] : null;
    if (!entries) return { ok: false, error: 'the editor returned no post list' };
    const parsed: CapturableEntry[] = [];
    for (const item of entries as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry['id'] !== 'string' || typeof entry['title'] !== 'string') continue;
      if (entry['resourceType'] !== 'post' && entry['resourceType'] !== 'page') continue;
      parsed.push({
        id: entry['id'],
        title: entry['title'],
        status: typeof entry['status'] === 'string' ? entry['status'] : 'unknown',
        updatedAt: typeof entry['updatedAt'] === 'string' ? entry['updatedAt'] : null,
        resourceType: entry['resourceType'],
      });
    }
    return { ok: true, entries: parsed };
  }

  async function captureCurrent(): Promise<CaptureReadResult> {
    const reply = await sendToEditor({ op: 'capture' });
    if (!reply.ok) return { ok: false, error: reply.error };
    const outcome = asCaptureOutcome(reply.result);
    if (!outcome) return { ok: false, error: 'the editor returned an unusable capture payload' };
    return { ok: true, outcome };
  }

  async function capturePost(
    resourceType: 'post' | 'page',
    resourceId: string,
  ): Promise<CaptureReadResult> {
    if (resourceType !== 'post' && resourceType !== 'page') {
      return { ok: false, error: 'invalid resource type' };
    }
    if (typeof resourceId !== 'string' || resourceId.trim().length === 0) {
      return { ok: false, error: 'a post must be selected first' };
    }
    const reply = await sendToEditor({ op: 'capturePost', resourceType, resourceId });
    if (!reply.ok) return { ok: false, error: reply.error };
    const outcome = asCaptureOutcome(reply.result);
    if (!outcome) return { ok: false, error: 'the editor returned an unusable capture payload' };
    return { ok: true, outcome };
  }

  async function saveCapture(
    outcome: CaptureOutcome,
    options: CaptureOptions,
  ): Promise<CaptureSaveResult> {
    let built;
    try {
      built = buildPresetFromCapture(outcome.source, options, outcome.siteOrigin);
    } catch (err) {
      return {
        ok: false,
        warnings: [],
        error: err instanceof Error ? err.message : 'the captured post could not be used',
      };
    }

    // Never shadow an existing preset: derive a fresh id from the name.
    let existing: Set<string>;
    try {
      existing = new Set((await runtime.loadPresets()).map((preset) => preset.id));
    } catch {
      existing = new Set<string>();
    }
    const baseId = options.id ?? deriveIdFromName(built.preset.name);
    const id = nextAvailablePresetId(baseId, existing);

    try {
      const saved = await runtime.savePreset({ ...built.preset, id });
      return { ok: true, preset: saved, warnings: [...outcome.warnings, ...built.warnings] };
    } catch (err) {
      return {
        ok: false,
        warnings: built.warnings,
        error: err instanceof Error ? err.message : 'the preset could not be saved',
      };
    }
  }

  return {
    refresh,
    loadPresets,
    applyPreset,
    previewPreset,
    undoLastApply,
    listCapturable,
    captureCurrent,
    capturePost,
    saveCapture,
    lastStatus,
  };
}
