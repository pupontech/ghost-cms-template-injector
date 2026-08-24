# C8 Luna round-two execution review

Date: 2026-08-24
Worktree: `/root/ghost-research/ghost-preset-toolbar/.worktrees/t_eacca232`
Reviewed commit at start: `f0800910dda970bc0a10d49af59c3da10cc0f82c`

## Verdict

**BLOCKED** — the production/unit implementation is bounded and automated gates are clean, but the required genuine headed MV3 Enable/Disable/new-document/re-enable evidence is not present. The checked-in proof is not evidence of that acceptance gate.

## What passed

- Read `AGENTS.md`, `GHOST_PRESET_TOOLBAR_DECISION.md`, and `GHOST_PRESET_TOOLBAR_IMPLEMENTATION_GUIDE.md`.
- Production registration wiring is present in `src/host-permission.ts`: registration occurs only after an explicit permission request succeeds, with separate isolated and MAIN registrations scoped to the exact normalized installation `/ghost/*` match. Revoke unregisters both IDs and clears consent.
- `src/content-script-main.ts` mints a per-document token in the isolated context, activates the MAIN bridge, and watches `chrome.storage.onChanged` for consent revocation to send deactivation.
- `src/main-bridge-main.ts` is dormant by default, routes requests through the capability gate, stays silent while dormant, consumes the active token on deactivation, removes its listener on `pagehide`, and refuses replay of consumed tokens.
- Focused capability test: `npm test -- --run tests/unit/main-bridge-capability.test.ts` — **10 tests passed**.
- Full clean verification: `npm run verify` — **format check, ESLint, TypeScript, production build, 302 tests, and manifest validation all passed**.
- The handoff's unused capability-gate dependency was removed as a small bounded defect; the production behavior remains unchanged and tests were updated accordingly.
- Pollution cleanup completed: untracked `node_modules` directory and untracked `_dbg`, `_idcheck`, and `probe-*` files were removed. The repository's pre-existing tracked `node_modules` symlink was restored; no pollution remains in `git status`.
- Permission review: `manifest.json` still has `host_permissions: []`, `permissions: ["storage", "scripting"]`, and only the already-declared optional host pattern. Runtime registration requests the concrete normalized Ghost installation match; no new permission or secret was added. Built artifacts contained no credential markers or broad static host match.
- Added-line static scan found no hardcoded-secret, shell-injection, eval/exec, or unsafe-deserialization matches.

## Headed evidence audit

The existing artifact `evidence/eacca232-headed-revoke-proof.md` reports PASS-like facts, but its harness `tests/e2e/headed-disable-bridge-proof.mjs` cannot satisfy the requested acceptance criterion:

- It launches Chromium with `--headless=new`, not headed Chromium.
- It does not load the packaged MV3 extension or exercise the real extension service worker.
- It injects `dist/bridge.js` with `Runtime.evaluate` and stubs `window.chrome`.
- It manually dispatches capability envelopes and bridge requests from page JavaScript.
- It does not click or drive the real setup Enable/Disable UI, observe a real consent prompt, verify the two live registrations before Disable, verify registrations are empty after Disable, or prove toolbar removal.

Therefore the reported same-realm silence, fresh-document silence, and re-enable response are useful synthetic/production-bundle checks, but **not** the ONE genuine headed MV3 Enable/Disable/new-document/re-enable evidence required by C8. I did not relabel this artifact as PASS or fabricate the missing acceptance result.

## Final state

Automated implementation gates: PASS.
Genuine headed MV3 consent/registration/toolbar evidence: MISSING; exact blocker documented above.
Final status: **BLOCKED**.
