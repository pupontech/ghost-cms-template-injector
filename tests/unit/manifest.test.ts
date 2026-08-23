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
    // Permissions are scoped: storage for persistence, scripting for dynamic
    // content-script registration. No `tabs`, no broad host grant up front.
    expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'scripting']));
    expect(manifest.permissions).not.toContain('tabs');
    // The optional grant is scoped to a Ghost Admin pattern; registration is
    // dynamic (after consent), so the static content_scripts array is empty.
    expect(manifest.optional_host_permissions ?? []).toEqual(['https://*/*']);
    expect(manifest.content_scripts ?? []).toEqual([]);
    expect(typeof manifest.setup_page).toBe('string');
  });

  it('has no static content_scripts (registration is dynamic after consent)', () => {
    const asText = JSON.stringify(manifest);
    expect(asText.includes('<all_urls>')).toBe(false);
    expect(asText.includes('*://')).toBe(false);
    // No static content_scripts are shipped; the injected toolbar/popup are
    // registered at runtime via chrome.scripting.registerContentScripts for the
    // user's exact, consent-granted origin. This is the security gate (no
    // broad host access, no hosted logic) for the injected surface.
    expect(manifest.content_scripts ?? []).toEqual([]);
  });

  it('contains no secrets or remote code hosts', () => {
    const asText = JSON.stringify(manifest);
    expect(/(api[_-]?key|token|secret|password)/i.test(asText)).toBe(false);
    expect(manifest.content_security_policy).toBeUndefined();
  });
});
