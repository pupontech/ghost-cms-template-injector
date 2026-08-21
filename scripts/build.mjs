#!/usr/bin/env node
// Production build for the Ghost Preset Toolbar: typecheck is run by the caller
// (`npm run build`), then entry points are bundled with esbuild (already a
// transitive dependency of vitest, but we require it explicitly) into dist/.
import { build } from 'esbuild';
import { mkdirSync, renameSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: [
    'src/background-main.ts',
    'src/content-script-main.ts',
    'src/ui-popup-main.ts',
    'src/ui-toolbar-main.ts',
    'src/options-main.ts',
    'src/setup-main.ts',
  ],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  // preset-store uses node:fs/node:url only inside a Node/test guard that is
  // never reached in the browser bundle; keep them out of the extension graph.
  external: ['node:fs', 'node:url'],
  sourcemap: 'external',
  minify: true,
  legalComments: 'none',
});

// Rename to the names referenced by manifest.json.
renameSync('dist/background-main.js', 'dist/background.js');
renameSync('dist/content-script-main.js', 'dist/content-script.js');
renameSync('dist/ui-popup-main.js', 'dist/popup.js');
renameSync('dist/ui-toolbar-main.js', 'dist/toolbar.js');
renameSync('dist/options-main.js', 'dist/options.js');
renameSync('dist/setup-main.js', 'dist/setup.js');
renameSync('dist/background-main.js.map', 'dist/background.js.map');
renameSync('dist/content-script-main.js.map', 'dist/content-script.js.map');
renameSync('dist/ui-popup-main.js.map', 'dist/popup.js.map');
renameSync('dist/ui-toolbar-main.js.map', 'dist/toolbar.js.map');
renameSync('dist/options-main.js.map', 'dist/options.js.map');
renameSync('dist/setup-main.js.map', 'dist/setup.js.map');

console.log(
  'build: dist/background.js dist/content-script.js dist/popup.js dist/toolbar.js dist/options.js dist/setup.js written',
);
