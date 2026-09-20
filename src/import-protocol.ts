/**
 * Options-page capture protocol.
 *
 * The options page owns the import UI (per the owner's workflow: the toolbar
 * popup carries one button that lands here), but it has no content script of
 * its own — an extension page cannot read the Ghost Admin API with the site's
 * session cookie, and it cannot touch the live editor record. So it asks the
 * service worker, which routes the request to the tab that actually holds the
 * granted host permission, using the SAME read-only operations the popup used.
 *
 * Security: the request identity is fixed, the operation allowlist is fixed,
 * and only a sender without a tab (i.e. an extension page — a web page cannot
 * message this extension at all, `externally_connectable` is not declared) is
 * accepted. The target tab is chosen by the service worker, never by the
 * caller, so a request can never redirect a read into an arbitrary tab.
 */
import { OPTIONS_CAPTURE_SOURCE, POPUP_MESSAGE_SOURCE } from './message-sources';

/** Read-only operations the options page may ask a Ghost tab for. */
export type OptionsCaptureOperation = 'listPosts' | 'capture' | 'capturePost';

export interface OptionsCaptureMessage {
  source: string;
  op: OptionsCaptureOperation;
  resourceType?: unknown;
  resourceId?: unknown;
}

const OPTIONS_CAPTURE_OPERATIONS: ReadonlySet<string> = new Set([
  'listPosts',
  'capture',
  'capturePost',
]);

/** Structural check for an options-page capture request. */
export function isOptionsCaptureMessage(message: unknown): message is OptionsCaptureMessage {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  if (m['source'] !== OPTIONS_CAPTURE_SOURCE) return false;
  return typeof m['op'] === 'string' && OPTIONS_CAPTURE_OPERATIONS.has(m['op']);
}

/**
 * Re-identify an options request as the content-script message it becomes.
 * The content script only needs the operations, so `capturePost` keeps its
 * validated resource type/id fields.
 */
export function toContentScriptMessage(message: OptionsCaptureMessage): {
  source: string;
  op: OptionsCaptureOperation;
  resourceType?: unknown;
  resourceId?: unknown;
} {
  return {
    source: POPUP_MESSAGE_SOURCE,
    op: message.op,
    ...(message.resourceType === undefined ? {} : { resourceType: message.resourceType }),
    ...(message.resourceId === undefined ? {} : { resourceId: message.resourceId }),
  };
}
