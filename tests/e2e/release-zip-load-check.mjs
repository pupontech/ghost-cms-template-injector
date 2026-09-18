/**
 * Verify the built release ZIP loads as an unpacked MV3 extension in real
 * Chromium (the "sources-only ZIP" class of failure, e.g. a missing dist
 * bundle, surfaces here and nowhere else).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { extensionLoadErrors } from './lib/chromium-stderr.mjs';

const ZIP = process.argv[2];
const dir = mkdtempSync('/tmp/gcti-zip-load-');
execFileSync('python3', [
  '-c',
  `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`,
  ZIP,
  dir,
]);

/** The version the ZIP claims, so the check cannot pass on a stale build. */
const expectedVersion = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;

const PORT = 9393;
const child = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=/tmp/gcti-zip-load-profile-${process.pid}`,
    `--remote-debugging-port=${PORT}`,
    `--load-extension=${dir}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

let version;
for (let i = 0; i < 100; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (version?.webSocketDebuggerUrl) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
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
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

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
  await new Promise((r) => setTimeout(r, 250));
}

// Ask the loaded extension for its own manifest (authoritative runtime view).
let manifestVersion = null;
if (extensionId) {
  const { result: target } = await send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/options/options.html`,
  });
  const { result: session } = await send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  });
  await send('Runtime.enable', {}, session.sessionId);
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 20 && manifestVersion === null; i += 1) {
    const r = await send(
      'Runtime.evaluate',
      { expression: `chrome.runtime.getManifest().version`, returnByValue: true },
      session.sessionId,
    );
    manifestVersion = r.result?.result?.value ?? null;
    if (manifestVersion === null) {
      const raw = await send(
        'Runtime.evaluate',
        {
          expression: `JSON.stringify({href: location.href, ready: document.readyState, chrome: typeof chrome, runtime: typeof (chrome && chrome.runtime), manifest: typeof (chrome && chrome.runtime && chrome.runtime.getManifest)})`,
          returnByValue: true,
        },
        session.sessionId,
      );
      console.log('  probe:', JSON.stringify(raw.result ?? raw).slice(0, 300));
      await new Promise((res) => setTimeout(res, 250));
    }
  }
}

// Extension load failures only: Chromium's own services (GCM, GPU, DBus, audio)
// also write "ERROR" lines to stderr and must not be reported as load errors.
const errors = extensionLoadErrors(stderr);

console.log(
  JSON.stringify({ extensionId, manifestVersion, expectedVersion, loadErrors: errors }, null, 2),
);
child.kill('SIGTERM');
process.exit(extensionId && manifestVersion === expectedVersion && errors.length === 0 ? 0 : 1);
