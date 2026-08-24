/**
 * Shared CDP helper for genuine HEADED e2e proofs (no --headless).
 *
 * Spawns a REAL headed Chromium (under Xvfb) with the built unpacked
 * extension loaded, attaches CDP, and exposes typed send/evaluate helpers.
 * The page/extension run in a real browser window — content scripts, the
 * service worker, native permission bubbles, and MAIN-world injection all
 * behave exactly as in production.
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

export const DEFAULT_PORT = 9373;

export async function launchHeadedChromium(opts = {}) {
  const {
    port = DEFAULT_PORT,
    extensionRoot = process.cwd(),
    userDataDir = '/tmp/gpt-eacca232-headed-profile',
    display = ':102',
    extraArgs = [],
  } = opts;

  const args = [
    '--no-sandbox',
    '--disable-gpu',
    '--ignore-certificate-errors',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${extensionRoot}`,
    '--allow-insecure-localhost',
    '--window-size=1440,1024',
    ...extraArgs,
    'about:blank',
  ];

  const child = spawn('/usr/bin/chromium', args, {
    env: { ...process.env, DISPLAY: display },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});

  // Wait for CDP endpoint.
  let version;
  for (let i = 0; i < 100; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (version?.webSocketDebuggerUrl) break;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!version?.webSocketDebuggerUrl) {
    child.kill('SIGTERM');
    throw new Error('Headed Chromium CDP did not come up');
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
    const id = ++seq;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  return {
    child,
    port,
    userDataDir,
    async newTarget(url = 'about:blank') {
      const { result: t } = await send('Target.createTarget', { url });
      const { result: si } = await send('Target.attachToTarget', {
        targetId: t.targetId,
        flatten: true,
      });
      return { targetId: t.targetId, sessionId: si.sessionId };
    },
    async attach(targetId) {
      const { result: si } = await send('Target.attachToTarget', {
        targetId,
        flatten: true,
      });
      return si.sessionId;
    },
    async sessionFor(url = 'about:blank') {
      const { targetId, sessionId } = await this.newTarget(url);
      return { targetId, sessionId };
    },
    async cdp(method, params = {}, sessionId) {
      const r = await send(method, params, sessionId);
      if (r.error) throw new Error(`${method}: ${r.error.message}`);
      return r.result;
    },
    async evaluate(expr, sessionId, awaitPromise = true) {
      const r = await this.cdp(
        'Runtime.evaluate',
        { expression: expr, awaitPromise, returnByValue: true },
        sessionId,
      );
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? 'page exception');
      }
      return r.result.value;
    },
    /** No-op kept for API compatibility; dialogs are accepted per-session. */
    onDialogAccept() {
      return () => {};
    },
    async listTargets() {
      const res = await send('Target.getTargets');
      const targetInfos = res.result?.targetInfos ?? res.targetInfos ?? [];
      return targetInfos.map((t) => ({
        url: t.url,
        type: t.type,
        targetId: t.targetId,
        attached: t.attached,
      }));
    },
    async extensionId() {
      // The real extension id is deterministic per user-data-dir and is stored
      // as the key of the extension's entry in <profile>/Default/Preferences
      // (under extensions.settings). Chrome writes that file asynchronously
      // after launch, so poll briefly before giving up.
      const { readFileSync, existsSync } = await import('node:fs');
      const prefsPath = `${this.userDataDir}/Default/Preferences`;
      for (let i = 0; i < 50; i++) {
        if (existsSync(prefsPath)) {
          try {
            const text = readFileSync(prefsPath, 'utf8');
            const m = /"settings"\s*:\s*\{\s*"([a-z]{32})"/.exec(text);
            if (m) return m[1];
          } catch {
            /* fall through */
          }
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return null;
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      child.kill('SIGTERM');
    },
  };
}
