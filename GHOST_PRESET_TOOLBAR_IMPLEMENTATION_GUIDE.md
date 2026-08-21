# Ghost Preset Toolbar — Implementation and Multi-Agent Delivery Guide

> **Status:** Build playbook. This document does not claim that the private Ghost editor bridge is already feasible; Phase 0 must prove it.
>
> **Architecture authority:** [`GHOST_PRESET_TOOLBAR_DECISION.md`](./GHOST_PRESET_TOOLBAR_DECISION.md)
>
> **Target source used for compatibility research:** [`ghost/`](./ghost/)

## 1. Purpose

This guide turns the technical decision into an executable engineering workflow. A future request such as **“build the Ghost preset toolbar”** should be treated as an instruction to:

1. use a dedicated Hermes Kanban board as the durable source of task truth;
2. use named Hermes profiles with different providers/models for distinct roles;
3. prove the two risky integration paths before building the full extension;
4. develop in isolated Git worktrees where tasks can safely run in parallel;
5. require independent review and real browser/Ghost verification before declaring completion.

Do not replace Kanban with an in-process `delegate_task` swarm for the main build. `delegate_task` is not durable and has one global child-model override; Kanban supports named profiles, per-card model/provider overrides, dependencies, reviews, retries, and an audit trail.

## 2. Non-negotiable technical contract

All workers must read the decision document before changing code. The following rules are hard requirements:

- `custom_template` is the complete filename **including `.hbs`**.
- Build Admin API URLs from the current installation subdirectory as `<subdir>/ghost/api/admin/…`.
- POST/PUT bodies use plural envelopes such as `{"posts":[…]}` or `{"pages":[…]}`.
- An ordinary MV3 content script runs in an isolated world and cannot directly access Ghost-owned Ember/React/Lexical objects.
- Active-editor writes require a narrowly scoped, capability-gated MAIN-world adapter and one Ghost-native save transaction.
- A separate API PUT is permitted only for a confirmed clean editor and must be followed by explicit live-store reconciliation or controlled reload.
- Packaged `presets.json` is read-only seed data; user edits live in `chrome.storage.local`.
- Body behavior is explicit: `replace`, `only-if-empty`, or `prompt`. There is no implicit append/merge in the MVP.
- API `lexical` and `?source=html` writes replace the whole body.
- Never store an Admin API token, OpenRouter key, NVIDIA key, OAuth token, or other secret in the repository or extension bundle.
- If Phase 0 cannot reach a stable live editor/model/native-save capability from MAIN world, stop and request an architecture decision. Do not hide the failure behind DOM automation or a stale-state API workaround.

## 3. Agent fleet and model assignment

Use four named Hermes profiles. The human-facing/default session remains the orchestrator; it creates and routes Kanban cards but should avoid implementing major features itself.

| Profile | Provider / model | Primary role | Typical cards |
| --- | --- | --- | --- |
| `ghostterra` | `openai-codex` / `gpt-5.6-terra` | Architect and decomposer | contracts, task DAG, bridge feasibility criteria, architecture decisions, final synthesis |
| `ghostox` | `openrouter` / `stealth/ox-alpha` | Primary coding worker | extension scaffolding, API client, state bridge, preset engine, UI integration |
| `ghostnim` | `nvidia` / `nvidia/nemotron-3-ultra-550b-a55b` | Independent adversarial reviewer | MV3 boundary, security, autosave races, API payload review, change requests |
| `ghostluna` | `openai-codex` / `gpt-5.6-luna` | Test, QA, and documentation worker | fixtures, unit/E2E tests, browser matrix, docs, release checklist |

### Why these assignments

- **Terra** handles architecture and decomposition, where broad context and balanced reasoning matter.
- **Ox Alpha** is assigned sustained implementation and production coding.
- **Nemotron 3 Ultra 550B-A55B** serves as a genuinely independent reviewer rather than reviewing its own implementation.
- **Luna** handles bounded, high-volume verification and documentation tasks economically.

Model identifiers can change. Before creating cards, query each provider’s live model catalog with `hermes model --refresh` or its provider picker. If an identifier has changed, update this guide and `AGENTS.md` with the verified replacement. Do not silently substitute a different model.

## 4. Provider and profile preflight

### Current canonical identifiers

```text
ChatGPT/Codex subscription:
  provider: openai-codex
  models:   gpt-5.6-terra, gpt-5.6-luna

NVIDIA Build/NIM:
  provider: nvidia
  model:    nvidia/nemotron-3-ultra-550b-a55b

OpenRouter:
  provider: openrouter
  model:    stealth/ox-alpha
```

The NVIDIA model is **Nemotron**, not “Omnitron.” The full model has 550B total parameters and 55B active parameters.

### Authentication facts

- Hermes supports **ChatGPT or Codex Subscription** through the `openai-codex` OAuth provider. Hermes documentation does not currently guarantee exact plan/quota accounting, so verify access instead of assuming it.
- NVIDIA Build/NIM requires `NVIDIA_API_KEY` in the relevant Hermes profile’s `.env` or a configured secret source.
- OpenRouter requires `OPENROUTER_API_KEY` in the relevant profile’s `.env` or a configured secret source.
- Never put keys in this repository, Kanban card bodies, comments, logs, or screenshots.

### Create the profiles

Run once, from outside an active worker run:

```bash
hermes profile create ghostterra --clone \
  --description "Architect for the Ghost preset toolbar; decomposes work, owns contracts, and synthesizes architecture decisions."

hermes profile create ghostox --clone \
  --description "Primary implementation engineer for the Ghost MV3 extension; writes production code and tests in isolated worktrees."

hermes profile create ghostnim --clone \
  --description "Independent adversarial reviewer for Ghost API, MV3 security, autosave consistency, and code quality."

hermes profile create ghostluna --clone \
  --description "QA, test, and documentation engineer for the Ghost preset toolbar and browser integration matrix."
```

`--clone` copies profile configuration and `.env`; verify what was copied without printing secrets. Configure each alias/profile with the normal Hermes provider wizard or profile alias:

```bash
# Generated profile aliases can run every Hermes subcommand.
ghostterra model   # choose ChatGPT/Codex subscription → gpt-5.6-terra
ghostluna model    # choose ChatGPT/Codex subscription → gpt-5.6-luna
ghostnim model     # choose NVIDIA Build/NIM → nvidia/nemotron-3-ultra-550b-a55b
ghostox model      # choose OpenRouter → stealth/ox-alpha
```

For ChatGPT/Codex OAuth, authenticate inside each relevant profile if its cloned auth is unavailable:

```bash
ghostterra auth add openai-codex
ghostluna auth add openai-codex
```

Then verify all profiles:

```bash
hermes profile list
ghostterra doctor
ghostluna doctor
ghostnim doctor
ghostox doctor
```

A build must not start until all four profiles appear and can complete a harmless one-shot inference. If a provider is unavailable, block the Kanban root card and ask the user whether to wait or approve a specific substitute.

## 5. Repository and workspace layout

Create the implementation as a separate repository, not inside the checked-out Ghost source:

```text
/root/ghost-research/
├── GHOST_PRESET_TOOLBAR_DECISION.md
├── GHOST_PRESET_TOOLBAR_IMPLEMENTATION_GUIDE.md
├── AGENTS.md
├── ghost/                         # upstream Ghost reference/test target; do not vendor changes
└── ghost-preset-toolbar/          # new extension repository created during build
```

Initialize `/root/ghost-research/ghost-preset-toolbar` as Git before dispatching coding cards. Use Kanban `worktree` workspaces for cards that change code. Do not run two workers in the same Git worktree. Research/review cards may use `dir:/root/ghost-research` when they are read-only.

Recommended implementation-repository contents:

```text
ghost-preset-toolbar/
├── AGENTS.md                      # copied/adapted project rules
├── README.md
├── package.json
├── manifest.json
├── presets/presets.json          # read-only defaults
├── src/
│   ├── background.*
│   ├── content-script.*
│   ├── page-bridge.*
│   ├── ghost-api.*
│   ├── ghost-state.*
│   ├── preset-engine.*
│   ├── preset-store.*
│   └── ui/*
├── options/*
├── tests/
│   ├── unit/*
│   ├── contract/*
│   └── e2e/*
└── docs/
    ├── compatibility.md
    ├── security.md
    └── manual-test-matrix.md
```

## 6. Kanban bootstrap

### Create a dedicated board

After the implementation repository exists:

```bash
hermes kanban init
hermes kanban boards create ghost-preset-toolbar \
  --name "Ghost Preset Toolbar" \
  --description "MV3 Ghost Admin preset toolbar implementation" \
  --icon "👻" \
  --default-workdir /root/ghost-research/ghost-preset-toolbar \
  --switch
```

Use the board slug explicitly in automation:

```bash
hermes kanban --board ghost-preset-toolbar list
hermes kanban --board ghost-preset-toolbar watch
hermes dashboard
```

### Card requirements

Every card body must include:

- objective and non-goals;
- exact files/components owned by the card;
- decision-document sections that constrain it;
- parent-card results it depends on;
- acceptance criteria;
- exact tests/commands to run;
- required artifacts and completion evidence;
- instruction to request review rather than self-approve.

Use `--goal` for implementation cards so the worker continues until its acceptance criteria pass. Use `--max-runtime` and `--max-retries` to bound unattended work. Use `--idempotency-key` so restarting orchestration does not duplicate cards.

### Per-card model pinning

Even when profile defaults are correct, pin provider/model on critical cards for an auditable record:

```bash
# Examples only; replace title/body with the full card specification.
hermes kanban --board ghost-preset-toolbar create "Architecture and contracts" \
  --assignee ghostterra --provider openai-codex --model gpt-5.6-terra \
  --workspace dir:/root/ghost-research --goal --goal-max-turns 20 \
  --idempotency-key ghost-preset-architecture

hermes kanban --board ghost-preset-toolbar create "Implement preset engine" \
  --assignee ghostox --provider openrouter --model stealth/ox-alpha \
  --workspace worktree --branch wt/preset-engine --goal --goal-max-turns 30 \
  --idempotency-key ghost-preset-engine

hermes kanban --board ghost-preset-toolbar create "Adversarial architecture review" \
  --assignee ghostnim --provider nvidia --model nvidia/nemotron-3-ultra-550b-a55b \
  --workspace worktree --branch wt/architecture-review --goal --goal-max-turns 20 \
  --idempotency-key ghost-preset-architecture-review

hermes kanban --board ghost-preset-toolbar create "Build test fixtures and QA matrix" \
  --assignee ghostluna --provider openai-codex --model gpt-5.6-luna \
  --workspace worktree --branch wt/test-matrix --goal --goal-max-turns 25 \
  --idempotency-key ghost-preset-tests
```

## 7. Required task graph

The orchestrator should create and link this dependency graph. Parallelize only cards with disjoint file ownership.

### Gate 0 — Preconditions

1. **Architecture contract and task decomposition — Terra**
   - Turn the decision into testable interfaces and card bodies.
   - Define the bridge capability contract and failure semantics.
   - Produce no production implementation.

2. **API/auth feasibility spike — Ox Alpha**
   - Verify cookie-authenticated reads and plural-envelope writes on a clean disposable post/page.
   - Verify subdirectory URL derivation, tags, excerpt, template, snippets, and themes response shapes.
   - Continue editing after API reconciliation/reload to prove no stale-state reversion.

3. **MAIN-world editor/native-save spike — Ox Alpha**
   - Prove that the supported Ghost checkout exposes a reachable live model, live Lexical state, dirty/save status, relation update path, and one native save operation.
   - Prove isolated↔MAIN message transport without generic eval/property/fetch exposure.
   - Abort without mutation when capability checks fail.

4. **Spike review — Nemotron**
   - Independently inspect source, spike code, browser evidence, and race tests.
   - Request changes for unsupported assumptions.

5. **Architecture gate — Terra**
   - Synthesize the spike/review results.
   - Mark the root build ready only if both spikes pass.
   - Otherwise block the board with the exact unresolved decision.

No scaffold or feature card may pass this gate by assuming the bridge works.

### Phase 1 — Foundation

6. **MV3/TypeScript scaffold — Ox Alpha**
7. **Contract fixtures and test harness — Luna**
8. **Security/threat-model baseline — Nemotron**

Required outputs include linting, type checking, unit test runner, extension build, fixture payloads, and a documented compatibility target.

### Phase 2 — Pure logic and storage

9. **Preset schema and validator — Ox Alpha**
10. **Per-field merge/planning engine — Ox Alpha**
11. **Packaged defaults + `chrome.storage.local` repository — Ox Alpha**
12. **Unit/property tests for modes and validation — Luna**
13. **Independent logic/storage review — Nemotron**

The pure engine must be testable without a browser or Ghost instance.

### Phase 3 — Ghost integration

14. **Admin API client — Ox Alpha**
15. **MAIN-world bridge protocol — Ox Alpha**
16. **Versioned live Ghost state adapter — Ox Alpha**
17. **Autosave/collision/recovery tests — Luna**
18. **MV3/API/race adversarial review — Nemotron**
19. **Architecture reconciliation — Terra**

Cards 14–16 should not edit the same files concurrently unless each has an explicitly separated module and integration ownership is assigned to a later card.

### Phase 4 — User experience

20. **Popup and route detection — Ox Alpha**
21. **Options CRUD/import/export UI — Ox Alpha**
22. **Optional injected toolbar — Ox Alpha**
23. **Accessibility, popup-closure, and permission UX tests — Luna**
24. **Security/privacy review — Nemotron**

Host permissions should be exact or optional and user-granted; do not ship a literal wildcard placeholder.

### Phase 5 — Integration and release gate

25. **Atomic end-to-end apply integration — Ox Alpha**
26. **Real Ghost/browser test matrix — Luna**
27. **Final source/API/security review — Nemotron**
28. **Change reconciliation and release synthesis — Terra**
29. **Human acceptance gate — unassigned/blocked until user approval**

The final implementation card may request review, but only the independent review and human gate can move the release to done.

## 8. Review and handoff protocol

- Implementers call `kanban_request_review` rather than `kanban_complete` when code is ready.
- The reviewer must read the diff, inspect cited Ghost source, and run relevant tests independently.
- Review comments must distinguish blockers from suggestions.
- `kanban_request_changes` returns the task to the implementer with exact required fixes.
- Completion summaries include changed files, tests and real outputs, known limitations, and artifact paths.
- Workers emit `kanban_heartbeat` during long browser/build/test operations.
- A blocked card states what human decision or credential is needed; it must not invent a fallback.

For colliding branches, use a dedicated reconciliation card assigned to Terra or the `merge-reconciler` skill. Do not ask one implementation worker to silently overwrite another worker’s changes.

## 9. Engineering quality gates

A card is not complete merely because files exist.

### Required automated gates

- dependency lockfile committed;
- formatter and linter pass;
- TypeScript type checking passes;
- unit tests pass;
- contract tests cover posts/pages/snippets/themes envelopes and paths;
- extension production build succeeds;
- manifest validation passes;
- no secrets or broad accidental host permissions appear in built artifacts;
- changed production behavior has a regression test.

### Required integration gates

Test at least:

- saved post and saved page;
- brand-new post/page before first autosave;
- dirty body, title, excerpt, tags, and template;
- `replace`, `only-if-empty`, `prompt`, and tag `merge`;
- missing snippet and invalid `.hbs` template;
- root and subdirectory Ghost installs if fixtures permit;
- rapid double-click/apply locking;
- popup closure during operation;
- failed native save and recoverable rollback state;
- clean-state API fallback followed by continued editing/autosave;
- unsupported Ghost version/capability abort without partial mutation;
- extension reload and browser restart persistence.

### Security gates

- bridge operation allowlist only;
- strict request/response schemas, request IDs, and source checks;
- no generic eval, arbitrary property access, unrestricted fetch proxy, or secret bridge;
- no Admin API token bundled or persisted;
- preset imports validated and size-limited;
- rendered preset names/descriptions treated as untrusted text;
- minimum host permissions and explicit setup consent;
- no remote code execution or remotely hosted extension logic.

## 10. Orchestrator behavior for a future “build it” prompt

When a future user asks to build this project, the orchestrator must:

1. read `AGENTS.md`, the decision document, and this guide;
2. inspect current files and Git state;
3. verify all four profiles/providers/models and never expose credentials;
4. initialize or reuse the `ghost-preset-toolbar` board;
5. inspect existing cards/idempotency keys before creating anything;
6. create the dependency graph beginning with Gate 0;
7. start or verify the gateway dispatcher, or run explicit dispatch passes;
8. monitor cards through Kanban and report blockers rather than bypassing them;
9. prevent parallel edits to the same files/worktree;
10. require independent review and real test evidence;
11. leave the human acceptance gate open for the user;
12. return links/IDs for the board tasks and the final artifact location.

A normal `delegate_task` may still be used *inside* a Kanban worker for a short, read-only reasoning subtask, but it must not own Kanban state, replace a named model lane, or perform untracked production edits.

## 11. Recommended build prompt

Use this from `/root/ghost-research`:

```text
Build the Ghost preset toolbar described in GHOST_PRESET_TOOLBAR_DECISION.md.
Follow AGENTS.md and GHOST_PRESET_TOOLBAR_IMPLEMENTATION_GUIDE.md exactly.
Use the durable ghost-preset-toolbar Kanban board and the required ghostterra,
ghostox, ghostnim, and ghostluna model lanes. Begin with the two mandatory
feasibility spikes; do not proceed past the architecture gate unless they pass.
Use isolated Git worktrees, TDD, independent review, real Ghost/browser tests,
and keep the final human acceptance card open for me. Do not silently substitute
models, weaken the MV3/native-save contract, or claim success without test output.
```

## 12. Operational references

- Hermes Kanban: <https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban>
- Hermes profiles: <https://hermes-agent.nousresearch.com/docs/user-guide/profiles>
- Hermes providers: <https://hermes-agent.nousresearch.com/docs/integrations/providers>
- Hermes delegation: <https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation>
- NVIDIA Nemotron 3 Ultra 550B-A55B: <https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b>
- OpenRouter Ox Alpha: <https://openrouter.ai/stealth/ox-alpha>
