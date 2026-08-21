# Ghost Preset Toolbar Project Rules

These instructions apply to work started from `/root/ghost-research`.

## Required reading

Before planning or editing, read:

1. `GHOST_PRESET_TOOLBAR_DECISION.md` — authoritative technical architecture.
2. `GHOST_PRESET_TOOLBAR_IMPLEMENTATION_GUIDE.md` — authoritative delivery, Kanban, model-lane, testing, and review workflow.
3. Relevant source under `ghost/` for every Ghost behavior relied upon.

If the decision and implementation guide conflict, stop and resolve the conflict explicitly before coding.

## Mandatory orchestration for a build request

When the user asks to build, implement, scaffold, or finish the Ghost preset toolbar:

- Use the durable Hermes board `ghost-preset-toolbar`; do not manage the main build only with an ephemeral `delegate_task` swarm or a private TODO list.
- Inspect existing board cards and idempotency keys before creating cards.
- Use named profiles and pin the requested provider/model on critical cards:
  - `ghostterra`: `openai-codex` / `gpt-5.6-terra` — architecture, decomposition, synthesis.
  - `ghostox`: `openrouter` / `stealth/ox-alpha` — primary implementation.
  - `ghostnim`: `nvidia` / `nvidia/nemotron-3-ultra-550b-a55b` — independent adversarial review.
  - `ghostluna`: `openai-codex` / `gpt-5.6-luna` — tests, QA, documentation.
- Verify every profile, provider credential, and live model ID before dispatch. Never print or copy secrets into the repository or board.
- Do not silently substitute models. Block and ask the user if a required lane is unavailable.
- Run the two Phase-0 feasibility spikes and independent review before full implementation.
- Use isolated Git worktrees for parallel coding cards. Never run two editing workers in one worktree or give parallel cards overlapping file ownership.
- Require review cards and real test/build/browser evidence. Keep the final human acceptance gate open for the user.

## Technical invariants

- `custom_template` includes `.hbs`.
- Admin API root is derived as `<subdir>/ghost/api/admin/`.
- Mutations use plural envelopes (`posts[]`, `pages[]`).
- MV3 isolated content scripts cannot directly access Ghost page-owned JavaScript state.
- Active-editor writes use a minimal, capability-gated MAIN-world adapter and one Ghost-native save transaction.
- API-only writes are clean-editor fallbacks and require reconciliation or reload before editing resumes.
- `presets.json` is read-only seed data; editable presets use `chrome.storage.local`.
- Body modes are `replace`, `only-if-empty`, or `prompt`; no implicit append/merge.
- API Lexical/HTML body writes replace the whole body.
- If stable live editor/native-save access cannot be proven, stop at the architecture gate. Do not conceal the blocker with fragile DOM automation.

## Definition of done

Do not report completion until:

- formatting, linting, type checking, unit/contract tests, and production build pass;
- real Ghost/browser integration tests cover dirty and unsaved drafts, posts/pages, metadata, body modes, autosave races, recovery, permissions, and persistence;
- an independent `ghostnim` review is resolved;
- `ghostterra` reconciles the final architecture and branch results;
- no credentials or broad accidental permissions are present in source or built artifacts;
- artifacts and test outputs are recorded on Kanban;
- the user performs or explicitly approves the final acceptance gate.
