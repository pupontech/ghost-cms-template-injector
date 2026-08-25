# Owner acceptance testing

Use a non-production or disposable post/page where possible. Do not record or commit cookies, passwords, tokens, private post content, or TLS keys.

## 1. Clean automated verification

```bash
git status --short
npm ci
npm run verify
```

Expected:

- The initial Git status is clean.
- Formatting, ESLint, strict TypeScript, and the production build pass.
- All Vitest tests pass.
- Manifest validation passes.
- `dist/` contains the generated extension bundles.

## 2. Load the unpacked extension

1. Open Chromium and visit `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select this repository directory—the directory containing `manifest.json`, not `dist/`.
5. Record the tested Git commit and Chromium/Ghost versions in your private test notes.

Expected: Chromium loads **Ghost-CMS Template Injector** without an extension error.

## 3. Grant narrowly scoped Ghost access

1. Open the extension setup page.
2. Enter the HTTPS Ghost installation base URL:
   - Root installation: `https://example.com/`
   - Subdirectory installation: `https://example.com/blog/`
3. Select **Enable**.
4. Accept Chromium's native permission prompt.
5. Reload the authenticated Ghost Admin editor.

Expected:

- Permission is requested explicitly; no site access exists before approval.
- Access is limited to the selected installation's `/ghost/*` Admin path.
- The toolbar appears on post/page editor routes only.
- It does not appear on unrelated origins or non-editor routes.

## 4. Apply and persist a preset

1. Create a disposable new post.
2. Note its initial body, custom excerpt, and tags.
3. Apply a bundled preset from the injected toolbar or popup.
4. Wait for Ghost's save/autosave state to settle.
5. Navigate away, reopen the post, and wait beyond another autosave interval.

Expected:

- One apply transaction runs; rapid duplicate activation does not duplicate work.
- The intended body, excerpt, and tag changes appear.
- Ghost reports a successful save.
- Body, excerpt, and tags remain correct after reopening.
- A later autosave does not revert any field.
- No unsupported template or snippet is silently accepted.

Repeat on a page if your workflow uses pages. For broader exploratory coverage, use `docs/manual-test-matrix.md`.

## 5. Verify Disable behavior

Keep one authenticated Ghost Admin editor document open.

1. Confirm the toolbar and preset actions work before Disable.
2. Return to the extension setup page and select **Disable**.
3. Return to the already-open editor without reloading it.
4. Open a new Ghost Admin tab or create a demonstrably new Admin document.

Expected:

- The setup page reports that access is disabled.
- The toolbar disappears from the already-open document.
- The already-loaded MAIN-world bridge no longer answers privileged requests.
- A newly opened/reloaded Admin document has no toolbar or responsive bridge.
- Other origins remain unaffected.

The automated headed evidence additionally verifies that dynamic registrations become empty and stale capability values remain rejected.

## 6. Verify re-enable behavior

1. Open setup again.
2. Enter the same Ghost installation base URL.
3. Select **Enable** and accept the native prompt if Chromium asks again.
4. Reload or open a new Ghost Admin editor.
5. Apply a preset to another disposable draft.

Expected:

- Scoped access and the toolbar return only for the intended installation.
- Preset application succeeds.
- Re-enable establishes a fresh capability; the old disabled capability is not reused.

## 7. Options and persistence smoke test

1. Open the extension options page.
2. Create a user preset and edit it.
3. Reload options and confirm it persists.
4. Export presets, then import the exported file.
5. Revert a bundled seed override or delete a user preset.

Expected:

- Bundled seeds are never modified in place.
- User changes persist in `chrome.storage.local`.
- Malformed or invalid imports are rejected without partial writes.
- Export/import round-trips without executable content.

## 8. Report a problem

Record only:

- Git commit, Chromium version, Ghost version, and installation URL shape (root/subdirectory)
- Which numbered step failed
- Sanitized console text and endpoint paths
- A redacted screenshot if needed

Never include cookie values, Authorization headers, session data, passwords, private keys, API tokens, or private post content. See `SECURITY.md` for security reports.

## 9. Test plain-text body templates

1. Open Extension options and select **Create / edit preset**.
2. Choose **Plain text template** and enter at least one non-whitespace line, optionally separated by blank lines.
3. Save, reload the Options page, and edit the preset again.
4. Confirm the text and line breaks are unchanged, then apply it to a disposable post or page.

Expected: each source line appears as a paragraph in Ghost; blank lines remain blank; `<script>`/HTML-looking text is displayed literally; tags, excerpt, and custom template metadata remain intact; and an empty or whitespace-only template is rejected before storage. Choosing **Serialized Lexical JSON** still exposes the advanced raw format, while **inline-html** remains fail-closed for live writes.
