/**
 * Focused headless mount proof for the t_f2218c98 content-script fix.
 *
 * Loads the REAL production bundle dist/toolbar.js the way a dynamically
 * registered isolated-world content script would run it (classic <script>,
 * with a chrome.storage.local + chrome.runtime stub), against a simulated
 * Ghost Admin editor URL (https://localhost:2368/blog/ghost/#/editor/post).
 * It captures console errors/page exceptions and asserts:
 *   1. no `Failed to fetch` / TypeError while the toolbar loads presets;
 *   2. the toolbar actually mounts: a [data-gpt-toolbar="1"] element exists.
 *
 * This is the exact failure mode from the release matrix (toolbar never
 * mounted, console showed `TypeError: Failed to fetch` from toolbar bootstrap).
 * It does NOT exercise the apply/persistence matrix — that is the dedicated
 * headed rerun's scope. Proof only, not shipped extension code.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const PORT = process.env.SPIKE_CDP_PORT ?? 9351;

import WebSocket from 'ws';

const chromium = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--allow-insecure-localhost',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/gpt-mount-profile',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
chromium.stderr.on('data', () => {});

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
async function evaluate(expression, awaitPromise = true) {
  const r = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? 'page exception');
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed a Ghost Admin editor page; the toolbar bootstrap reads location.pathname
// (/blog/ghost/) and location.hash (#/editor/post) and mounts on editor routes.
await cdp('Page.enable');
await cdp('Page.navigate', {
  url: 'https://localhost:2368/blog/ghost/#/editor/post',
});
await sleep(400);

// Capture console + page errors (this is where the old `TypeError: Failed to
// fetch` surfaced from toolbar.js).
const consoleErrors = [];
await cdp('Runtime.enable');
await send('Runtime.addBinding', { name: '__gptCapture', sessionId }, sessionId);
bws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') {
    const text =
      m.method === 'Runtime.exceptionThrown'
        ? (m.params.exceptionDetails?.exception?.description ??
          m.params.exceptionDetails?.text ??
          'exception')
        : (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/error|fail|exception/i.test(String(text)) || m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(String(text));
    }
  }
});

// Install a chrome runtime/storage stub on the page BEFORE loading the bundle,
// so the toolbar's browser bootstrap can run listPresets() from the inlined
// seed (no extension-resource fetch required).
await evaluate(`(() => {
  const area = {};
  window.chrome = {
    storage: { local: {
      get: (k) => Promise.resolve(k in area ? { [k]: area[k] } : {}),
      set: (items) => { for (const key in items) area[key] = items[key]; return Promise.resolve(); }
    } },
    runtime: { sendMessage: () => Promise.resolve() }
  };
  return true;
})()`);

// Inject the REAL production toolbar bundle as a classic script (content-script
// runtime). Strip only the trailing esbuild export footer; everything else runs
// exactly as the registered content script would.
const toolbarBundle = readFileSync(path.join(ROOT, 'dist', 'toolbar.js'), 'utf8');
const stripped = toolbarBundle.replace(/export\s*\{[^}]*\};?\s*$/, '');
await evaluate(
  `(() => {
     const s = document.createElement('script');
     s.textContent = ${JSON.stringify(stripped)};
     document.documentElement.appendChild(s);
     return true;
   })()`,
);

// Wait for async initToolbar -> sync -> mount to settle.
let mounted = false;
for (let i = 0; i < 50 && !mounted; i++) {
  await sleep(100);
  mounted = await evaluate(`!!document.querySelector('[data-gpt-toolbar="1"]')`, false);
}

const failedToFetch = consoleErrors.some((e) => /failed to fetch|typeerror/i.test(e));

console.log('--- toolbar mount proof ---');
console.log('toolbar mounted [data-gpt-toolbar="1"]:', mounted);
console.log('console/page errors captured:', consoleErrors.length);
for (const e of consoleErrors.slice(0, 8)) console.log('   !', e.split('\n')[0]);
console.log('contains "Failed to fetch":', failedToFetch);

bws.close();
chromium.kill('SIGTERM');

if (!mounted || failedToFetch) {
  console.error('PROF FAIL: toolbar did not mount cleanly (release blocker not fixed).');
  process.exit(1);
}
console.log('PROF OK: toolbar mounted on real bundle with no fetch exception.');
process.exit(0);
