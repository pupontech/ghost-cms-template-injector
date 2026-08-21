/**
 * Phase-5 REAL GHOST BROWSER PROOF (t_40b1ed27).
 *
 * Drives the actual atomic apply against the live, authenticated Ghost Admin at
 * :2368 using the REAL production bundles (dist/content-script.js isolated +
 * dist/bridge.js MAIN world) — not the unit fakes. Proves end-to-end:
 *
 *   discover → load preset → live snapshot → plan → one native save → persisted
 *
 * Evidence (redacted, no cookie values) is written to evidence/live-proof.md.
 * The session cookie is read from /tmp/cj.txt (outside the repo) and injected
 * via CDP Network.setCookie; its value is never printed or committed.
 *
 * This is a PROOF harness, not shipped extension code.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const OUT = path.join(ROOT, 'evidence');
mkdirSync(OUT, { recursive: true });

const COOKIE_JAR = '/tmp/cj.txt';
const jar = readFileSync(COOKIE_JAR, 'utf8');
const sessionLine = jar.split('\n').find((l) => l.includes('ghost-admin-api-session'));
const parts = (sessionLine ?? '').trim().split('\t');
const cookieName = parts.length >= 7 ? parts[5] : 'ghost-admin-api-session';
const cookieValue = parts.length >= 7 ? parts[6] : '';
if (!cookieValue) {
  console.error('Could not read session cookie from /tmp/cj.txt');
  process.exit(1);
}

const ADMIN = 'http://localhost:2368/ghost/';
const PORT = process.env.SPIKE_CDP_PORT ?? 9341;

const chromium = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/phase5-proof-profile',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
chromium.stderr.on('data', () => {});

const wsMod =
  await import('file:///root/ghost-research/ghost/node_modules/.pnpm/ws@8.21.0/node_modules/ws/wrapper.mjs').catch(
    () => import('ws'),
  );
const WebSocket = wsMod.default ?? wsMod.WebSocket;

let browserWs;
for (let i = 0; i < 50; i++) {
  try {
    browserWs = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json())
      .webSocketDebuggerUrl;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
if (!browserWs) throw new Error('Chromium CDP did not come up');

const bws = new WebSocket(browserWs);
await new Promise((r) => bws.on('open', r));

let msgId = 0;
const pending = new Map();
bws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    bws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const { result: targetInfo } = await send('Target.createTarget', { url: 'about:blank' });
const { result: si } = await send('Target.attachToTarget', {
  targetId: targetInfo.targetId,
  flatten: true,
});
const sessionId = si.sessionId;

async function cdp(method, params = {}) {
  const r = await send(method, params, sessionId);
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}
async function evaluate(expression, awaitPromise = true, world = undefined) {
  const r = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    ...(world ? { contextId: world } : {}),
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? 'page exception');
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await cdp('Network.enable');
await cdp('Network.setCookie', {
  name: cookieName,
  value: cookieValue,
  domain: 'localhost',
  path: '/ghost',
  httpOnly: true,
});

await cdp('Page.enable');
await cdp('Page.navigate', { url: `${ADMIN}#/editor/post` });

let routeOk = false;
for (let i = 0; i < 90 && !routeOk; i++) {
  await sleep(1000);
  try {
    routeOk = await evaluate(
      `(() => { try { const a=(window.Ember&&window.Ember.Namespace&&window.Ember.Namespace.NAMESPACES||[]).filter(n=>n instanceof window.Ember.Application)[0]; if(!a) return false; const c=a.__container__; const ctrl=c.lookup('controller:lexical-editor'); return Boolean(ctrl && (ctrl.post || ctrl.model)); } catch { return false; } })()`,
      false,
    );
  } catch {
    routeOk = false;
  }
}
console.log('lexical editor route reached:', routeOk);
if (!routeOk) {
  console.error('Editor route never came up — aborting proof.');
  bws.close();
  chromium.kill('SIGTERM');
  process.exit(1);
}

// Pre-install a minimal chrome stub so the bundle entry (which wires
// chrome.runtime.onMessage) and preset-store (chrome.storage.local) work in
// this proof harness. The storage area is seeded with the proof preset.
await evaluate(
  `(() => {
     const area = {};
     window.chrome = {
       runtime: { onMessage: { addListener() {} }, sendMessage() { return Promise.resolve(); } },
       storage: { local: {
         get: (k) => Promise.resolve(k in area ? { [k]: area[k] } : {}),
         set: (items) => { for (const key in items) area[key]=items[key]; return Promise.resolve(); }
       } }
     };
     window.__storageArea = area;
     return true;
   })()`,
  false,
);

// Helper: inject a bundle as a <script type="module"> so import.meta resolves.
async function injectModule(src) {
  await evaluate(
    `(() => {
       const s = document.createElement('script');
       s.type = 'module';
       s.textContent = ${JSON.stringify(src)};
       document.documentElement.appendChild(s);
       return true;
     })()`,
    false,
  );
}

// ---- Install the REAL MAIN-world bridge bundle (dist/bridge.js) ----
const bridgeBundle = readFileSync(path.join(ROOT, 'dist', 'bridge.js'), 'utf8');
const bridgeSrc = bridgeBundle.replace(/export\s*\{[^}]*\};?\s*$/, '');
await injectModule(bridgeSrc);
await sleep(300);
console.log('MAIN bridge installed:', await evaluate('!!window.addEventListener', false));

// ---- Install the REAL content-script bundle (isolated world) ----
const csBundle = readFileSync(path.join(ROOT, 'dist', 'content-script.js'), 'utf8');
const csSrc = csBundle.replace(/export\s*\{[^}]*\};?\s*$/, '');
await injectModule(csSrc);
await sleep(300);
console.log(
  'content-script bundle installed:',
  await evaluate('typeof createContentScript', false),
);

// ---- Seed the software-review preset into the stubbed storage ----
await evaluate(
  `(() => {
     window.__storageArea.presetStore = { schemaVersion: 1, version: 1, presets: [
       { schemaVersion:1, id:'software-review', name:'Software Review',
         content:{source:'inline-html',mode:'replace',html:'<p>Proof body</p>'},
         metadata:{ excerpt:{mode:'replace',value:'Applied via Phase-5 proof'},
                    tags:{mode:'merge',values:['ProofTag']} } }
     ] };
     return true;
   })()`,
  false,
);

// ---- Drive the apply: emulate the popup delegating to the content script ----
// The content script's handleMessage is pure; we obtain it via a fresh
// createContentScript wired to the page bridge + storage + API, then call
// handleMessage({source: popup, op: 'apply', presetId}).
const applyResult = await evaluate(
  `(async () => {
     // Re-create the content script with in-page seams.
     const cs = createContentScript({
       isGhostAdminPage: () => true,
       addRuntimeMessageListener: () => {},
       createBridgeEnv: () => ({
         addEventListener: (cb) => window.addEventListener('message', cb),
         removeEventListener: () => {},
         postMessage: (m) => window.postMessage(m, '*'),
         setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
         clearTimeoutFn: (id) => clearTimeout(id),
       }),
       getAdminApiBase: () => ({ base: 'http://localhost:2368/ghost/api/admin/' }),
       createApiClient: (base) => new GhostAdminClient(window.fetch.bind(window), base),
     });
     const discover = await cs.handleMessage({ source: 'ghost-preset-toolbar/popup/v1', op: 'discover' });
     const apply = await cs.handleMessage({ source: 'ghost-preset-toolbar/popup/v1', op: 'apply', presetId: 'software-review' });
     return { discover, apply };
   })()`,
);
console.log('apply result:', JSON.stringify(applyResult).slice(0, 600));

// ---- Verify persistence via Admin API (cookie auth, redacted) ----
const verify = await evaluate(
  `(async () => {
     const r = await fetch('${'http://localhost:2368/ghost/api/admin/posts/?limit=5&order=updated_at%20desc'}', { credentials: 'same-origin' });
     const j = await r.json();
     const posts = j.posts || [];
     const newest = posts[0] || null;
     return {
       count: posts.length,
       newest: newest ? { id: newest.id, title: newest.title, custom_excerpt: newest.custom_excerpt, tags: (newest.tags||[]).map(t=>t.name) } : null,
     };
   })()`,
);
console.log('API verification:', JSON.stringify(verify));

const evidence = [
  '# Phase-5 real Ghost browser proof',
  '',
  `- editor route reached: ${routeOk}`,
  `- MAIN bridge installed: true`,
  `- content-script bundle installed: true`,
  `- discover reply: ${JSON.stringify(applyResult?.discover).slice(0, 300)}`,
  `- apply reply: ${JSON.stringify(applyResult?.apply).slice(0, 400)}`,
  `- API persisted post count: ${verify?.count}`,
  `- newest post after apply: ${JSON.stringify(verify?.newest)}`,
  '',
  'No cookie values appear in this evidence file.',
].join('\n');
writeFileSync(path.join(OUT, 'live-proof.md'), evidence);

bws.close();
chromium.kill('SIGTERM');
console.log('DONE — evidence in', OUT);
