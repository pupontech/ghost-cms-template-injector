# Gate-0 Architecture Contract — Ghost Preset Toolbar

Status: provisional until both feasibility spikes pass, independent review completes, and the architecture gate approves. This document defines contracts, not a claim that private Ghost editor access is feasible.

## Compatibility target and evidence

Target: the checked-out Ghost Admin implementation at `/root/ghost-research/ghost`, exercised against a disposable authenticated local Ghost instance of the same commit/version in Chromium. Browser evidence must include a clean saved post and page, a new unsaved post and page, and a dirty existing editor. Record Ghost commit/version, Chromium version, installation URL (including subdirectory when used), request/response redacted HAR or equivalent, screenshots/video, and command logs as task artifacts. No credential, cookie, token, or CSRF value may appear in artifacts.

Source anchors: `ghost/apps/ember-admin/app/utils/ghost-paths.js:17-39` derives `subdir`, `/ghost/`, and the Admin API root; `routes/lexical-editor/new.js:9-30` creates client-only new posts/pages; `controllers/lexical-editor.js:225-231,311-324,577-666` exposes the observed dirty/autosave/native save behavior; `services/ajax.js:253-269` sets cookie credentials; `models/theme.js:13-27` filters custom templates by blank slug; and `components/gh-psm-template-select.js:46-62` compares the full filename.

## Contract C1 — API base and envelopes

Input is an authenticated Ghost Admin URL containing `/ghost/`. Derive `subdir` as the path prefix before that segment and set `adminApiBase = origin + subdir + '/ghost/api/admin/'`. Reject URLs without exactly usable `/ghost/` Admin context; never default to root. API reads return and validate the documented plural resource root. Mutations use exactly one plural envelope matching the resource: `{posts:[record]}` or `{pages:[record]}`. Contract tests cover root and `/blog/ghost/` installations, posts and pages, malformed URL rejection, and rejection of singular payloads.

## Contract C2 — Capability discovery

The MAIN adapter exposes `discover`, which returns a versioned capability object only after proving identity/type (post or page), live record, live Lexical state, dirty/save status, relation mutation path, and one native-save operation are reachable. Unsupported, ambiguous, or changed internals return a structured `UNSUPPORTED_CAPABILITY` result and perform no mutation. Discovery is not generic property traversal.

## Contract C3 — Isolated↔MAIN bridge

Only a fixed allowlist is permitted: `discover`, `snapshot`, `planApply`, `apply`, `save`, and `rollback`. Every request and response carries protocol version, nonce/request ID, operation, and schema-valid structured-cloneable payload. The isolated side accepts replies only from its injected bridge identity and matching request ID. No `eval`, arbitrary property path, function name, unrestricted fetch, or extension API enters MAIN world. Invalid schema, duplicate request, origin/source mismatch, timeout, and unsupported operation fail closed without mutation. The bridge must serialize one apply transaction per editor tab.

## Contract C4 — Live transaction, save, and rollback

`snapshot` captures type/id-or-unsaved, live metadata, tags in display order, Lexical state/emptiness, dirty state, `updated_at` if available, and save activity. `planApply` resolves every dependency and validates all modes before changing state. `apply` mutates the live record/editor only after a valid plan; then invokes exactly one Ghost-native save transaction and verifies returned clean state and current `updated_at`. If mutation or save fails, attempt rollback from the pre-apply snapshot through the same live path; if rollback cannot be proven, retain a recoverable failure record and block further apply. A successful transaction must survive a subsequent user edit and Ghost autosave.

## Contract C5 — Preset schema, modes, and storage

Preset fields have a schema version, unique id, untrusted display strings, body content source, and per-field modes. Body modes are only `replace`, `only-if-empty`, and `prompt`; there is no append or merge. Metadata modes are explicitly validated per supported field; tag `merge` preserves existing normalized names/order and appends non-duplicates. `only-if-empty` and `prompt` use the live snapshot, never stale API data. Body API writes (`lexical` or `?source=html`) replace the whole body. A packaged `presets.json` is immutable seed data; all edits/imports live in validated, bounded `chrome.storage.local`, with import/export and migration tests.

## Contract C6 — Ghost data semantics

`custom_template` must exactly equal a valid active-theme custom template filename, including `.hbs`; valid choices are the active `themes[]` entry templates with blank `slug`. `custom_excerpt` is bounded to Ghost's accepted limit. Tags use full relation replacement on write; a merge operation starts from the live model/store relation and saves the resolved full list. Snippet lookup is exact local name matching over a validated plural `snippets[]` response and is body-only. Missing snippets/templates abort before mutation.

## Contract C7 — API-only fallback and reconciliation

API-only writes are forbidden for an unsaved or dirty open editor and forbidden if live-store reconciliation/reload cannot be proven. For a confirmed clean, saved editor the fallback uses C1 payloads and optimistic concurrency data, then reconciles the returned resource into the live store or performs a controlled reload before editing resumes. Its evidence must prove a subsequent edit/autosave cannot revert preset fields.

## Contract C8 — Security and permissions

Use cookie-authenticated same-origin requests; never persist an Admin API key or any secret. Host permission is exact/optional and explicitly granted for the selected HTTPS Ghost origin; no wildcard placeholder or remote code. Validate imports and bridge messages, render preset strings as text, minimize manifest permissions, and audit source/build outputs for secrets and broad permissions.

## Gate and review sequencing

The two Phase-0 spikes run in separate worktrees and must each request review only after TDD evidence, browser evidence, and artifact paths exist. A dedicated independent spike-review card depends on both completed spikes; it completes or returns changes to the relevant spike. The Terra architecture-gate card depends on the completed review card and is the sole release parent for all downstream work. Therefore no review card races an implementation card, and no downstream card can run before a pass decision. Later implementation cards use the same pattern: implementer requests same-card review; reviewer completes/requeues it; dependent integration/release cards depend on the reviewed implementation's completion. A dedicated downstream review child is never also requested on the parent.

## Required production-card TDD and evidence

Every production card must: (1) create one focused behavior test, (2) run it and preserve expected RED output before implementation, (3) make the minimum implementation, (4) rerun GREEN, then formatter/linter/typecheck/full regression/production build, and (5) attach exact logs and artifacts. Browser cards additionally record the scenario matrix: saved and unsaved posts/pages, dirty fields, every mode, autosave race, recovery, permissions, persistence, root/subdirectory paths, and capability failure.

## Stop conditions

If either Phase-0 spike cannot prove its contract, the architecture gate blocks with the exact missing capability and requests a human decision. It must not replace the failure with DOM automation, direct stale-state PUTs, wildcard permissions, or an untracked secret.
