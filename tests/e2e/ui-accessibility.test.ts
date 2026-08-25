import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd());

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Phase-4 UI accessibility and permission contracts', () => {
  it('keeps popup status live and preset controls keyboard-operable', () => {
    const html = read('popup/popup.html');
    expect(html).toContain('<html lang="en">');
    expect(html).toMatch(/id="gcti-status" role="status"/);
    expect(html).toContain('<ul id="gcti-preset-list"></ul>');
    expect(html).toContain('<script type="module" src="../dist/popup.js"></script>');
    expect(read('src/ui-popup-main.ts')).toContain("button.setAttribute('type', 'button')");
  });

  it('keeps toolbar semantics and polite apply feedback in the injected surface', () => {
    const source = read('src/ui-toolbar-main.ts');
    expect(source).toContain("root.setAttribute('role', 'toolbar')");
    expect(source).toContain("statusEl.setAttribute('role', 'status')");
    expect(source).toContain("statusEl.setAttribute('aria-live', 'polite')");
    expect(source).toContain("button.setAttribute('aria-label', preset.name)");
    expect(source).toContain("button.setAttribute('type', 'button')");
  });

  it('keeps options form labels, status semantics, and untrusted text rendering', () => {
    const html = read('options/options.html');
    // Visible simplified form: name + template text; the legacy opt-id input is
    // retained as a hidden round-trip field, so its label lives in the hidden block.
    expect(html).toMatch(/<form id="opt-form" aria-label="Create or edit a preset">/);
    expect(html).toMatch(/<label for="opt-name">/);
    expect(html).toMatch(/<label for="opt-body">/);
    expect(html).toMatch(/<label for="opt-tags">/);
    expect(html).toMatch(/id="opt-import-area"\s+aria-label=/);
    expect(html).toMatch(/id="opt-export-area"\s+aria-label=/);
    const source = read('src/options-main.ts');
    expect(source).toContain('textContent');
    expect(source).not.toMatch(/\.innerHTML\s*=/);
  });

  it('ships consent-gated optional host permission and dynamic content-script registration (no static wildcard)', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      permissions: string[];
      host_permissions: string[];
      content_scripts: Array<{ matches: string[]; js: string[] }>;
      optional_host_permissions?: string[];
    };
    // No broad/broad default host permission is granted up front.
    expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'scripting']));
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.host_permissions).toEqual([]);
    // The static wildcard match is gone: content scripts are registered
    // dynamically after explicit consent, so the manifest declares none.
    expect(manifest.content_scripts).toEqual([]);
    // Chromium supports the declared optional pattern, but the setup controller
    // requests only the user's exact installation /ghost/* path at consent time.
    expect(manifest.optional_host_permissions ?? []).toEqual(['https://*/*']);
    expect(read('popup/popup.html')).toContain('href="../setup/setup.html"');
    // The setup surface and dynamically-registered bundle must exist.
    expect(read('setup/setup.html')).toContain('type="module" src="../dist/setup.js"');
    // Source must reference the dynamic registration primitives.
    const setupSource = read('src/host-permission.ts');
    expect(setupSource).toContain('requestPermission');
    expect(setupSource).toContain('registerContentScripts');
    expect(setupSource).not.toMatch(
      /content_scripts\.matches\s*[:=]\s*\[["']https:\/\/\*\/ghost\/\*["']\]/,
    );
  });
});

describe('Phase-4 persistence and route-change manual seams', () => {
  it('documents restart persistence and route transition evidence as explicit checks', () => {
    const matrix = read('docs/manual-test-matrix.md');
    expect(matrix).toContain('Extension reload / browser restart');
    expect(matrix).toContain('Close popup immediately after clicking Apply');
    expect(matrix).toContain('Editor → list → editor');
    expect(matrix).toContain('Optional permission setup');
  });
});
