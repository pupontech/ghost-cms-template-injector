/**
 * Setup/consent entry point (owns this module + setup/setup.html only).
 *
 * Thin DOM glue that drives the pure `host-permission` controller. It renders
 * the current enable/disable status, reads the user's exact Ghost origin from
 * the input, and runs the consent → permission-request → dynamic-registration
 * flow only after an explicit "Enable" click. All `chrome.*` access is injected
 * via seams in the controller; this file only paints status as untrusted text.
 *
 * This is the ONLY place that triggers `chrome.permissions.request` and
 * `chrome.scripting.registerContentScripts`. There is no static wildcard match
 * in the manifest — the content scripts are registered here, for one exact
 * origin, after consent.
 */

import { createHostPermission, type HostPermissionDeps } from './host-permission';

/* ------------------------------------------------------------------ */
/* Chrome API surface                                                  */
/* ------------------------------------------------------------------ */

export interface SetupChromeApi {
  permissions: {
    request: (args: { origins: string[] }) => Promise<boolean>;
    remove: (args: { origins: string[] }) => Promise<boolean>;
    getAll: () => Promise<{ origins?: string[] }>;
  };
  scripting: {
    registerContentScripts: (scripts: unknown[]) => Promise<void>;
    unregisterContentScripts: (ids: { ids: string[] }) => Promise<void>;
    getRegisteredContentScripts: () => Promise<Array<{ id: string }>>;
  };
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  };
}

/** Build the host-permission deps over the chrome seam. */
export function buildHostPermissionDeps(api: SetupChromeApi): HostPermissionDeps {
  return {
    requestPermission: (origins) => api.permissions.request({ origins }),
    removePermission: (origins) => api.permissions.remove({ origins }),
    getAllPermissions: () => api.permissions.getAll(),
    registerContentScripts: (scripts) => api.scripting.registerContentScripts(scripts as unknown[]),
    unregisterContentScripts: (ids) => api.scripting.unregisterContentScripts({ ids }),
    getRegisteredContentScripts: () => api.scripting.getRegisteredContentScripts(),
    storageGet: (key) => api.storage.local.get(key).then((r) => r[key]),
    storageSet: (items) => api.storage.local.set(items),
  };
}

/* ------------------------------------------------------------------ */
/* View contract                                                       */
/* ------------------------------------------------------------------ */

export interface SetupRenderEl {
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface SetupView {
  statusEl: SetupRenderEl;
  originInput: SetupRenderEl & { value: string };
  enableBtn: SetupRenderEl & SetupClickable;
  disableBtn: SetupRenderEl & SetupClickable;
  document: {
    getElementById: (id: string) => SetupRenderEl | null;
  };
}

/** Minimal clickable surface for the action buttons. */
export interface SetupClickable {
  addEventListener(type: string, cb: () => void): void;
}

function setStatus(view: SetupView, message: string, isError = false): void {
  view.statusEl.textContent = message;
  view.statusEl.setAttribute('role', isError ? 'alert' : 'status');
}

/* ------------------------------------------------------------------ */
/* Controller wiring                                                   */
/* ------------------------------------------------------------------ */

export interface SetupControllerDeps {
  controller: ReturnType<typeof createHostPermission>;
  view: SetupView;
}

export async function refreshStatus(deps: SetupControllerDeps): Promise<void> {
  const { controller, view } = deps;
  const status = await controller.status();
  if (status.enabled && status.origin) {
    setStatus(view, `Enabled for ${status.origin}.`);
    view.originInput.value = status.origin;
  } else {
    setStatus(view, 'Not yet enabled. Enter your Ghost Admin origin and click Enable.');
  }
}

export async function handleEnable(deps: SetupControllerDeps): Promise<void> {
  const { controller, view } = deps;
  const origin = view.originInput.value ?? '';
  if (origin.trim().length === 0) {
    setStatus(view, 'Enter your Ghost Admin origin first.', true);
    return;
  }
  const result = await controller.grant(origin);
  if (!result.ok) {
    setStatus(view, result.error ?? 'Could not enable access.', true);
    return;
  }
  setStatus(view, `Enabled for ${result.origin}. Reload Ghost Admin to load the toolbar.`);
}

export async function handleDisable(deps: SetupControllerDeps): Promise<void> {
  const { controller, view } = deps;
  const status = await controller.revoke();
  setStatus(view, status.enabled ? 'Still enabled.' : 'Disabled. Content scripts removed.');
}

/** Wire the setup UI once the DOM is ready. */
export async function initSetup(deps: SetupControllerDeps): Promise<void> {
  const { view } = deps;
  view.enableBtn.addEventListener('click', () => void handleEnable(deps));
  view.disableBtn.addEventListener('click', () => void handleDisable(deps));
  await refreshStatus(deps);
}

/* Browser bootstrap: only runs when a real `chrome` global is present. */
declare const chrome: SetupChromeApi;

function isBrowserContext(): boolean {
  return typeof globalThis !== 'undefined' && 'chrome' in globalThis;
}

if (isBrowserContext()) {
  const doc = globalThis.document;
  if (doc) {
    const el = (id: string) => doc.getElementById(id) as unknown as SetupRenderEl | null;
    const statusEl = el('setup-status');
    const originInput = el('setup-origin') as unknown as (SetupRenderEl & { value: string }) | null;
    if (statusEl && originInput) {
      void initSetup({
        controller: createHostPermission(buildHostPermissionDeps(chrome)),
        view: {
          statusEl,
          originInput,
          enableBtn: el('setup-enable') as SetupRenderEl & SetupClickable,
          disableBtn: el('setup-disable') as SetupRenderEl & SetupClickable,
          document: {
            getElementById: (id: string) => el(id),
          },
        },
      });
    }
  }
}
