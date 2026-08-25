# Release status — owner acceptance pending

## Candidate

- Final private-main candidate: the current `main` HEAD
- Genuine headed lifecycle implementation/evidence lineage: `45f7fc0`
- Compatibility target exercised: Ghost 6.60
- Chromium: 151.0.7922.169
- Extension platform: Manifest V3

## Automated verification

The final C8 worktree passed `npm run verify`:

- Prettier format check
- ESLint
- Strict TypeScript check
- Production build
- Vitest: 32 files, 326 tests
- Manifest and built-artifact validation

Focused bridge/capability verification also passed: 5 files, 39 tests.

The manifest uses only `storage` and `scripting`, has no static host permission, and declares the existing optional HTTPS Ghost Admin pattern. The setup page requests explicit native permission for one concrete installation before dynamically registering isolated and MAIN-world scripts for that installation's `/ghost/*` pages.

## Real Ghost/browser gates

### Preset persistence

A genuine headed Chromium run against authenticated Ghost Admin verified that the body, custom excerpt, and tag persisted after the native save and remained correct beyond the subsequent autosave interval. See `evidence/ef2721b1-headed-rerun.md`.

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

The round-two source/security review is recorded in `evidence/c8-luna-round2-review.md`. Its original headed-evidence blocker was resolved by commits `d1b1a1f` and `45f7fc0`, followed by the genuine all-green C8 run above.

## Remaining gate

Technical verification is complete. Final acceptance remains with the repository owner. Follow `TESTING.md` against the owner's Ghost installation and Chromium environment before treating the private pre-1.0 release as accepted.
