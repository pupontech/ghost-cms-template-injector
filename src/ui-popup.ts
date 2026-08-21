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
 *  - delegate `apply` (and prompt answers) to the content script and return
 *    the delegation acknowledgement immediately — it does NOT await the full
 *    apply transaction.
 *
 * Security: every message carries a fixed popup `source` identity, every reply
 * is validated for that identity, and only the fixed `discover`/`apply`
 * operations are sent. No eval, no arbitrary property access, no secrets.
 */

import type { DetectedRoute } from './route-detection';
import { detectEditorUrl } from './route-detection';
import type { Preset } from './preset-schema';

/** Identity stamped on every popup→content message and accepted on replies. */
export const POPUP_MESSAGE_SOURCE = 'ghost-preset-toolbar/popup/v1';

/** Operations the popup is permitted to send to the content script. */
export type PopupOperation = 'discover' | 'apply';

export interface PopupMessage {
  source: string;
  op: PopupOperation;
  /** Target tab id the content script is attached to. */
  tabId: string;
  presetId?: string;
  promptAnswers?: Partial<Record<string, boolean>>;
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
}

export interface PopupController {
  refresh: (route: DetectedRoute) => Promise<PopupState>;
  loadPresets: () => Promise<Preset[]>;
  applyPreset: (
    presetId: string,
    promptAnswers?: Partial<Record<string, boolean>>,
  ) => Promise<ApplyResult>;
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
    return { ok: checked.ok, delegated: checked.ok, error: checked.error };
  }

  function lastStatus(): PopupState {
    return last;
  }

  return { refresh, loadPresets, applyPreset, lastStatus };
}
