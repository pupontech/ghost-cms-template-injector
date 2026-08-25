/**
 * Build regression: every bundle registered through
 * `chrome.scripting.registerContentScripts` is executed by Chrome as a *classic*
 * script (not a module). If the production build emits ESM-only syntax
 * (`import`/`export`/`import.meta`) into those bundles, Chromium throws a
 * SyntaxError at registration time and the content script, toolbar, and MAIN
 * bridge never start — a release-blocking defect proven by the headed real
 * browser matrix (t_192ff30d).
 *
 * This contract test builds the production bundle set and asserts that the
 * three dynamically-registered outputs (dist/content-script.js,
 * dist/toolbar.js, dist/bridge.js) are classic-script parseable and contain no
 * module-only syntax. The service worker and extension pages may remain ESM as
 * required by their runtimes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, beforeAll } from 'vitest';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const DIST = path.join(ROOT, 'dist');

/** Bundles that `chrome.scripting.registerContentScripts` runs as classic scripts. */
const CLASSIC_BUNDLES = ['content-script.js', 'toolbar.js', 'bridge.js'] as const;

/**
 * A SyntaxError emitted by `vm.compileFunction` for top-level module syntax is
 * the closest Node-side analogue to Chromium's classic-script parser rejecting
 * the same bundle. We additionally scan for the module-only tokens so the
 * failure message pinpoints the exact defect.
 */
function assertClassicParseable(name: string, code: string): void {
  try {
    // compileFunction compiles in the "sloppy/classic" realm — the same grammar
    // Chromium uses for content scripts registered without `type: 'module'`.
    vm.compileFunction(code, [], { filename: name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${name} is not classic-script parseable (Chromium would throw SyntaxError at ` +
        `registerContentScripts): ${message}`,
    );
  }

  // Module-only token guards — these are unreachable in a classic script and
  // are exactly what Chromium's classic-script parser rejects. Note: dynamic
  // `import('specifier')` IS valid inside a classic script (it is just a call
  // expression), so it is intentionally NOT flagged here; the release-blocking
  // defect was `import.meta` and `export` tokens, not dynamic import().
  const moduleOnly =
    /\bimport\.meta\b/.test(code) ||
    /^\s*export\s+/m.test(code) || // top-level export
    /^export\s*\{/m.test(code) ||
    /\bexport\s*\{/.test(code) ||
    /\bimport\s*\{/.test(code) || // static import statement
    /\bimport\s+[A-Za-z_$][\w$]*\s+from\b/.test(code) ||
    /\bimport\s*['"]/.test(code);
  expect(moduleOnly, `${name} must contain no module-only import/export/import.meta syntax`).toBe(
    false,
  );
}

describe('dynamically registered bundles are classic-script parseable', () => {
  beforeAll(() => {
    // Build the real production bundles (tsc typecheck + esbuild).
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  }, 120_000);

  for (const file of CLASSIC_BUNDLES) {
    it(`${file} exists and is classic-parseable`, () => {
      const full = path.join(DIST, file);
      expect(existsSync(full), `${file} must be produced by the build`).toBe(true);
      const code = readFileSync(full, 'utf8');
      expect(code.length).toBeGreaterThan(0);
      assertClassicParseable(file, code);
    });
  }
});

/**
 * REGRESSION (release blocker t_f2218c98): content scripts must not fetch the
 * packaged `presets/presets.json` at runtime — Chromium blocks a content-script
 * fetch of an extension resource (net::ERR_FAILED) unless it is listed in
 * `web_accessible_resources`, which the minimal-permission contract omits. The
 * seed must be INLINED into the bundle at build time. This guard inspects the
 * real built classic bundles and asserts the seed preset is embedded (only for
 * bundles that consume presets) and no runtime
 * `chrome.runtime.getURL('presets/presets.json')` fetch path remains.
 */
describe('built classic bundles inline the seed (no content-script fetch)', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' });
  }, 120_000);

  // Only these classic bundles consume preset-store and therefore must inline
  // the seed. The MAIN-world bridge (dist/bridge.js) never imports preset-store.
  const SEED_BUNDLES = ['content-script.js', 'toolbar.js'] as const;

  for (const file of SEED_BUNDLES) {
    it(`${file} embeds the inlined seed`, () => {
      const code = readFileSync(path.join(DIST, file), 'utf8');
      // The seed ids from the shipped presets.json must be present (inlined).
      expect(code, `${file} must inline the bundled seed preset`).toContain('life-update');
    });
  }

  for (const file of CLASSIC_BUNDLES) {
    it(`${file} performs no runtime presets fetch`, () => {
      const code = readFileSync(path.join(DIST, file), 'utf8');
      // The residual `presets/presets.json` reference (if any) must be only the
      // static error-message string, never a runtime getURL+fetch of it.
      const fetchPresets =
        /chrome\.runtime\.getURL\(\s*['"]presets\/presets\.json['"]\s*\)/.test(code) ||
        /fetch\(\s*[^)]*presets\/presets\.json[^)]*\)/.test(code);
      expect(
        fetchPresets,
        `${file} must not fetch presets/presets.json at runtime (content-script blocker)`,
      ).toBe(false);
    });
  }
});
