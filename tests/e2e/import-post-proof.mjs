/**
 * POST-IMPORT LIVE PROOF (real Ghost 6.59 + real Chromium, no fakes).
 *
 * Proves the "import an existing Ghost post as a preset" feature against the
 * REAL environment in two phases:
 *
 *   A. CAPTURE (real Ghost data, real capture modules):
 *      a real post is created through the Admin API, read back with the exact
 *      query the extension's own client issues (`?formats=lexical&include=tags`),
 *      mapped with the production `sourceFromGhostRecord`, built with the
 *      production `buildPresetFromCapture` (compiled from this tree with
 *      esbuild), and validated with the production `validatePreset`.
 *      A negative control proves the fail-closed path against real data: a post
 *      whose body cannot be read must abort instead of producing a preset.
 *
 *   B. APPLY (real MV3 runtime + real editor):
 *      the captured document is written to `chrome.storage.local` under the
 *      production key and the REAL options page must list it, then the live
 *      Ember editor record of a different draft is snapshotted, planned by the
 *      PRODUCTION planner (`planPresetApplication`, compiled from this tree),
 *      and applied through the PRODUCTION MAIN-world bridge with ONE native
 *      save. The result is confirmed by an authenticated Admin API readback.
 *
 * LIMITATION (recorded on purpose): the isolated content-script registration
 * needs the optional host permission, which Chrome only grants through its
 * native consent bubble — unreachable in headless automation. Phase B therefore
 * drives the same production MAIN-world bundle with the same plan shape the
 * content script sends; phase A runs the production capture code against the
 * real API. The `chrome.runtime` plumbing between popup and content script is
 * covered by the unit/integration suites, not claimed here.
 *
 * The session cookie is read from /tmp/cj.txt (outside the repository) and is
 * never printed or written to evidence.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

// The local development Ghost sits behind a self-signed TLS certificate (the
// extension only accepts https admin URLs). Only this harness process disables
// verification — never the extension.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const OUT = path.join(ROOT, 'evidence');
mkdirSync(OUT, { recursive: true });

const ADMIN_URL = 'https://localhost:2443/ghost/';
const ADMIN_BASE = 'https://localhost:2443/ghost/api/admin/';
const ORIGIN = 'https://localhost:2443';
const PORT = Number(process.env.IMPORT_PROOF_CDP_PORT ?? 9391);
const PNG_PATH = process.env.IMPORT_PROOF_PNG ?? '/tmp/spike-feature-image.png';

/**
 * The proof needs a real image, and /tmp is cleaned between runs: generate a
 * small deterministic PNG when the fixture is missing.
 */
function generatePng(width = 8, height = 8) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 3;
      raw[offset] = (x * 30) % 256;
      raw[offset + 1] = (y * 30) % 256;
      raw[offset + 2] = 128;
    }
  }
  const crc32 = (buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const name = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function loadPng(pathname) {
  if (existsSync(pathname)) return readFileSync(pathname);
  const bytes = generatePng();
  writeFileSync(pathname, bytes);
  return bytes;
}

const pngBytes = loadPng(PNG_PATH);
const pngBase64 = pngBytes.toString('base64');

const sessionLine = readFileSync('/tmp/cj.txt', 'utf8')
  .split('\n')
  .find((line) => line.includes('ghost-admin-api-session'));
const cookieParts = (sessionLine ?? '').trim().split('\t');
const cookieName = cookieParts.length >= 7 ? cookieParts[5] : 'ghost-admin-api-session';
const cookieValue = cookieParts.length >= 7 ? cookieParts[6] : '';
if (!cookieValue) {
  console.error('import-post-proof: no session cookie in /tmp/cj.txt');
  process.exit(1);
}
const cookieHeader = `${cookieName}=${cookieValue}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { steps: [], readback: {}, capture: {}, plan: {} };
function record(step, detail) {
  evidence.steps.push({ step, ...(detail === undefined ? {} : { detail }) });
  console.log(`✓ ${step}`, detail === undefined ? '' : JSON.stringify(detail));
}
function fail(message) {
  console.error(`✗ ${message}`);
  try {
    chromium?.kill('SIGTERM');
  } catch {
    /* not started yet */
  }
  process.exit(1);
}
let chromium = null;

/* ---------------------------------------------------------------- */
/* Admin API helpers (Node side, cookie-authenticated)              */
/* ---------------------------------------------------------------- */

async function api(method, resourcePath, body) {
  const response = await fetch(`${ADMIN_BASE}${resourcePath}`, {
    method,
    headers: {
      cookie: cookieHeader,
      origin: ORIGIN,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${method} ${resourcePath} → ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

/* ---------------------------------------------------------------- */
/* A. Capture — production modules against real Ghost data           */
/* ---------------------------------------------------------------- */

const bundleDir = `/tmp/gcti-import-proof-${process.pid}`;
mkdirSync(bundleDir, { recursive: true });
const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild');
const captureBundle = path.join(bundleDir, 'capture.mjs');
execFileSync(
  esbuild,
  [
    path.join(ROOT, 'src', 'preset-capture.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${captureBundle}`,
  ],
  { cwd: ROOT, stdio: 'pipe' },
);
const capture = await import(pathToFileURL(captureBundle).href);
const schemaBundle = path.join(bundleDir, 'schema.mjs');
execFileSync(
  esbuild,
  [
    path.join(ROOT, 'src', 'preset-schema.ts'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    `--outfile=${schemaBundle}`,
  ],
  { cwd: ROOT, stdio: 'pipe' },
);
const schema = await import(pathToFileURL(schemaBundle).href);
record('compiled the production capture + schema modules from this tree', {
  bundles: ['capture.mjs', 'schema.mjs'],
});

const stamp = Date.now();

// A real photo for the source post's feature image (uploaded the same way the
// extension uploads a cached photo).
const form = new FormData();
form.append('file', new Blob([pngBytes], { type: 'image/png' }), 'import-source.png');
form.append('purpose', 'image');
const uploadResponse = await fetch(`${ADMIN_BASE}images/upload/`, {
  method: 'POST',
  headers: { cookie: cookieHeader, origin: ORIGIN, accept: 'application/json' },
  body: form,
});
const uploadBody = await uploadResponse.json().catch(() => null);
const uploadedUrl = uploadBody?.images?.[0]?.url;
if (uploadResponse.status !== 201 || !uploadedUrl) {
  fail(`image upload failed: ${uploadResponse.status} ${JSON.stringify(uploadBody)}`);
}
record('uploaded the source post photo through Ghost admin images/upload/', {
  status: uploadResponse.status,
  url: uploadedUrl,
});

// The post we import: excerpt + two tags + custom template + body + photo.
const sourceCreated = await api('POST', 'posts/?source=html', {
  posts: [
    {
      title: `Import source ${stamp}`,
      status: 'draft',
      html: '<p>First paragraph of the imported post.</p><p>Second paragraph.</p>',
      custom_excerpt: 'An excerpt worth templating.',
      custom_template: 'custom-review.hbs',
      feature_image: uploadedUrl,
      tags: [{ name: 'Software' }, { name: 'Reviews' }],
    },
  ],
});
const sourcePost = sourceCreated.posts[0];
record('created the source post to import through the Admin API', {
  postId: sourcePost.id,
  tags: (sourcePost.tags ?? []).map((t) => t.name),
  customTemplate: sourcePost.custom_template,
});

// Read it back exactly as the extension's client does.
const sourceRead = await api('GET', `posts/${sourcePost.id}/?formats=lexical&include=tags`);
const sourceRecord = sourceRead.posts[0];
if (typeof sourceRecord.lexical !== 'string' || sourceRecord.lexical.length === 0) {
  fail('the Admin API did not return a lexical body for the source post');
}
record("read the post back with ?formats=lexical&include=tags (the extension's own query)", {
  lexicalBytes: sourceRecord.lexical.length,
  tagNames: (sourceRecord.tags ?? []).map((t) => t.name),
});

const capturedSource = capture.sourceFromGhostRecord('post', sourceRecord);
const built = capture.buildPresetFromCapture(capturedSource, { name: `Imported ${stamp}` }, ORIGIN);
const preset = built.preset;
evidence.capture = {
  presetId: preset.id,
  name: preset.name,
  warnings: built.warnings,
  metadata: preset.metadata,
  content: {
    source: preset.content.source,
    mode: preset.content.mode,
    bytes: preset.content.lexical.length,
  },
};

// The captured document must satisfy the production schema unchanged.
if (JSON.stringify(schema.validatePreset(preset)) !== JSON.stringify(preset)) {
  fail('the captured preset did not survive production schema validation');
}
record('the captured preset passes production schema validation', { presetId: preset.id });

const checks = {
  bodyCaptured: preset.content.source === 'inline-lexical' && preset.content.mode === 'replace',
  bodyByteIdentical: preset.content.lexical === sourceRecord.lexical,
  excerptCaptured: preset.metadata?.excerpt?.value === 'An excerpt worth templating.',
  excerptOnlyIfEmpty: preset.metadata?.excerpt?.mode === 'only-if-empty',
  tagsCaptured:
    JSON.stringify(preset.metadata?.tags?.values) === JSON.stringify(['Software', 'Reviews']),
  tagsMerge: preset.metadata?.tags?.mode === 'merge',
  customTemplateCaptured: preset.metadata?.customTemplate?.value === 'custom-review.hbs',
  featureImagePortable:
    typeof preset.metadata?.featureImage?.url === 'string' &&
    preset.metadata.featureImage.url.startsWith('/content/images/'),
  featureImageOnlyIfEmpty: preset.metadata?.featureImage?.mode === 'only-if-empty',
  titleNotCaptured: preset.metadata?.title === undefined,
  grouped: preset.ui?.group === 'Imported',
  documentBytesUnderLimit: JSON.stringify(preset).length < 256 * 1024,
};
const failedChecks = Object.entries(checks)
  .filter(([, ok]) => ok !== true)
  .map(([name]) => name);
evidence.capture.checks = checks;
if (failedChecks.length > 0) fail(`capture checks failed: ${failedChecks.join(', ')}`);
record('every capture expectation holds for the real post', checks);

// Negative control: a post whose body cannot be read must abort, not produce a
// half-built preset (this is the fail-closed contract, on real data).
const emptyCreated = await api('POST', 'posts/?source=html', {
  posts: [{ title: `Import negative control ${stamp}`, status: 'draft', html: '' }],
});
const emptyRead = await api(
  'GET',
  `posts/${emptyCreated.posts[0].id}/?formats=lexical&include=tags`,
);
let negativeControl = 'no-throw';
try {
  capture.buildPresetFromCapture(
    capture.sourceFromGhostRecord('post', emptyRead.posts[0]),
    { name: 'Should not be built' },
    ORIGIN,
  );
} catch (err) {
  negativeControl = err instanceof Error ? err.message : String(err);
}
evidence.capture.negativeControl = negativeControl;
if (negativeControl === 'no-throw') {
  fail('a post with an unreadable body produced a preset instead of failing closed');
}
record('negative control: an unreadable body aborts the import (fail closed)', {
  message: negativeControl,
});

/* ---------------------------------------------------------------- */
/* B. Apply the imported preset in the real runtime                  */
/* ---------------------------------------------------------------- */

// The target draft the imported preset will be applied to.
const targetCreated = await api('POST', 'posts/?source=html', {
  posts: [{ title: `Import target ${stamp}`, status: 'draft', html: '' }],
});
const targetPost = targetCreated.posts[0];
record('created the target draft the imported preset will be applied to', {
  postId: targetPost.id,
});

const profile = `/tmp/gcti-import-proof-profile-${process.pid}`;
chromium = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--ignore-certificate-errors',
    '--allow-insecure-localhost',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${ROOT}`,
    '--window-size=1440,1024',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
chromium.stderr.on('data', () => {});

let version;
for (let i = 0; i < 100; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (version?.webSocketDebuggerUrl) break;
  } catch {
    /* retry */
  }
  await sleep(200);
}
if (!version?.webSocketDebuggerUrl) fail('chromium CDP did not come up');

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let seq = 0;
const pending = new Map();
const consoleLog = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params?.args ?? [])
      .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
      .join(' ');
    if (text) consoleLog.push(`[${m.params?.type}] ${text}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleLog.push(`[exception] ${m.params?.exceptionDetails?.exception?.description ?? ''}`);
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function newSession(url) {
  const { result: target } = await send('Target.createTarget', { url });
  const { result: session } = await send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  await send('Runtime.enable', {}, session.sessionId);
  return { targetId: target.targetId, sessionId: session.sessionId };
}
async function evaluate(expression, sessionId, awaitPromise = true) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true },
    sessionId,
  );
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? 'page exception');
  }
  return r.result?.result?.value;
}
async function waitFor(expression, sessionId, { tries = 60, delay = 250 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = await evaluate(expression, sessionId);
      if (value) return value;
    } catch {
      /* keep polling */
    }
    await sleep(delay);
  }
  return null;
}

// Ghost admin session cookie for the browser (https installation).
await send('Storage.setCookies', {
  cookies: [
    {
      name: cookieName,
      value: cookieValue,
      domain: 'localhost',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ],
});

// B1 — the real options page must accept the captured document through the
// production store (single write of the production document shape).
let extensionId = null;
for (let i = 0; i < 60; i += 1) {
  const { result } = await send('Target.getTargets');
  const target = (result?.targetInfos ?? []).find((t) =>
    String(t.url).startsWith('chrome-extension://'),
  );
  if (target) {
    extensionId = String(target.url).split('/')[2];
    break;
  }
  await sleep(250);
}
if (!extensionId) fail('extension id not found (unpacked extension did not load)');
record('unpacked extension loaded with the production bundles', { extensionId });

const optionsPage = await newSession(`chrome-extension://${extensionId}/options/options.html`);
const ready = await waitFor(
  `!!document.getElementById('opt-save') && !!document.getElementById('opt-status')`,
  optionsPage.sessionId,
  { tries: 120, delay: 250 },
);
if (!ready) fail('the real options page did not finish loading');

const seedSet = await evaluate(
  `chrome.storage.local
     .set({ presetStore: ${JSON.stringify({ schemaVersion: 1, version: 1, presets: [preset] })} })
     .then(() => 'stored')`,
  optionsPage.sessionId,
);
if (seedSet !== 'stored')
  fail('the captured document could not be written to chrome.storage.local');
// Reload so the real page re-reads the store through the production reader.
await evaluate('location.reload(); true', optionsPage.sessionId, false);
const listed = await waitFor(
  `(document.body.innerText || '').includes(${JSON.stringify(preset.name)})`,
  optionsPage.sessionId,
  { tries: 120, delay: 250 },
);
if (!listed) fail('the real options page did not list the captured preset from the store');
const seedResult = { listed: true, documentBytes: JSON.stringify(preset).length };
evidence.store = seedResult;
record('the REAL options page lists the captured preset from chrome.storage.local', seedResult);

// The import UI itself lives in the Options page. A granted-content-script
// Ghost tab is required for a real read, which headless Chrome cannot consent
// to, so this checks the delivered section is live and reports the actionable
// reason instead of silently doing nothing — and that a click cannot store
// anything without a capture.
const importSection = await evaluate(
  `(async () => {
     const status = document.getElementById('opt-frompost-status');
     const select = document.getElementById('opt-frompost-source');
     const name = document.getElementById('opt-frompost-name');
     const save = document.getElementById('opt-frompost-save');
     const heading = document.getElementById('opt-frompost-heading');
     if (!status || !select || !name || !save || !heading) {
       return JSON.stringify({ sectionPresent: false });
     }
     const initialStatus = status.textContent.trim();
     name.value = 'Must not be created';
     save.click();
     await new Promise((r) => setTimeout(r, 400));
     const stored = await chrome.storage.local.get('presetStore');
     const ids = (((stored || {}).presetStore || {}).presets || []).map((p) => p.id);
     return JSON.stringify({
       sectionPresent: true,
       heading: heading.textContent,
       sourceOptions: select.options.length,
       initialStatus,
       statusAfterClick: status.textContent.trim(),
       storedIds: ids,
       refusedWithoutCapture: /Pick a post to import first/.test(status.textContent),
       storedNothingNew: !ids.includes('must-not-be-created'),
     });
   })()`,
  optionsPage.sessionId,
);
const importUi = JSON.parse(importSection ?? '{}');
evidence.importSection = importUi;
if (!importUi.sectionPresent) fail('the delivered options page has no import section');
if (!importUi.refusedWithoutCapture || !importUi.storedNothingNew) {
  fail(`the import section stored something without a capture: ${importSection}`);
}
record(
  'the delivered options import section is live and refuses to save without a capture',
  importUi,
);

// B2 — plan the imported preset with the production planner in the page.
const planBundle = path.join(bundleDir, 'plan-iife.js');
execFileSync(
  esbuild,
  [
    path.join(ROOT, 'src', 'preset-engine.ts'),
    '--bundle',
    '--format=iife',
    '--global-name=GCTIPlan',
    `--outfile=${planBundle}`,
  ],
  { cwd: ROOT, stdio: 'pipe' },
);
record('compiled the production planner from this tree', { bundle: 'plan-iife.js' });

const editor = await newSession(`${ADMIN_URL}#/editor/post/${targetPost.id}`);
const findControllerJs = `(() => {
  const ns = (window.Ember && window.Ember.Namespace && window.Ember.Namespace.NAMESPACES) || [];
  for (const n of ns) {
    try {
      const c = n && n.__container__ && n.__container__.lookup('controller:lexical-editor');
      if (c) return c;
    } catch (e) { /* try the next namespace */ }
  }
  return null;
})()`;
await waitFor(`!!${findControllerJs}`, editor.sessionId, { tries: 180, delay: 500 });
const recordReady = await waitFor(
  `(() => {
     const c = ${findControllerJs};
     const p = c && (c.post || (c.model && c.model.post));
     return Boolean(p && typeof p.get === 'function' && p.get('id') === ${JSON.stringify(targetPost.id)});
   })()`,
  editor.sessionId,
  { tries: 180, delay: 500 },
);
if (!recordReady) {
  const diag = await evaluate(
    `JSON.stringify({
       href: location.href,
       editorRoute: !!document.querySelector('.gh-editor, [data-test-lexical-editor], .gh-lexical-editor'),
       bodyText: (document.body.innerText || '').slice(0, 200),
       controllerFound: Boolean(${findControllerJs}),
       recordId: (() => { const c = ${findControllerJs}; const p = c && (c.post || (c.model && c.model.post)); return p && p.get ? p.get('id') : null; })(),
     })`,
    editor.sessionId,
  );
  fail(`the editor did not load the live record for the target draft: ${diag}`);
}
record('Ghost Admin editor loaded the live Ember record', { postId: targetPost.id });

// Snapshot the live record with the same six fields ghost-state reads.
const snapshotJson = await evaluate(
  `(() => {
     const c = ${findControllerJs};
     const p = c && (c.post || (c.model && c.model.post));
     const rawLexical = p.get('lexical') || null;
     const tagsAttr = p.get('tags');
     const tags = tagsAttr && tagsAttr.map
       ? tagsAttr.map((t) => (t && t.get ? t.get('name') : String(t)))
       : [];
     return JSON.stringify({
       bodyEmpty: !rawLexical || !/"text"\\s*:/.test(rawLexical),
       excerpt: p.get('custom_excerpt') || null,
       customTemplate: p.get('custom_template') || null,
       title: p.get('title') || null,
       tags: tags,
       featureImage: p.get('feature_image') || null,
     });
   })()`,
  editor.sessionId,
);
const snapshot = JSON.parse(snapshotJson ?? '{}');
evidence.snapshot = snapshot;
if (snapshot.bodyEmpty !== true) {
  fail(`the target draft was expected to start with an empty body: ${snapshotJson}`);
}
record('snapshotted the live editor record (empty body, no excerpt/photo)', snapshot);

const planSource = readFileSync(planBundle, 'utf8');
await evaluate(planSource, editor.sessionId, false);
const planJson = await evaluate(
  `JSON.stringify(window.GCTIPlan.planPresetApplication(${JSON.stringify(preset)}, ${JSON.stringify(snapshot)}, { templates: ['custom-review.hbs'] }))`,
  editor.sessionId,
);
const plan = JSON.parse(planJson ?? '{}');
evidence.plan = plan;
if (plan.status !== 'ready') {
  fail(`the production planner did not produce a ready plan: ${planJson}`);
}
const fieldSet = (plan.actions ?? []).map((a) => a.field).sort();
evidence.plan.fields = fieldSet;
record('the production planner planned the imported preset against the live record', {
  status: plan.status,
  fields: fieldSet,
});
for (const expected of ['body', 'excerpt', 'tags', 'customTemplate', 'featureImage']) {
  if (!fieldSet.includes(expected)) fail(`the plan is missing the ${expected} action`);
}

// B3 — install the production MAIN-world bridge and apply the plan with one save.
const bridgeSource = readFileSync(path.join(ROOT, 'dist', 'bridge.js'), 'utf8');
await evaluate(bridgeSource, editor.sessionId, false);
const token = 'import-proof-token-0001';
await evaluate(
  `window.postMessage({ capSource: 'ghost-cms-template-injector/page-bridge-capability/v1', action: 'activate', token: ${JSON.stringify(token)} }, window.location.origin); true`,
  editor.sessionId,
  false,
);

// Double-injection guard (real browser): the service worker may inject the
// bundles on demand for a tab that predates the registration, so a second
// evaluation of the SAME bundle in one document must not install a second
// responder — otherwise every request (including an apply) would run twice.
await evaluate(bridgeSource, editor.sessionId, false);
await evaluate(bridgeSource, editor.sessionId, false);
const guardProbe = await evaluate(
  `(async () => {
     // The protocol validates the nonce as a UUID (isBridgeRequest).
     const nonce = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
     let replies = 0;
     const onMessage = (event) => {
       const data = event.data;
       if (!data || data.nonce !== nonce || data.op !== undefined) return;
       replies += 1;
     };
     window.addEventListener('message', onMessage);
     window.postMessage({
       v: 1,
       source: 'ghost-cms-template-injector/page-bridge/v1',
       nonce,
       op: 'discover',
       payload: {},
     }, window.location.origin);
     await new Promise((r) => setTimeout(r, 1200));
     window.removeEventListener('message', onMessage);
     return JSON.stringify({
       installedFlag: window.__gctiMainBridgeInstalled === true,
       replies,
     });
   })()`,
  editor.sessionId,
);
const guard = JSON.parse(guardProbe ?? '{}');
evidence.doubleInjectionGuard = guard;
if (guard.installedFlag !== true || guard.replies !== 1) {
  fail(`injecting the bridge twice was not a no-op: ${guardProbe}`);
}
record('installing the MAIN bundle three times still answers each request once', guard);

let nonceSeq = 0;
/** Send one plan to the production bridge and return its reply. */
async function sendPlan(planPayload, sessionId) {
  const nonce = `99999999-8888-4777-8666-${String(++nonceSeq).padStart(12, '0')}`;
  const raw = await evaluate(
    `new Promise((resolve) => {
       const onMessage = (event) => {
         const data = event.data;
         if (!data || data.nonce !== ${JSON.stringify(nonce)} || data.op !== undefined) return;
         window.removeEventListener('message', onMessage);
         resolve(JSON.stringify(data));
       };
       window.addEventListener('message', onMessage);
       window.postMessage({
         v: 1,
         source: 'ghost-cms-template-injector/page-bridge/v1',
         nonce: ${JSON.stringify(nonce)},
         op: 'apply',
         payload: { plan: ${JSON.stringify(planPayload)} },
       }, window.location.origin);
       setTimeout(() => resolve(JSON.stringify({ timeout: true })), 30000);
     })`,
    sessionId,
  );
  return JSON.parse(raw ?? '{}');
}

/** Open a draft in the existing editor page and wait for its live record. */
async function openDraft(sessionId, postId) {
  await evaluate(
    `location.href = ${JSON.stringify(`${ADMIN_URL}#/editor/post/${postId}`)}; true`,
    sessionId,
    false,
  );
  return waitFor(
    `(() => {
       const c = ${findControllerJs};
       const p = c && (c.post || (c.model && c.model.post));
       return Boolean(p && typeof p.get === 'function' && p.get('id') === ${JSON.stringify(postId)});
     })()`,
    sessionId,
    { tries: 180, delay: 500 },
  );
}

/**
 * Per-field live diagnostics: the full plan failed once during development, and
 * a masked ROLLBACK_FAILED error hides its cause. Each field is therefore
 * applied on its OWN fresh draft through the same production path so the
 * evidence names exactly which write Ghost accepts or rejects.
 */
const fieldDiagnostics = [];
for (const field of ['body', 'excerpt', 'tags', 'customTemplate', 'featureImage']) {
  const action = (plan.actions ?? []).find((a) => a.field === field);
  if (!action) continue;
  const diagCreated = await api('POST', 'posts/?source=html', {
    posts: [{ title: `Field probe ${field} ${stamp}`, status: 'draft', html: '' }],
  });
  const diagId = diagCreated.posts[0].id;
  const loaded = await openDraft(editor.sessionId, diagId);
  if (!loaded) {
    fieldDiagnostics.push({ field, ok: false, error: 'the draft did not load in the editor' });
    continue;
  }
  const reply = await sendPlan(
    { ...plan, presetId: `${plan.presetId}-field-${field}`, actions: [action] },
    editor.sessionId,
  );
  fieldDiagnostics.push({
    field,
    ok: reply.ok === true && reply.result?.saved === true,
    error: reply.error ?? null,
    status: reply.result?.status ?? null,
  });
}
evidence.fieldDiagnostics = fieldDiagnostics;
record('per-field live diagnostics through the production path', fieldDiagnostics);
const failingFields = fieldDiagnostics.filter((d) => !d.ok);
if (failingFields.length > 0) {
  fail(`these imported fields could not be written live: ${JSON.stringify(failingFields)}`);
}

// The real run: back to the target draft, re-planned against its live record.
if (!(await openDraft(editor.sessionId, targetPost.id))) {
  fail('the target draft did not reload in the editor');
}
const freshSnapshot = JSON.parse(
  (await evaluate(
    `(() => {
       const c = ${findControllerJs};
       const p = c && (c.post || (c.model && c.model.post));
       const rawLexical = p.get('lexical') || null;
       const tagsAttr = p.get('tags');
       const tags = tagsAttr && tagsAttr.map ? tagsAttr.map((t) => (t && t.get ? t.get('name') : String(t))) : [];
       return JSON.stringify({
         bodyEmpty: !rawLexical || !/"text"\\s*:/.test(rawLexical),
         excerpt: p.get('custom_excerpt') || null,
         customTemplate: p.get('custom_template') || null,
         title: p.get('title') || null,
         tags: tags,
         featureImage: p.get('feature_image') || null,
       });
     })()`,
    editor.sessionId,
  )) ?? '{}',
);
const finalPlan = JSON.parse(
  (await evaluate(
    `JSON.stringify(window.GCTIPlan.planPresetApplication(${JSON.stringify(preset)}, ${JSON.stringify(freshSnapshot)}, { templates: ['custom-review.hbs'] }))`,
    editor.sessionId,
  )) ?? '{}',
);
if (finalPlan.status !== 'ready') {
  fail(`the production planner refused the target draft: ${JSON.stringify(finalPlan.problems)}`);
}
const bridge = await sendPlan(finalPlan, editor.sessionId);
if (bridge.ok !== true || bridge.result?.saved !== true) {
  console.error('page console (last 25):', consoleLog.slice(-25).join('\n'));
  fail(`bridge apply failed: ${JSON.stringify(bridge)}`);
}
record('production MAIN-world bridge applied the imported preset with one native save', {
  saved: bridge.result.saved,
  resourceId: bridge.result.resourceId,
  fields: (finalPlan.actions ?? []).map((a) => a.field).sort(),
});

// B4 — authenticated readback of every imported field.
const reread = await api('GET', `posts/${targetPost.id}/?formats=lexical&include=tags`);
const applied = reread.posts[0];
const appliedTags = (applied.tags ?? []).map((t) => t.name).sort();
const appliedLexical = applied.lexical ?? '';
const sourceHasText = (appliedLexical.match(/"text"\s*:\s*"([^"]*)"/g) ?? []).length;
evidence.readback = {
  postId: targetPost.id,
  title: applied.title,
  titleUnchanged: applied.title === targetPost.title,
  customExcerpt: applied.custom_excerpt,
  customTemplate: applied.custom_template,
  featureImage: applied.feature_image,
  expectedFeatureImagePath: new URL(uploadedUrl).pathname,
  tags: appliedTags,
  bodyTextNodes: sourceHasText,
  bodyContainsImportedText: appliedLexical.includes('First paragraph of the imported post.'),
};
const readbackChecks = {
  excerptApplied: applied.custom_excerpt === 'An excerpt worth templating.',
  tagsApplied: JSON.stringify(appliedTags) === JSON.stringify(['Reviews', 'Software']),
  customTemplateApplied: applied.custom_template === 'custom-review.hbs',
  // The preset stores the portable `/content/…` path; Ghost resolves it to the
  // absolute URL of the very file uploaded for the source post.
  featureImageApplied:
    typeof applied.feature_image === 'string' &&
    new URL(applied.feature_image).pathname === new URL(uploadedUrl).pathname,
  bodyApplied: appliedLexical.includes('First paragraph of the imported post.'),
  titleUntouched: applied.title === targetPost.title,
};
evidence.readback.checks = readbackChecks;
const readbackFailures = Object.entries(readbackChecks)
  .filter(([, ok]) => ok !== true)
  .map(([name]) => name);
record('authenticated Admin API readback confirms every imported field', evidence.readback);
if (readbackFailures.length > 0) {
  fail(`readback checks failed: ${readbackFailures.join(', ')}`);
}

evidence.cookieOnWire = 'session cookie used for API calls; value never recorded';
evidence.verdict = 'PASS';

const md = [
  '# Post-import live proof (real Ghost + real Chromium)',
  '',
  `Verdict: **${evidence.verdict}**`,
  '',
  'Environment: Ghost 6.59 behind a local TLS proxy (`https://localhost:2443`), an unpacked MV3',
  'extension built from this tree, Chromium (headless=new), scripted over CDP. The capture modules',
  'and the planner are compiled from this tree with esbuild — the same source the extension ships.',
  'No cookie value, token, or credential appears below.',
  '',
  '## A. Capture (production capture code + real Ghost data)',
  '',
  '```json',
  JSON.stringify(evidence.capture, null, 2),
  '```',
  '',
  '## B. Apply (real store, real planner, real MAIN-world bridge)',
  '',
  '```json',
  JSON.stringify(
    {
      store: evidence.store,
      snapshot: evidence.snapshot,
      plan: { status: evidence.plan.status, fields: evidence.plan.fields },
      readback: evidence.readback,
    },
    null,
    2,
  ),
  '```',
  '',
  '## Steps',
  '',
  ...evidence.steps.map(
    (s) => `- **${s.step}**${s.detail === undefined ? '' : ` — \`${JSON.stringify(s.detail)}\``}`,
  ),
  '',
  '## Storage-level corroboration (run separately against the same instance)',
  '',
  '```bash',
  `docker exec ghost-local-mysql mysql -ughost -pghostpw ghost -e "select title, custom_excerpt, custom_template, feature_image from posts where id='${targetPost.id}'\\\\G"`,
  `docker exec ghost-local-mysql mysql -ughost -pghostpw ghost -e "select p.slug, t.name from posts p join posts_tags pt on pt.post_id=p.id join tags t on t.id=pt.tag_id where p.id='${targetPost.id}';"`,
  '```',
  '',
  '## Limitation recorded honestly',
  '',
  'The isolated content-script registration needs the optional host permission, which Chrome only',
  'grants through its native consent bubble (not reachable in headless automation). Phase B drives',
  'the production MAIN-world bundle with the exact plan the content script sends, and phase A runs',
  'the production capture code against the real API; the popup↔content-script plumbing is covered',
  'by the unit and integration suites rather than claimed here.',
  '',
].join('\n');
writeFileSync(path.join(OUT, 'post-import-live-proof.md'), md);

console.log(`\nverdict: ${evidence.verdict}`);
console.log(`evidence: ${path.join(OUT, 'post-import-live-proof.md')}`);

chromium.kill('SIGTERM');
process.exit(0);
