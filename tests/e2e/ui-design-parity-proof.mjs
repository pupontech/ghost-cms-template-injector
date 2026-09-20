/**
 * UI-PARITY LIVE PROOF (real Chromium, real delivered ZIP).
 *
 * The owner asked for the toolbar popup to look like the rest of the extension's
 * settings. This harness loads the built extension, opens the popup and the
 * Options page side by side in a real browser, and compares what the browser
 * actually computes — palette, radii, heading treatment, and the primary/secondary
 * button colours — rather than trusting that two stylesheets say similar things.
 *
 * Usage: node tests/e2e/ui-design-parity-proof.mjs [extensionDirOrZip]
 * Default: the repository root (unpacked build in dist/).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const OUT = path.join(ROOT, 'evidence');
mkdirSync(OUT, { recursive: true });

const target = process.argv[2] ?? ROOT;
let extensionDir = target;
let extracted = null;
if (target.endsWith('.zip')) {
  extracted = `/tmp/gcti-ui-parity-${process.pid}`;
  rmSync(extracted, { recursive: true, force: true });
  mkdirSync(extracted, { recursive: true });
  execFileSync('unzip', ['-q', target, '-d', extracted], { stdio: 'pipe' });
  extensionDir = extracted;
}
if (!existsSync(path.join(extensionDir, 'manifest.json'))) {
  console.error(`ui-parity-proof: ${extensionDir} is not an unpacked extension`);
  process.exit(1);
}

const PORT = Number(process.env.UI_PARITY_CDP_PORT ?? 9477);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidence = { steps: [] };
function record(step, detail) {
  evidence.steps.push({ step, ...(detail === undefined ? {} : { detail }) });
  console.log(`✓ ${step}`, detail === undefined ? '' : JSON.stringify(detail));
}

const chromium = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=/tmp/gcti-ui-parity-profile-${process.pid}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${extensionDir}`,
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
if (!version?.webSocketDebuggerUrl) {
  chromium.kill('SIGTERM');
  console.error('ui-parity-proof: chromium CDP did not come up');
  process.exit(1);
}

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let seq = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
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
  const { result: t } = await send('Target.createTarget', { url });
  const { result: s } = await send('Target.attachToTarget', {
    targetId: t.targetId,
    flatten: true,
  });
  await send('Runtime.enable', {}, s.sessionId);
  return { sessionId: s.sessionId };
}
async function evaluate(expression, sessionId) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? 'page exception');
  }
  return r.result?.result?.value;
}

let extensionId = null;
for (let i = 0; i < 60; i++) {
  const { result } = await send('Target.getTargets');
  const found = (result?.targetInfos ?? []).find((x) =>
    String(x.url).startsWith('chrome-extension://'),
  );
  if (found) {
    extensionId = String(found.url).split('/')[2];
    break;
  }
  await sleep(250);
}
if (!extensionId) {
  chromium.kill('SIGTERM');
  console.error('ui-parity-proof: the extension did not load');
  process.exit(1);
}
record('loaded the delivered extension in real Chromium', { extensionId });

/** What the browser computes for one page's design language. */
const PROBE = `(() => {
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  const heading = document.querySelector('h2');
  const card = document.querySelector('.card');
  const primary =
    document.getElementById('gcti-import-open') || document.getElementById('opt-save');
  const secondary =
    document.getElementById('gcti-undo') || document.getElementById('opt-cancel');
  const px = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
  return JSON.stringify({
    tokens: {
      bg: root.getPropertyValue('--bg').trim(),
      surface: root.getPropertyValue('--surface').trim(),
      surface2: root.getPropertyValue('--surface-2').trim(),
      text2: root.getPropertyValue('--text-2').trim(),
      line: root.getPropertyValue('--line').trim(),
      accent: root.getPropertyValue('--accent').trim(),
      danger: root.getPropertyValue('--danger').trim(),
      radius: root.getPropertyValue('--radius').trim(),
    },
    bodyBackground: body.backgroundColor,
    fontFamily: body.fontFamily.split(',')[0].trim(),
    headingTransform: heading ? px(heading, 'textTransform') : null,
    headingColor: heading ? px(heading, 'color') : null,
    cardBackground: card ? px(card, 'backgroundColor') : null,
    cardRadius: card ? px(card, 'borderRadius') : null,
    primaryBackground: primary ? px(primary, 'backgroundColor') : null,
    primaryColor: primary ? px(primary, 'color') : null,
    secondaryBackground: secondary ? px(secondary, 'backgroundColor') : null,
    darkModeSupported: window.matchMedia('(prefers-color-scheme: dark)').matches,
  });
})()`;

const popup = await newSession(`chrome-extension://${extensionId}/popup/popup.html`);
const options = await newSession(`chrome-extension://${extensionId}/options/options.html`);
await sleep(1200);
const popupDesign = JSON.parse((await evaluate(PROBE, popup.sessionId)) ?? '{}');
const optionsDesign = JSON.parse((await evaluate(PROBE, options.sessionId)) ?? '{}');
evidence.popup = popupDesign;
evidence.options = optionsDesign;
record('probed the popup and the Options page in the same browser', {
  popupBody: popupDesign.bodyBackground,
  optionsBody: optionsDesign.bodyBackground,
});

const checks = {
  sameTokens: JSON.stringify(popupDesign.tokens) === JSON.stringify(optionsDesign.tokens),
  sameBodyBackground: popupDesign.bodyBackground === optionsDesign.bodyBackground,
  settingsBackgroundApplied: popupDesign.bodyBackground === optionsDesign.bodyBackground,
  sameFontStack: popupDesign.fontFamily === optionsDesign.fontFamily,
  sameHeadingTreatment:
    popupDesign.headingTransform === 'uppercase' &&
    popupDesign.headingTransform === optionsDesign.headingTransform,
  sameCardRadius: popupDesign.cardRadius === optionsDesign.cardRadius,
  samePrimaryColor: popupDesign.primaryBackground === optionsDesign.primaryBackground,
  secondaryIsHairline:
    popupDesign.secondaryBackground === 'rgba(0, 0, 0, 0)' ||
    popupDesign.secondaryBackground === 'transparent',
  accentIsSystemBlue: popupDesign.tokens.accent.toLowerCase() === '#0a84ff',
  cardIsSurface: popupDesign.cardBackground === optionsDesign.cardBackground,
};
evidence.checks = checks;
const failed = Object.entries(checks)
  .filter(([, ok]) => ok !== true)
  .map(([name]) => name);
if (failed.length > 0) {
  console.error('ui-parity-proof: failed checks', failed.join(', '));
}
record('compared what the browser computes for both surfaces', checks);

const pass = failed.length === 0;
evidence.verdict = pass ? 'PASS' : 'FAIL';

const md = [
  '# Popup ↔ settings UI parity (real browser)',
  '',
  `Verdict: **${evidence.verdict}**`,
  '',
  `Extension loaded from: \`${target}\`, Chromium (headless=new), scripted over CDP.`,
  'Both pages were probed in the same browser session; the values below are what the',
  'browser computes, not what the stylesheets claim.',
  '',
  '## Popup',
  '',
  '```json',
  JSON.stringify(popupDesign, null, 2),
  '```',
  '',
  '## Options page (reference)',
  '',
  '```json',
  JSON.stringify(optionsDesign, null, 2),
  '```',
  '',
  '## Checks',
  '',
  ...Object.entries(checks).map(([name, ok]) => `- ${ok ? '✅' : '❌'} \`${name}\``),
  '',
].join('\n');
writeFileSync(path.join(OUT, 'ui-parity-live-proof.md'), md);

console.log(`\nverdict: ${evidence.verdict}`);
console.log(`evidence: ${path.join(OUT, 'ui-parity-live-proof.md')}`);

chromium.kill('SIGTERM');
if (extracted) rmSync(extracted, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
