# Ghost Preset Toolbar Project Rules

This repository implements the architecture in the parent research workspace:

- `../GHOST_PRESET_TOOLBAR_DECISION.md`
- `../GHOST_PRESET_TOOLBAR_IMPLEMENTATION_GUIDE.md`
- `../AGENTS.md`
- `../ghost/` (authoritative Ghost source checkout)

Before planning or editing, read all three documents and inspect the relevant source under `../ghost/` for every Ghost behavior relied upon. If the decision and implementation guide conflict, stop and report the conflict.

## Hard technical invariants

- `custom_template` includes `.hbs`.
- Derive the Admin API root as `<subdir>/ghost/api/admin/`.
- Mutations use plural envelopes (`posts[]`, `pages[]`).
- MV3 isolated content scripts cannot directly access Ghost page-owned JavaScript state.
- Active-editor writes use a minimal, capability-gated MAIN-world adapter and one Ghost-native save transaction.
- API-only writes are clean-editor fallbacks and require reconciliation or reload before editing resumes.
- `presets.json` is read-only seed data; editable presets use `chrome.storage.local`.
- Body modes are `replace`, `only-if-empty`, or `prompt`; no implicit append/merge.
- API Lexical/HTML body writes replace the whole body.
- If stable live editor/native-save access cannot be proven in Phase 0, stop at the architecture gate. Never substitute fragile DOM automation.
- Never store provider credentials, Ghost Admin API tokens, or other secrets in source, tests, fixtures, logs, screenshots, or built artifacts.

## Delivery rules

- Work is tracked on the durable `ghost-preset-toolbar` Hermes Kanban board.
- Use strict RED → GREEN → REFACTOR TDD for production behavior.
- Parallel editing cards must use isolated Git worktrees and disjoint file ownership.
- Implementers request independent review; they do not self-approve.
- Record exact test/build/browser evidence and artifact paths on each card.
- Do not claim project completion before automated gates, real Ghost/browser integration tests, independent review, architecture reconciliation, and the user's final acceptance.
