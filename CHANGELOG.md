# Changelog

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
