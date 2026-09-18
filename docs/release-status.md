# Release status — v0.3.0 owner acceptance pending

## v0.5.1 (unreleased) — import moved into the Options page

Per the owner's workflow, the popup carries a single **Import as template** button that opens the
Options page's import section; the picker/name/title/status controls live there. The Options page has
no content script, so it reads through a service-worker route that targets a Ghost Admin tab the user
has already granted (editor route preferred, target chosen by the worker, no `tabs` permission). The
live proof asserts the delivered section is live and refuses to store anything before a capture.

## v0.5.0 — import a Ghost post as a preset

Branch `feat/feature-image` (now carrying both features) adds post import on top of v0.4.0: the popup
panel and the toolbar button turn an existing post/page into a preset (body, excerpt, tags, custom
template, feature image; the title is opt-in), with the same schema validation, bounds, group, and
fail-closed rules as hand-authored presets. The live proof in `evidence/post-import-live-proof.md`
captures a real post through the production capture modules, and applies the captured preset to a
different draft through the production planner and MAIN-world bridge, confirming every field by an
authenticated Admin API readback. That proof also found and fixed a real defect: a `/content/…`
feature image was written correctly but rejected by the post-save readback as `SAVE_FAILED` because
Ghost stores the absolute URL — the comparison is now normalization-aware (`featureImageMatches`).

Not yet claimed: the isolated content-script path (the optional host-permission consent bubble cannot
be accepted by headless automation) and owner acceptance on a real Ghost installation. Run A24–A30
from `docs/manual-test-matrix.md` before treating v0.5.0 as accepted.

## v0.4.0 — feature image

Branch `feat/feature-image` adds the preset feature image (post top image) with a local photo cache.
`npm run verify` is green (34 files, 467 tests) and the real-browser + real-Ghost proof is recorded in
`evidence/feature-image-live-proof.md` (photo cached in the extension runtime, byte-identical over the
service-worker channel, page-origin upload accepted by Ghost, feature image persisted and re-read
through the Admin API). The built release ZIP was loaded as an unpacked extension in real Chromium
(`tests/e2e/release-zip-load-check.mjs`, manifest version 0.4.0, zero load errors).

Not yet claimed: a live pass of the **isolated content-script** path (the optional host-permission
consent bubble cannot be accepted by headless automation) and owner acceptance on a real Ghost
installation. Run the feature-image scenarios from `docs/manual-test-matrix.md` before treating v0.4.0
as accepted.

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
