import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));

describe('manifest.json (MV3 baseline)', () => {
  it('is manifest v3 with required identity fields', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(typeof manifest.name).toBe('string');
    expect(manifest.version).toMatch(/^\d+(\.\d+)*$/);
  });

  it('registers the production background service worker', () => {
    expect(manifest.background?.type).toBe('module');
    expect(manifest.background?.service_worker).toBe('dist/background.js');
  });

  it('grants no static host permission, no scheme wildcards, and no broad match patterns', () => {
    const asText = JSON.stringify(manifest);
    expect(asText.includes('*://')).toBe(false);
    expect(asText.includes('<all_urls>')).toBe(false);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.permissions).toEqual(['storage']);
  });

  it('permits only scoped Ghost Admin content_scripts matches (no remote code)', () => {
    const asText = JSON.stringify(manifest);
    expect(asText.includes('<all_urls>')).toBe(false);
    expect(asText.includes('*://')).toBe(false);
    // Every content_scripts match must be a scoped Ghost Admin path; no entry
    // may load remote code. This is the security gate (no broad host access,
    // no hosted logic) for the injected toolbar/popup.
    const GHOST_MATCH_RE = /^https:\/\/[^:*?/]+\/ghost\/\*$/;
    const isScoped = (m: string) => GHOST_MATCH_RE.test(m) || m === 'https://*/ghost/*';
    for (const cs of manifest.content_scripts ?? []) {
      for (const m of cs.matches ?? []) {
        expect(isScoped(m)).toBe(true);
      }
      expect(cs.js?.some((j: string) => /^https?:/.test(j)) ?? false).toBe(false);
    }
  });

  it('contains no secrets or remote code hosts', () => {
    const asText = JSON.stringify(manifest);
    expect(/(api[_-]?key|token|secret|password)/i.test(asText)).toBe(false);
    expect(manifest.content_security_policy).toBeUndefined();
  });
});
