import { describe, expect, it } from 'vitest';

import {
  extensionLoadErrors,
  isBrowserNoise,
  isExtensionLoadFailure,
} from '../e2e/lib/chromium-stderr.mjs';

describe('chromium stderr classification for the ZIP load check', () => {
  it('ignores Chromium service chatter that looks like an error', () => {
    const lines = [
      '[56174:56204:0918/145140.423580:ERROR:google_apis/gcm/engine/registration_request.cc:291] Registration response error message: DEPRECATED_ENDPOINT',
      '[56174:56204:0918/145140.448081:ERROR:google_apis/gcm/engine/registration_request.cc:291] Registration response error message: PHONE_REGISTRATION_ERROR',
      'DevTools listening on ws://127.0.0.1:9393/devtools/browser/abc',
    ];
    expect(lines.every(isBrowserNoise)).toBe(true);
    expect(extensionLoadErrors(lines.join('\n'))).toEqual([]);
  });

  it('reports the failures that actually mean the ZIP would not load', () => {
    const stderr = [
      "Failed to load extension from: /tmp/x. Could not load background script ''.",
      'Could not load manifest.',
      '[1:1:ERROR:google_apis/gcm/engine/registration_request.cc:291] noise',
    ].join('\n');
    expect(extensionLoadErrors(stderr)).toEqual([
      "Failed to load extension from: /tmp/x. Could not load background script ''.",
      'Could not load manifest.',
    ]);
  });

  it('treats a bare ERROR line with no extension context as noise, not a load error', () => {
    const line = 'ERROR:media/gpu/vaapi/vaapi_wrapper.cc:1631 Creating a Vaapi device failed';
    expect(isBrowserNoise(line)).toBe(true);
    expect(isExtensionLoadFailure(line)).toBe(false);
    expect(extensionLoadErrors(line)).toEqual([]);
  });

  it('caps the reported list so one noisy build cannot flood the output', () => {
    const stderr = Array.from({ length: 9 }, () => 'Could not load manifest.').join('\n');
    expect(extensionLoadErrors(stderr)).toHaveLength(5);
  });
});
