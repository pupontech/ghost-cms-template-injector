# Release status — independent review and owner acceptance pending

## Candidate

- Candidate worktree: `chore/governance-release-safety-4` (not merged to `main`)
- Governance issue: https://github.com/pupontech/ghost-cms-template-injector/issues/4
- OpenSpec: `openspec/changes/4-governance-release-safety/proposal.md`
- Kanban board/card: `ghost-preset-toolbar` / `t_96555f52`
- Draft PR: https://github.com/pupontech/ghost-cms-template-injector/pull/5
- Extension/package version: `0.2.3` (manifest, package.json, and package-lock.json synchronized)
- Genuine headed lifecycle implementation/evidence lineage: `45f7fc0`
- Compatibility target exercised: Ghost 6.60
- Chromium: 151.0.7922.169
- Extension platform: Manifest V3

## Automated verification

The current pre-commit working tree's latest full test run passed:

- Vitest: 34 test files, 372 tests

The implementation commit `3389885298a8c7e0c337ee1986f8809d38f4fa16` passed the aggregate `npm run verify` gate after commit; `npm run audit:high` found 0 vulnerabilities. Re-run both after any further source change and before merge.

Hosted GitHub Actions also passed on pushed tip `80f017d14a6f2414f8b66d0790b1fb6ea11a467e`: `verify (Node 20)` and `verify (Node 22)`; run `33401081288`.

The manifest uses only `storage` and `scripting`, has no static host permission, and declares the existing optional HTTPS Ghost Admin pattern. The setup page requests explicit native permission for one concrete installation before dynamically registering isolated and MAIN-world scripts for that installation's `/ghost/*` pages.

## Real Ghost/browser gates

### Preset persistence

The persistence harness is a headless CDP production-bundle proof, not genuine headed-browser acceptance evidence. It verifies body, custom excerpt, and tag persistence after the native save and beyond the subsequent autosave interval; its raw output remains local-only under `evidence/local/`.

The `real-ghost-browser-proof.mjs` harness drives the real `dist/` bundles through the production `chrome.runtime` message path against live authenticated Ghost, activates the MAIN bridge via the real capability token, and writes sanitized local-only output through the exclusive proof-artifact writer. It is headless and stubs `window.chrome`, so it is not genuine headed-browser acceptance evidence.

### Disable/re-enable lifecycle

A genuine headed Chromium run loaded the actual unpacked extension, used trusted OS-level input and Chromium's native host-consent prompt, and recorded all C8 assertions as true:

- Exactly two registrations scoped to the intended `/ghost/*` installation path
- Toolbar and capability-gated bridge active before Disable
- Real setup-page Disable emptied registrations
- Toolbar removed and the already-loaded bridge became silent
- Stale capability rejected
- Genuinely new post-Disable document had no toolbar, handshake, or bridge response
- Re-enable restored only the scoped registrations and used a fresh capability

See `evidence/eacca232-headed-revoke-proof.md`. Capability values, cookies, and credentials are not included in the evidence.

## Independent review

The 2026-08-31 independent security and governance audit found FIX-FIRST issues in the prior staged remediation. A fresh native Luna read-only review of the stabilized tree returned PASS for the implementation and safety controls, with one P2 governance/documentation conflict remaining in protected `AGENTS.md`: it still prohibits all GPT-family worker lanes and omits `dsflash`. No code/security blocker remained.

The requested official DeepSeek Flash review could not start. Profile `dsflash` reached `https://api.deepseek.com/v1` with `deepseek-v4-flash` but returned HTTP 401 (`Authentication Fails`); no fallback provider or alternate model was used. Re-authentication is required before claiming a DeepSeek review.

## Branch-protection limitation

Read-only GitHub inspection reported HTTP 403 for branch-protection and ruleset endpoints because this private repository/plan does not expose enforceable controls there. CODEOWNERS and the pull-request template are advisory in this state. Until the owner enables a supported required-review/ruleset control or explicitly accepts an equivalent external process, the owner must perform the final merge and no agent may self-approve, self-merge, force-push, or bypass checks.

## Remaining gates

1. Keep the passing full verification and high-severity dependency audit attached to any subsequent remediation commit.
2. Resolve the P2 `AGENTS.md` routing-policy conflict by owner-authorized edit or an explicit precedence rule.
3. Update Issue #4 and Kanban card with the exact PR #5 URL, OpenSpec path, current CI status, native Luna result, DeepSeek 401 status, and owner-gate state.
4. Keep final owner acceptance pending until the owner completes `TESTING.md` and any required genuine headed persistence run.
