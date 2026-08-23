/**
 * Host-permission consent + dynamic content-script registration (owns this
 * module exclusively).
 *
 * Phase-4 previously shipped a STATIC wildcard match (the content_scripts
 * matches array set to the wildcard "/ghost/" host pattern) with no consent
 * step. That violates the decision document SS8 and security baselines M1/M2/M3,
 * C8-2/C8-3: a distributable extension must NOT pre-grant broad host access via
 * a literal wildcard, and must NOT ship a "literal wildcard placeholder." Instead
 * the manifest declares optional_host_permissions only, and the extension
 * requests the user's EXACT Ghost origin after an explicit setup/consent action,
 * then registers the "/ghost/" content scripts dynamically for that single origin.
 *
 * This module is the pure brain: all chrome.* and DOM access is injected via
 * seams so the flow is fully unit-testable with fakes. It performs no writes of
 * its own — it orchestrates the injected permissions/scripting seams and
 * reports structured outcomes.
 *
 * Security invariants enforced here:
 *  - The requested origin must be an exact "https://<host>" origin (no scheme
 *    wildcard, no path, no glob). We never derive or accept a wildcard
 *    host-slash-ghost pattern.
 *  - Registration only proceeds AFTER consent is recorded (the requestPermission
 *    call resolves true). The consent step carries explicit purpose text so the
 *    user understands why host access is needed.
 *  - Content scripts are registered with chrome.scripting.registerContentScripts
 *    keyed by a stable id, scoped to "<origin>/ghost/" only.
 *  - No chrome.tabs access, no broad permissions, no remote code.
 */

/** A validated `https://<host>` origin (path-less, scheme-exact). */
export interface ExactOrigin {
  /** The normalized origin string, e.g. `https://ghost.example.com`. */
  origin: string;
}

/** Injected chrome.* seams so the controller is testable without a browser. */
export interface HostPermissionDeps {
  /** Request optional host permission for the exact origin after consent. */
  requestPermission: (origins: string[]) => Promise<boolean>;
  /** Read currently-granted optional host permissions. */
  getAllPermissions: () => Promise<{ origins?: string[] }>;
  /** Register content scripts for the granted origin's `/ghost/*`. */
  registerContentScripts: (
    scripts: ReadonlyArray<{
      id: string;
      matches: string[];
      js: string[];
      runAt: 'document_idle' | 'document_start' | 'document_end';
      world?: 'ISOLATED' | 'MAIN';
    }>,
  ) => Promise<void>;
  /** Remove previously-registered content scripts by id (idempotent). */
  unregisterContentScripts: (ids: string[]) => Promise<void>;
  /** Persist/recall consent state (records that the user opted in). */
  storageGet: (key: string) => Promise<unknown>;
  storageSet: (items: Record<string, unknown>) => Promise<void>;
}

/** Files injected into the matched Ghost Admin pages. */
export const CONTENT_SCRIPT_FILES = ['dist/content-script.js', 'dist/toolbar.js'] as const;

/** MAIN-world bridge file injected with `world: 'MAIN'` (Ghost internals). */
export const MAIN_WORLD_BRIDGE_FILE = 'dist/bridge.js';

/** Stable registration id so (re)registration is idempotent. */
export const CONTENT_SCRIPT_REGISTRATION_ID = 'ghost-preset-toolbar-enabled';

/** MAIN-world bridge registration id (isolated id + `-main` suffix). */
export const MAIN_WORLD_REGISTRATION_ID = `${CONTENT_SCRIPT_REGISTRATION_ID}-main`;

/** Storage key recording explicit consent for the granted origin. */
export const CONSENT_STORAGE_KEY = 'hostPermissionConsent';

export interface HostPermissionStatus {
  /** True once the exact origin is granted AND scripts are registered. */
  enabled: boolean;
  /** The exact granted origin, or null when not yet granted. */
  origin: string | null;
}

export interface GrantResult {
  ok: boolean;
  enabled: boolean;
  origin: string | null;
  error?: string;
}

/**
 * Validate and normalize a user-supplied Ghost installation/Admin URL into a
 * concrete installation base. Accepts `https://<host>[/<subdir>]` forms with
 * an optional subdirectory (e.g. `https://localhost:2368/blog`), a trailing
 * slash, or an explicit `/ghost` suffix. Rejects anything unsafe or
 * non-concrete: non-HTTPS, wildcards, query strings, fragments.
 */
export function normalizeInstallation(input: string): ExactOrigin | null {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Scheme must be exactly https; no query or fragment allowed.
  if (url.protocol !== 'https:') return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (url.hostname === '' || url.hostname.includes('*') || url.hostname.includes('?')) {
    return null;
  }
  // Normalize the installation path: drop the trailing slash, then a trailing
  // `/ghost` component (the Admin URL may point directly at the admin app).
  let pathname = url.pathname.replace(/\/+$/, '');
  if (/(^|\/)ghost$/.test(pathname)) pathname = pathname.slice(0, -'/ghost'.length);
  return { origin: `${url.origin}${pathname}` };
}

/**
 * Validate a legacy path-less input. Kept for callers that need strict
 * origin-only validation (no subdirectory).
 */
export function normalizeExactOrigin(input: string): ExactOrigin | null {
  const normalized = normalizeInstallation(input);
  if (!normalized) return null;
  let url: URL;
  try {
    url = new URL(normalized.origin);
  } catch {
    return null;
  }
  if (url.pathname !== '' && url.pathname !== '/') return null;
  return { origin: url.origin };
}

/** Build the scoped `/ghost/*` match pattern for an installation base. */
export function ghostMatchForOrigin(origin: string): string {
  return `${origin}/ghost/*`;
}

/**
 * Pure host-permission + dynamic-registration controller.
 */
export function createHostPermission(deps: HostPermissionDeps): {
  status: () => Promise<HostPermissionStatus>;
  /**
   * Run the consent → request → register flow for a single exact origin.
   * Returns a structured result; never throws for a user-facing failure.
   */
  grant: (originInput: string) => Promise<GrantResult>;
  /** Revoke: unregister scripts and drop consent. */
  revoke: () => Promise<HostPermissionStatus>;
} {
  async function status(): Promise<HostPermissionStatus> {
    const granted = await deps.getAllPermissions();
    const origins = granted.origins ?? [];
    const consent = await deps.storageGet(CONSENT_STORAGE_KEY);
    if (
      typeof consent === 'object' &&
      consent !== null &&
      typeof (consent as Record<string, unknown>)['origin'] === 'string' &&
      typeof (consent as Record<string, unknown>)['match'] === 'string' &&
      origins.includes((consent as Record<string, unknown>)['match'] as string)
    ) {
      return { enabled: true, origin: (consent as Record<string, unknown>)['origin'] as string };
    }
    return { enabled: false, origin: null };
  }

  async function grant(originInput: string): Promise<GrantResult> {
    const normalized = normalizeInstallation(originInput);
    if (!normalized) {
      return { ok: false, enabled: false, origin: null, error: 'Invalid Ghost origin.' };
    }
    const origin = normalized.origin;
    const match = ghostMatchForOrigin(origin);

    // Request the exact origin's `/ghost/*` host permission. This is a subset of
    // the declared `optional_host_permissions` pattern, so Chrome accepts it and
    // the user is shown their concrete origin (not a wildcard) at the consent
    // prompt. Nothing is granted until this resolves true.
    const permissionGranted = await deps.requestPermission([match]);
    if (!permissionGranted) {
      return {
        ok: false,
        enabled: false,
        origin: null,
        error: 'Host permission was not granted.',
      };
    }

    try {
      await deps.registerContentScripts([
        {
          id: CONTENT_SCRIPT_REGISTRATION_ID,
          matches: [match],
          js: [...CONTENT_SCRIPT_FILES],
          runAt: 'document_idle',
        },
        {
          // MAIN-world bridge: reaches Ghost's live Ember/Lexical internals.
          // Runs in the page's MAIN world (not the isolated content-script
          // world) so it can own the native save transaction.
          id: MAIN_WORLD_REGISTRATION_ID,
          matches: [match],
          js: [MAIN_WORLD_BRIDGE_FILE],
          runAt: 'document_idle',
          world: 'MAIN',
        },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register content scripts.';
      return { ok: false, enabled: false, origin: null, error: message };
    }

    await deps.storageSet({ [CONSENT_STORAGE_KEY]: { origin, match, grantedAt: Date.now() } });
    return { ok: true, enabled: true, origin };
  }

  async function revoke(): Promise<HostPermissionStatus> {
    // Both the isolated content script and the MAIN-world bridge were
    // registered under two distinct ids in grant(). Unregister both, or the
    // MAIN bridge lingers after the user disables the toolbar (release
    // defect C8). Each unregister is idempotent and non-fatal on its own.
    await deps
      .unregisterContentScripts([CONTENT_SCRIPT_REGISTRATION_ID, MAIN_WORLD_REGISTRATION_ID])
      .catch(() => {});
    await deps.storageSet({ [CONSENT_STORAGE_KEY]: null });
    return { enabled: false, origin: null };
  }

  return { status, grant, revoke };
}
