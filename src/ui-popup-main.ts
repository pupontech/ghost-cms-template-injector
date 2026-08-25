/**
 * Phase-4 popup entry point (owns this module + ui-popup.ts only).
 *
 * Thin DOM glue: it resolves the active Ghost Admin tab, builds a
 * `PopupRuntime` over the chrome.* seams, drives the pure `ui-popup`
 * controller, and renders the result. All routing logic lives in
 * `route-detection.ts`; all apply/state logic lives in `ui-popup.ts`. This
 * file is intentionally small and free of business rules.
 *
 * The popup delegates apply to the content script (see `ui-popup.ts`), so the
 * long-running apply transaction survives popup closure.
 */

import { createPopupController, type PopupRuntime } from './ui-popup';
import type { PopupMessage, ContentReply } from './ui-popup';
import { detectEditorUrl, type DetectedRoute } from './route-detection';
import { listPresets } from './preset-store';
import type { Preset } from './preset-schema';

/* ------------------------------------------------------------------ */
/* Chrome API surface (narrowed for testability)                       */
/* ------------------------------------------------------------------ */

export interface PopupChromeApi {
  tabs: {
    query: (queryInfo: {
      active: boolean;
      currentWindow: boolean;
    }) => Promise<Array<{ id?: number; url?: string; hash?: string }>>;
    sendMessage: (tabId: number, message: PopupMessage) => Promise<ContentReply | undefined>;
  };
}

export interface ResolvedActiveTab {
  tabId: string;
  tab: { url?: string; hash?: string };
}

/** Query the active Ghost Admin tab; returns null when none is active. */
export async function resolveActiveTab(api: PopupChromeApi): Promise<ResolvedActiveTab | null> {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find((t) => typeof t.id === 'number');
  if (!tab || typeof tab.id !== 'number') return null;
  const tabInfo: { url?: string; hash?: string } = {};
  if (typeof tab.url === 'string') tabInfo.url = tab.url;
  if (typeof tab.hash === 'string') tabInfo.hash = tab.hash;
  return { tabId: String(tab.id), tab: tabInfo };
}

/**
 * Build a `PopupRuntime` from the chrome seam and a pre-resolved active tab.
 * `sendMessage` forwards to the content script on the active tab; `loadPresets`
 * reads the validated storage repository (bundled seeds + chrome.storage).
 */
export function buildPopupRuntime(
  api: PopupChromeApi,
  resolved: ResolvedActiveTab | null,
): PopupRuntime {
  return {
    getActiveTabId: () => resolved?.tabId ?? null,
    findTab: (id) => (id === resolved?.tabId ? resolved.tab : undefined),
    async sendMessage(_tabId, message) {
      if (!resolved) return undefined;
      return api.tabs.sendMessage(Number(resolved.tabId), message);
    },
    loadPresets: () => listPresets(),
  };
}

/* ------------------------------------------------------------------ */
/* Render helpers (minimal DOM surface for testability)                */
/* ------------------------------------------------------------------ */

/** Element subset the renderer touches, so it can be faked in tests. */
export interface RenderEl {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild(child: RenderEl): void;
  addEventListener(type: string, cb: () => void): void;
}

export type CreateEl = (tag: string) => RenderEl;

/** Human-readable one-line summary of the capability status. */
export function statusSummary(
  status: ReturnType<ReturnType<typeof createPopupController>['lastStatus']>,
): string {
  switch (status.state) {
    case 'capable': {
      const c = status.capability;
      const kind = c.resourceType === 'post' ? 'Post' : 'Page';
      const id =
        c.resourceId === null ? 'new unsaved draft' : `saved ${kind.toLowerCase()} ${c.resourceId}`;
      const dirty = c.dirty ? ' · unsaved changes' : ' · clean';
      return `Editing: ${id}${dirty}`;
    }
    case 'unsupported':
      return status.reason ?? 'Ghost editor capability unavailable.';
    case 'error':
      return `Error: ${status.reason ?? 'unknown'}`;
  }
}

/** Render the presets list; each button delegates apply via `onApply`. */
export function renderPresetList(
  container: RenderEl,
  presets: readonly Preset[],
  onApply: (presetId: string) => void,
  createEl: CreateEl,
): void {
  // Clear existing children.
  container.textContent = '';
  if (presets.length === 0) {
    const empty = createEl('li');
    empty.textContent = 'No presets available.';
    container.appendChild(empty);
    return;
  }
  for (const preset of presets) {
    const item = createEl('li');
    const button = createEl('button');
    button.setAttribute('type', 'button');
    button.setAttribute('data-preset-id', preset.id);
    button.textContent = `${preset.ui?.icon ?? ''} ${preset.name}`.trim();
    button.addEventListener('click', () => onApply(preset.id));
    item.appendChild(button);
    container.appendChild(item);
  }
}

/* ------------------------------------------------------------------ */
/* Entry / lifecycle                                                   */
/* ------------------------------------------------------------------ */

export interface PopupView {
  statusEl: RenderEl;
  listEl: RenderEl;
  promptPanel: RenderEl;
  promptListEl: RenderEl;
  promptYes: RenderEl;
  promptNo: RenderEl;
  document: { createElement: CreateEl };
}

/** Render the prompts a plan is awaiting; returns true if any were shown. */
export function renderPromptPanel(
  panel: RenderEl,
  listEl: RenderEl,
  prompts: readonly { field: string; question: string }[],
  createEl: CreateEl,
): void {
  listEl.textContent = '';
  for (const p of prompts) {
    const item = createEl('li');
    item.textContent = p.question || p.field;
    listEl.appendChild(item);
  }
  // `hidden` is a DOM attribute toggled via setAttribute for the test seam.
  panel.setAttribute('hidden', '');
  // Enzyme-free toggle: render is complete; the entry layer decides visibility.
}

/** Build the {field: answer} map for a confirmed prompt panel. */
export function buildPromptAnswers(
  prompts: readonly { field: string; question: string }[],
  answer: boolean,
): Partial<Record<string, boolean>> {
  const out: Partial<Record<string, boolean>> = {};
  for (const p of prompts) out[p.field] = answer;
  return out;
}

/**
 * Wire the popup once the DOM is ready. Resolves the active tab, refreshes the
 * capability, loads presets, and renders. Apply clicks delegate to the content
 * script and report the delegation outcome back into the status region. When a
 * preset apply needs a decision (NEEDS_PROMPT), the prompt panel is shown;
 * confirming it re-applies with the collected answers (C1 wiring).
 */
export async function initPopup(api: PopupChromeApi, view: PopupView): Promise<void> {
  const resolved = await resolveActiveTab(api);
  const runtime = buildPopupRuntime(api, resolved);
  const controller = createPopupController(runtime);

  const route: DetectedRoute | null = resolved
    ? detectEditorUrl(runtime.findTab, resolved.tabId)
    : null;

  const status = await controller.refresh(route ?? { kind: 'unknown' });
  view.statusEl.textContent = statusSummary(status);

  let presets: Preset[] = [];
  try {
    presets = await controller.loadPresets();
  } catch {
    presets = [];
  }

  // Pending prompt state for the active apply.
  let pendingPrompts: { field: string; question: string }[] = [];
  let pendingPresetId: string | null = null;

  function showPromptPanel(prompts: { field: string; question: string }[], presetId: string): void {
    pendingPrompts = prompts;
    pendingPresetId = presetId;
    renderPromptPanel(view.promptPanel, view.promptListEl, prompts, view.document.createElement);
    // Reveal the panel by removing the `hidden` attribute.
    view.promptPanel.removeAttribute('hidden');
  }

  function hidePromptPanel(): void {
    pendingPrompts = [];
    pendingPresetId = null;
    view.promptPanel.setAttribute('hidden', '');
  }

  function applyAndReport(
    presetId: string,
    promptAnswers?: Partial<Record<string, boolean>>,
  ): void {
    view.statusEl.textContent = 'Applying preset — you can close this popup.';
    void controller.applyPreset(presetId, promptAnswers).then((result) => {
      if (result.ok) {
        view.statusEl.textContent = 'Applied.';
        return;
      }
      if (result.error === 'NEEDS_PROMPT' && result.prompts && result.prompts.length > 0) {
        showPromptPanel(result.prompts, presetId);
        return;
      }
      view.statusEl.textContent = `Apply failed: ${result.error ?? 'unknown error'}`;
    });
  }

  renderPresetList(
    view.listEl,
    presets,
    (presetId) => applyAndReport(presetId),
    view.document.createElement,
  );

  view.promptYes.addEventListener('click', () => {
    if (pendingPresetId) applyAndReport(pendingPresetId, buildPromptAnswers(pendingPrompts, true));
    hidePromptPanel();
  });
  view.promptNo.addEventListener('click', () => {
    hidePromptPanel();
    view.statusEl.textContent = 'Cancelled — nothing applied.';
  });
}

/* Browser bootstrap: only runs when a real `chrome` global is present. */
declare const chrome: PopupChromeApi;

function isBrowserContext(): boolean {
  return typeof globalThis !== 'undefined' && 'chrome' in globalThis;
}

if (isBrowserContext()) {
  const doc = globalThis.document;
  if (doc) {
    doc.addEventListener('DOMContentLoaded', () => {
      const statusEl = doc.getElementById('gpt-status');
      const listEl = doc.getElementById('gpt-preset-list');
      const promptPanel = doc.getElementById('gpt-prompt-panel');
      const promptListEl = doc.getElementById('gpt-prompt-list');
      const promptYes = doc.getElementById('gpt-prompt-yes');
      const promptNo = doc.getElementById('gpt-prompt-no');
      if (statusEl && listEl && promptPanel && promptListEl && promptYes && promptNo) {
        void initPopup(chrome, {
          statusEl: statusEl as unknown as RenderEl,
          listEl: listEl as unknown as RenderEl,
          promptPanel: promptPanel as unknown as RenderEl,
          promptListEl: promptListEl as unknown as RenderEl,
          promptYes: promptYes as unknown as RenderEl,
          promptNo: promptNo as unknown as RenderEl,
          document: {
            createElement: (tag: string) => doc.createElement(tag) as unknown as RenderEl,
          },
        });
      }
    });
  }
}
