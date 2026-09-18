# Changelog

## 0.5.1 — unreleased

### Changed

- **The import UI now lives in the Options page, not the popup.** The popup keeps a single
  **Import as template** button that opens the Options page on its new _Import a post as a preset_
  section, where the source picker, name, title opt-in, status, and Import button live — next to the
  preset form the owner already uses.
- Because the Options page is an extension origin, it cannot read your Admin API or the live editor
  itself. It asks the extension's **service worker**, which routes the same read-only operations to a
  Ghost Admin tab you have already granted (an editor route when one is open) and reports an
  actionable message when no such tab exists. The target tab is chosen by the worker, never by the
  page, and no `tabs` permission was added.
- The preset-collection import keeps its own card and is now labelled **Import presets (JSON)** so the
  two imports are unmistakable.

### Verification

- `npm run verify` green: formatting, ESLint, strict TypeScript, production build, manifest/built-artifact
  validation, and the Vitest suite (38 files, 556 tests).
- The post-import live proof was re-run against real Ghost 6.59 and now also asserts that the delivered
  Options section is live, refuses to store anything before a post is read, and reports the reason it
  cannot read a Ghost tab in a headless browser. See `evidence/post-import-live-proof.md`.

## 0.5.0 — unreleased

### Added

- **Import an existing Ghost post as a preset.** The popup gains an **Import a post as a preset**
  panel: pick the post open in the editor or any post/page from this site (the picker is filled from
  your own Admin API, newest first), name the preset, optionally capture the title, and import. The
  generated editor toolbar offers the same thing as a one-click **Save this post as a preset** button.
- Captured fields and their default modes: body (`replace`, the post's serialized Lexical), excerpt
  (`only-if-empty`), tags (`merge`), custom template (`only-if-empty`, only `.hbs` values), feature
  image (`only-if-empty`, stored as a portable same-origin `/content/…` path). The **title is not
  captured by default** — a preset carrying a title would rename every post it is applied to.
- Imported presets land in an **Imported** group, record their provenance in the description, pass
  the same schema validation as hand-written presets, and can be edited in the Options page
  afterwards.
- Import is fail-closed and honest about what it could not capture: a blank or unreadable body aborts
  the import with a reason, an over-limit excerpt is trimmed and reported, a non-`.hbs` custom
  template or unacceptable image URL is skipped with a warning, and importing while the editor has
  unsaved changes says so (the stored record is read through the Admin API whenever the editor is
  clean).

### Fixed

- **Feature image written as a `/content/…` path no longer reports a false failure.** Ghost normalizes
  the value to an absolute URL on the record, so the post-save readback compared the literal text and
  rejected a save that had in fact succeeded (`SAVE_FAILED`, escalating to `ROLLBACK_FAILED` when the
  transaction also had to roll back). The comparison now resolves both sides (`featureImageMatches`)
  and is used by both the state adapter and the MAIN-world bridge. Found by the post-import live
  proof, which applies a preset captured from a real post.

### Verification

- `npm run verify` green: formatting, ESLint, strict TypeScript, production build, manifest/built-artifact
  validation, and the Vitest suite (35 files, 529 tests).
- Real-Ghost + real-Chromium post-import proof (`npm run proof:post-import`, Ghost 6.59 behind a local
  TLS proxy, production bundles compiled from this tree with esbuild): a real post was created through
  the Admin API and read back with the extension's own query, captured into a schema-valid preset
  (body byte-identical, excerpt, tags, custom template, portable feature image, title deliberately
  absent), a blank draft aborted the import as a negative control, the captured document was accepted
  by the real options page's store, and the production planner + MAIN-world bridge then applied it to a
  **different** draft with one native save — excerpt, tags, custom template, body and top image all
  confirmed by authenticated Admin API readback and by the database row. See
  `evidence/post-import-live-proof.md`.
- The v0.4.0 feature-image proof was re-run after the readback fix: still PASS
  (`evidence/feature-image-live-proof.md`).

## 0.4.0 — unreleased

### Added

- **Feature image (the editor's top image) in presets.** A preset can carry a photo plus a write mode
  (`only-if-empty` default, `replace`, `prompt`). The photo is cached in the extension's own IndexedDB
  (content-addressed `img_<sha256>` id, PNG/JPEG/WebP/GIF, 8 MB cap); the preset document stores only
  that id, so it stays far below the 256 KB document bound.
- On apply, a cached photo is uploaded once to the target Ghost installation through Ghost's own
  `POST <admin>/images/upload/` (multipart, session cookie) and the returned URL is memoized per
  installation, so repeat applies reuse the same media. An unresolvable photo **blocks the whole
  plan** instead of applying a post without its image.
- The feature image participates in the atomic transaction: rollback, undo, stale-editor detection,
  and post-save readback verification all cover the field.

### Verification

- `npm run verify` green: formatting, ESLint, strict TypeScript, production build, manifest/built-artifact
  validation, and the Vitest suite (34 files, 467 tests).
- Real-browser + real-Ghost proof (`node tests/e2e/feature-image-proof.mjs`, Ghost 6.59 behind a local
  TLS proxy): photo cached in the extension runtime and returned byte-identical over the service-worker
  asset channel; preset document measured at 283 bytes with the photo attached; page-origin multipart
  upload accepted by Ghost (`201`, `/content/images/2026/09/...`); production MAIN-world bridge applied
  the image with one native save; authenticated Admin API readback and the database row both confirm
  `feature_image`. See `evidence/feature-image-live-proof.md`.
- Known limit of that proof: the isolated content-script registration needs Chrome's optional
  host-permission consent bubble, which headless automation cannot accept, so the proof drives the same
  production MAIN-world bundle and the same request shape the content script issues.

## 0.3.0 — 2026-09-02

### Added

- Read-only field-aware preview before preset mutation.
- One-use Undo for the last successful apply, guarded against stale editor state.
- Visible advanced preset authoring for body sources, per-field modes, snippets, custom templates, groups, and icons.
- C1 prompt panel with explicit confirmation/cancellation.

### Fixed

- Isolated/Main bridge now validates source, origin, closed payloads, and clone-safe responses.
- Custom-template `replace`, `only-if-empty`, and `prompt` modes now use the live snapshot and active-theme allowlist.
- Native-save and rollback paths verify live readback and preserve distinct failure codes.
- Context resolution uses a success-only 60-second cache with an explicit reset hook.
- Apply busy protection runs at the message boundary.

### Verification

- Full Vitest suite: 32 files, 382 tests.
- Full typecheck and production build are required before publishing.
- New real-Ghost/browser scenarios remain owner acceptance gates; no live-browser PASS is claimed from this environment.
