#!/usr/bin/env node
// Production build for the Ghost Preset Toolbar: typecheck is run by the caller
// (`npm run build`), then entry points are bundled with esbuild (already a
// transitive dependency of vitest, but we require it explicitly) into dist/.
//
// Format split (release-blocking contract, proven by t_192ff30d):
//   - The three bundles registered through `chrome.scripting.registerContentScripts`
//     (dist/content-script.js, dist/toolbar.js, dist/bridge.js) are executed by
//     Chromium as *classic* scripts. They MUST be emitted as IIFE/classic with no
//     `import`/`export`/`import.meta` syntax, or Chrome throws SyntaxError at
//     registration and no listener/toolbar/MAIN bridge ever starts.
//   - The service worker (background) and the extension pages (popup/options/setup)
//     declare their scripts as `type: "module"` in their HTML/manifest, so they
//     keep ESM output as required by their runtimes.
import { build } from 'esbuild';
import { mkdirSync, renameSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

// Shared esbuild options. `external` keeps node: builtins out of the browser
// graph; preset-store only references them inside its never-browser Node/test
// guard. `minify` + `legalComments: 'none'` keep the bundles small.
const shared = {
  bundle: true,
  target: 'chrome116',
  external: ['node:fs', 'node:url', 'node:path'],
  sourcemap: 'external',
  minify: true,
  legalComments: 'none',
};

// Classic (IIFE) bundles registered as dynamic content scripts. No ESM syntax.
await build({
  ...shared,
  entryPoints: ['src/content-script-main.ts', 'src/ui-toolbar-main.ts', 'src/main-bridge-main.ts'],
  outdir: 'dist',
  format: 'iife',
});

// ESM bundles for the service worker and extension pages (module runtimes).
await build({
  ...shared,
  entryPoints: [
    'src/background-main.ts',
    'src/ui-popup-main.ts',
    'src/options-main.ts',
    'src/setup-main.ts',
  ],
  outdir: 'dist',
  format: 'esm',
});

// Rename to the names referenced by manifest.json / page HTML.
renameSync('dist/content-script-main.js', 'dist/content-script.js');
renameSync('dist/ui-toolbar-main.js', 'dist/toolbar.js');
renameSync('dist/main-bridge-main.js', 'dist/bridge.js');
renameSync('dist/background-main.js', 'dist/background.js');
renameSync('dist/ui-popup-main.js', 'dist/popup.js');
renameSync('dist/options-main.js', 'dist/options.js');
renameSync('dist/setup-main.js', 'dist/setup.js');
renameSync('dist/content-script-main.js.map', 'dist/content-script.js.map');
renameSync('dist/ui-toolbar-main.js.map', 'dist/toolbar.js.map');
renameSync('dist/main-bridge-main.js.map', 'dist/bridge.js.map');
renameSync('dist/background-main.js.map', 'dist/background.js.map');
renameSync('dist/ui-popup-main.js.map', 'dist/popup.js.map');
renameSync('dist/options-main.js.map', 'dist/options.js.map');
renameSync('dist/setup-main.js.map', 'dist/setup.js.map');

console.log(
  'build: dist/background.js dist/content-script.js dist/popup.js dist/toolbar.js dist/options.js dist/setup.js dist/bridge.js written',
);
