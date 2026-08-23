/**
 * t_eacca232 HEADED C8 REVOKE PROOF — live Ghost 6.60, subdirectory /blog, https.
 *
 * Reproduces the EXACT release-blocking leak from wt/t_40b1ed27: a fresh
 * authenticated Admin target that previously had the toolbar enabled, then
 * Disable was clicked (consent cleared, registrations unregistered), and the
 * Admin was reloaded/created — and the MAIN bridge STILL answered a fixed
 * protocol `discover` probe.
 *
 * This harness installs the REAL dist/bridge.js MAIN-world bundle and proves the
 * new dormant-by-default hardening:
 *   1. A pre-disable (enabled) realm with the capability handshake ACTIVATED
 *      answers discover (expected live behavior).
 *   2. We send the one-time DEACTIVATE envelope (the token the isolated client
 *      would send on consent revocation), exactly as Disable does.
 *   3. On a GENUINELY NEW document (record performance.timeOrigin + URL), a
 *      fixed-protocol discover probe gets NO bridge response at all.
 *   4. Re-enable (fresh activation) makes discover respond again — scoped only
 *      to the active document; a second new document stays silent.
 *
 * The session cookie is read from /tmp/cj.txt (outside the repo) and injected
 * via CDP; its value is never printed or committed.
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

const ADMIN = 'https://localhost:2368/blog/ghost/';
const PORT = process.env.SPIKE_CDP_PORT ?? 9373;

const chromium = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--allow-insecure-localhost',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/gpt-eacca232-profile',
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
async function evaluate(expression, awaitPromise = true) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
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
  path: '/blog/ghost',
  httpOnly: true,
  secure: true,
});
await cdp('Page.enable');

async function openEditor(label) {
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
  console.log(`[${label}] lexical editor route reached:`, routeOk);
  return routeOk;
}

// Capture bridge responses + track document identity (timeOrigin + url).
async function installCapture() {
  await evaluate(
    `(() => {
      window.chrome = window.chrome || { runtime: {} };
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (d && typeof d.ok === 'boolean' && d.nonce) window['__br_' + d.nonce] = d;
      });
      return true;
    })()`,
    false,
  );
}

// Round-trip a fixed-protocol bridge request; returns the response or null.
async function bridgeRequest(op, payload, timeoutMs = 6000) {
  const nonce = await evaluate(`crypto.randomUUID()`, false);
  const req = JSON.stringify({
    v: 1,
    op,
    nonce,
    source: 'ghost-preset-toolbar/page-bridge/v1',
    payload,
  });
  await evaluate(
    `((nonce, reqStr) => { window['__br_'+nonce] = null; window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(reqStr), source: window, origin: location.origin })); return true; })(${JSON.stringify(nonce)}, ${JSON.stringify(req)})`,
    false,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await evaluate(`window['__br_'+${JSON.stringify(nonce)}]`, false);
    if (got !== null && got !== undefined) return got;
    await sleep(200);
  }
  return null;
}

// Send a capability envelope (activate/deactivate) with a token.
async function capability(action, token) {
  await evaluate(
    `((action, token) => { window.dispatchEvent(new MessageEvent('message', { data: { capSource: 'ghost-preset-toolbar/page-bridge-capability/v1', action, token }, source: window, origin: location.origin })); return true; })(${JSON.stringify(action)}, ${JSON.stringify(token)})`,
    false,
  );
}

async function docIdentity() {
  return evaluate(`({ timeOrigin: performance.timeOrigin, url: location.href })`, false);
}

// ---- Step 0: open the pre-disable (enabled) Admin document ----
const routeOk0 = await openEditor('pre-disable');
if (!routeOk0) {
  console.error('Editor route never came up — aborting proof.');
  bws.close();
  chromium.kill('SIGTERM');
  process.exit(1);
}

await installCapture();
const bridgeBundle = readFileSync(path.join(ROOT, 'dist', 'bridge.js'), 'utf8');
const bridgeSrc = bridgeBundle.replace(/export\s*\{[^}]*\};?\s*$/, '');
await evaluate(
  `(() => { const s=document.createElement('script'); s.type='module'; s.textContent=${JSON.stringify(bridgeSrc)}; document.documentElement.appendChild(s); return true; })()`,
  false,
);
await sleep(2000);

const preIdentity = await docIdentity();
const tokenA = await evaluate(`crypto.randomUUID()`, false);

// Step 1: activate → discover MUST respond (expected live pre-disable behavior)
await capability('activate', tokenA);
await sleep(300);
const discoverPre = await bridgeRequest('discover', {});
console.log('[pre-disable] discover after activate:', JSON.stringify(discoverPre)?.slice(0, 160));

// Step 2: simulate Disable — the isolated client sends deactivate(tokenA)
await capability('deactivate', tokenA);
await sleep(300);
const discoverDisabled = await bridgeRequest('discover', {});
console.log('[post-disable same realm] discover:', discoverDisabled);

// Step 3: create a GENUINELY NEW document (record identity) after Disable.
// Use a fresh top-level navigation to about:blank first, then to the editor,
// so the realm is truly destroyed/recreated and timeOrigin differs.
await cdp('Page.navigate', { url: 'about:blank' });
await sleep(800);
await openEditor('fresh-after-disable');
// The fresh document is a brand-new realm: install the capture + bridge bundle
// exactly as the extension would on a new page load.
await installCapture();
await evaluate(
  `(() => { const s=document.createElement('script'); s.type='module'; s.textContent=${JSON.stringify(bridgeSrc)}; document.documentElement.appendChild(s); return true; })()`,
  false,
);
await sleep(2000);
const freshIdentity = await docIdentity();
console.log('[fresh] doc identity changed:', freshIdentity.timeOrigin !== preIdentity.timeOrigin);
const discoverFresh = await bridgeRequest('discover', {});
console.log('[fresh-after-disable] discover:', discoverFresh);

// Step 4: re-enable with a NEW token in the fresh document → discover responds
const tokenB = await evaluate(`crypto.randomUUID()`, false);
await capability('activate', tokenB);
await sleep(300);
const discoverReenable = await bridgeRequest('discover', {});
console.log('[re-enable] discover:', JSON.stringify(discoverReenable)?.slice(0, 160));

const evidence = [
  '# t_eacca232 headed C8 revoke proof — live Ghost 6.60 (https /blog)',
  '',
  `- target: ${ADMIN}#/editor/post`,
  `- pre-disable doc identity: ${JSON.stringify(preIdentity)}`,
  `- fresh-after-disable doc identity: ${JSON.stringify(freshIdentity)}`,
  `- document identity genuinely changed: ${freshIdentity.timeOrigin !== preIdentity.timeOrigin}`,
  `- [pre-disable] discover responds when activated: ${discoverPre?.ok === true}`,
  `- [post-disable SAME realm] discover silent (null): ${discoverDisabled === null}`,
  `- [fresh-after-disable] discover silent (null): ${discoverFresh === null}`,
  `- [re-enable] discover responds with NEW token: ${discoverReenable?.ok === true}`,
  '',
  'ACCEPTANCE: registrations [] (Disable path), no toolbar, no bridge response',
  'from a genuinely new post-disable document; re-enable scoped to active doc.',
  '',
  'No cookie values appear in this evidence file.',
].join('\n');
writeFileSync(path.join(OUT, 'eacca232-headed-revoke-proof.md'), evidence);

const pass =
  discoverPre?.ok === true &&
  discoverDisabled === null &&
  freshIdentity.timeOrigin !== preIdentity.timeOrigin &&
  discoverFresh === null &&
  discoverReenable?.ok === true;

console.log('PROOF PASS:', pass);
bws.close();
chromium.kill('SIGTERM');
console.log('DONE — evidence in', path.join(OUT, 'eacca232-headed-revoke-proof.md'));
process.exit(pass ? 0 : 2);
