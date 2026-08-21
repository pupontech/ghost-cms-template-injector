# Ghost CMS Page/Post Preset Toolbar — Technical Decision Document

> **Scope:** Research, architecture, and approach decision only. No code has been written or modified.
> **Date:** 2026-08-21
> **Primary sources:** TryGhost/Ghost `main` branch (sparse clone inspected live), official Ghost docs (`docs.ghost.org`, current `/llms.txt` index), and PR #27656 ("Added a built-in theme code editor").

---

## 0. What the current Ghost codebase actually tells us (verified facts)

These are concrete findings from the live `main` branch of the Ghost monorepo, not from old tutorials:

1. **Editor is Lexical by default.** Ghost 6.x stores post/page body in a `lexical` column (`schema.js`: `lexical: {type:'text', maxlength:1e9}`). The legacy `mobiledoc` column still exists for back-compat but Lexical is the active default. The Admin editor is the Ember app `apps/ember-admin`, with the Lexical surface implemented via `koenig-lexical-editor.js` / `gh-koenig-editor-lexical.js` (the `@tryghost/koenig-lexical` React editor mounted inside Ember).

2. **New drafts are client-only until autosave.** `apps/ember-admin/app/routes/lexical-editor/new.js:9-17` calls `this.store.createRecord(modelName, {...})` for a post or page. The record is an Ember Data object living in the browser; it is **not** persisted to the server until Ghost's autosave (`autosaveTask`/`saveTask`) fires. So a freshly-opened "New post" has **no server ID** yet.

3. **Snippets are server-backed but contain only content.** `apps/ember-admin/app/models/snippet.js`:
   ```
   name, mobiledoc, lexical, createdAtUTC, updatedAtUTC
   ```
   The server endpoint `core/core/server/api/endpoints/snippets.js` exposes full CRUD (browse/read/edit/add/delete). Snippets are **content-only**: they have a `lexical` body and a `name`. They carry **no tags, no excerpt, no custom-template, no metadata**.

4. **Snippets cannot specify metadata.** There is no field for tags/excerpt/template on a snippet. To insert a snippet, Ghost sets `item.value = JSON.stringify(item.lexical)` and pushes the Lexical nodes into the editor — purely body content.

5. **Custom page/post template = `custom_template` string = the full theme filename including `.hbs`.** In `schema.js`: `custom_template: {type:'string', maxlength:100, nullable:true}`. In the Post Settings Menu it is exposed as `post.customTemplate` and set via `action (mut this.post.customTemplate)` (`gh-post-settings-menu.hbs:123`). The available options come from `gh-psm-template-select.js`, which compares the stored value directly with `activeTheme.customTemplates[].filename`; Ghost's acceptance test uses values such as `custom-news-bulletin.hbs`. **This is a plain model property, not a special API.**

6. **Excerpt = `custom_excerpt` string.** `schema.js`: `custom_excerpt: {type:'string', maxlength:2000, validations:{isLength:{max:300}}}`. Plain model property, editable in the Post Settings Menu.

7. **Tags are a related resource.** Posts schema has a `tags` relation; `posts_tags` join table. The Admin API accepts tags as a string array (`["Software","Reviews"]`) or object array (`[{"name":"..."}]`). **Tags that don't exist are auto-created** by the API; matched by name. Tag relations in an update **replace** (not merge) the whole array — you must re-send the full desired set.

8. **Authentication is cookie/session based, not per-request bearer in the admin UI.** `apps/ember-admin/app/services/ajax.js` sets `hash.withCredentials = true` and sends no `Authorization` header for normal admin calls — it rides the HttpOnly session cookie that Ghost issues on login. (The Admin **API token** auth is a separate server-to-server path, documented as "server-side usage only".)

9. **No native "post/preset/editor-template" concept exists beyond snippets.** Searches for `contentTemplate`, `postTemplate`, `editorTemplate`, `preset`, `reusable` in `apps/ember-admin` and `core/core/server` returned **nothing** for post content templates. The only "template" involved in the editor is the *theme* custom template (point 5). So Approach A / "use Ghost's native template system for everything" is **not** viable — Ghost has no native reusable-content-with-metadata system.

10. **PR #27656 added a *built-in theme code editor*** (appears in the v6.x release notes as "Added a built-in theme code editor — John O'Nolan"). This is the single most relevant architectural precedent in the codebase for *inserting auxiliary editing tooling into Ghost Admin*. It is **not** about post/page templates, but it demonstrates exactly the integration pattern you'd want: a new in-Admin surface (a full code editor) mounted within the existing Admin app, talking to existing Ghost models/APIs. For a *browser extension* (our recommended delivery), the lesson is inverted: we mimic Ghost's *behavior* (mutate the same Ember model properties, call the same REST endpoints) rather than forking Admin. The PR is useful as proof that Ghost treats "auxiliary editing features" as first-class surfaces and that the data layer (themes, snippets, posts) is stable and well-separated — which is exactly what an extension should lean on.

---

## 1. Executive Recommendation

**Recommended architecture: Chromium extension (isolated content script + popup + minimal MAIN-world bridge) that uses Ghost's cookie-authenticated Admin API for reads and dependency resolution, but applies a preset to an actively open editor through Ghost's live Ember/Lexical state and one native save transaction. Direct API writes are allowed only when the editor is confirmed clean and the returned record is reconciled into the live store or followed by a controlled reload. Ghost-native *snippets* remain an optional content source, never the metadata carrier.**

Concrete one-liner:

> **Chromium extension + extension-owned presets + Admin REST dependency reads + a capability-gated MAIN-world adapter that updates the live Ghost model/editor and performs one native save.**

The decisive reasons (all grounded in the verified facts above):

- Ghost has **no** native preset/metadata-template system (fact 9). So an extension **must** own the preset definition. That rules out pure "Approach A."
- The metadata you care about — tags, excerpt, custom template — are **plain, stable model properties and API fields** (facts 5, 6, 7). Their merge rules can be computed outside Ghost, then applied to the open model through the bridge.
- A separate API PUT does not update the Ember record already open in Ghost Admin. Its pending autosave can overwrite the preset or hit a stale `updated_at` collision. Therefore an active editor must use one native model/editor save transaction, or a deliberately less-smooth clean-state API update followed by reconciliation/reload.
- The body remains the hardest field because it lives in Lexical and a new draft may not yet exist server-side (facts 1, 2). We intentionally **do not** target CSS classes or hand-build Lexical trees.

---

## 2. Native Ghost Capability Matrix

| Capability | Ghost native | Extension needed | Notes |
| --- | --- | --- | --- |
| **Body content** | Partial — *snippets* store Lexical/mobiledoc content only | Yes (to inject/choose) | Snippets are server-backed CRUD (`/snippets/`) but are content-only, no metadata. |
| **Tags** | Native (relation, auto-create) | Yes (to set/merge) | API takes string/object array; missing tags auto-created; update **replaces** the array. |
| **Excerpt** | Native (`custom_excerpt`, ≤300 chars) | Yes (to set) | Plain model property + API field. |
| **Custom template** | Native (`custom_template` = full theme filename including `.hbs`) | Yes (to set) | Plain model property; validate against the active theme response's `templates` array. |
| **Preset orchestration** | **None** | Yes (entirely) | No native preset/template/metadata-template concept exists. |
| **Snippet as preset** | No | N/A | Snippets cannot carry tags/excerpt/template. |
| **Per-field merge rules** | No | Yes (entirely) | Must be implemented in the extension. |
| **Auth/session reuse** | Native (cookie session) | Yes (to reuse) | Extension rides the existing logged-in session cookie. |

---

## 3. Architecture Comparison

| Option | Complexity | Reliability | Maintenance | Ghost-update resistance | API access | UX |
| --- | --- | --- | --- | --- | --- | --- |
| **Chromium extension (recommended)** | High | Medium–High after a successful version spike | Med | Medium (stable API fields, private editor bridge) | Excellent (same cookie session) | Good (popup + floating toolbar) |
| **Userscript (Tampermonkey)** | Low | Medium | Med (manual install/update) | Medium | Excellent (same page context) | Good but harder to ship/version |
| **Ghost fork/modification** | Very High | Medium | Very High (rebase every release) | Very Low | N/A (in-tree) | Best (native feel) but unsustainable |
| **External companion app** | High | Medium | Med | High | Needs Admin API key (server-side) | Poor (no in-editor UX; copy/paste or separate flow) |

**Comments:**
- **Fork/modify Ghost Admin** is the worst choice here: Ghost ships frequently (v6.x is the current major; releases are continuous), and a fork must re-merge every time. The data layer we need is already reachable from outside, so forking buys us nothing we can't get with an extension while costing us the entire maintenance burden.
- **External companion app** is only attractive if you wanted batch/CLI automation; for an *in-editor* "click preset → populate" flow it has the worst UX and forces a long-lived Admin API key into a server you must host. We explicitly want to avoid embedding a long-lived secret.
- **Userscript** is a viable MVP delivery and lower-effort than a packaged extension, but it's harder to distribute, version, and give a clean options UI. Recommendation: build as a proper extension; if you want the absolute fastest prototype, a userscript with the same logic is a fine Phase-0 spike.
- **Chromium extension** wins because it (a) reuses the live session cookie so there is **no secret to store**, (b) can call the exact Admin REST endpoints Ghost Admin uses, and (c) can use a narrowly-scoped MAIN-world bridge for the open editor's native save path. That bridge is required for JavaScript state access; the isolated content script cannot reach Ember/Lexical objects directly.

---

## 4. Template / Content Strategy

**Answer: Our preset system owns everything (Approach B/C hybrid). Ghost-native snippets are used only as an *optional content source*, never as the metadata carrier.**

Why:
- Snippets **cannot** express tags/excerpt/template (fact 4). Any design that leans on "Ghost's native template system for the main content + we add metadata" collapses immediately, because there is no native object that bundles content + metadata. There is no Ghost-native preset to extend.
- Therefore the preset **definition** must live in the extension. The only question is *how the body content gets into the editor*.

Three body-content strategies, ranked by preference:

1. **Reference a Ghost snippet by name (optional).** Preset says `content: { source: ghost-snippet, snippet: "software-review" }`. The extension calls `GET <derived-admin-base>/snippets/?limit=all&formats=lexical`, performs an exact local match against `response.snippets[].name`, and passes the matched snippet's `lexical` JSON to the live-editor adapter. Local matching avoids constructing an NQL filter from preset-controlled text. *Benefit:* you edit the reusable body in Ghost's own snippet UI. *Cost:* snippets are a flat list with no metadata, so the snippet is purely the body; a renamed snippet breaks the reference and must produce a visible error.
2. **Extension-owned Lexical/HTML content.** Preset carries the body inline (`content: { source: inline-lexical, lexical: "..." }` or `content: { source: inline-html, html: "..." }`). *Benefit:* fully self-contained, no dependency on Ghost-side snippets. An API fallback must use `?source=html`; Ghost converts the supplied HTML into a complete replacement Lexical state. That is not a body merge or a generally lossless HTML round-trip. Preserve arbitrary markup only through a deliberately authored Ghost HTML card whose behavior is covered by an integration test.*
3. **Build the Lexical JSON ourselves.** Avoid unless necessary — generating valid Lexical node trees by hand is fragile and version-sensitive (fact 1; the Lexical schema can change). Prefer strategy 1 or 2.

**Do not duplicate Ghost's snippet *storage* logic** — if a preset wants reusable body text, store that text as a Ghost snippet and reference it (strategy 1), rather than re-implementing a second content store.

---

## 5. Recommended Data Model

```yaml
# presets/software-review.yaml   (also expressible as JSON)
id: software-review
name: Software Review
description: Standard structure for software reviews.

content:
  # One of: ghost-snippet | inline-html | inline-lexical
  source: ghost-snippet
  mode: only-if-empty                 # replace | only-if-empty | prompt (no implicit append)
  snippet: software-review          # name of a Ghost snippet (content only)
  # OR for inline:
  # source: inline-html
  # html: |
  #   <h2>Overview</h2>
  #   <p>...</p>

metadata:
  excerpt:
    mode: replace                    # replace | only-if-empty | prompt
    value: Reviews, guides and practical notes about software I use.

  customTemplate:
    mode: replace
    value: custom-software-review.hbs # full filename, exactly as returned by themes[].templates[].filename

  tags:
    mode: merge                      # replace | merge | only-if-empty | prompt
    # merge  = keep existing tags, add preset tags that aren't present
    # replace = set exactly this list
    values:
      - Software
      - Reviews
      - Tech

ui:
  icon: 💻
  group: Reviews
```

**Improvements over the draft model you proposed:**
- Made **per-field `mode`** explicit and first-class (replace / merge / only-if-empty / prompt). This directly answers your "what if I already started editing" concern.
- Split `content` from `metadata` so body vs. metadata behaviors are independent (the body often wants `only-if-empty`; tags often want `merge`).
- `customTemplate.value` is the **full filename including `.hbs`** — Ghost stores that exact value in `custom_template`, and `gh-psm-template-select` compares it directly with `templates[].filename` (`findBy('filename', filename)`).
- Added a body-level `content.mode`; without it the later `only-if-empty` behavior is not representable by the preset schema.
- Body writes are whole-body replacements. `only-if-empty` checks the **live** Lexical root's children, not a potentially stale server copy; malformed/unreadable state aborts rather than being treated as empty. `prompt` asks before replacing. There is no implicit node append/merge in the MVP.
- `tags.mode: merge` is the default we recommend: it reuses existing tags, creates missing ones (the API auto-creates by name), and never duplicates.

---

## 6. Recommended Interaction Flow

```
User opens Ghost  →  New or existing post/page editor (Ember + Lexical)
        │
User clicks extension icon (popup)  OR  floating "⚡ Preset" button in Admin chrome
        │
User selects "Software Review"
        │
Extension resolves the current post:
   • Reads the editor route / URL (/ghost/#/editor/post/<id> or /page/<id>)
   • MAIN-world bridge snapshots live model/editor state and dirty/save status
   • API base is derived from the current Ghost subdirectory, ending in
     /ghost/api/admin/ (never assume Ghost is installed at the domain root)
        │
STEP 1 — BODY (only if content.mode allows)
   • ghost-snippet: GET <admin-base>/snippets/?limit=all&formats=lexical
                    → exact-match response.snippets[].name locally
                    → take the matched snippet.lexical
   • bridge checks content.mode against the live Lexical state and, when
     allowed, replaces the editor state (API body writes also replace; no merge)
        │
STEP 2 — TAGS
   • Compute merged/replaced list from the live model snapshot
   • Bridge resolves relations through Ghost's store and sends the full list
        │
STEP 3 — EXCERPT (custom_excerpt)
   • bridge sets the live model property per mode
        │
STEP 4 — CUSTOM TEMPLATE (custom_template)
   • set to the full `.hbs` filename; GET `<admin-base>/themes/`, select the
     active theme, and validate against its `templates[]` entries with a blank
     `slug` (the Admin app derives `customTemplates`; it is not an API field)
        │
STEP 5 — SAVE
   • Bridge invokes Ghost's native editor save path once so pending Lexical
     scratch state, the Ember record, relationships, and updated_at stay aligned
   • Verify the save response/state before reporting success
   • If the native bridge is unsupported, abort. Optional fallback: only after
     the editor is confirmed clean, send one API PUT and then reconcile the
     returned record into the live store or perform a controlled reload.
        │
Done — user keeps writing.
```

**API vs. state split (the key reliability point):**
- **Reads and dependency lookup → Admin API** from the isolated extension context.
- **Writes to the actively open editor → live model/editor + Ghost's native save path** through the MAIN-world bridge. This applies to metadata as well as body; an external PUT alone leaves the open Ember record stale.
- **Direct API PUT fallback → clean editor only**, followed by explicit store reconciliation or reload. Payloads use plural envelopes, for example `{"posts":[{"updated_at":"…","custom_template":"custom-x.hbs"}]}` or the equivalent `pages` envelope.
- **Body semantics → replace / only-if-empty / prompt**, always checked against live Lexical state. We never parse the rendered DOM to read/write the body.

**MV3 execution boundary:** keep extension UI/API code in the isolated content-script world. Any Ember/Lexical access must run through a tiny, separately injected page-world bridge (for example `chrome.scripting.executeScript({world: 'MAIN'})`) with a fixed, validated message protocol. Do not expose a generic `eval`, arbitrary property access, or unrestricted fetch bridge to the page. The popup should message the content script; it should not own editor state or long-running apply operations because the popup can close at any time.

---

## 7. Technical Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Undocumented/private Admin API** | Med | Prefer documented endpoints; treat snippets/themes and the page-world bridge as version-gated capabilities. Derive `<subdir>/ghost/api/admin/` from the current Admin URL rather than hardcoding a root install. |
| **Internal React/Lexical state** | High | Use a capability-checked page-world bridge to a known editor API and Ghost's native save path. Do not assume setting the Ember model's `lexical` property updates an already-mounted Lexical editor. Fail visibly when unsupported. |
| **Ember model internals** | High | Active-editor consistency requires updating the live model and invoking its native save transaction. Keep all version-specific access in `ghost-state.js`, pin supported Ghost majors, and cover with live integration tests. |
| **DOM selectors / CSS classes** | High if used | **Deliberately avoided** for everything except optionally locating the editor mount. We drive data, not pixels. |
| **Ghost Admin updates** | Med | Lexical schema and route structure change across majors. Pin supported Ghost version; gate features behind capability detection (e.g., "does `/snippets/` respond?"). The metadata fields (`custom_template`, `custom_excerpt`, tags) are extremely stable and have been unchanged for years. |
| **Authentication / CSRF** | Low–Med | Extension content script runs in the authenticated page origin → inherits the session cookie (`withCredentials` confirmed in source). **No Admin API secret stored.** Risk: a CSRF token may be required for mutating requests in some setups — verify by reproducing a Ghost Admin save in DevTools Network and mirroring its headers. If a CSRF token is needed, read it from the same place Ghost reads it (session/meta) rather than hardcoding. |
| **Autosave / stale open model** | Critical | A GET-latest/PUT does not refresh the editor's Ember record. Apply through one native save transaction. Permit API PUT only after a clean-state check and reconcile the response or reload before editing resumes. |
| **Partial preset application** | Med | Resolve all dependencies and validate every mode before mutating live state. Apply all fields, invoke one native save, and restore the pre-apply snapshot or show a blocking recovery state if that save fails. |
| **Tag array replace semantics** | Med | API *replaces* tags on update. For `merge` mode we must `GET` existing tags and concatenate before `PUT`. Forgetting this silently drops user tags. |
| **custom_template validation** | Low | Only set exact `.hbs` filenames present in the active theme response's `templates[]` entries whose `slug` is blank. Reject an invalid preset before mutation rather than relying on frontend fallback behavior. |
| **MV3 isolated worlds** | Critical | Content scripts cannot directly read Ghost's Ember/Lexical objects. Use a minimal MAIN-world bridge with strict operation names, source checks, request IDs/nonces, and structured-cloneable payloads; keep storage and network orchestration in the isolated world. |
| **Editable preset persistence** | Med | Packaged `presets.json` is read-only at runtime. Treat it as defaults and persist user edits in `chrome.storage.local` (with schema versioning, validation, import/export, and size-limit errors). |
| **Snippet name collisions / content-only** | Low | Snippets are a flat namespace and carry no metadata — that's fine because we only use them for body. Don't try to overload them. |

---

## 8. MVP Architecture (folder/component structure — not implemented)

```
ghost-presets/
├── manifest.json                 # MV3; request an exact Ghost origin at setup
│                                #   and register the /ghost/* content script
├── presets/
│   └── presets.json             # read-only packaged defaults (§5 model)
├── src/
│   ├── background.js            # site-permission setup + storage/import coordination
│   ├── content-script.js        # isolated world; detects route, owns apply operation
│   ├── page-bridge.js           # MAIN world; minimal capability-gated Ember/Lexical bridge
│   ├── ghost-api.js             # Admin reads + clean-state/reconciled PUT fallback
│   ├── ghost-state.js           # versioned live model/editor adapter + native save
│   ├── preset-engine.js         # applies a preset: resolve post, run steps, merge rules
│   ├── preset-store.js          # defaults + validated chrome.storage.local overrides
│   ├── ui-popup.js              # list presets; message content script to apply
│   └── ui-toolbar.js            # optional floating "⚡ Preset" button injected into Admin
├── options/
│   ├── options.html             # manage presets (add/edit/import)
│   └── options.js
└── README.md
```

**Notes from research that shaped this:**
- Do not ship a literal `https://<your-domain>/ghost/*` placeholder or require blanket access by default. For a single private deployment, build with that exact origin. For a distributable extension, declare `optional_host_permissions` for HTTPS origins, request the user's exact Ghost origin after an explicit setup action, and dynamically register the content script for that origin's `/ghost/*` pages.
- `ghost-api.js` derives the API base from the current Admin URL so subdirectory installs work. It encapsulates `GET/PUT posts/{id}/`, `GET/PUT pages/{id}/`, `GET tags/`, `GET themes/`, and `GET snippets/`; request `formats=mobiledoc,lexical` when body data is required. Browse responses are plural-rooted (`snippets[]`, `themes[]`), and mutation payloads must also use the matching plural envelope (`posts[]` or `pages[]`).
- `ghost-state.js` is the version-specific active-editor adapter, not merely an unsaved-draft fallback. It snapshots live state, applies metadata/body changes, resolves relationships through Ghost's store, invokes one native editor save, and reports unsupported capabilities without partial mutation.
- `preset-engine.js` owns the per-field `mode` logic (§5) — the most important business logic, fully testable without a browser.
- `preset-store.js` loads packaged JSON as defaults but writes options-page changes to `chrome.storage.local`; an extension cannot rewrite its installed `presets.json`.
- No long-lived secret anywhere; auth is the inherited session cookie.

---

## 9. Implementation Roadmap (phased, each with a verifiable test)

**Phase 0 — Two-part spike (required before the packaged extension):** (A) prove cookie-auth and the plural-envelope API payload on a saved, clean post; (B) prove that a MAIN-world script can snapshot the live editor, apply fields, invoke Ghost's native save path, and leave the model clean with the returned `updated_at`. The API-only spike must reload/reconcile before editing resumes.
*Test:* after each path, continue editing and save again; verify no preset field is reverted and no collision occurs. This specifically tests stale-open-model behavior rather than only checking the first PUT.

**Phase 1 — Detect Ghost Admin & current post/page.** Content script identifies editor route, including hash-route changes without a full page load; extracts post type + id (or "unsaved").
*Test:* popup shows "Editing: post <id>" or "New unsaved draft".

**Phase 2 — Snapshot live state and read dependencies.** Bridge reads live tags/excerpt/template/body/dirty status; API reads snippets and the active theme's `templates[]`; derive custom templates by selecting entries with a blank `slug`.
*Test:* live unsaved values win over stale server values; invalid template names and unsupported bridge capabilities are flagged before mutation.

**Phase 3 — Native transaction for custom template and excerpt.** Bridge mutates the live properties and invokes Ghost's save path once.
*Test:* Post Settings Menu reflects the template/excerpt; a subsequent edit/autosave does not revert either value.

**Phase 4 — Implement and unit-test field modes.** Compute replace/merge/only-if-empty/prompt from the live snapshot before mutation.
*Test:* `only-if-empty` leaves live unsaved values untouched; cancelling a prompt writes nothing.

**Phase 5 — Set tags with merge logic.** Preserve live order/objects, append preset names not already present after trimming and case-normalization, resolve relations through Ghost's store, and include the full list in the native save transaction.
*Test:* `merge` adds preset tags without dropping existing; missing tags auto-create; case variants do not duplicate; `replace` sends exactly the configured list.

**Phase 6 — Body content.** Resolve a ghost-snippet or inline source, enforce replace/only-if-empty/prompt against live Lexical state, then apply through the bridge and native save. No append mode in the MVP.
*Test:* non-empty live scratch content is never misclassified from a stale GET; replacement survives autosave; a subsequent edit does not restore the old body.

**Phase 7 — Preset GUI.** Popup list + optional floating button; load packaged defaults plus `chrome.storage.local` overrides; options page validates, edits, imports, and exports presets.
*Test:* click preset in popup → all fields applied correctly per mode.

**Phase 8 — Edge cases & hardening.** Native-save failure recovery, clean-state API fallback/reload, subdirectory installs, plural payload envelopes, CSRF verification, rapid double-apply locking, and Ghost-version capability gates.
*Test:* rapid apply; published vs draft; brand-new draft; subdirectory install; no `/snippets/`; failed save restores or visibly preserves recoverable state; next autosave never reverts preset fields.

---

## 10. Final Decision

```
Recommended architecture:
  Chromium extension (MV3) — isolated content script + popup + minimal
  MAIN-world bridge, with an optional floating button. API reads resolve
  dependencies; active-editor writes update the live model/editor and use one
  Ghost-native save transaction.

Content:
  Extension-owned preset; optional reference to a Ghost-native snippet for the
  body (snippets are content-only and cannot carry metadata). Prefer snippet
  reference or inline HTML over hand-built Lexical JSON.

Tags:
  Compute from the live model, resolve through Ghost's store, and save the full
  relation list in the native transaction. Never DOM-automated.

Excerpt:
  Live model customExcerpt property (API field custom_excerpt, <=300 chars),
  persisted by Ghost's native save transaction. Never DOM-automated.

Custom template:
  Live model customTemplate property (API field custom_template) set to the full
  filename including ".hbs", validated against custom-template entries derived
  from the active theme's templates[] response, then natively saved.

UI:
  Extension popup (primary) + optional floating "⚡ Preset" button injected into
  Admin chrome. Avoids tight coupling to Ghost's DOM/CSS.

Preset storage:
  Packaged presets.json supplies read-only defaults; options-page edits are
  validated and persisted in chrome.storage.local, with JSON import/export.
  No server, no cloud, no long-lived Admin API secret.

Why:
  Ghost has no native preset/metadata-template system, so the extension must own
  the preset. API-only writes are unsafe while an editor record is open because
  later autosaves can use stale state. The bridge therefore updates live state
  and uses Ghost's native save path; all version-sensitive access stays behind
  one capability-gated adapter. Cookie/session reuse means zero secrets.
```

---

## 11. Implementation companion

The executable build workflow is maintained separately in [`GHOST_PRESET_TOOLBAR_IMPLEMENTATION_GUIDE.md`](./GHOST_PRESET_TOOLBAR_IMPLEMENTATION_GUIDE.md). It defines:

- the mandatory Phase-0 API and MAIN-world feasibility spikes;
- the durable Hermes Kanban task graph and review gates;
- the `ghostterra`, `ghostox`, `ghostnim`, and `ghostluna` provider/model lanes;
- profile/provider preflight without storing secrets in the repository;
- Git worktree isolation, TDD, integration/security checks, and human acceptance criteria.

Project-level future-agent instructions live in [`AGENTS.md`](./AGENTS.md). A request to build this project should follow both files rather than treating this decision document alone as an implementation plan.

---

## Appendix A — Evidence pointers (from the inspected `main` branch)

- `apps/ember-admin/app/models/snippet.js` — snippet fields: `name, mobiledoc, lexical, createdAtUTC, updatedAtUTC` (content only).
- `core/core/server/api/endpoints/snippets.js` — server-backed CRUD for snippets.
- `apps/ember-admin/app/components/gh-post-settings-menu.hbs:123` — `action (mut this.post.customTemplate)`.
- `apps/ember-admin/app/components/gh-psm-template-select.js` and `app/models/theme.js` — custom templates are derived from `activeTheme.templates` by blank `slug`; selection compares the full filename (including `.hbs`) via `findBy('filename', filename)`.
- `apps/ember-admin/tests/acceptance/custom-post-templates-test.js` — source-backed examples use `custom-news-bulletin.hbs` as both the stored value and select option value.
- `ghost/core/core/server/data/schema/schema.js` — `custom_template` (len 100), `custom_excerpt` (len 2000, max 300), `lexical`/`mobiledoc` columns, `tags` relation + `posts_tags`.
- `apps/ember-admin/app/services/ajax.js` — `hash.withCredentials = true`; no per-request Authorization header (session cookie auth).
- `apps/ember-admin/app/routes/lexical-editor/new.js:9-17` — `store.createRecord(modelName, …)` creates client-only new posts/pages; `apps/ember-admin/app/controllers/lexical-editor.js:251-261` prepares snippet Lexical values and lines 312-324 schedule body autosaves.
- `apps/ember-admin/app/serializers/application.js:16-26` and `app/adapters/embedded-relation-adapter.js:151-172` — writes use plural resource envelopes such as `posts[]`/`pages[]`.
- `ghost/core/test/e2e-api/admin/posts.test.js:631-644` — `?source=html` replaces prior body content rather than merging it.
- Docs: `docs.ghost.org/admin-api/posts/creating-a-post.md` (HTML `source=html`, tags auto-create, lexical payload), `updating-a-post.md` (`updated_at` required, tag relations replace).
- PR #27656 (release notes): "Added a built-in theme code editor" — architectural precedent for auxiliary in-Admin editing surfaces; confirms the data layer (themes/snippets/posts) is stable and separable.

## Appendix B — Prior-art search result

No actively-maintained, general-purpose "Ghost Admin preset/template toolbar" browser extension or userscript was found. Related but distinct projects exist (e.g., bulk post editors, invisible-character cleaners, AI writing assistants) — none solve preset-driven metadata population. Building this from scratch is justified; a userscript spike (Phase 0) is the lowest-risk way to validate before committing to a packaged extension.
