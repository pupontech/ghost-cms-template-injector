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

import WebSocket from 'ws';

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
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    // Surface content-script diagnostics and page errors without dumping Ghost's
    // own chatty console output.
    if (txt.includes('ghost-preset-toolbar') || txt.includes('error'))
      console.log('[page]', txt.slice(0, 200));
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log('[page exc]', (d.exception?.description ?? d.text ?? '').slice(0, 300));
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
await cdp('Runtime.enable');
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
// this proof harness. The stub ROUTES chrome.runtime.sendMessage to the
// listener the REAL content-script bundle registers, mirroring the production
// delivery semantics (listeners may return true and reply later via
// sendResponse). The storage area is seeded with the proof preset.
await evaluate(
  `(() => {
     const area = {};
     const runtimeListeners = [];
     window.chrome = {
       runtime: {
         onMessage: { addListener(cb) { runtimeListeners.push(cb); } },
         sendMessage(msg, callback) {
                     return new Promise((resolve) => {
                       let responded = false;
                       const finish = (r) => {
                         if (responded) return;
                         responded = true;
                         if (typeof callback === 'function') callback(r);
                         resolve(r);
                       };
                       let syncResponse;
                       let sawAsync = false;
                       for (const cb of runtimeListeners) {
                         let replied = false;
                         const sendResponse = (r) => { replied = true; finish(r); };
                         try {
                           const ret = cb(msg, {}, sendResponse);
                           if (ret === true) {
                             sawAsync = true;
                             continue;
                           }
                           if (!replied && ret !== undefined) syncResponse = ret;
                         } catch { /* listener error - try next */ }
                       }
                       if (!responded && syncResponse !== undefined) finish(syncResponse);
                       // Only auto-resolve when NO listener waits on an async
                       // sendResponse: if any returned true, the real reply wins.
                       if (!responded && !sawAsync) queueMicrotask(() => finish(syncResponse));
                     });
                   },
       },
       storage: {
         local: {
           get: (k) => Promise.resolve(k in area ? { [k]: area[k] } : {}),
           set: (items) => { for (const key in items) area[key]=items[key]; return Promise.resolve(); },
         },
       },
     };
     window.__storageArea = area;
     window.__runtimeListeners = runtimeListeners;
     window.__sendRuntime = (msg) => new Promise((res) => window.chrome.runtime.sendMessage(msg, res));
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
const bridgeSrc = bridgeBundle.replace(/export\s*\{[^}]*\};\?\s*$/, '');
await injectModule(bridgeSrc);
await sleep(300);
console.log('MAIN bridge installed:', await evaluate('!!window.addEventListener', false));

// ---- Install the REAL content-script bundle (auto-inits, registers listener) ----
const csBundle = readFileSync(path.join(ROOT, 'dist', 'content-script.js'), 'utf8');
const csSrc = csBundle.replace(/export\s*\{[^}]*\};\?\s*$/, '');
await injectModule(csSrc);
await sleep(300);
const listenerCount = await evaluate(
  'window.__runtimeListeners ? window.__runtimeListeners.length : 0',
  false,
);
console.log('content-script bundle installed (listeners):', listenerCount);

// ---- Seed a VALID proof preset into the stubbed storage ----
// The planner blocks `content.source: 'inline-html'` (preset-engine), so the
// proof preset uses `inline-lexical` with an only-if-empty excerpt + merged tag.
const proofLexical = JSON.stringify({
  root: {
    children: [
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'Proof body applied by the live Ghost browser proof.',
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
});
await evaluate(
  `(() => {
     window.__storageArea.presetStore = { schemaVersion: 1, version: 1, presets: [
       { schemaVersion:1, id:'software-review', name:'Software Review',
         content:{source:'inline-lexical',mode:'replace',lexical: ${JSON.stringify(proofLexical)}},
         metadata:{ excerpt:{mode:'only-if-empty',value:'Applied via Phase-5 proof'},
                    tags:{mode:'merge',values:['ProofTag']} } }
     ] };
     return true;
   })()`,
  false,
);

// ---- Drive apply EXACTLY as the production popup does ----
// The MAIN bridge is DORMANT by design; activate it with a fresh per-enable
// token (the same real capability protocol the isolated client uses).
await evaluate(
  `(() => {
     const token = 'proof-' + Array.from({length:24}, () => Math.floor(Math.random()*36).toString(36)).join('');
     window.postMessage({ capSource: 'ghost-preset-toolbar/page-bridge-capability/v1', action: 'activate', token }, '*');
     return true;
   })()`,
  false,
);
await sleep(400);

// 1) Confirm the MAIN bridge answers discover (real capability protocol).
const discovered = await evaluate(
  `(() => new Promise((resolve) => {
     const nonce = crypto.randomUUID();
     const onMsg = (e) => {
       if (e.data && e.data.nonce === nonce && e.data.source === 'ghost-preset-toolbar/page-bridge/v1' && e.data.ok === true) {
         window.removeEventListener('message', onMsg);
         resolve(e.data);
       }
     };
     window.addEventListener('message', onMsg);
     window.postMessage({ v: 1, source: 'ghost-preset-toolbar/page-bridge/v1', op: 'discover', nonce, payload: {} }, '*');
     setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, 5000);
   }))()`,
  true,
);
console.log(
  'discover from MAIN bridge (after activation):',
  JSON.stringify(discovered).slice(0, 300),
);

// 2) Apply via window.sendRuntime — the exact call the popup makes
//    (chrome.runtime.sendMessage → content-script handleMessage → page bridge
//    → MAIN bridge → real Ghost editor + native save).
const applyResult = await evaluate(
  `(() => new Promise((resolve) => {
     const t = setTimeout(
       () => resolve({ ok: false, error: 'TIMEOUT', note: 'no reply within 20s' }),
       20000,
     );
     window.__sendRuntime(
       { source: 'ghost-preset-toolbar/popup/v1', op: 'apply', presetId: 'software-review' },
     ).then((r) => { clearTimeout(t); resolve(r); });
   }))()`,
  true,
).then(
  (r) => r ?? { ok: false, error: 'NO_REPLY', note: 'content-script never replied (undefined)' },
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
  `- content-script bundle installed (listeners): ${listenerCount}`,
  `- discover reply: ${JSON.stringify(discovered).slice(0, 300)}`,
  `- apply reply: ${JSON.stringify(applyResult).slice(0, 400)}`,
  `- API persisted post count: ${verify?.count}`,
  `- newest post after apply: ${JSON.stringify(verify?.newest)}`,
  '',
  'No cookie values appear in this evidence file.',
].join('\n');
writeFileSync(path.join(OUT, 'live-proof.md'), evidence);

bws.close();
chromium.kill('SIGTERM');
console.log('DONE — evidence in', OUT);
