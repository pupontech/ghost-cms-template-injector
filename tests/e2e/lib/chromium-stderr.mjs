/**
 * Chromium writes plenty of unrelated noise to stderr (GCM registration, audio
 * service, GPU, DBus). A load check that greps for "ERROR" therefore reports
 * browser chatter as extension load errors, which both hides real failures in
 * noise and makes an honest "no load errors" claim impossible to defend.
 *
 * These helpers keep the two apart. Only lines that describe the extension
 * itself failing to load count as load errors.
 */

/** Substrings that identify Chromium's own services, never the extension. */
const BROWSER_NOISE = [
  'google_apis/gcm',
  'registration_request.cc',
  'PHONE_REGISTRATION_ERROR',
  'DEPRECATED_ENDPOINT',
  'voice_transcription',
  'DevTools listening',
  'CreatePlatformSocket',
  'dbus',
  'bluez',
  'gpu_',
  'GpuChannelMsg',
  'sandbox_linux',
  'media/gpu',
  'CONSOLE',
];

/** Substrings that describe an extension failing to load. */
const EXTENSION_LOAD_FAILURES = [
  'Failed to load extension',
  'Could not load manifest',
  'Could not load background script',
  'Could not load javascript',
  'Could not load file',
  'Manifest file is invalid',
  'Manifest version mismatch',
  'Unrecognized manifest key',
  'Invalid value for',
  'Cannot load extension',
];

export function isBrowserNoise(line) {
  return BROWSER_NOISE.some((needle) => line.includes(needle));
}

export function isExtensionLoadFailure(line) {
  return EXTENSION_LOAD_FAILURES.some((needle) => line.includes(needle));
}

/** Load errors only: extension failures, minus browser service chatter. */
export function extensionLoadErrors(stderr, limit = 5) {
  return stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => isExtensionLoadFailure(line) && !isBrowserNoise(line))
    .slice(0, limit);
}
