# Changelog

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
