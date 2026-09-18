/**
 * Fixed message identities used across extension contexts.
 *
 * Kept in one dependency-free module so the service worker, the popup, and the
 * options page can all agree on them without pulling each other's controllers
 * into their bundles.
 */

/** Identity of popup/toolbar messages relayed to the same tab's content script. */
export const POPUP_MESSAGE_SOURCE = 'ghost-cms-template-injector/popup/v1';

/**
 * Identity the options page uses to ask the service worker to read a Ghost tab.
 *
 * The options page has no content script of its own, so it cannot reach the
 * Admin API or the live editor directly; the service worker routes the request
 * to the tab that actually has the granted host permission.
 */
export const OPTIONS_CAPTURE_SOURCE = 'ghost-cms-template-injector/options-capture/v1';
