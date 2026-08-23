# Release status — pending real-browser evidence

## Candidate

- Extension integration branch: `wt/t_40b1ed27`
- Candidate commit: `687815e`
- Compatibility research target: Ghost `af4af7d`
- Chromium used for the attempted proof: `151.0.7922.169`

## Automated verification

On the candidate worktree, `npm run verify` passed:

- Prettier format check
- ESLint
- TypeScript type check
- Vitest: 23 files, 262 tests
- Manifest and built-artifact validation
- Production bundle build (`dist/background.js`, `dist/content-script.js`, `dist/popup.js`, `dist/toolbar.js`, `dist/options.js`, `dist/setup.js`, and `dist/bridge.js`)

The manifest is MV3 with `storage` and `scripting` permissions, no static host permissions, and optional host permission `https://*/ghost/*`. The setup page asks the user to grant one exact Ghost HTTPS origin before it dynamically registers the content script.

## Real Ghost/browser gate: BLOCKED

The real-browser proof harness, `tests/e2e/real-ghost-browser-proof.mjs`, was run locally against the available Ghost listener and Chromium. It failed before mutation or persistence verification:

```text
lexical editor route reached: false
Editor route never came up — aborting proof.
```

No `evidence/live-proof.md` was produced. The manual matrix in `docs/manual-test-matrix.md` remains unfilled. Consequently, this candidate does not yet have the required evidence for saved/unsaved posts and pages, dirty editor state, all body/tag modes, autosave races, recovery, permissions, persistence, and root/subdirectory behavior.

## Installation for the next QA run

1. Run `npm install` and `npm run build` in the candidate worktree.
2. In Chromium, open `chrome://extensions`, enable Developer mode, and select **Load unpacked** for the candidate worktree.
3. Open the extension setup page and explicitly grant the exact HTTPS origin serving Ghost Admin. Reload Ghost Admin afterward.
4. Use a disposable, authenticated Ghost instance and complete the matrix in `docs/manual-test-matrix.md`, retaining only redacted evidence.
5. Re-run the real-browser proof or replace it with a validated browser procedure that exercises the actual MV3 isolated content script and MAIN-world bridge.

## Human acceptance

The human acceptance card remains intentionally blocked. It must not be completed until the real-browser gate has successful, redacted evidence and the user explicitly accepts the release.
