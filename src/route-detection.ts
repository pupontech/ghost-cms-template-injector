/**
 * Phase-4 route detection (owns this module exclusively).
 *
 * Pure, browser-independent URL/hash parsing that classifies the current Ghost
 * Admin location into a small discriminated union: `editor`, `list`, or
 * `unknown`. The popup and injected toolbar both depend only on this module —
 * they never reach into Ghost DOM or Ember internals for routing.
 *
 * Ghost Admin uses the `trailing-hash` location type, so editor routes live in
 * the URL hash fragment (e.g. `#/editor/edit/post/<id>`). The decision document
 * and legacy acceptance tests also use a hash-less form (`/editor/post/<id>`);
 * both are recognised. Path reading is independent of the extension's own
 * origin, so subdirectory installs (`/blog/ghost/`) work unchanged.
 *
 * This module is intentionally free of chrome.* and DOM access so it can be
 * unit-tested with plain strings. The one chrome-aware helper
 * (`detectEditorUrl`) takes the tab-lookup as an injection and reads only the
 * `url` field, matching how the isolated content script reports the active tab.
 */

export type GhostResourceType = 'post' | 'page';

export interface EditorRoute {
  kind: 'editor';
  resourceType: GhostResourceType;
  /** Server id when editing a saved record; null for a brand-new draft. */
  savedId: string | null;
  /** True when the route is a `new` route (no server id yet). */
  isNew: boolean;
}

export interface ListRoute {
  kind: 'list';
  resourceType: GhostResourceType;
}

export interface UnknownRoute {
  kind: 'unknown';
}

export type DetectedRoute = EditorRoute | ListRoute | UnknownRoute;

const HASH_ROUTE_RE = /^#?\/?editor\/(new|edit)\/(post|page)(?:\/([^/]+))?\/?$/;
const LEGACY_ROUTE_RE = /^#?\/?editor\/(post|page)(?:\/([^/]+))?\/?$/;
const LIST_RE = /^#?\/?posts\/?$/;

function isGhostAdmin(originPath: string): boolean {
  return /\/ghost\/?($|[#?])/.test(originPath) || /\/ghost\//.test(originPath);
}

function classifyEditor(type: GhostResourceType, id: string | null): EditorRoute {
  return { kind: 'editor', resourceType: type, savedId: id, isNew: id === null };
}

/**
 * Parse a Ghost Admin URL plus its hash fragment and classify the route.
 * Returns `unknown` for anything that is not a recognized editor or list route.
 * `hash` should be the `location.hash` value (including a leading `#`); it may
 * be empty when the caller is chasing a previously seen fragment.
 */
export function detectGhostRoute(adminUrl: string, hash: string): DetectedRoute {
  let pathname = '';
  let search = '';
  try {
    const url = new URL(adminUrl);
    pathname = url.pathname;
    search = url.search;
  } catch {
    return { kind: 'unknown' };
  }

  if (!isGhostAdmin(`${pathname}${search}`) && !isGhostAdmin(adminUrl)) {
    return { kind: 'unknown' };
  }

  const raw = (hash ?? '').trim();
  if (raw.length === 0) return { kind: 'unknown' };

  // Editor — hash form (router: editor/new/:type, editor/edit/:type/:id).
  const hashMatch = raw.match(HASH_ROUTE_RE);
  if (hashMatch) {
    const verb = hashMatch[1] as 'new' | 'edit';
    const type = hashMatch[2] as GhostResourceType;
    const id = hashMatch[3] ?? null;
    if (verb === 'new') return classifyEditor(type, null);
    // edit without an id segment is malformed.
    if (id === null) return { kind: 'unknown' };
    return classifyEditor(type, id);
  }

  // Editor — legacy/decision-doc form (/editor/post/<id>).
  const legacyMatch = raw.match(LEGACY_ROUTE_RE);
  if (legacyMatch) {
    const type = legacyMatch[1] as GhostResourceType;
    const id = legacyMatch[2] ?? null;
    return classifyEditor(type, id);
  }

  // Posts/pages list route.
  if (LIST_RE.test(raw)) {
    return { kind: 'list', resourceType: 'post' };
  }
  if (/^#?\/?pages\/?$/.test(raw)) {
    return { kind: 'list', resourceType: 'page' };
  }

  return { kind: 'unknown' };
}

/** Minimal tab shape the detector reads (page-world / isolated side). */
export interface ActiveTabLike {
  url?: string;
  /** Already-parsed hash fragment when the live tab hash is empty. */
  hash?: string;
}

export type TabFinder = (tabId: string) => ActiveTabLike | undefined;

/**
 * Resolve the current route for the active Ghost Admin tab. The live tab's
 * `url` hash is authoritative; when it is empty (some Ghost navigation leaves
 * the hash unset while a stored fragment persists), `lastHash` is used as a
 * fallback. Returns null when no Ghost Admin tab is found or the route is not
 * recognized as editor/list.
 */
export function detectEditorUrl(
  findTab: TabFinder,
  tabId: string,
  lastHash?: string,
): DetectedRoute | null {
  const tab = findTab(tabId);
  if (!tab || typeof tab.url !== 'string') return null;

  const live = extractHash(tab.url);
  const hash = live.length > 0 ? live : (lastHash ?? '');
  const route = detectGhostRoute(tab.url, hash);
  return route.kind === 'unknown' ? null : route;
}

/** Pull the hash fragment off a full URL, including a leading `#`. */
function extractHash(url: string): string {
  const idx = url.indexOf('#');
  if (idx === -1) return '';
  return url.slice(idx);
}
