# Ghost-CMS Template Injector project rules

These rules apply only inside this repository. `$HERMES_HOME/SOUL.md` is identity-only and must not carry project rules; do not modify it unless the owner explicitly asks for an identity change.

## Sources of truth and required reading

1. The GitHub Issue is the authoritative product/work record.
2. The `ghost-preset-toolbar` Hermes Kanban card executes that issue and must link back to it.
3. Read the applicable OpenSpec proposal, `GHOST_CMS_TEMPLATE_INJECTOR_DECISION.md`, `GHOST_CMS_TEMPLATE_INJECTOR_IMPLEMENTATION_GUIDE.md`, and relevant Ghost source before implementation.
4. If documents conflict, stop and record the discrepancy in the issue; do not guess.

No implementation begins before an OpenSpec proposal links the architecture decision, risk assessment, acceptance tests, and owner approval. Emergency security containment may make the minimum necessary secret-removal change first, then must open the retrospective proposal.

## Git, worktrees, and review

- Use `npm run worktree:init -- --name <slug>` for a new isolated writer workspace. It never deletes or reuses a worktree.
- One editing worker owns one worktree and an explicit file set. Never run overlapping writers.
- Never run `git clean`, `git reset --hard`, `git checkout .`, bulk worktree removal, history rewrite, or file truncation/replacement without first reading the target and receiving explicit owner approval.
- Agents may open a PR and request review, but must never self-approve, self-merge, or bypass required checks. The owner or an independent reviewer merges only after CI and acceptance evidence are current.

## Required Hermes preflight

Before dispatching a build card, confirm named profiles and live model/provider access without exposing credentials:

- `ghostox`: `openrouter` / `stealth/ox-alpha` (preferred free worker lane)
- `ghostnim`: `nvidia` / `nvidia/nemotron-3-ultra-550b-a55b` (permitted free-worker fallback)
- `ghostterra` and `ghostluna` are GPT-family profiles reserved for the primary orchestrator only; never assign them as worker lanes.

Load the matching Hermes/Kanban, GitHub, testing, security, and browser-control skills before acting. Do not silently substitute a lane: block the card and ask the owner.

## Non-negotiable safety contract

- `custom_template` includes `.hbs`; Admin API URLs derive from `<subdir>/ghost/api/admin/`; writes use plural post/page envelopes.
- Active-editor writes use the capability-gated MAIN-world bridge and one Ghost-native save. API fallback requires a clean editor plus reconciliation/reload.
- `presets.json` is read-only seed data; editable values use `chrome.storage.local`; body modes are explicit and never append implicitly.
- Never store keys, OAuth tokens, cookies, private Ghost content, browser profiles, or raw proof output in Git, Kanban, issues, PRs, CI logs, or screenshots.
- Do not use `curl | sh` or `curl | bash`; pin and verify executable downloads.
- Use `npm run safety:check` before opening a PR.

## Evidence and completion

- Raw live-proof output belongs in ignored `evidence/local/`. Only redacted, reviewed summaries may enter tracked `evidence/`.
- Do not call synthetic/headless/stubbed execution genuine headed browser evidence.
- A change is incomplete until formatting, lint, typecheck, tests, build, manifest validation, safety scan, independent review, and required owner browser acceptance have been recorded against the GitHub Issue and linked Kanban card.
