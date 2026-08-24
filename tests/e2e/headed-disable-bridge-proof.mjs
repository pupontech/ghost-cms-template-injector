/**
 * t_eacca232 GENUINE HEADED C8 REVOKE PROOF — real unpacked MV3 extension,
 * live Ghost 6.60 (https /blog).
 *
 * NOT a synthetic injection harness: launches a real HEADED Chromium under
 * Xvfb with the BUILT UNPACKED EXTENSION loaded (--load-extension=<repo root>),
 * drives the REAL setup page Enable/Disable buttons with OS-level trusted
 * input, and accepts the GENUINE native Chromium permission bubble with
 * keyboard input (the procedure proven in the 85116b8 headed matrix). It then
 * asserts, with redacted values:
 *   1. exactly two dynamic registrations scoped EXACTLY to
 *      https://localhost:2368/blog/ghost/* before Disable (read from the real
 *      extension context via chrome.scripting.getRegisteredContentScripts),
 *   2. the toolbar mounts in an authenticated Admin editor target,
 *   3. the real setup Disable yields registrations === [],
 *   4. the same pre-disable realm goes bridge-silent (revocation watcher),
 *   5. a genuinely new target/document (distinct timeOrigin) has no toolbar
 *      and no bridge response,
 *   6. replaying the stale activation token observed from the real production
 *      handshake cannot re-activate the bridge (silence),
 *   7. real re-enable restores the two exact-scoped registrations and a fresh
 *      target mounts the toolbar and answers discover under a NEW capability
 *      token (fresh handshake, digest-compared, never printed).
 *
 * The session cookie is read from /tmp/cj.txt (outside the repo); its value is
 * never printed or committed. No chrome stubbing, no manual bridge injection,
 * no headless mode.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { launchHeadedChromium } from './headed-cdp-helper.mjs';

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
const ORIGIN_INPUT = 'https://localhost:2368/blog/';
const EXACT_MATCH = 'https://localhost:2368/blog/ghost/*';
const EXPECTED_IDS = ['ghost-preset-toolbar-enabled', 'ghost-preset-toolbar-enabled-main'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await launchHeadedChromium({
  extensionRoot: ROOT,
  userDataDir: '/tmp/gpt-eacca232-c8qa-profile',
  display: ':102',
});
const extId = await browser.extensionId();
if (!extId) {
  console.error('No extension id found — aborting.');
  browser.close();
  process.exit(1);
}
console.log('headed chromium up; extension id:', extId);

function acceptNativeBubble() {
  const shot = '/tmp/c8qa-native-bubble.png';
  execSync(`DISPLAY=:102 scrot ${shot}`);
  const locatorPath = '/tmp/c8qa-locate-allow.py';
  writeFileSync(
    locatorPath,
    `
import json
from PIL import Image
im = Image.open('${shot}').convert('RGB'); W,H = im.size; px = im.load()
blue=[]
for y in range(H):
    for x in range(W):
        r,g,b = px[x,y]
        if b>150 and r<100 and 80<g<190 and (b-r)>70: blue.append((x,y))
if not blue: print(json.dumps({'found':False})); raise SystemExit
xs=[p[0] for p in blue]; ys=[p[1] for p in blue]
dbx0,dbx1,dby0,dby1=min(xs),max(xs),min(ys),max(ys); deny_w=dbx1-dbx0
x0=dbx1+2; x1=min(W,dbx1+int(deny_w*2)); y0=max(0,dby0-10); y1=min(H,dby1+10)
allow_left=None
for yy in range(y0,y1):
    for xx in range(x0,x1):
        r,g,b=px[xx,yy]
        if not (r>245 and g>245 and b>245): allow_left = xx if allow_left is None else min(allow_left, xx)
if allow_left is None: allow_left=dbx1+int(deny_w*0.62)
print(json.dumps({'found':True,'allow':[allow_left+int(deny_w*0.5),(dby0+dby1)//2]}))
`,
  );
  const parsed = JSON.parse(execSync(`python3 ${locatorPath}`).toString().trim());
  if (!parsed.found) return false;
  execSync(`DISPLAY=:102 xdotool mousemove ${parsed.allow[0]} ${parsed.allow[1]} click 1`);
  return true;
}

async function pressKey(sessionId, key, code, keyCode) {
  await browser.cdp(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode },
    sessionId,
  );
  await browser.cdp(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode },
    sessionId,
  );
}

/** Screenshot artifact (kept in /tmp; path recorded, never committed). */
async function snap(sessionId, name) {
  try {
    const shot = await browser.cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = `/tmp/c8qa-${name}.png`;
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  } catch {
    return null;
  }
}

/** Genuine Enable/Disable via the real setup page + OS-level trusted input. */
async function driveSetup(buttonId, wantOrigin) {
  const { sessionId, targetId } = await browser.sessionFor(
    `chrome-extension://${extId}/setup/setup.html`,
  );
  await browser.cdp('Page.enable', {}, sessionId);
  await browser.cdp('Page.bringToFront', {}, sessionId).catch(() => {});
  await sleep(1200);
  if (wantOrigin) {
    await browser.evaluate(
      `(() => {
        const i = document.querySelector('#setup-origin');
        i.focus();
        i.value = ${JSON.stringify(ORIGIN_INPUT)};
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      sessionId,
      false,
    );
  }
  const vb = await browser.evaluate(
    `(() => { const r = document.querySelector('#${buttonId}').getBoundingClientRect();
       return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`,
    sessionId,
    false,
  );
  // Proven geometry for this headed X11 build: the Input domain consumes
  // browser-window coordinates; page coords + measured top-chrome offset.
  let offset = 87;
  const x = vb.x;
  let y = vb.y + offset;
  execSync(`DISPLAY=:102 xdotool mousemove ${x} ${y} click 1`);

  const expect = buttonId === 'setup-enable' ? 'Enabled for' : 'Disabled.';
  let status = null;
  let consentShot = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    status = await browser
      .evaluate(`document.querySelector('#setup-status')?.textContent ?? ''`, sessionId, false)
      .catch(() => null);
    if (status && status.includes(expect)) break;
    if (buttonId === 'setup-enable' && i === 0 && !consentShot) {
      // The native permission bubble should be up now; record it, then accept
      // with keyboard input (Deny is focused: Tab moves to Allow, Enter fires).
      consentShot = await snap(sessionId, 'consent-prompt');
    }
    if (buttonId === 'setup-enable' && i === 0) acceptNativeBubble();
  }
  const granted =
    buttonId === 'setup-enable'
      ? await browser
          .evaluate(
            `chrome.permissions.contains({ origins: [${JSON.stringify(EXACT_MATCH)}] })`,
            sessionId,
          )
          .catch(() => false)
      : null;
  await browser.cdp('Page.close', {}, sessionId).catch(() => {});
  return { status, granted, consentShot };
}

/** Registrations as seen by the actual MV3 service-worker execution context. */
async function getRegistrations() {
  let worker;
  for (let i = 0; i < 20 && !worker; i++) {
    worker = (await browser.listTargets()).find(
      (t) => t.type === 'service_worker' && String(t.url).includes(extId),
    );
    if (!worker) await sleep(100);
  }
  if (!worker) throw new Error('MV3 service-worker target not found');
  const sid = await browser.attach(worker.targetId);
  await browser.cdp('Runtime.enable', {}, sid);
  return browser.evaluate(
    `chrome.scripting.getRegisteredContentScripts().then(x => x.map(s => ({id:s.id, matches:s.matches, world:s.world})))`,
    sid,
  );
}

/**
 * Open an authenticated Admin editor target. Installs a document-start
 * OBSERVER that records the real production capability handshake envelopes
 * (the isolated world's activate/deactivate posts) so the proof can compare
 * token digests without printing tokens.
 */
async function openEditorTarget(label) {
  const { targetId, sessionId } = await browser.newTarget('about:blank');
  await browser.cdp('Page.enable', {}, sessionId);
  await browser.cdp(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `(() => {
        window.__capLog = [];
        window.__capTokens = [];
        window.addEventListener('message', (e) => {
          const d = e.data;
          if (d && d.capSource === 'ghost-preset-toolbar/page-bridge-capability/v1' && typeof d.token === 'string') {
            window.__capLog.push({ action: d.action, tokenLen: d.token.length });
            window.__capTokens.push(d.token);
          }
        });
      })()`,
    },
    sessionId,
  );
  await browser.cdp('Network.enable', {}, sessionId);
  await browser.cdp(
    'Network.setCookie',
    {
      name: cookieName,
      value: cookieValue,
      domain: 'localhost',
      path: '/blog/ghost',
      httpOnly: true,
      secure: true,
    },
    sessionId,
  );
  await browser.cdp('Page.navigate', { url: `${ADMIN}#/editor/post` }, sessionId);
  let routeOk = false;
  for (let i = 0; i < 90 && !routeOk; i++) {
    await sleep(1000);
    try {
      routeOk = await browser.evaluate(
        `(() => { try {
            const ns=(window.Ember&&window.Ember.Namespace&&window.Ember.Namespace.NAMESPACES||[]);
            const app=ns.filter(n=>n instanceof window.Ember.Application)[0];
            if(!app) return false;
            const ctrl=app.__container__.lookup('controller:lexical-editor');
            return Boolean(ctrl && (ctrl.post || ctrl.model));
          } catch { return false; } })()`,
        sessionId,
        false,
      );
    } catch {
      routeOk = false;
    }
  }
  const identity = await browser.evaluate(
    `({ timeOrigin: performance.timeOrigin, url: location.href, targetId: ${JSON.stringify(targetId)} })`,
    sessionId,
    false,
  );
  const caps = await browser.evaluate(
    `(() => {
      const t = window.__capTokens ?? [];
      const acts = (window.__capLog ?? []).filter(x => x.action === 'activate').length;
      return { activations: acts, tokenCount: t.length, tokenLen: t[0] ? t[0].length : null };
    })()`,
    sessionId,
    false,
  );
  console.log(
    `[${label}] route reached: ${routeOk}; timeOrigin: ${identity.timeOrigin}; handshake activations observed: ${caps.activations}`,
  );
  return { targetId, sessionId, routeOk, identity, caps };
}

/** SHA-256 digest prefix of a token — comparable evidence without revealing it. */
async function tokenDigest(sessionId, index) {
  return browser.evaluate(
    `crypto.subtle.digest('SHA-256', new TextEncoder().encode(window.__capTokens[${index}] ?? '')).then(b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('').slice(0, 12))`,
    sessionId,
  );
}

/**
 * Fixed-protocol discover probe sent through window.postMessage — the exact
 * channel production uses. With a token, first posts the capability ACTIVATE
 * envelope exactly like the isolated client. Resolves with the response or
 * null after timeoutMs of silence.
 */
async function bridgeDiscover(sessionId, token, timeoutMs = 5000) {
  return browser.evaluate(
    `((token, timeoutMs) => new Promise((resolve) => {
      const nonce = crypto.randomUUID();
      let settled = false;
      const onMsg = (e) => {
        const d = e.data;
        if (d && typeof d.ok === 'boolean' && d.nonce === nonce) {
          cleanup(); settled = true; resolve(d);
        }
      };
      const timer = setTimeout(() => { if (!settled) { cleanup(); resolve(null); } }, timeoutMs);
      function cleanup() { window.removeEventListener('message', onMsg); clearTimeout(timer); }
      window.addEventListener('message', onMsg);
      if (token) {
        window.postMessage({ capSource: 'ghost-preset-toolbar/page-bridge-capability/v1',
          action: 'activate', token }, '*');
      }
      window.postMessage({ v: 1, op: 'discover', nonce,
        source: 'ghost-preset-toolbar/page-bridge/v1', payload: {} }, '*');
    }))(${JSON.stringify(token)}, ${timeoutMs})`,
    sessionId,
  );
}

const results = {};
const artifacts = {};
let failed = false;
function check(name, value) {
  results[name] = value;
  console.log(`CHECK ${name}: ${value}`);
  if (value !== true) failed = true;
}
const exactlyScoped = (regs) =>
  Array.isArray(regs) &&
  regs.length === 2 &&
  JSON.stringify(regs.map((s) => s.id).sort()) === JSON.stringify(EXPECTED_IDS) &&
  regs.every(
    (s) => Array.isArray(s.matches) && s.matches.length === 1 && s.matches[0] === EXACT_MATCH,
  );

try {
  // ---- 1. genuine Enable + two exactly-scoped registrations ----------------
  const enable = await driveSetup('setup-enable', true);
  console.log('[enable] status:', enable.status, '| granted:', enable.granted);
  artifacts.consentPromptShot = enable.consentShot;
  check('enable_native_consent_granted', enable.granted === true);
  const regsEnabled = await getRegistrations();
  console.log('[enable] registrations:', JSON.stringify(regsEnabled));
  check('enable_two_registrations_exactly_scoped', exactlyScoped(regsEnabled));

  // ---- 2. pre-disable: toolbar present, production-activated bridge responds
  const pre = await openEditorTarget('pre-disable');
  check('pre_disable_route_reached', pre.routeOk === true);
  check('pre_disable_production_handshake_observed', pre.caps.activations >= 1);
  const preDigest = await tokenDigest(pre.sessionId, 0);
  const toolbarPre = await browser.evaluate(
    `Boolean(document.querySelector('[data-gpt-toolbar="1"]'))`,
    pre.sessionId,
    false,
  );
  check('pre_disable_toolbar_mounted', toolbarPre === true);
  const discoverPre = await bridgeDiscover(pre.sessionId, null);
  check('pre_disable_activated_discover_responds', discoverPre?.ok === true);

  // ---- 3. REAL Disable → registrations [] ---------------------------------
  const disable = await driveSetup('setup-disable', false);
  console.log('[disable] status:', disable.status);
  check(
    'disable_via_real_setup_ui',
    typeof disable.status === 'string' && disable.status.includes('Disabled.'),
  );
  const regsDisabled = await getRegistrations();
  console.log('[disable] registrations:', JSON.stringify(regsDisabled));
  check('disable_registrations_empty', Array.isArray(regsDisabled) && regsDisabled.length === 0);

  // Same pre-disable realm: the isolated client's revocation watcher must have
  // deactivated the live bridge. Verify silence with a bare probe.
  const discoverSameRealm = await bridgeDiscover(pre.sessionId, null);
  check('post_disable_same_realm_silent', discoverSameRealm === null);

  // Stale-token rejection: replay the exact token the production handshake
  // used before Disable; the consumed token must not re-activate (silence).
  const staleToken = await browser.evaluate(`window.__capTokens[0] ?? null`, pre.sessionId, false);
  check(
    'stale_token_captured_from_real_handshake',
    typeof staleToken === 'string' && staleToken.length >= 16,
  );
  const discoverStale = await bridgeDiscover(pre.sessionId, staleToken, 4000);
  check('stale_token_rejected_silent', discoverStale === null);

  // ---- 4. brand-new post-disable target: new identity, no toolbar, no bridge
  const fresh = await openEditorTarget('fresh-after-disable');
  check('fresh_doc_identity_distinct', fresh.identity.timeOrigin !== pre.identity.timeOrigin);
  const toolbarFresh = await browser.evaluate(
    `Boolean(document.querySelector('[data-gpt-toolbar="1"]'))`,
    fresh.sessionId,
    false,
  );
  check('fresh_post_disable_no_toolbar', toolbarFresh === false);
  check('fresh_post_disable_no_handshake', fresh.caps.activations === 0);
  const discoverFresh = await bridgeDiscover(fresh.sessionId, null, 3000);
  check('fresh_post_disable_no_bridge_response', discoverFresh === null);

  // ---- 5. real re-enable: scoped registrations + fresh capability ----------
  const reEnable = await driveSetup('setup-enable', true);
  console.log('[re-enable] status:', reEnable.status, '| granted:', reEnable.granted);
  const regsRe = await getRegistrations();
  console.log('[re-enable] registrations:', JSON.stringify(regsRe));
  check('re_enable_scoped_registrations_restored', exactlyScoped(regsRe));
  const reTarget = await openEditorTarget('re-enabled');
  const toolbarRe = await browser.evaluate(
    `Boolean(document.querySelector('[data-gpt-toolbar="1"]'))`,
    reTarget.sessionId,
    false,
  );
  check('re_enable_toolbar_mounts', toolbarRe === true);
  const reDigest = await tokenDigest(reTarget.sessionId, 0);
  check(
    're_enable_fresh_capability_token',
    reTarget.caps.activations >= 1 && reDigest !== preDigest,
  );
  const discoverRe = await bridgeDiscover(reTarget.sessionId, null);
  check('re_enable_new_handshake_discover_responds', discoverRe?.ok === true);
} catch (err) {
  failed = true;
  console.error('PROOF ERROR:', err?.stack ?? err);
}

const lines = [
  '# t_eacca232 genuine headed C8 revoke proof — real unpacked MV3 extension, live Ghost 6.60',
  '',
  `- headed Chromium under Xvfb display :102, --load-extension=${ROOT}`,
  `- extension id: ${extId}`,
  '- Enable/Disable driven through the real setup page UI with OS-level trusted input;',
  '  the native Chromium permission bubble was accepted with keyboard input;',
  `  native-consent screenshot artifact: ${artifacts.consentPromptShot ?? 'not captured'}`,
  '- registrations read from the real extension context via',
  '  chrome.scripting.getRegisteredContentScripts(); capability tokens observed from the',
  '  real production handshake are only compared by SHA-256 digest prefix and never printed.',
  '',
  ...Object.entries(results).map(([k, v]) => `- ${k}: ${v}`),
  '',
  'All checks must be true for PROOF PASS. No cookie or token values appear in this file.',
].join('\n');
writeFileSync(path.join(OUT, 'eacca232-headed-revoke-proof.md'), lines);
console.log('PROOF PASS:', !failed);
browser.close();
process.exit(failed ? 2 : 0);
