// Release-defect regression coverage (QA t_15b1cdeb):
// P1 — extension pages must reference script bundles that the production
// build actually packages (pages live in setup/, popup/, options/ but bundles
// are emitted to dist/).
// P2 — the setup flow must accept a Ghost installation/Admin URL that carries
// a subdirectory (e.g. https://localhost:2368/blog/) and register
// <origin>/<subdir>/ghost/* instead of rejecting it.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createHostPermission,
  ghostMatchForOrigin,
  normalizeInstallation,
  type HostPermissionDeps,
} from '../../src/host-permission';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const EXTENSION_PAGES = ['setup/setup.html', 'popup/popup.html', 'options/options.html'];

describe('extension-page packaging (P1)', () => {
  for (const page of EXTENSION_PAGES) {
    it(`${page} references script bundles that exist as packaged outputs`, () => {
      const html = readFileSync(path.join(root, page), 'utf8');
      const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
      expect(srcs.length).toBeGreaterThan(0);
      for (const src of srcs) {
        if (src === undefined) continue;
        // Bundles live in dist/ at the extension root; a bare sibling name
        // (e.g. src="setup.js") never resolves to a packaged output.
        const rel = path.posix.normalize(path.join(path.dirname(page), src));
        expect(rel.startsWith('dist/'), `${page} must load ${src} from dist/, got ${rel}`).toBe(
          true,
        );
        expect(
          existsSync(path.join(root, rel)),
          `${page} references missing bundle dist/${rel}`,
        ).toBe(true);
      }
    });
  }
});

describe('subdirectory Ghost installations (P2)', () => {
  it('normalizes an installation URL with a subdirectory', () => {
    expect(normalizeInstallation('https://localhost:2368/blog')).toEqual({
      origin: 'https://localhost:2368/blog',
    });
  });

  it('strips a trailing slash and an explicit /ghost suffix', () => {
    expect(normalizeInstallation('https://example.com/blog/')?.origin).toBe(
      'https://example.com/blog',
    );
    expect(normalizeInstallation('https://example.com/blog/ghost')?.origin).toBe(
      'https://example.com/blog',
    );
    expect(normalizeInstallation('https://example.com/ghost/')?.origin).toBe('https://example.com');
  });

  it('still normalizes a bare origin to the empty subdirectory', () => {
    expect(normalizeInstallation('https://ghost.example.com')?.origin).toBe(
      'https://ghost.example.com',
    );
  });

  it('builds the subdirectory-aware match pattern', () => {
    expect(ghostMatchForOrigin('https://localhost:2368/blog')).toBe(
      'https://localhost:2368/blog/ghost/*',
    );
  });

  it('rejects wildcards, non-HTTPS, query, and fragment inputs', () => {
    expect(normalizeInstallation('https://*/ghost/*')).toBeNull();
    expect(normalizeInstallation('<all_urls>')).toBeNull();
    expect(normalizeInstallation('http://example.com/blog')).toBeNull();
    expect(normalizeInstallation('https://example.com/blog?x=1')).toBeNull();
    expect(normalizeInstallation('https://example.com/blog#top')).toBeNull();
    expect(normalizeInstallation('not a url')).toBeNull();
  });

  function makeDeps(overrides: Partial<HostPermissionDeps> = {}): HostPermissionDeps {
    return {
      requestPermission: overrides.requestPermission ?? (async () => true),
      getAllPermissions: overrides.getAllPermissions ?? (async () => ({ origins: [] })),
      registerContentScripts: overrides.registerContentScripts ?? (async () => {}),
      unregisterContentScripts: overrides.unregisterContentScripts ?? (async () => {}),
      storageGet: overrides.storageGet ?? (async () => undefined),
      storageSet: overrides.storageSet ?? (async () => {}),
    };
  }

  it('grants and registers <origin>/<subdir>/ghost/* for a subdirectory install', async () => {
    const requestPermission = vi.fn(async () => true);
    const registerContentScripts = vi.fn(async () => {});
    const storageSet = vi.fn(async () => {});
    const hp = createHostPermission(
      makeDeps({ requestPermission, registerContentScripts, storageSet }),
    );
    const result = await hp.grant('https://localhost:2368/blog/');
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.origin).toBe('https://localhost:2368/blog');
    expect(requestPermission).toHaveBeenCalledWith(['https://localhost:2368/blog/ghost/*']);
    const registered = (
      registerContentScripts.mock.calls as unknown as Array<[Array<{ matches: string[] }>]>
    )[0]?.[0] as Array<{ matches: string[] }>;
    for (const entry of registered) {
      expect(entry.matches).toEqual(['https://localhost:2368/blog/ghost/*']);
    }
    const stored = (
      storageSet.mock.calls as unknown as Array<[Record<string, unknown>]>
    )[0]?.[0] as Record<string, unknown> | undefined;
    expect(stored?.hostPermissionConsent).toMatchObject({
      origin: 'https://localhost:2368/blog',
      match: 'https://localhost:2368/blog/ghost/*',
    });
  });

  it('status reports enabled for a persisted subdirectory consent', async () => {
    const hp = createHostPermission(
      makeDeps({
        getAllPermissions: async () => ({ origins: ['https://localhost:2368/blog/ghost/*'] }),
        storageGet: async () => ({
          origin: 'https://localhost:2368/blog',
          match: 'https://localhost:2368/blog/ghost/*',
          grantedAt: 1,
        }),
      }),
    );
    await expect(hp.status()).resolves.toEqual({
      enabled: true,
      origin: 'https://localhost:2368/blog',
    });
  });

  it('the manifest declares the optional host scope that makes narrow per-install requests possible', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    expect(manifest.optional_host_permissions).toContain('https://*/*');
  });
});
