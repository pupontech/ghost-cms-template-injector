/**
 * Phase-5 content-script orchestration (owns this module + content-script-main).
 *
 * The content script is the long-lived, isolated-world owner of the apply
 * The popup and toolbar delegate `preview`, `apply`, and `undo` here (via
 * `chrome.runtime.sendMessage` with the fixed popup `source`), so closing either
 * surface mid-apply never aborts the transaction (the content script owns the
 * apply lifecycle through the MAIN-world bridge + one native save, per the
 * decision document).
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
import {
  runApplyPipeline,
  previewApplyPipeline,
  type ApplyOutcome,
  type ApplyPipelineAdapter,
  type ApplyPipelineDeps,
  type PreviewOutcome,
} from './apply-pipeline';
import { loadPreset } from './preset-store';
import { GhostAdminClient } from './ghost-api';
import { sourceFromGhostRecord, type CapturedSource } from './preset-capture';
import type { GhostSnapshot } from './ghost-state';
import {
  resolveFeatureImage,
  type CachedImageBytes,
  type FeatureImageRuntime,
  type FeatureImageUploadCache,
  type ResolveFeatureImageResult,
} from './feature-image';
import type { FeatureImageField } from './preset-schema';
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
  /**
   * Read a cached feature-image photo from the extension asset store. Absent
   * when this context has no asset channel; a preset carrying a cached photo
   * then fails closed instead of saving a post without its image.
   */
  getImageAsset?: (assetId: string) => Promise<CachedImageBytes | null>;
  /** Per-installation memo of uploaded feature-image URLs. */
  featureImageUploadCache?: FeatureImageUploadCache;
  /** Existence check for a memoized image URL (same-origin only). */
  verifyImageUrl?: (url: string) => Promise<boolean>;
}

export interface ContentScriptHandle {
  init: () => void;
  handleMessage: (message: unknown) => Promise<unknown>;
  resolveContext: () => Promise<PlanContext>;
  resetResolveContextCache: () => void;
}

/** One entry in the import picker (id + title only; no body is fetched yet). */
export interface CapturableIndexEntry {
  id: string;
  title: string;
  status: string;
  updatedAt: string | null;
  resourceType: 'post' | 'page';
}

/** Result of reading one post/page into a capture source. */
export interface CaptureOutcome {
  source: CapturedSource;
  /** Extra cautions for the owner (e.g. the draft has unsaved changes). */
  warnings: string[];
  /** Where the fields came from — live editor record or the Admin API. */
  readFrom: 'live-editor' | 'admin-api';
  /** Site origin, so absolute media URLs become portable `/content/…` paths. */
  siteOrigin: string | null;
}

/** Reply shape handed back to the popup / toolbar. */
export interface ApplyReply {
  source: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const PROMPT_FIELDS = new Set([
  'body',
  'excerpt',
  'customTemplate',
  'tags',
  'title',
  'featureImage',
]);

/** Cache that never hits: used when no memo store is wired into this context. */
const NULL_UPLOAD_CACHE: FeatureImageUploadCache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
};

function parsePromptAnswers(value: unknown): Partial<Record<string, boolean>> | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const parsed: Record<string, boolean> = {};
  for (const [key, answer] of Object.entries(value)) {
    if (!PROMPT_FIELDS.has(key) || typeof answer !== 'boolean') return null;
    parsed[key] = answer;
  }
  return parsed;
}

export function createContentScript(deps: ContentScriptDeps): ContentScriptHandle {
  let initialized = false;
  let bridge: PageBridge | null = null;
  let inFlight = false;
  const CONTEXT_CACHE_TTL_MS = 60_000;
  let cachedContext: { base: string; context: PlanContext; at: number } | null = null;

  function getBridge(): PageBridge {
    if (!bridge) bridge = createPageBridge(deps.createBridgeEnv());
    return bridge;
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

  function resetResolveContextCache(): void {
    cachedContext = null;
  }

  /**
   * Feature-image resolver for this tab: cached photo → upload to the Ghost
   * install being edited → Ghost-served absolute URL (memoized per install, so
   * repeat applies reuse the same media instead of re-uploading). Returns
   * undefined when this context has no asset channel, which makes a preset
   * that carries a cached photo block instead of applying without its image.
   */
  function createFeatureImageResolver():
    ((field: FeatureImageField) => Promise<ResolveFeatureImageResult>) | undefined {
    const getAsset = deps.getImageAsset?.bind(deps);
    if (!getAsset) return undefined;
    return async (field: FeatureImageField): Promise<ResolveFeatureImageResult> => {
      const derived = deps.getAdminApiBase();
      if (!derived) {
        return { ok: false, reason: 'the Ghost Admin API base could not be derived for this tab' };
      }
      const client = deps.createApiClient(derived.base);
      const runtime: FeatureImageRuntime = {
        getAsset: (assetId) => getAsset(assetId),
        uploadImage: (input) => client.uploadImage(input),
        cache: deps.featureImageUploadCache ?? NULL_UPLOAD_CACHE,
      };
      if (deps.verifyImageUrl) runtime.verifyUrl = deps.verifyImageUrl;
      return resolveFeatureImage(field, derived.base, runtime);
    };
  }

  /** Pipeline dependencies for one apply/preview, including feature images. */
  function buildPipelineDeps(adapter: ApplyPipelineAdapter): ApplyPipelineDeps {
    const resolveFeatureImageFn = createFeatureImageResolver();
    return {
      adapter,
      loadPreset,
      resolveContext,
      ...(resolveFeatureImageFn ? { resolveFeatureImage: resolveFeatureImageFn } : {}),
    };
  }

  /** Cookie-authenticated Admin API client for this tab, or null. */
  function apiClient(): GhostAdminClient | null {
    const derived = deps.getAdminApiBase();
    if (!derived) return null;
    return deps.createApiClient(derived.base);
  }

  /** Site origin (for turning absolute media URLs into portable paths). */
  function siteOrigin(): string | null {
    const derived = deps.getAdminApiBase();
    if (!derived) return null;
    try {
      return new URL(derived.base).origin;
    } catch {
      return null;
    }
  }

  /**
   * Import picker data: ids and titles of this installation's posts and pages,
   * newest first. Read-only; no body is fetched until one is chosen.
   */
  async function listCapturable(): Promise<ApplyReply> {
    const client = apiClient();
    if (!client) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'NO_ADMIN_API_BASE' };
    }
    try {
      const [posts, pages] = await Promise.all([
        client.listCapturableIndex('posts'),
        client.listCapturableIndex('pages'),
      ]);
      const entries: CapturableIndexEntry[] = [
        ...posts.map((post) => ({ ...post, resourceType: 'post' as const })),
        ...pages.map((page) => ({ ...page, resourceType: 'page' as const })),
      ].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return { source: POPUP_MESSAGE_SOURCE, ok: true, result: { entries } };
    } catch (err) {
      return {
        source: POPUP_MESSAGE_SOURCE,
        ok: false,
        error: `LIST_FAILED: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }
  }

  /** Read one saved post/page through the Admin API into a capture source. */
  async function captureFromApi(
    resourceType: 'post' | 'page',
    resourceId: string,
  ): Promise<ApplyReply> {
    const client = apiClient();
    if (!client) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'NO_ADMIN_API_BASE' };
    }
    try {
      const record = await client.getCapturableRecord(
        resourceType === 'page' ? 'pages' : 'posts',
        resourceId,
      );
      if (!record) {
        return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'CAPTURE_NOT_FOUND' };
      }
      const outcome: CaptureOutcome = {
        source: sourceFromGhostRecord(resourceType, record),
        warnings: [],
        readFrom: 'admin-api',
        siteOrigin: siteOrigin(),
      };
      return { source: POPUP_MESSAGE_SOURCE, ok: true, result: outcome };
    } catch (err) {
      return {
        source: POPUP_MESSAGE_SOURCE,
        ok: false,
        error: `CAPTURE_FAILED: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }
  }

  /**
   * Capture the post/page open in the editor.
   *
   * A saved, clean record is re-read through the Admin API (`formats=lexical`
   * + the tag relation) because that is the authoritative stored value. While
   * the editor is dirty or the draft is unsaved, the LIVE editor body is used
   * and the caller is warned — capturing a stale autosave silently would be
   * worse than an explicit caution.
   */
  async function captureLive(): Promise<ApplyReply> {
    const reply = await getBridge().request('snapshot', {});
    if (!reply.ok) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: reply.error };
    }
    const snapshot = reply.result as GhostSnapshot;
    const liveSource: CapturedSource = {
      resourceType: snapshot.resourceType,
      title: snapshot.title,
      excerpt: snapshot.excerpt,
      tags: snapshot.tags,
      customTemplate: snapshot.customTemplate,
      featureImage: snapshot.featureImage,
      lexical: snapshot.lexical,
    };
    const warnings: string[] = [];
    if (snapshot.dirty) {
      warnings.push(
        'the editor has unsaved changes — the captured body comes from the editor, so save the post to be certain',
      );
    }
    if (snapshot.resourceId === null) {
      warnings.push('this draft has no server id yet, so only the live editor state could be read');
      return {
        source: POPUP_MESSAGE_SOURCE,
        ok: true,
        result: {
          source: liveSource,
          warnings,
          readFrom: 'live-editor',
          siteOrigin: siteOrigin(),
        } satisfies CaptureOutcome,
      };
    }

    const apiReply = await captureFromApi(snapshot.resourceType, snapshot.resourceId);
    if (!apiReply.ok) {
      warnings.push(
        'the saved record could not be re-read from the Ghost API; using the live editor state',
      );
      return {
        source: POPUP_MESSAGE_SOURCE,
        ok: true,
        result: {
          source: liveSource,
          warnings,
          readFrom: 'live-editor',
          siteOrigin: siteOrigin(),
        } satisfies CaptureOutcome,
      };
    }
    const apiOutcome = apiReply.result as CaptureOutcome;
    if (!snapshot.dirty) {
      return { source: POPUP_MESSAGE_SOURCE, ok: true, result: { ...apiOutcome, warnings } };
    }
    // Dirty editor: keep the stored metadata (tags/template come back resolved
    // from the API) but take the body from the live record.
    return {
      source: POPUP_MESSAGE_SOURCE,
      ok: true,
      result: {
        source: { ...apiOutcome.source, lexical: liveSource.lexical },
        warnings,
        readFrom: 'live-editor',
        siteOrigin: apiOutcome.siteOrigin,
      } satisfies CaptureOutcome,
    };
  }

  async function discover(): Promise<ApplyReply> {
    const reply = await getBridge().request('discover', {});
    if (!reply.ok) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: reply.error };
    }
    return { source: POPUP_MESSAGE_SOURCE, ok: true, result: reply.result };
  }

  async function apply(
    presetId: string,
    promptAnswers?: Partial<Record<string, boolean>>,
  ): Promise<ApplyReply> {
    // Per-tab in-flight guard (belt-and-suspenders over the bridge BUSY lock).
    if (inFlight) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'APPLY_BUSY' } as ApplyReply;
    }
    inFlight = true;
    try {
      const adapter = createBridgeStateAdapter(getBridge());
      const outcome: ApplyOutcome = await runApplyPipeline(
        buildPipelineDeps(adapter),
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
    } catch (err) {
      // ANY unexpected pipeline exception must surface as a structured failure
      // reply — never as `undefined` (which the popup parses as "no reply").
      const message = err instanceof Error ? err.message : 'apply pipeline crashed';
      console.error('ghost-cms-template-injector: apply pipeline crashed', err);
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: `APPLY_CRASH: ${message}` };
    } finally {
      inFlight = false;
    }
  }

  async function preview(presetId: string): Promise<ApplyReply> {
    if (inFlight) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'APPLY_BUSY' };
    }
    inFlight = true;
    try {
      const adapter = createBridgeStateAdapter(getBridge());
      const outcome: PreviewOutcome = await previewApplyPipeline(
        buildPipelineDeps(adapter),
        presetId,
      );
      switch (outcome.status) {
        case 'preview':
          return { source: POPUP_MESSAGE_SOURCE, ok: true, result: outcome };
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
    } catch (err) {
      const message = err instanceof Error ? err.message : 'preview pipeline crashed';
      console.error('ghost-cms-template-injector: preview pipeline crashed', err);
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: `PREVIEW_CRASH: ${message}` };
    } finally {
      inFlight = false;
    }
  }

  async function undo(): Promise<ApplyReply> {
    if (inFlight) {
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'APPLY_BUSY' };
    }
    inFlight = true;
    try {
      const adapter = createBridgeStateAdapter(getBridge());
      const result = await adapter.undoLastApply();
      return { source: POPUP_MESSAGE_SOURCE, ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'undo failed';
      return { source: POPUP_MESSAGE_SOURCE, ok: false, error: message };
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
      return discover();
    }
    if (op === 'preview') {
      if (inFlight) return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'APPLY_BUSY' };
      const presetId = msg['presetId'];
      if (typeof presetId !== 'string') {
        return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'MISSING_PRESET_ID' };
      }
      return preview(presetId);
    }
    if (op === 'listPosts') {
      return listCapturable();
    }
    if (op === 'capture') {
      return captureLive();
    }
    if (op === 'capturePost') {
      const resourceType = msg['resourceType'];
      const resourceId = msg['resourceId'];
      if (resourceType !== 'post' && resourceType !== 'page') {
        return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'INVALID_RESOURCE_TYPE' };
      }
      if (typeof resourceId !== 'string' || resourceId.trim().length === 0) {
        return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'MISSING_RESOURCE_ID' };
      }
      return captureFromApi(resourceType, resourceId.trim());
    }
    if (op === 'undo') {
      if (inFlight) return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'APPLY_BUSY' };
      return undo();
    }
    if (op === 'apply') {
      if (inFlight) {
        return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'APPLY_BUSY' };
      }
      const presetId = msg['presetId'];
      if (typeof presetId !== 'string') {
        return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'MISSING_PRESET_ID' };
      }
      const promptAnswers = parsePromptAnswers(msg['promptAnswers']);
      if (promptAnswers === null) {
        return { source: POPUP_MESSAGE_SOURCE, ok: false, error: 'INVALID_PROMPT_ANSWERS' };
      }
      return apply(presetId, promptAnswers);
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
