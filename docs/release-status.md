# Release status — v0.3.0 owner acceptance pending

## Candidate

- v0.3.0 candidate: `wt/v030-implementation` (to be fast-forwarded to `main` only after final verification)
- Previous genuine headed lifecycle implementation/evidence lineage: `45f7fc0`
- Compatibility target exercised by inherited evidence: Ghost 6.60
- Chromium in inherited evidence: 151.0.7922.169
- Extension platform: Manifest V3

## Automated verification

The v0.3.0 candidate passed `npm run verify`:

- Prettier format check
- ESLint
- Strict TypeScript check
- Production build
- Vitest: 32 files, 382 tests
- Manifest and built-artifact validation, including package/manifest/VERSION consistency

The manifest uses only `storage` and `scripting`, has no static host permission, and declares the existing optional HTTPS Ghost Admin pattern. The setup page requests explicit native permission for one concrete installation before dynamically registering isolated and MAIN-world scripts for that installation's `/ghost/*` pages.

## v0.3.0 implementation scope

- Bridge source/origin gates, closed payload schemas, and clone-safe response validation.
- Persistent rollback/readback verification with distinct `SAVE_FAILED`, `ROLLBACK_FAILED`, stale-editor, and busy outcomes.
- Custom-template replace, only-if-empty, and prompt modes with active-theme allowlist validation.
- Visible Advanced preset authoring for body source, per-field modes, custom-template filename/mode, description, group, and icon.
- Read-only field-aware plan preview before mutation.
- MAIN-private one-use Undo with post-apply stale-state protection, native save, readback, and cancellable automatic refresh.
- Deferred-items port: C1 prompt panel, success-only 60-second context cache with SPA reset, and message-boundary `APPLY_BUSY`.

## Real Ghost/browser gates

### Inherited persistence and lifecycle evidence

A genuine headed Chromium run against authenticated Ghost Admin verified that the body, custom excerpt, and tag persisted after the native save and remained correct beyond the subsequent autosave interval. See `evidence/ef2721b1-headed-rerun.md`.

The `real-ghost-browser-proof.mjs` harness drives the REAL `dist/` bundles through the production `chrome.runtime` message path against the live authenticated Ghost and records evidence in `evidence/live-proof.md` — discover `ok`, apply `ok: { saved: true }`, and API read-back showing the applied excerpt + tag persisted to the newest post. Credentials are not included in the evidence.

A genuine headed Chromium run loaded the actual unpacked extension, used trusted OS-level input and Chromium's native host-consent prompt, and recorded the C8 Disable/re-enable assertions as true. See `evidence/eacca232-headed-revoke-proof.md`.

### v0.3.0 scenarios still requiring owner evidence

The new plan-preview, advanced-authoring, all custom-template modes, prompt panel, Undo success, Undo stale refusal, and 5-second cancellable refresh scenarios are covered by automated tests but have not been claimed as live-browser PASS in this environment. Run A19–A23 from `docs/manual-test-matrix.md` against the owner's Ghost installation before treating v0.3.0 as accepted.

## Independent review

The existing round-two source/security review is recorded in `evidence/c8-luna-round2-review.md`. The v0.3.0 candidate remains subject to the board's independent review and QA cards before release publication.

## Remaining gate

Technical verification is complete. Final acceptance remains with the repository owner. Follow `TESTING.md` against the owner's Ghost installation and Chromium environment before treating the private v0.3.0 release as accepted.
