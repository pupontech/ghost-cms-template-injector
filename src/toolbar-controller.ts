/**
 * Phase-4 optional injected toolbar — pure controller (owns this module).
 *
 * This is the brain of the floating "⚡ Presets" toolbar injected into Ghost
 * Admin. It is deliberately free of direct Ghost DOM coupling: it learns the
 * current screen only through the shared `route-detection` module and decides
 * visibility without reading any Ghost-owned element. All browser surface
 * (mounting the DOM, watching hash changes, sending messages) is delegated to
 * injected seams so the logic is unit-testable with plain fakes.
 *
 * Responsibilities:
 *  - decide visibility: show only on an editor route (post/page), never on
 *    lists or non-Admin pages;
 *  - hold the validated preset list (bundled seeds + chrome.storage overrides);
 *  - delegate `apply` to the long-lived content script using the SAME message
 *    protocol the popup uses (`op: 'apply'`, fixed popup `source`); the toolbar
 *    is a thin, disposable surface and must NOT own the apply transaction, so
 *    closing the toolbar never aborts the apply (mirrors the popup design);
 *  - run accessibility semantics: a stable `aria-label`, a status live region
 *    announcement around the apply delegation, and per-preset rows carrying
 *    id/name/icon for rendering.
 *
 * Security: every delegated message carries the fixed popup `source` identity
 * and only the `apply` operation. No eval, no arbitrary property access, no
 * secrets. Visibility is permission-gated to the editor surface only.
 */

import type { DetectedRoute } from './route-detection';
import { POPUP_MESSAGE_SOURCE, type PopupMessage } from './ui-popup';

/** Stable accessible label for the injected toolbar region. */
export const TOOLBAR_ARIA_LABEL = 'Ghost preset toolbar';

/** A preset row the toolbar renders. `icon` is a string; empty means "no icon". */
export interface ToolbarPreset {
  id: string;
  name: string;
  icon: string;
}

/** Outcome of a visibility decision for the current route. */
export interface ToolbarVisibility {
  visible: boolean;
  reason: string;
}

/** Result of an apply delegation to the content script. */
export interface ToolbarApplyResult {
  ok: boolean;
  delegated: boolean;
  error?: string;
}

/** Injected seams the controller drives (browser/extension aware). */
export interface ToolbarControllerDeps {
  /** True when the document is a Ghost Admin page (extension match guard). */
  isGhostAdminPage: () => boolean;
  /** Resolve the current Admin route from the live tab/url (no Ghost DOM). */
  detectRoute: () => DetectedRoute;
  /** Load validated presets (bundled seeds + chrome.storage overrides). */
  listPresets: () => Promise<ToolbarPreset[]>;
  /** Send a structured message to the content script on the active tab. */
  sendMessage: (message: PopupMessage) => Promise<unknown>;
  /** Ask for an explicit prompt-mode overwrite decision. */
  confirmPrompt?: ((question: string, field: string) => boolean | Promise<boolean>) | undefined;
}

function visibilityFor(route: DetectedRoute): ToolbarVisibility {
  if (route.kind === 'editor') {
    return { visible: true, reason: `editor: ${route.resourceType}` };
  }
  if (route.kind === 'list') {
    return { visible: false, reason: 'List screen — open a post or page editor.' };
  }
  return { visible: false, reason: 'Not a Ghost editor screen.' };
}

/**
 * Pure visibility predicate. Exported for direct unit testing and reuse by the
 * entry layer so the mount/unmount decision never reaches into Ghost DOM.
 */
export function computeVisibility(route: DetectedRoute): ToolbarVisibility {
  return visibilityFor(route);
}

/**
 * Stable per-route identity used to decide whether the rendered preset list
 * needs rebuilding. Two distinct editor records (different id) are different
 * identities even if both are `editor` routes; a brand-new draft (null id) is
 * its own identity and is distinct from a saved record.
 */
function routeIdentity(route: DetectedRoute): string {
  if (route.kind !== 'editor') return route.kind;
  return `editor:${route.resourceType}:${route.savedId ?? 'new'}`;
}

export function createToolbarController(deps: ToolbarControllerDeps): {
  init: (watchRoute: () => void) => void;
  sync: () => Promise<void>;
  isMounted: () => boolean;
  visibilityReason: () => string;
  currentPresets: () => ToolbarPreset[];
  applyPreset: (presetId: string) => Promise<ToolbarApplyResult>;
  renderCount: () => number;
  onStatus: (cb: (message: string) => void) => void;
} {
  let initialized = false;
  let mounted = false;
  let reason = '';
  let presets: ToolbarPreset[] = [];
  let activeIdentity: string | null = null;
  let renders = 0;
  const statusListeners = new Set<(message: string) => void>();

  function emitStatus(message: string): void {
    for (const cb of statusListeners) cb(message);
  }

  async function sync(): Promise<void> {
    const route = deps.detectRoute();
    const vis = visibilityFor(route);
    reason = vis.reason;

    if (!vis.visible) {
      mounted = false;
      activeIdentity = null;
      presets = [];
      return;
    }

    const identity = routeIdentity(route);
    if (!mounted || identity !== activeIdentity) {
      presets = await deps.listPresets();
      mounted = true;
      activeIdentity = identity;
      renders += 1;
    }
  }

  return {
    init(watchRoute: () => void): void {
      if (initialized) return;
      initialized = true;
      if (!deps.isGhostAdminPage()) return;
      watchRoute();
    },

    sync,

    isMounted(): boolean {
      return mounted;
    },

    visibilityReason(): string {
      return reason;
    },

    currentPresets(): ToolbarPreset[] {
      return presets;
    },

    async applyPreset(presetId: string): Promise<ToolbarApplyResult> {
      if (!mounted) {
        return { ok: false, delegated: false, error: 'Toolbar not available here.' };
      }
      emitStatus('Applying preset…');
      try {
        const message: PopupMessage = {
          source: POPUP_MESSAGE_SOURCE,
          op: 'apply',
          tabId: '',
          presetId,
        };
        let reply = await deps.sendMessage(message);
        if (typeof reply === 'object' && reply !== null) {
          let parsed = reply as Record<string, unknown>;
          if (
            parsed['ok'] === false &&
            parsed['error'] === 'NEEDS_PROMPT' &&
            Array.isArray(parsed['result']) &&
            deps.confirmPrompt
          ) {
            const promptAnswers: Record<string, boolean> = {};
            for (const rawPrompt of parsed['result']) {
              if (typeof rawPrompt !== 'object' || rawPrompt === null) {
                emitStatus('');
                return { ok: false, delegated: true, error: 'Invalid prompt response.' };
              }
              const prompt = rawPrompt as Record<string, unknown>;
              if (typeof prompt['field'] !== 'string' || typeof prompt['question'] !== 'string') {
                emitStatus('');
                return { ok: false, delegated: true, error: 'Invalid prompt response.' };
              }
              promptAnswers[prompt['field']] = await deps.confirmPrompt(
                prompt['question'],
                prompt['field'],
              );
            }
            reply = await deps.sendMessage({ ...message, promptAnswers });
            parsed =
              typeof reply === 'object' && reply !== null ? (reply as Record<string, unknown>) : {};
          }
          if (parsed['ok'] === false) {
            const error =
              typeof parsed['error'] === 'string' ? parsed['error'] : 'Apply was rejected.';
            emitStatus('');
            return { ok: false, delegated: true, error };
          }
          if (parsed['ok'] !== true) {
            emitStatus('');
            return { ok: false, delegated: true, error: 'Unrecognized apply response.' };
          }
        }
        // The MAIN bridge reloads the Ghost editor shortly after the apply
        // persists, so the applied text becomes visible without a manual
        // refresh. Tell the user this is imminent rather than clearing.
        emitStatus('Applied — reloading the editor…');
        return { ok: true, delegated: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'apply delegation failed';
        emitStatus('');
        return { ok: false, delegated: false, error: message };
      }
    },

    renderCount(): number {
      return renders;
    },

    onStatus(cb: (message: string) => void): void {
      statusListeners.add(cb);
    },
  };
}
