#!/usr/bin/env node
// Manifest validation for the Ghost-CMS Template Injector. Enforces the Phase-4
// security contract: MV3 only, scoped permissions, NO static wildcard content
// match, consent-gated optional host permissions, and dynamic content-script
// registration. Built dist artifacts must contain no chrome.tabs (the toolbar
// is a content script and must use chrome.runtime only) and no static
// `https://*/ghost/*` injection.
import { readFileSync, existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const errors = [];
const repositoryRoot = realpathSync('.');
// Keep release bundles bounded; debug/source-map output is rejected separately.
const MAX_ARTIFACT_BYTES = 2_000_000;

function check(cond, msg) {
  if (!cond) errors.push(msg);
}

check(manifest.manifest_version === 3, 'manifest_version must be 3');
check(/^\d+(\.\d+)*$/.test(manifest.version), 'version must be dotted integers');
check(
  manifest.background?.service_worker === 'dist/background.js' &&
    manifest.background?.type === 'module',
  'background service worker must be dist/background.js (module)',
);

// SECURITY INVARIANT (F2): no static wildcard content-script match. Content
// scripts are registered DYNAMICALLY after explicit user consent, so the
// static `content_scripts` array must be empty.
check(
  Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 0,
  'content_scripts must be empty (registration is dynamic after consent)',
);
check(
  !JSON.stringify(manifest).includes('"https://*/ghost/*"') ||
    (manifest.optional_host_permissions ?? []).includes('https://*/ghost/*'),
  'no static https://*/ghost/* outside optional_host_permissions',
);

// Permissions: only storage + scripting (scripting needed for dynamic
// registerContentScripts). No tabs, no broad host grants.
const allowedPermissions = new Set(['storage', 'scripting']);
for (const p of manifest.permissions ?? []) {
  check(allowedPermissions.has(p), `unexpected permission: ${p}`);
}
check(
  (manifest.host_permissions ?? []).length === 0,
  'host_permissions must be empty (use optional_host_permissions)',
);
check(
  Array.isArray(manifest.optional_host_permissions) &&
    manifest.optional_host_permissions.length >= 1,
  'optional_host_permissions must declare at least one scoped pattern',
);
// The optional grant must be declared so Chrome can show a narrow per-install
// consent (an exact `<origin>[/<subdir>]/ghost/*` request is a subset of
// `https://*/*`). Nothing is granted statically; the setup flow requests only
// the user's concrete installation pattern.
for (const p of manifest.optional_host_permissions ?? []) {
  check(
    /^https:\/\/\*\/\*$/.test(p),
    `optional_host_permissions entry must be https://*/*, got: ${p}`,
  );
}
const allowedManifestKeys = new Set([
  'action',
  'background',
  'content_scripts',
  'description',
  'host_permissions',
  'manifest_version',
  'minimum_chrome_version',
  'name',
  'options_page',
  'optional_host_permissions',
  'permissions',
  'version',
]);
for (const key of Object.keys(manifest)) {
  check(allowedManifestKeys.has(key), `unsupported manifest key: ${key}`);
}

// PACKAGING INVARIANT: every extension page (popup/options/setup) and every
// manifest-referenced script URL must resolve to a packaged dist/ output.
// This is the guard for the release defect where setup/setup.html referenced a
// sibling setup.js that was never emitted.
function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function resolveManifestUrl(fromDir, url) {
  if (typeof url !== 'string' || /[\0\r\n]/.test(url)) return null;
  return path.resolve(repositoryRoot, fromDir, url);
}

function displayPath(absolute) {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/') || '.';
}
const pageScriptRefs = [];
const htmlFiles = ['setup/setup.html', 'popup/popup.html', 'options/options.html'];
for (const htmlFile of htmlFiles) {
  if (!existsSync(htmlFile)) {
    errors.push(`extension page missing: ${htmlFile}`);
    continue;
  }
  const html = readFileSync(htmlFile, 'utf8');
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    const resolved = resolveManifestUrl(path.dirname(htmlFile), m[1]);
    if (!resolved) {
      errors.push(`${htmlFile} contains an invalid script reference`);
    } else {
      pageScriptRefs.push([htmlFile, resolved]);
    }
  }
}
const manifestUrls = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
].filter(Boolean);
for (const u of manifestUrls) {
  const resolved = resolveManifestUrl('.', u);
  if (!resolved) errors.push(`manifest.json contains an invalid packaged reference`);
  else pageScriptRefs.push(['manifest.json', resolved]);
}

const asText = JSON.stringify(manifest);
check(!asText.includes('<all_urls>'), 'no <all_urls>');
check(!asText.includes('*://'), 'no scheme wildcard match patterns');
check(
  !/(api[_-]?key|secret|password|"token")/i.test(asText),
  'possible secret-like key found in manifest',
);

// Built artifacts must exist and contain no secrets, no chrome.tabs (content
// scripts must use chrome.runtime), and no static wildcard host injection.
let distRoot = null;
let distInfo = null;
try {
  distInfo = lstatSync(path.join(repositoryRoot, 'dist'));
} catch {
  distInfo = null;
}
if (!distInfo) {
  errors.push('dist/ missing — run the production build first');
} else if (distInfo.isSymbolicLink()) {
  errors.push('dist/ must not be a symbolic link');
} else if (!distInfo.isDirectory()) {
  errors.push('dist/ must be a directory');
} else {
  distRoot = realpathSync(path.join(repositoryRoot, 'dist'));
  check(distRoot === path.join(repositoryRoot, 'dist'), 'dist/ must resolve inside the repository');
  for (const [refSource, resolved] of pageScriptRefs) {
    check(
      isWithin(distRoot, resolved),
      `${refSource} references ${displayPath(resolved)} outside dist`,
    );
    if (isWithin(distRoot, resolved)) {
      let referenceInfo = null;
      try {
        referenceInfo = lstatSync(resolved);
      } catch {
        referenceInfo = null;
      }
      check(
        Boolean(referenceInfo?.isFile()) &&
          !referenceInfo.isSymbolicLink() &&
          referenceInfo.nlink === 1,
        `${refSource} references ${displayPath(resolved)} that is not a regular packaged output`,
      );
    }
  }
  // Content-script bundles run WITHOUT the `tabs` permission, so chrome.tabs
  // is undefined at runtime and must never be referenced there (F1). The
  // service worker legitimately uses `chrome.tabs.sendMessage` for the Phase-5
  // same-tab relay — that API works with only the message host permission
  // already granted, so it is explicitly permitted for the SW bundle.
  const contentScriptBundles = new Set([
    'content-script.js',
    'toolbar.js',
    'popup.js',
    'options.js',
    'setup.js',
    'bridge.js',
  ]);
  for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
    const f = entry.name;
    const fp = path.join(distRoot, f);
    check(!entry.isSymbolicLink(), `symbolic link in dist: ${displayPath(fp)}`);
    check(entry.isFile(), `dist entry is not a regular file: ${displayPath(fp)}`);
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    check(!f.endsWith('.map'), `source map is not a release artifact: ${displayPath(fp)}`);
    let artifactInfo = null;
    try {
      artifactInfo = lstatSync(fp);
    } catch {
      check(false, `unable to stat packaged output: ${displayPath(fp)}`);
    }
    const artifactSize = artifactInfo?.size ?? 0;
    check(
      artifactSize <= MAX_ARTIFACT_BYTES,
      `packaged output exceeds ${MAX_ARTIFACT_BYTES} bytes: ${displayPath(fp)}`,
    );
    check(artifactInfo?.nlink === 1, `hard link in dist: ${displayPath(fp)}`);
    const text = readFileSync(fp, 'utf8');
    check(
      !/sk-[A-Za-z0-9]|api[_-]?key\s*[:=]/i.test(text),
      `possible secret pattern in ${displayPath(fp)}`,
    );
    check(!text.includes('<all_urls>'), `<all_urls> in built artifact ${displayPath(fp)}`);
    // F1: content scripts must not reach for chrome.tabs (undefined at runtime).
    if (contentScriptBundles.has(f)) {
      check(
        !/\bchrome\.tabs\b/.test(text),
        `chrome.tabs usage in content-script bundle ${displayPath(fp)} (use chrome.runtime)`,
      );
    }
    // F2: no static wildcard host injection baked into the bundle.
    check(
      !text.includes('https://*/ghost/*'),
      `static wildcard https://*/ghost/* injected into ${displayPath(fp)}`,
    );
  }
}

if (errors.length) {
  console.error('manifest validation FAILED:');
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log('manifest validation OK');
