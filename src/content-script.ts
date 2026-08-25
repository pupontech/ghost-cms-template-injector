/**
 * Phase-5 content-script orchestration (owns this module + content-script-main).
 *
 * The content script is the long-lived, isolated-world owner of the apply
 * operation. The popup and the injected toolbar ONLY delegate `apply` here (via
 * `chrome.runtime.sendMessage` with the fixed popup `source`), so closing either
 * surface mid-apply never aborts the transaction (the apply runs through the
 * MAIN-world bridge + one native save, per the decision document).
 *
 * Responsibilities:
 *  - install exactly one isolated-world `chrome.runtime.onMessage` listener;
 *  - answer the fixed `discover` | `apply` operations;
 *  - `discover`: probe the MAIN-world bridge for editor capability and report
 *    the versioned capability summary;
 *  - `apply`: run the atomic apply pipeline (capability gate → load preset →
 *    live snapshot → resolve dependency context → plan → apply once). Dependency
 *    context (snippet names, active-theme templates) is resolved from the
 *    cookie-authenticated Admin API (Ghost Admin URL derives the admin base).
 *  - double-apply is locked at the MAIN-world bridge (transactional BUSY)
 *    and again here with a per-tab in-flight guard.
 *
 * No DOM automation, no eval, no arbitrary property access, no Ghost internals
 * here — all live-editor access is marshalled by the MAIN-world bridge.
 */

import { BRIDGE_SOURCE_ID, BRIDGE_PROTOCOL_VERSION } from './bridge-protocol';
import { createPageBridge, type PageBridge, type PageBridgeEnv } from './page-bridge';
import { createBridgeStateAdapter } from './bridge-state-adapter';
import { runApplyPipeline, type ApplyOutcome } from './apply-pipeline';
import { loadPreset } from './preset-store';
import { GhostAdminClient } from './ghost-api';
import type { PlanContext } from './preset-engine';
import { POPUP_MESSAGE_SOURCE, type PopupMessage } from './ui-popup';

export interface ContentScriptDeps {
  isGhostAdminPage: () => boolean;
  addRuntimeMessageListener: (
    cb: (message: unknown, sendResponse: (response: unknown) => void) => Promise<unknown> | unknown,
  ) => void;
  /** Build the isolated-side page bridge (posts to window, awaits MAIN reply). */
  createBridgeEnv: () => PageBridgeEnv;
  /** Derive the Admin API base for the current tab (C1). */
  getAdminApiBase: () => { base: string } | null;
  /** Build a cookie-authenticated Admin API client over fetch. */
  createApiClient: (base: string) => GhostAdminClient;
}

export interface ContentScriptHandle {
  init: () => void;
  handleMessage: (message: unknown) => Promise<unknown>;
  /** Resolve the dependency context (snippets/templates) — exported for tests. */
  resolveContext: () => Promise<PlanContext>;
  /** Drop the cached dependency context (snippets/templates). */
  resetResolveContextCache: () => void;
}

/** Reply shape handed back to the popup / toolbar. */
export interface ApplyReply {
  source: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function createContentScript(deps: ContentScriptDeps): ContentScriptHandle {
  let initialized = false;
  let bridge: PageBridge | null = null;
  let inFlight = false;

  function getBridge(): PageBridge {
    if (!bridge) bridge = createPageBridge(deps.createBridgeEnv());
    return bridge;
  }

  /**
   * Resolve-context TTL cache. Two Admin API round-trips (snippet list +
   * active-theme templates) happen on every apply; the allowlists are cheap
   * and change rarely within a session, so a short-lived cache removes the
   * redundant work. Only *successful* resolutions are cached — a fail-closed
   * empty result is never cached, so a transient API outage cannot pin the
   * allowlist permanently empty. The cache is keyed by the derived admin base
   * so a tab that navigates between Ghost installs re-resolves correctly.
   */
  const CONTEXT_CACHE_TTL_MS = 60_000;
  let cachedContext: { base: string; context: PlanContext; at: number } | null = null;

  /** Test/lifecycle hook: drop any cached dependency context. */
  function resetResolveContextCache(): void {
    cachedContext = null;
  }

  /**
   * Resolve the dependency context (snippet names + active-theme template
   * filenames) from the cookie-authenticated Admin API. Any failure yields an
   * empty allowlist so the planner fails closed (no mutation).
   */
  async function resolveContext(): Promise<PlanContext> {
    const derived = deps.getAdminApiBase();
    if (!derived) return {};
    const now = Date.now();
    if (
      cachedContext &&
      cachedContext.base === derived.base &&
      now - cachedContext.at < CONTEXT_CACHE_TTL_MS
    ) {
      return cachedContext.context;
    }
    try {
      const client = deps.createApiClient(derived.base);
      const [snippets, templates] = await Promise.all([
        client
          .listSnippets()
          .then((list) => ({
            names: list.map((s) => s.name ?? ''),
            lexical: Object.fromEntries(
              list
                .filter((s) => typeof s.name === 'string' && typeof s.lexical === 'string')
                .map((s) => [s.name as string, s.lexical as string]),
            ),
          }))
          .catch(() => null),
        client.getActiveThemeTemplates().catch(() => []),
      ]);
      if (!snippets) return {};
      const context: PlanContext = {
        snippets: snippets.names,
        snippetLexical: snippets.lexical,
        templates,
      };
      cachedContext = { base: derived.base, context, at: Date.now() };
      return context;
    } catch {
      return {};
    }
  }

  async function discover(): Promise<unknown> {
    const reply = await getBridge().request('discover', {});
    if (!reply.ok) {
      // Fail closed with the actual bridge error (e.g. TIMEOUT when the MAIN
      // bridge is still dormant). Reporting ok:true here masked capability
      // failures as a successful-but-unsupported probe and forced the caller to
      // wait the full 5s bridge timeout before surfacing a confusing reason.
      return {
        source: POPUP_MESSAGE_SOURCE,
        ok: false,
        error: reply.error,
      };
    }
    return reply.result;
  }

  async function apply(
    presetId: string,
    promptAnswers?: Partial<Record<string, boolean>>,
  ): Promise<ApplyReply> {
    // Per-tab in-flight guard (belt-and-suspenders over the bridge BUSY lock).
    if (inFlight) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'APPLY_BUSY' };
    }
    inFlight = true;
    try {
      const adapter = createBridgeStateAdapter(getBridge());
      const outcome: ApplyOutcome = await runApplyPipeline(
        {
          adapter,
          loadPreset,
          resolveContext,
        },
        presetId,
        promptAnswers,
      );
      switch (outcome.status) {
        case 'applied':
          return { source: POPUP_MESSAGE_SOURCE, ok: true, result: outcome.result };
        case 'needs-prompt':
          return {
            source: POPUP_MESSAGE_SOURCE,
            ok: false,
            error: 'NEEDS_PROMPT',
            result: outcome.prompts,
          };
        case 'blocked':
          return {
            source: POPUP_MESSAGE_SOURCE,
            ok: false,
            error: `BLOCKED: ${outcome.problems.join('; ')}`,
          };
        case 'unsupported':
          return {
            source: POPUP_MESSAGE_SOURCE,
            ok: false,
            error: `UNSUPPORTED: ${outcome.reason}`,
          };
        case 'error':
          return { source: POPUP_MESSAGE_SOURCE, ok: false, error: outcome.error };
      }
    } finally {
      inFlight = false;
    }
  }

  async function handleMessage(message: unknown): Promise<unknown> {
    if (typeof message !== 'object' || message === null) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'INVALID_MESSAGE' };
    }
    const msg = message as Record<string, unknown>;
    // Accept only the popup/toolbar protocol with the fixed source identity.
    if (msg['source'] !== POPUP_MESSAGE_SOURCE) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'SOURCE_MISMATCH' };
    }
    const op = msg['op'];
    if (op === 'discover') {
      const result = await discover();
      return { source: POPUP_MESSAGE_SOURCE, ok: true, result };
    }
    if (op === 'apply') {
      // Guard at the message boundary too, so a rapid double-click or a second
      // apply that arrives before the async transaction begins is rejected
      // cleanly instead of racing the bridge BUSY lock. (Refinement of Flash #3
      // — belt-and-suspenders over the in-apply `inFlight` flag.)
      if (inFlight) {
        return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'APPLY_BUSY' };
      }
      const presetId = msg['presetId'];
      if (typeof presetId !== 'string') {
        return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'MISSING_PRESET_ID' };
      }
      return apply(presetId, msg['promptAnswers'] as Partial<Record<string, boolean>> | undefined);
    }
    return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'UNKNOWN_OP' };
  }

  return {
    init(): void {
      if (initialized) return;
      if (!deps.isGhostAdminPage()) return;
      initialized = true;
      deps.addRuntimeMessageListener((message) => handleMessage(message));
    },
    handleMessage,
    resolveContext,
    resetResolveContextCache,
  };
}

// Re-export for callers/tests that build a PopupMessage.
export type { PopupMessage };
export { BRIDGE_SOURCE_ID, BRIDGE_PROTOCOL_VERSION };
