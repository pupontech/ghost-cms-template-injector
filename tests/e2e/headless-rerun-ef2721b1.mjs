/**
 * t_ef2721b1 HEADLESS CDP RERUN — live Ghost 6.60, subdirectory /blog, https.
 *
 * Drives the REAL production bundle (dist/bridge.js MAIN world) against the
 * live, authenticated Ghost Admin at https://localhost:2368/blog/ghost/, using
 * the exact C3 page-bridge message protocol the isolated content script would
 * use. This is NOT the unit fake and NOT the repo's proof harness (which
 * hardcodes http://localhost:2368/ghost/ and a raw-HTML body that the adapter
 * cannot consume).
 *
 * It proves the real defect fix end-to-end:
 *   window.postMessage(bridge request) → MAIN bridge responder
 *     → createGhostStateAdapter.apply(plan) → one native save
 *   → Admin API readback shows body + excerpt + tag all persisted from ONE apply,
 *     and a subsequent autosave does not revert.
 *
 * The session cookie is read from an explicit safe local path supplied by
 * GHOST_PROOF_COOKIE_JAR and injected via CDP; its value is never printed or
 * committed. Raw output remains under ignored evidence/local/.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveProofPaths, writeProofArtifact } from '../../scripts/proof-path-safety.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..', '..');
const { evidenceDirectory: OUT, cookieJar: COOKIE_JAR } = resolveProofPaths(
  ROOT,
  process.env.GHOST_PROOF_COOKIE_JAR,
);
const ARTIFACT_NAME =
  process.env.GHOST_PROOF_ARTIFACT_NAME ||
  `ef2721b1-headless-rerun-${Date.now()}-${process.pid}.md`;
const jar = readFileSync(COOKIE_JAR, 'utf8');
const sessionLine = jar.split('\n').find((l) => l.includes('ghost-admin-api-session'));
const parts = (sessionLine ?? '').trim().split('\t');
const cookieName = parts.length >= 7 ? parts[5] : 'ghost-admin-api-session';
const cookieValue = parts.length >= 7 ? parts[6] : '';
if (!cookieValue) {
  console.error('Could not read session cookie from GHOST_PROOF_COOKIE_JAR');
  process.exit(1);
}

const ADMIN = 'https://localhost:2368/blog/ghost/';
const BASE = 'https://localhost:2368/blog/ghost/api/admin/';
const PORT = process.env.SPIKE_CDP_PORT ?? 9371;

const chromium = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--allow-insecure-localhost',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/gcti-ef2721b1-profile',
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
  console.error('Editor route never came up — aborting headed rerun.');
  bws.close();
  chromium.kill('SIGTERM');
  process.exit(1);
}

// Watch for the MAIN bridge responder by round-tripping a discover request.
async function bridgeRequest(op, payload, timeoutMs = 8000) {
  const nonce = await evaluate(`crypto.randomUUID()`, false);
  const req = JSON.stringify({
    v: 1,
    op,
    nonce,
    source: 'ghost-cms-template-injector/page-bridge/v1',
    payload,
  });
  // Dispatch as a synthetic MessageEvent with `source: window` (non-null) so
  // the MAIN bridge's `event.source.postMessage(reply)` reply path fires.
  // The page's global 'message' listener (installed before the bridge bundle)
  // records every response-shaped message onto window['__br_'+nonce].
  await evaluate(
    `((nonce, reqStr) => { window['__br_'+nonce] = null; window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(reqStr), source: window, origin: location.origin })); return true; })(${JSON.stringify(nonce)}, ${JSON.stringify(req)})`,
    false,
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await evaluate(`window['__br_'+${JSON.stringify(nonce)}]`, false);
    if (got) return got;
    await sleep(200);
  }
  return null;
}

// ---- Install the REAL MAIN-world bridge bundle (dist/bridge.js) ----
// The bundle's entry only wires its message listener when `'chrome' in
// globalThis` (it is a real extension's world). Stub that so the responder
// installs in this harness; no extension APIs are actually used by the bridge.
// The MAIN bridge replies to `event.source.postMessage`. Because our requests
// are dispatched from Runtime.evaluate (no real sender window, source is null),
// we intercept the reply by wrapping window.postMessage so the response is
// captured on a global keyed by nonce, exactly as a real page listener would.
await evaluate(
  `(() => {
  window.chrome = window.chrome || { runtime: {} };
  // Capture ANY response-shaped postMessage (boolean ok) onto a global keyed
  // by nonce. The MAIN bridge calls event.source.postMessage for its reply,
  // whose postMessage is the bridge's own captured copy — so a wrapper install
  // would be bypassed. Instead we simply record every response globally; the
  // request dispatch (below) uses a real synthetic MessageEvent so the bridge
  // replies through its captured window.postMessage, which still calls the
  // underlying implementation that ultimately reaches this listener.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && typeof d.ok === 'boolean' && d.nonce) {
      window['__br_' + d.nonce] = d;
    }
  });
  return true;
})()`,
  false,
);
const bridgeBundle = readFileSync(path.join(ROOT, 'dist', 'bridge.js'), 'utf8');
const bridgeSrc = bridgeBundle.replace(/export\s*\{[^}]*\};?\s*$/, '');
await evaluate(
  `(() => { const s=document.createElement('script'); s.type='module'; s.textContent=${JSON.stringify(
    bridgeSrc,
  )}; document.documentElement.appendChild(s); return true; })()`,
  false,
);
await sleep(2000);
const discoverRaw = await bridgeRequest('discover', {});
console.log('discover reply ok:', discoverRaw?.ok === true);
if (!discoverRaw?.ok) {
  console.error('MAIN bridge discover failed — aborting.');
  bws.close();
  chromium.kill('SIGTERM');
  process.exit(1);
}

// ---- Software Review preset plan, with a REAL serialized Lexical body ----
// Mirrors the planner output for content.source inline lexical + excerpt
// replace + tags merge. The body value is serialized Lexical (what setLexical
// consumes), not raw HTML — this is exactly the field the old code dropped.
const BODY_LEXICAL = JSON.stringify({
  root: {
    children: [
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'A hands-on review.',
            type: 'text',
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
});

const plan = {
  presetId: 'software-review',
  status: 'ready',
  actions: [
    { field: 'body', op: 'set', status: 'apply', value: BODY_LEXICAL },
    { field: 'excerpt', op: 'set', status: 'apply', value: 'A hands-on review.' },
    { field: 'tags', op: 'set', status: 'apply', value: ['Reviews'] },
  ],
  problems: [],
};

// Create a disposable new post first so we don't clobber existing content.
const newPost = await evaluate(
  `(() => {
    const a = (window.Ember.Namespace.NAMESPACES.filter(n => n instanceof window.Ember.Application)[0]);
    const c = a.__container__;
    const ctrl = c.lookup('controller:lexical-editor');
    const store = c.lookup('service:store');
    const user = ctrl.get ? ctrl.get('session.user') : (ctrl.session && ctrl.session.user);
    const post = store.createRecord('post', { authors: [user] });
    ctrl.setPost(post);
    return { id: post.get('id') || null, isNew: post.get('isNew') };
  })()`,
  false,
).catch((e) => ({ error: String(e) }));
console.log('disposable new post created:', newPost?.error ? false : newPost?.isNew === true);

const applyRaw = await bridgeRequest('apply', { plan });
console.log('apply reply ok:', applyRaw?.ok === true);

// ---- Verify persistence via Admin API (cookie auth, redacted) ----
const verify1 = await evaluate(
  `(() => { const r=null; return fetch(${JSON.stringify(BASE + 'posts/?limit=5&order=updated_at%20desc&include=tags')}, { credentials:'include' }).then(x=>x.json()).then(j=>{ const posts=j.posts||[]; const newest=posts[0]||null; let lexEmpty=true, lexChildren=0; try { const l=JSON.parse(newest.lexical); lexChildren=(l.root&&l.root.children||[]).length; lexEmpty=lexChildren===0; } catch {} return { count:posts.length, newest: newest?{ id:newest.id, custom_excerpt:newest.custom_excerpt, lexical_children:lexChildren, lexical_empty:lexEmpty, tags:(newest.tags||[]).map(t=>t.name) }:null }; }); })()`,
);
const verify1Summary = {
  count: verify1?.count ?? 0,
  newestPresent: Boolean(verify1?.newest),
  excerptPresent: Boolean(verify1?.newest?.custom_excerpt),
  tagCount: verify1?.newest?.tags?.length ?? 0,
  lexicalChildren: verify1?.newest?.lexical_children ?? 0,
};
console.log('API verification after apply summary:', JSON.stringify(verify1Summary));

// ---- Subsequent autosave must NOT revert ----
await sleep(6000); // allow any ghost autosave window to pass
const verify2 = await evaluate(
  `(() => { return fetch(${JSON.stringify(BASE + 'posts/?limit=5&order=updated_at%20desc&include=tags')}, { credentials:'include' }).then(x=>x.json()).then(j=>{ const posts=j.posts||[]; const newest=posts[0]||null; let lexChildren=0; try { const l=JSON.parse(newest.lexical); lexChildren=(l.root&&l.root.children||[]).length; } catch {} return { newest: newest?{ id:newest.id, custom_excerpt:newest.custom_excerpt, lexical_children:lexChildren, tags:(newest.tags||[]).map(t=>t.name) }:null }; }); })()`,
);
const persisted =
  verify1?.newest &&
  verify1.newest.custom_excerpt === 'A hands-on review.' &&
  verify1.newest.lexical_empty === false &&
  JSON.stringify(verify1.newest.tags) === JSON.stringify(['Reviews']) &&
  verify2?.newest?.lexical_children === verify1.newest.lexical_children;
const verify2Summary = {
  newestPresent: Boolean(verify2?.newest),
  excerptPresent: Boolean(verify2?.newest?.custom_excerpt),
  tagCount: verify2?.newest?.tags?.length ?? 0,
  lexicalChildren: verify2?.newest?.lexical_children ?? 0,
};
console.log('API verification after idle summary:', JSON.stringify(verify2Summary));
console.log('PERSISTED BODY+EXCERPT+TAG FROM ONE APPLY:', persisted);
console.log(
  'NO REVERT AFTER AUTOSAVE:',
  verify2?.newest?.custom_excerpt === 'A hands-on review.' &&
    verify2?.newest?.lexical_children === verify1.newest.lexical_children,
);

const evidence = [
  '# t_ef2721b1 headed rerun — live Ghost 6.60 (https /blog)',
  '',
  `- target: ${ADMIN}#/editor/post`,
  `- lexical editor route reached: ${routeOk}`,
  `- MAIN bridge discover ok: ${discoverRaw?.ok}`,
  `- disposable new post created: ${newPost?.error ? false : newPost?.isNew === true}`,
  `- apply reply ok: ${applyRaw?.ok === true}`,
  `- API persisted post count: ${verify1Summary.count}`,
  `- newest post present after apply: ${verify1Summary.newestPresent}`,
  `- excerpt present after apply: ${verify1Summary.excerptPresent}`,
  `- tag count after apply: ${verify1Summary.tagCount}`,
  `- newest post present after idle: ${verify2Summary.newestPresent}`,
  `- excerpt present after idle: ${verify2Summary.excerptPresent}`,
  `- tag count after idle: ${verify2Summary.tagCount}`,
  `- body+excerpt+tag all persisted from ONE apply: ${persisted}`,
  `- no revert after autosave: ${verify2?.newest?.custom_excerpt === 'A hands-on review.' && verify2?.newest?.lexical_children === verify1.newest.lexical_children}`,
  '',
  'No cookie values appear in this evidence file.',
].join('\n');
writeProofArtifact(ROOT, OUT, ARTIFACT_NAME, evidence);

bws.close();
chromium.kill('SIGTERM');
console.log('DONE — evidence in', path.join(OUT, ARTIFACT_NAME));
