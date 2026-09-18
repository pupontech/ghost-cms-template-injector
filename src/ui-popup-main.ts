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
import type { CaptureOutcome, ContentReply, PopupMessage } from './ui-popup';
import { detectEditorUrl, type DetectedRoute } from './route-detection';
import { listPresets, savePreset } from './preset-store';
import { describeCapture, defaultImportName, type CaptureOptions } from './preset-capture';
import type { Preset } from './preset-schema';
import type { ApplicationPlan } from './preset-engine';

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
  /** Optional explicit prompt-mode confirmation delegate. */
  confirmPrompt?: (question: string) => boolean | Promise<boolean>;
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
    savePreset: (input) => savePreset(input),
  };
}

/* ------------------------------------------------------------------ */
/* Render helpers (minimal DOM surface for testability)                */
/* ------------------------------------------------------------------ */

/** Element subset the renderer touches, so it can be faked in tests. */
export interface RenderEl {
  textContent: string | null;
  /** Present on form controls (select/input/checkbox). */
  value?: string;
  disabled?: boolean;
  checked?: boolean;
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

export interface PopupPrompt {
  field: string;
  question: string;
}

/** Build the single decision payload understood by the content script. */
export function buildPromptAnswers(
  prompts: readonly PopupPrompt[],
  accepted: boolean,
): Partial<Record<string, boolean>> {
  return Object.fromEntries(prompts.map((prompt) => [prompt.field, accepted]));
}

/** Render prompt questions into the panel and leave it hidden by default. */
export function renderPromptPanel(
  panel: RenderEl,
  list: RenderEl,
  prompts: readonly PopupPrompt[],
  createEl: CreateEl,
): void {
  list.textContent = '';
  for (const prompt of prompts) {
    const item = createEl('li');
    item.textContent = prompt.question;
    list.appendChild(item);
  }
  panel.setAttribute('hidden', '');
}

/** Render the mutation plan without invoking any editor mutation. */
export function renderPlanPanel(
  panel: RenderEl,
  list: RenderEl,
  plan: ApplicationPlan,
  createEl: CreateEl,
): void {
  list.textContent = '';
  for (const action of plan.actions) {
    const item = createEl('li');
    const detail =
      action.status === 'apply'
        ? 'will apply'
        : action.status === 'prompt'
          ? `prompt — ${action.question ?? 'needs confirmation'}`
          : `skipped${action.reason ? ` — ${action.reason}` : ''}`;
    item.textContent = `${action.field}: ${detail}`;
    list.appendChild(item);
  }
  for (const problem of plan.problems) {
    const item = createEl('li');
    item.textContent = `blocked: ${problem}`;
    list.appendChild(item);
  }
  panel.setAttribute('hidden', '');
}

/* ------------------------------------------------------------------ */
/* Entry / lifecycle                                                   */
/* ------------------------------------------------------------------ */

export interface PopupView {
  statusEl: RenderEl;
  listEl: RenderEl;
  promptPanel?: RenderEl;
  promptListEl?: RenderEl;
  promptYes?: RenderEl;
  promptNo?: RenderEl;
  planPanel?: RenderEl;
  planListEl?: RenderEl;
  planApply?: RenderEl;
  planCancel?: RenderEl;
  undoButton?: RenderEl;
  /** Import-an-existing-post controls (absent in reduced views). */
  importSourceSelect?: RenderEl;
  importNameInput?: RenderEl;
  importTitleToggle?: RenderEl;
  importSaveButton?: RenderEl;
  importStatusEl?: RenderEl;
  document: { createElement: CreateEl };
}

/** Value used for the "the post open in the editor" picker entry. */
export const IMPORT_CURRENT_VALUE = 'current';

export { defaultImportName } from './preset-capture';
/**
 * Fill the import picker: the open editor (when the route has one) followed by
 * the installation's posts and pages, newest first.
 */
export function renderImportOptions(
  select: RenderEl,
  entries: readonly {
    id: string;
    title: string;
    status: string;
    resourceType: 'post' | 'page';
  }[],
  includeCurrent: boolean,
  createEl: CreateEl,
): void {
  select.textContent = '';
  if (includeCurrent) {
    const option = createEl('option');
    option.value = IMPORT_CURRENT_VALUE;
    option.textContent = 'The post open in the editor';
    select.appendChild(option);
  }
  for (const entry of entries) {
    const option = createEl('option');
    option.value = `${entry.resourceType}:${entry.id}`;
    option.textContent = `${entry.title} (${entry.resourceType}, ${entry.status})`;
    select.appendChild(option);
  }
  if (includeCurrent) select.value = IMPORT_CURRENT_VALUE;
}

/**
 * Wire the popup once the DOM is ready. Resolves the active tab, refreshes the
 * capability, loads presets, and renders. Apply clicks delegate to the content
 * script and report the delegation outcome back into the status region.
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
  // A prompt-mode preset needs explicit user decisions before its fields are
  // applied. The toolbar contracts a `confirmPrompt` seam for this; the popup
  // surface gets the same behavior through an injected delegate (defaults to
  // the browser `confirm` dialog) so prompt-mode presets work from BOTH
  // surfaces. The loop collects answers per question, retries apply with them,
  // and stops if the user declines any question.
  const confirmPrompt: (question: string) => boolean | Promise<boolean> =
    api.confirmPrompt ??
    ((question: string) => {
      if (typeof globalThis.confirm === 'function') return globalThis.confirm(question);
      return true;
    });

  if (view.promptPanel) view.promptPanel.setAttribute('hidden', '');

  async function promptDecision(prompts: readonly PopupPrompt[]): Promise<boolean> {
    const { promptPanel, promptListEl, promptYes, promptNo } = view;
    if (!promptPanel || !promptListEl || !promptYes || !promptNo) {
      for (const prompt of prompts) {
        if (!(await confirmPrompt(prompt.question))) return false;
      }
      return true;
    }
    renderPromptPanel(promptPanel, promptListEl, prompts, view.document.createElement);
    promptPanel.removeAttribute('hidden');
    view.statusEl.textContent = 'Review the fields this preset will overwrite.';
    return new Promise<boolean>((resolve) => {
      promptYes.addEventListener('click', () => {
        promptPanel.setAttribute('hidden', '');
        resolve(true);
      });
      promptNo.addEventListener('click', () => {
        promptPanel.setAttribute('hidden', '');
        resolve(false);
      });
    });
  }

  async function planDecision(plan: ApplicationPlan): Promise<boolean> {
    const { planPanel, planListEl, planApply, planCancel } = view;
    if (!planPanel || !planListEl || !planApply || !planCancel) return true;
    renderPlanPanel(planPanel, planListEl, plan, view.document.createElement);
    planPanel.removeAttribute('hidden');
    view.statusEl.textContent = 'Review the preset plan before applying it.';
    return new Promise<boolean>((resolve) => {
      planApply.addEventListener('click', () => {
        planPanel.setAttribute('hidden', '');
        resolve(true);
      });
      planCancel.addEventListener('click', () => {
        planPanel.setAttribute('hidden', '');
        resolve(false);
      });
    });
  }

  async function runUndo(): Promise<void> {
    const result = await controller.undoLastApply();
    if (result.ok) {
      view.statusEl.textContent = 'Last preset apply was undone and saved.';
      view.undoButton?.setAttribute('disabled', '');
    } else {
      view.statusEl.textContent = `Undo failed: ${result.error ?? 'unknown error'}`;
    }
  }

  if (view.undoButton) {
    view.undoButton.setAttribute('disabled', '');
    view.undoButton.addEventListener('click', () => {
      void runUndo();
    });
  }

  async function runApply(presetId: string): Promise<void> {
    if (view.planPanel) {
      const preview = await controller.previewPreset(presetId);
      if (!preview.ok || !preview.plan) {
        view.statusEl.textContent = `Preview failed: ${preview.error ?? 'invalid plan'}`;
        return;
      }
      if (!(await planDecision(preview.plan))) {
        view.statusEl.textContent = `Preset "${presetId}" not applied — you cancelled the plan.`;
        return;
      }
    }
    let answers: Partial<Record<string, boolean>> | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await controller.applyPreset(presetId, answers);
      if (
        !result.ok &&
        result.error === 'NEEDS_PROMPT' &&
        result.prompts &&
        result.prompts.length > 0
      ) {
        const accepted = await promptDecision(result.prompts);
        if (!accepted) {
          view.statusEl.textContent = `Preset "${presetId}" not applied — you declined a prompt.`;
          return;
        }
        answers = buildPromptAnswers(result.prompts, true);
        continue;
      }
      if (view.promptPanel) view.promptPanel.setAttribute('hidden', '');
      if (result.ok) view.undoButton?.removeAttribute('disabled');
      view.statusEl.textContent = result.ok
        ? 'Applying preset — the editor will reload to show the changes.'
        : `Apply failed: ${result.error ?? 'unknown error'}`;
      return;
    }
    view.statusEl.textContent = 'Apply failed: too many prompt rounds.';
  }

  function renderList(): void {
    renderPresetList(
      view.listEl,
      presets,
      (presetId) => {
        void runApply(presetId);
      },
      view.document.createElement,
    );
  }

  /* ---------------- import an existing post as a preset ---------------- */

  const importSource = view.importSourceSelect;
  const importName = view.importNameInput;
  const importTitle = view.importTitleToggle;
  const importSave = view.importSaveButton;

  function setImportStatus(message: string): void {
    if (view.importStatusEl) view.importStatusEl.textContent = message;
  }

  let captured: CaptureOutcome | null = null;

  function importSelection(): { resourceType: 'post' | 'page'; id: string } | null {
    const value = importSource?.value ?? '';
    if (value.length === 0 || value === IMPORT_CURRENT_VALUE) return null;
    const [resourceType, id] = value.split(':');
    if (resourceType !== 'post' && resourceType !== 'page') return null;
    if (!id) return null;
    return { resourceType, id };
  }

  /** Read the selected source into capture fields and prefill the name. */
  async function loadImportSource(): Promise<void> {
    if (!importSource) return;
    const selection = importSelection();
    setImportStatus('Reading the post…');
    const read = selection
      ? await controller.capturePost(selection.resourceType, selection.id)
      : await controller.captureCurrent();
    if (!read.ok || !read.outcome) {
      captured = null;
      setImportStatus(`Import failed: ${read.error ?? 'unknown error'}`);
      return;
    }
    captured = read.outcome;
    const summary = describeCapture(read.outcome.source, {
      name: '',
      includeTitle: importTitle?.checked === true,
    });
    if (importName) importName.value = defaultImportName(read.outcome.source);
    const cautions =
      read.outcome.warnings.length > 0 ? ` — ${read.outcome.warnings.join('; ')}` : '';
    setImportStatus(`Ready to import: ${summary.join(', ')}.${cautions}`);
  }

  /** Build + store a preset from the captured post/page. */
  async function runImport(): Promise<void> {
    if (!captured) {
      setImportStatus('Pick a post to import first.');
      return;
    }
    const name = (importName?.value ?? '').trim() || defaultImportName(captured.source);
    const options: CaptureOptions = {
      name,
      includeTitle: importTitle?.checked === true,
    };
    const saved = await controller.saveCapture(captured, options);
    if (!saved.ok || !saved.preset) {
      setImportStatus(`Import failed: ${saved.error ?? 'unknown error'}`);
      return;
    }
    try {
      presets = await controller.loadPresets();
    } catch {
      /* keep the previous list; the save already succeeded */
    }
    renderList();
    const warnings = saved.warnings.length > 0 ? ` (${saved.warnings.join('; ')})` : '';
    setImportStatus(`Saved preset “${saved.preset.name}”.${warnings}`);
    view.statusEl.textContent = `Imported “${saved.preset.name}” as a preset.`;
  }

  renderList();

  if (importSource) {
    const listed = await controller.listCapturable();
    renderImportOptions(
      importSource,
      listed.ok ? (listed.entries ?? []) : [],
      status.state === 'capable',
      view.document.createElement,
    );
    if (!listed.ok && listed.error) setImportStatus(`Post list unavailable: ${listed.error}`);
    else void loadImportSource();

    importSource.addEventListener('change', () => {
      void loadImportSource();
    });
  }

  if (importSave) {
    importSave.addEventListener('click', () => {
      void runImport();
    });
  }

  if (importTitle) {
    importTitle.addEventListener('change', () => {
      if (captured) void loadImportSource();
    });
  }
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
      const statusEl = doc.getElementById('gcti-status');
      const listEl = doc.getElementById('gcti-preset-list');
      const promptPanel = doc.getElementById('gcti-prompt-panel');
      const promptListEl = doc.getElementById('gcti-prompt-list');
      const promptYes = doc.getElementById('gcti-prompt-yes');
      const promptNo = doc.getElementById('gcti-prompt-no');
      const planPanel = doc.getElementById('gcti-plan-panel');
      const planListEl = doc.getElementById('gcti-plan-list');
      const planApply = doc.getElementById('gcti-plan-apply');
      const planCancel = doc.getElementById('gcti-plan-cancel');
      const undoButton = doc.getElementById('gcti-undo');
      const importSourceSelect = doc.getElementById('gcti-import-source');
      const importNameInput = doc.getElementById('gcti-import-name');
      const importTitleToggle = doc.getElementById('gcti-import-title');
      const importSaveButton = doc.getElementById('gcti-import-save');
      const importStatusEl = doc.getElementById('gcti-import-status');
      if (statusEl && listEl) {
        const popupView: PopupView = {
          statusEl: statusEl as unknown as RenderEl,
          listEl: listEl as unknown as RenderEl,
          document: {
            createElement: (tag: string) => doc.createElement(tag) as unknown as RenderEl,
          },
        };
        if (promptPanel && promptListEl && promptYes && promptNo) {
          popupView.promptPanel = promptPanel as unknown as RenderEl;
          popupView.promptListEl = promptListEl as unknown as RenderEl;
          popupView.promptYes = promptYes as unknown as RenderEl;
          popupView.promptNo = promptNo as unknown as RenderEl;
        }
        if (planPanel && planListEl && planApply && planCancel) {
          popupView.planPanel = planPanel as unknown as RenderEl;
          popupView.planListEl = planListEl as unknown as RenderEl;
          popupView.planApply = planApply as unknown as RenderEl;
          popupView.planCancel = planCancel as unknown as RenderEl;
        }
        if (undoButton) popupView.undoButton = undoButton as unknown as RenderEl;
        if (importSourceSelect && importNameInput && importSaveButton) {
          popupView.importSourceSelect = importSourceSelect as unknown as RenderEl;
          popupView.importNameInput = importNameInput as unknown as RenderEl;
          popupView.importSaveButton = importSaveButton as unknown as RenderEl;
          if (importTitleToggle)
            popupView.importTitleToggle = importTitleToggle as unknown as RenderEl;
          if (importStatusEl) popupView.importStatusEl = importStatusEl as unknown as RenderEl;
        }
        void initPopup(chrome, popupView);
      }
    });
  }
}
