/**
 * Phase-4 optional injected toolbar — content-script entry + DOM glue.
 *
 * This file owns ONLY the browser surface of the floating toolbar: it builds an
 * accessible DOM fragment, mounts/unmounts it across Ghost Admin route changes,
 * and renders preset buttons. All business logic (visibility, apply
 * delegation, accessibility contract) lives in `toolbar-controller.ts`.
 *
 * Key invariants:
 *  - No Ghost DOM coupling. The current route is read exclusively through the
 *    shared `route-detection` module (via injected `getHref`/`getHash`), never
 *    by inspecting Ghost-owned elements, CSS classes, or Ember internals.
 *  - Mount/unmount is idempotent and driven by hash-route changes; leaving the
 *    editor screen (list/unknown) fully removes the toolbar from the document.
 *  - Apply is delegated by sending the SAME `PopupMessage` the popup sends to
 *    the content script (fixed `source`, `op: 'apply'`). Because the toolbar is
 *    injected as its own content script co-resident with the main content
 *    script, it reaches that content script through `chrome.runtime.sendMessage`
 *    (the content-script-available API) — identical to the popup's protocol —
 *    so the long-lived apply transaction survives toolbar closure and no editor
 *    state is owned here. `chrome.tabs` is intentionally NOT used: the toolbar
 *    only holds `storage` (+`scripting`) permissions and has no `tabs`
 *    permission, so `chrome.tabs` would be undefined at runtime.
 *  - Accessibility: the root is `role="toolbar"` with an accessible label, the
 *    status region is `role="status"` `aria-live="polite"`, and each preset
 *    button carries an `aria-label` equal to the preset name.
 *
 * The module is silent until a real browser context (`chrome` global) is
 * present, so it is safe to import and unit-test in Node.
 */

import { detectGhostRoute, type DetectedRoute } from './route-detection';
import {
  createToolbarController,
  TOOLBAR_ARIA_LABEL,
  type ToolbarControllerDeps,
  type ToolbarPreset,
} from './toolbar-controller';
import { POPUP_MESSAGE_SOURCE, type PopupMessage } from './ui-popup';
import type { CreateEl, RenderEl } from './ui-popup-main';
import { buildPresetFromCapture, defaultImportName, type CapturedSource } from './preset-capture';
import { deriveIdFromName, nextAvailablePresetId } from './preset-naming';
import type { Preset } from './preset-schema';

/** DOM element surface the toolbar touches (reuses the popup's minimal subset). */
export type ToolbarDomElement = RenderEl;

/** Injected browser/extension seams so the entry is fully unit-testable. */
export interface ToolbarEnv {
  /** True on a Ghost Admin page (extension match guard). */
  isGhostAdminPage: () => boolean;
  /** Current page href (for route detection). */
  getHref: () => string;
  /** Current location hash fragment (for route detection). */
  getHash: () => string;
  /** Subscribe to hash-route changes. */
  onHashChange: (cb: () => void) => void;
  /** Send the apply `PopupMessage` to the active tab's content script. */
  sendMessage: (message: PopupMessage) => Promise<unknown>;
  /** Ask a prompt-mode overwrite question. */
  confirmPrompt?: (question: string, field: string) => boolean | Promise<boolean>;
  /** Load validated presets (bundled seeds + chrome.storage overrides). */
  listPresets: () => Promise<ToolbarPreset[]>;
  /** Create a DOM element. */
  createElement: CreateEl;
  /** Attach the toolbar root to the document. */
  appendToBody: (el: ToolbarDomElement) => void;
  /** Detach the toolbar root from the document. */
  removeElement: (el: ToolbarDomElement) => void;
  /** Ask for an import preset name (defaults to the browser prompt). */
  promptText?: (message: string, defaultValue: string) => string | null;
  /** Persist an imported preset (defaults to the shared preset store). */
  savePreset?: (input: unknown) => Promise<Preset>;
}

/** Handle to the three regions of a built toolbar. */
export interface ToolbarElementHandle {
  root: ToolbarDomElement;
  listEl: ToolbarDomElement;
  statusEl: ToolbarDomElement;
  /** "Save this post as a preset" button (imports the open editor). */
  importButton: ToolbarDomElement;
}

/** Build the accessible toolbar DOM fragment (root + status + list + import). */
export function createToolbarElement(createEl: CreateEl): ToolbarElementHandle {
  const root = createEl('div');
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', TOOLBAR_ARIA_LABEL);
  root.setAttribute('data-gcti-toolbar', '1');

  const statusEl = createEl('div');
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.textContent = '';

  const listEl = createEl('ul');
  listEl.setAttribute('aria-label', 'Presets');

  const importButton = createEl('button');
  importButton.setAttribute('type', 'button');
  importButton.setAttribute('data-gcti-save-preset', '1');
  importButton.setAttribute('aria-label', TOOLBAR_IMPORT_LABEL);
  importButton.textContent = TOOLBAR_IMPORT_LABEL;

  root.appendChild(statusEl);
  root.appendChild(listEl);
  root.appendChild(importButton);
  return { root, listEl, statusEl, importButton };
}

/** Label of the import action (also its accessible name). */
export const TOOLBAR_IMPORT_LABEL = 'Save this post as a preset';

export interface ImportFromEditorResult {
  ok: boolean;
  name?: string;
  error?: string;
  warnings?: string[];
}

/**
 * Import the post/page open in the editor as a new preset, from the toolbar.
 *
 * The toolbar is a content script co-resident with the main content script, so
 * it asks for the capture over the same fixed popup protocol the popup uses
 * (`op: 'capture'`) and stores the result through the shared preset store. The
 * title is never captured here (the popup exposes that as an explicit choice).
 */
export async function importPresetFromEditor(env: {
  sendMessage: (message: PopupMessage) => Promise<unknown>;
  promptText: (message: string, defaultValue: string) => string | null;
  savePreset: (input: unknown) => Promise<Preset>;
  listPresets: () => Promise<ToolbarPreset[]>;
}): Promise<ImportFromEditorResult> {
  let reply: unknown;
  try {
    reply = await env.sendMessage({
      source: POPUP_MESSAGE_SOURCE,
      op: 'capture',
      tabId: '',
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'capture request failed' };
  }
  const outer = reply as { ok?: boolean; error?: string; result?: unknown } | undefined;
  if (!outer || outer.ok !== true) {
    return { ok: false, error: outer?.error ?? 'no reply from the content script' };
  }
  const result = outer.result as
    { source?: CapturedSource; siteOrigin?: string | null; warnings?: string[] } | undefined;
  if (!result?.source) return { ok: false, error: 'unrecognized capture payload' };

  const suggested = defaultImportName(result.source);
  const answer = env.promptText('Name for the imported preset', suggested);
  if (answer === null) return { ok: false, error: 'cancelled' };
  const name = answer.trim();
  if (name.length === 0) return { ok: false, error: 'a preset name is required' };

  let built;
  try {
    built = buildPresetFromCapture(result.source, { name }, result.siteOrigin ?? null);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'the post could not be captured',
    };
  }

  let existing: Set<string>;
  try {
    existing = new Set((await env.listPresets()).map((preset) => preset.id));
  } catch {
    existing = new Set<string>();
  }
  const id = nextAvailablePresetId(deriveIdFromName(built.preset.name), existing);
  try {
    await env.savePreset({ ...built.preset, id });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'the preset could not be saved',
    };
  }
  return {
    ok: true,
    name: built.preset.name,
    warnings: [...(result.warnings ?? []), ...built.warnings],
  };
}

/** Render one `li > button` per preset; each button delegates apply by id. */
export function renderToolbarPresets(
  container: ToolbarDomElement,
  presets: readonly ToolbarPreset[],
  onApply: (presetId: string) => void,
  createEl: CreateEl,
): void {
  container.textContent = '';
  for (const preset of presets) {
    const item = createEl('li');
    const button = createEl('button');
    button.setAttribute('type', 'button');
    button.setAttribute('data-preset-id', preset.id);
    button.setAttribute('aria-label', preset.name);
    button.textContent = `${preset.icon ?? ''} ${preset.name}`.trim();
    button.addEventListener('click', () => onApply(preset.id));
    item.appendChild(button);
    container.appendChild(item);
  }
}

/**
 * Initialize the injected toolbar for a Ghost Admin page. Mounts when the
 * current route is an editor screen; unmounts whenever the route leaves the
 * editor. Idempotent with respect to route-watch registration.
 */
export async function initToolbar(env: ToolbarEnv): Promise<void> {
  if (!env.isGhostAdminPage()) return;

  const deps: ToolbarControllerDeps = {
    isGhostAdminPage: env.isGhostAdminPage,
    detectRoute: (): DetectedRoute => detectGhostRoute(env.getHref(), env.getHash()),
    listPresets: env.listPresets,
    sendMessage: env.sendMessage,
    confirmPrompt: env.confirmPrompt,
  };

  const controller = createToolbarController(deps);
  let mountedRoot: ToolbarDomElement | null = null;
  let listElRef: ToolbarDomElement | null = null;
  let statusElRef: ToolbarDomElement | null = null;

  const onApply = (presetId: string): void => {
    void controller.applyPreset(presetId);
  };
  controller.onStatus((message) => {
    if (statusElRef) statusElRef.textContent = message;
  });

  /** Import the open editor's post as a preset, then refresh the toolbar list. */
  async function runImport(): Promise<void> {
    const result = await importPresetFromEditor({
      sendMessage: (message) => env.sendMessage(message),
      promptText:
        env.promptText ??
        ((message, defaultValue) => {
          const prompt = (globalThis as { prompt?: typeof window.prompt }).prompt;
          return typeof prompt === 'function' ? prompt(message, defaultValue) : defaultValue;
        }),
      savePreset: env.savePreset ?? ((input) => Promise.resolve(input as Preset)),
      listPresets: () => env.listPresets(),
    });
    if (statusElRef) {
      statusElRef.textContent = result.ok
        ? `Saved preset “${result.name}”${result.warnings && result.warnings.length > 0 ? ` (${result.warnings.join('; ')})` : ''}.`
        : `Import failed: ${result.error ?? 'unknown error'}`;
    }
    if (result.ok) await syncAndRender();
  }

  async function syncAndRender(): Promise<void> {
    await controller.sync();

    if (controller.isMounted() && !mountedRoot) {
      const handle = createToolbarElement(env.createElement);
      mountedRoot = handle.root;
      listElRef = handle.listEl;
      statusElRef = handle.statusEl;
      handle.importButton.addEventListener('click', () => {
        void runImport();
      });
      env.appendToBody(handle.root);
    } else if (!controller.isMounted() && mountedRoot) {
      env.removeElement(mountedRoot);
      mountedRoot = null;
      listElRef = null;
      statusElRef = null;
      return;
    }

    if (controller.isMounted() && listElRef) {
      renderToolbarPresets(listElRef, controller.currentPresets(), onApply, env.createElement);
    }
  }

  controller.init(() => env.onHashChange(() => void syncAndRender()));
  await syncAndRender();
}

/* ------------------------------------------------------------------ */
/* Browser bootstrap — only runs when a real `chrome` global is present. */
/* ------------------------------------------------------------------ */

declare const chrome: {
  runtime: {
    sendMessage: (message: PopupMessage) => Promise<unknown>;
  };
};

function isBrowserContext(): boolean {
  return typeof globalThis !== 'undefined' && 'chrome' in globalThis;
}

if (isBrowserContext()) {
  const doc = globalThis.document;
  const win = globalThis as unknown as {
    location: { href: string; hash: string; pathname: string };
    addEventListener: (type: string, cb: () => void) => void;
  };
  if (doc && win) {
    const env: ToolbarEnv = {
      isGhostAdminPage: () => /\/ghost\//.test(win.location.pathname),
      getHref: () => win.location.href,
      getHash: () => win.location.hash,
      onHashChange: (cb) => win.addEventListener('hashchange', cb),
      // The toolbar is a content script co-resident with the main content
      // script. It delegates apply via chrome.runtime.sendMessage (the
      // content-script-available API) rather than chrome.tabs.* — the manifest
      // does NOT grant the `tabs` permission, so chrome.tabs is undefined in
      // the runtime and would make apply throw.
      async sendMessage(message: PopupMessage) {
        return chrome.runtime.sendMessage(message);
      },
      confirmPrompt: (question) => globalThis.confirm(question),
      promptText: (message, defaultValue) => globalThis.prompt(message, defaultValue),
      savePreset: (input) => import('./preset-store').then((m) => m.savePreset(input)),
      listPresets: () =>
        import('./preset-store').then((m) =>
          m.listPresets().then((presets) =>
            presets.map((p) => ({
              id: p.id,
              name: p.name,
              icon: p.ui?.icon ?? '',
            })),
          ),
        ),
      createElement: (tag) => doc.createElement(tag) as unknown as ToolbarDomElement,
      appendToBody: (el) => doc.body.appendChild(el as unknown as Node),
      removeElement: (el) => {
        const node = el as unknown as Node;
        if (node.parentNode) node.parentNode.removeChild(node);
      },
    };
    void initToolbar(env);
  }
}
