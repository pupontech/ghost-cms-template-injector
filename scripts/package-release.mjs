#!/usr/bin/env node
/**
 * Build the owner-facing release ZIP for the current tree.
 *
 * The manifest's service worker points at `dist/background.js`, so a
 * sources-only ZIP fails Chromium unpacked load with the misleading
 * `Could not load background script ''`. `dist/` is a Git-tree hygiene
 * exclusion, NOT a packaging exclusion: this script ships every tracked file
 * plus the built bundles, asserts the required entries, verifies the
 * extraction round-trip, and prints the SHA-256.
 *
 * Usage: node scripts/package-release.mjs [output-dir]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : '/root/Downloads';

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

/** Entries Chromium needs to load the unpacked extension. */
const REQUIRED = [
  'manifest.json',
  'options/options.html',
  'popup/popup.html',
  'setup/setup.html',
  'presets/presets.json',
  'dist/background.js',
  'dist/content-script.js',
  'dist/popup.js',
  'dist/toolbar.js',
  'dist/options.js',
  'dist/setup.js',
  'dist/bridge.js',
];

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function builtBundles() {
  // `dist/` is git-ignored (a Git-tree rule), so list it from disk: the bundles
  // the manifest references MUST ship inside the ZIP.
  const distDir = path.join(ROOT, 'dist');
  if (!existsSync(distDir)) return [];
  return readdirSync(distDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => `dist/${name}`);
}

async function main() {
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (dirty.length > 0) {
    console.warn('warning: working tree is not clean; the ZIP will contain uncommitted files');
  }

  const files = [...new Set([...trackedFiles(), ...builtBundles()])]
    .filter((f) => existsSync(path.join(ROOT, f)))
    .sort();
  const missing = REQUIRED.filter((f) => !files.includes(f));
  if (missing.length > 0) {
    throw new Error(`required entries missing (build first?): ${missing.join(', ')}`);
  }

  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `ghost-cms-template-injector-v${version}.zip`);
  rmSync(outFile, { force: true });

  const staged = mkdtempSync(path.join(tmpdir(), 'gcti-zip-stage-'));
  try {
    // Stage by copying so the archive stores stable paths, then archive with
    // `zip` when available; otherwise fall back to python3's zipfile module
    // (minimal images ship unzip but not zip).
    for (const rel of files) {
      const target = path.join(staged, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(ROOT, rel)));
    }
    const hasZip = execFileSync('sh', ['-c', 'command -v zip || true'], {
      encoding: 'utf8',
    }).trim();
    if (hasZip) {
      execFileSync('zip', ['-q', '-r', '-X', outFile, ...files], { cwd: staged });
    } else {
      const listFile = path.join(staged, '.zip-inputs');
      writeFileSync(listFile, files.join('\n'));
      execFileSync(
        'python3',
        [
          '-c',
          'import sys, zipfile; names=[l.strip() for l in open(sys.argv[1]) if l.strip()]; ' +
            'z=zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED); ' +
            '[z.write(n, n) for n in names]; z.close()',
          listFile,
          outFile,
        ],
        { cwd: staged },
      );
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }

  // Verify the round trip and the required entries from the archive itself.
  const listed = execFileSync('unzip', ['-Z1', outFile], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const stillMissing = REQUIRED.filter((f) => !listed.includes(f));
  if (stillMissing.length > 0) throw new Error(`ZIP is missing: ${stillMissing.join(', ')}`);

  const extracted = mkdtempSync(path.join(tmpdir(), 'gcti-zip-check-'));
  try {
    execFileSync('unzip', ['-qq', outFile, '-d', extracted]);
    const extractedManifest = JSON.parse(
      readFileSync(path.join(extracted, 'manifest.json'), 'utf8'),
    );
    if (extractedManifest.version !== version) {
      throw new Error(`extracted manifest version ${extractedManifest.version} !== ${version}`);
    }
    const size = readFileSync(path.join(extracted, 'dist', 'background.js')).length;
    if (size === 0) throw new Error('extracted dist/background.js is empty');
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }

  const sha256 = createHash('sha256').update(readFileSync(outFile)).digest('hex');
  const bytes = readFileSync(outFile).length;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  console.log(
    JSON.stringify(
      { file: outFile, version, commit, entries: listed.length, bytes, sha256 },
      null,
      2,
    ),
  );
}

await main();
