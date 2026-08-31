# Phase-4 manual QA matrix

This matrix is the release evidence checklist for the popup, options page, and optional injected toolbar. Run it against a disposable Ghost installation with a real authenticated Admin session. Do not enter credentials into test logs or screenshots.

Legend: `PASS` means observed and recorded with browser/version/date evidence; `BLOCKED` means the environment was unavailable; `FAIL` requires a defect card before release.

## Environment record

- Ghost version / commit: ____________________
- Chromium version: ____________________
- Install URL shape: root / subdirectory (`____________________`)
- Extension build commit: ____________________
- Test date: ____________________
- Browser profile: disposable authenticated profile (no exported cookies)

## Automated preflight

- [ ] `npm run format:check`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run manifest:validate`
- [ ] `npm run build`
- [ ] Inspect `dist/` for credentials, remote code, and unexpected host strings.
- [ ] `npm run safety:check`

## Browser matrix

| ID  | Scenario                                                      | Expected evidence                                                                                                                                                                         | Result / notes |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| A1  | Open popup on a saved post editor                             | Popup reports `Editing: saved post <id> · clean`; preset buttons are reachable with Tab and activate with Enter/Space.                                                                    |                |
| A2  | Open popup on a saved page editor                             | Popup reports Page, not Post; no cross-resource wording.                                                                                                                                  |                |
| A3  | Open popup on a brand-new post and page before first autosave | Popup reports `new unsaved draft`; it does not attempt an API-only write.                                                                                                                 |                |
| A4  | Dirty body/title/excerpt/tags/template                        | Popup/toolbar reports unsaved state; applying uses the long-lived content-script transaction.                                                                                             |                |
| A5  | Close popup immediately after clicking Apply                  | Close the popup while the apply promise is pending; Ghost continues the apply and shows final success/error after reopening.                                                              |                |
| A6  | Rapid double-click Apply                                      | Only one apply transaction is accepted; the second click is rejected or safely ignored without duplicate mutation.                                                                        |                |
| A7  | Editor → list → editor                                        | Injected toolbar mounts only on post/page editor routes, is removed on list/unknown routes, and remounts on return.                                                                       |                |
| A8  | Browser back/forward and hash-only route changes              | Same mount/unmount behavior occurs without a full reload.                                                                                                                                 |                |
| A9  | Toolbar accessibility                                         | Root exposes `role=toolbar` and an accessible label; each preset button has its preset name as `aria-label`; status is a polite live region.                                              |                |
| A10 | Popup accessibility                                           | Status is announced by `role=status`; preset controls are native buttons; no focus trap or keyboard-only dead end.                                                                        |                |
| A11 | Options page initial load                                     | Bundled defaults appear; seeded rows say `Revert`, and all names/descriptions are rendered as text.                                                                                       |                |
| A12 | Create and edit a preset                                      | Save, reload options page, and confirm the value persists in `chrome.storage.local`; editing a seed creates an override rather than mutating packaged data.                               |                |
| A13 | Revert/delete                                                 | Revert a seeded preset and delete a user preset; reload and confirm the expected state persists.                                                                                          |                |
| A14 | Import/export                                                 | Import valid JSON; reject malformed/oversized/unvalidated JSON without partial persistence; export is downloadable and round-trips after reload.                                          |                |
| A15 | Optional permission setup                                     | With no site access initially, confirm setup is explicit and user-granted; deny permission and verify the extension remains usable without broad access. Record the exact origin granted. |                |
| A16 | Extension reload / browser restart                            | Reload the extension and restart Chromium; options overrides remain, and the toolbar does not appear on non-Ghost pages.                                                                  |                |
| A17 | Apply feedback                                                | Successful delegation announces that the popup can close; rejected delegation/error is visible in the status region and does not claim success.                                           |                |
| A18 | Privacy/security smoke check                                  | No API token prompt, secret storage, unexpected network request, wildcard host permission, or remote script is observed.                                                                  |                |

## Required negative cases

- [ ] Unsupported Ghost route/capability aborts visibly before mutation.
- [ ] Popup on a non-Ghost tab reports unsupported without sending a content-script message.
- [ ] Invalid `.hbs` template, missing snippet, and cancelled prompt leave the editor unchanged.
- [ ] Native-save failure leaves a recoverable error state and does not report success.
- [ ] A clean-editor API fallback, if exercised, is followed by reconciliation/reload before further editing.
- [ ] A subdirectory Ghost install derives its Admin API root correctly.

## Evidence record

For each failed or blocked case, record: matrix ID, Ghost/Chromium versions, sanitized console output, sanitized network endpoint (never cookies/tokens), and a screenshot with personal content redacted. The QA card must link the command output and state whether real Ghost/browser evidence was PASS, BLOCKED, or FAIL; do not represent unit/static tests as browser evidence.

## Current verified runs

- Latest local test run: `npm test` passed with 34 test files / 372 tests. The full release gate must be rerun and recorded against the final remediation commit.
- Preset-persistence production-bundle proof: headless CDP only; it is **not** genuine headed-browser acceptance. Keep its raw output local under `evidence/local/` and do not link it as headed evidence.
- Genuine headed C8 lifecycle: PASS for explicit native consent, exact scoped registrations, current/new-document silence after Disable, stale-token rejection, and fresh-capability re-enable; see `evidence/eacca232-headed-revoke-proof.md`.
- Owner acceptance: pending completion of `TESTING.md` in the owner's environment, including any required headed persistence run.
