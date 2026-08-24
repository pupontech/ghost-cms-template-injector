# Contributing

This is a private pre-1.0 project. Keep changes focused, reviewable, and supported by tests.

## Development workflow

1. Branch from `main` using `feat/`, `fix/`, `test/`, `docs/`, or `chore/` prefixes.
2. Install exactly from the lockfile with `npm ci`.
3. Add or update tests before changing behavior where practical.
4. Run `npm run verify` before opening a pull request.
5. Use a conventional commit subject, for example `fix(bridge): reject stale capability after disable`.
6. Describe manual browser coverage and any untested environment assumptions in the pull request.

## Required safeguards

- Do not add static host permissions or broad runtime grants. The manifest's optional HTTPS pattern exists only so setup can request one concrete installation; runtime registrations must remain exact-path scoped.
- Do not add remote executable code.
- Do not add a `chrome.tabs` dependency to the toolbar path.
- Preserve root and subdirectory Ghost installations.
- Preserve `.hbs` in `custom_template` values and plural API envelopes.
- Keep seed presets read-only; editable values belong in `chrome.storage.local`.
- Keep credentials and private content out of commits, tests, fixtures, logs, and screenshots.
- Never represent synthetic DOM or headless injection as genuine MV3 browser evidence.

## Pull-request checklist

- [ ] `npm run verify` passes from a clean install.
- [ ] Permissions and manifest changes are explained.
- [ ] New behavior has automated coverage.
- [ ] Relevant real Chromium/Ghost behavior was tested or explicitly marked pending.
- [ ] Evidence is redacted.
- [ ] No generated `dist/`, `node_modules`, browser profile, credential, cookie jar, or local TLS key is committed.
