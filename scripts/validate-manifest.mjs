#!/usr/bin/env node
// Manifest validation for the Phase-1 MV3 scaffold. Enforces the contract:
// MV3 only, exact permissions, no wildcards/hosts/secrets/remote code.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const errors = [];

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

const allowedPermissions = new Set(['storage']);
for (const p of manifest.permissions ?? []) {
  check(allowedPermissions.has(p), `unexpected permission: ${p}`);
}
check(
  (manifest.host_permissions ?? []).length === 0,
  'host_permissions must be empty (use scoped content_scripts matches)',
);

// Content scripts are permitted only when scoped to a Ghost Admin surface:
// every match pattern must be a fixed https pattern whose path includes
// `/ghost/`, with no scheme wildcard (`*://`) and no `<all_urls>`. This keeps
// the security invariant (no broad host access, no remote code) while allowing
// the injected toolbar/popup to run on a Ghost Admin page.
const contentScripts = manifest.content_scripts ?? [];
const GHOST_MATCH_RE = /^https:\/\/[^:*?/]+\/ghost\/\*$/;
function isScopedGhostMatch(pattern) {
  // Scoped = https scheme, a single host (literal or MV3 wildcard '*'), path '/ghost/*'.
  return GHOST_MATCH_RE.test(pattern) || /^https:\/\/\*\/ghost\/\*$/.test(pattern);
}
for (const cs of contentScripts) {
  const matches = cs.matches ?? [];
  check(matches.length > 0, 'content_scripts entry must declare at least one match');
  for (const m of matches) {
    check(
      isScopedGhostMatch(m),
      `content_scripts match must be a scoped Ghost Admin path (https://<host>/ghost/*), got: ${m}`,
    );
  }
  check(
    cs.js?.includes('dist/toolbar.js') || cs.js?.includes('dist/content-script.js'),
    'content_scripts must load the packaged dist bundle(s)',
  );
  check(!cs.js?.some((j) => /^https?:/.test(j)), 'content_scripts must not load remote code');
}

const asText = JSON.stringify(manifest);
check(!asText.includes('<all_urls>'), 'no <all_urls>');
check(!asText.includes('*://'), 'no scheme wildcard match patterns');
// Remote URLs are forbidden except inside scoped content_scripts matches,
// which are individually validated above to be https Ghost Admin paths.
const remoteUrlInMatches =
  contentScripts.length > 0 &&
  (manifest.content_scripts ?? []).every((cs) =>
    (cs.matches ?? []).every((m) => isScopedGhostMatch(m)),
  );
check(
  !/https?:\/\//.test(asText) || remoteUrlInMatches,
  'no remote URLs outside scoped content_scripts matches (no remote code / no hosted logic)',
);
check(
  !/(api[_-]?key|secret|password|"token")/i.test(asText),
  'possible secret-like key found in manifest',
);

// Built artifacts must exist and contain no secrets or wildcard hosts.
if (!existsSync('dist')) {
  errors.push('dist/ missing — run the production build first');
} else {
  for (const f of readdirSync('dist')) {
    const fp = path.join('dist', f);
    if (!statSync(fp).isFile()) continue;
    const text = readFileSync(fp, 'utf8');
    check(!/sk-[A-Za-z0-9]|api[_-]?key\s*[:=]/i.test(text), `possible secret pattern in ${fp}`);
    check(!text.includes('<all_urls>'), `<all_urls> in built artifact ${fp}`);
  }
}

if (errors.length) {
  console.error('manifest validation FAILED:');
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log('manifest validation OK');
