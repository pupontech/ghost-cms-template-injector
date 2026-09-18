# Ghost-CMS Template Injector

> **WARNING: COMPLETELY VIBE CODED**

TLDR - Gives you full post templates withought touching .hbs files and will apply your tags and excerpts as well in the native ghost editor.
No credentials are stored!!!

A private Manifest V3 Chromium extension for applying validated presets to Ghost Admin posts and pages. It provides local preset management, an optional injected toolbar, explicit per-installation host consent, and a narrowly capability-gated MAIN-world bridge for Ghost-native editor updates and saves.

<img width="834" height="1038" alt="Screenshot 2026-08-25 160140" src="https://github.com/user-attachments/assets/654fdc54-071a-4e5b-9a19-44d4afb8d013" />
<img width="1571" height="1166" alt="Screenshot 2026-08-25 160210" src="https://github.com/user-attachments/assets/f5ae2e79-ee9c-441a-a142-b3b4068d9e77" />
<img width="536" height="973" alt="Screenshot 2026-08-25 160452" src="https://github.com/user-attachments/assets/0e348152-423a-460f-aae8-6a6a2c4b886a" />

## Security model

- No static host permissions.
- The user explicitly grants one HTTPS Ghost installation from the setup page.
- Runtime content scripts are scoped to that installation's `/ghost/*` Admin path.
- Disabling access unregisters both scripts and makes an already-loaded MAIN-world bridge dormant.
- Presets stay in `chrome.storage.local`; no API tokens are requested or stored.
- A picked feature-image photo is kept in the extension's own IndexedDB (never in the preset document). It is uploaded to your Ghost site only when a preset that uses it is applied, with your existing admin session cookie.
- No remote scripts or remotely hosted executable code.

## Requirements

- Node.js 20 or 22
- npm 10+
- Chromium 116+
- An HTTPS Ghost Admin installation and an authenticated test account

## Build and verify

```bash
npm ci
npm run verify
```

`npm run verify` runs formatting checks, ESLint, strict TypeScript, a production build, the complete Vitest suite, and manifest/built-artifact validation. Normal builds omit source maps; use `npm run build:debug` for external maps. CI also runs the high-severity dependency audit gate. The generated extension bundles are placed in `dist/` and are intentionally not committed.

Two opt-in live-proof harnesses drive the built extension and this tree's modules against a real Ghost
installation behind a local TLS proxy (they read the admin session cookie from `/tmp/cj.txt`, never the
repository, and never print it):

```bash
npm run proof:feature-image   # preset photo cache + page-origin upload + MAIN-bridge write
npm run proof:post-import     # capture a real post, then apply that preset to a different draft
npm run load-check:zip -- <zip>   # extract a release ZIP and load it unpacked in real Chromium
```

Their redacted output is committed under `evidence/`.

## Load the extension

1. Run `npm ci && npm run build`.
2. Open `chrome://extensions` in Chromium.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this repository directory (the directory containing `manifest.json`).
5. Open the extension's **Details** page and then **Extension options**, or open the setup page from the extension UI.
6. Enter the public HTTPS base URL of the Ghost installation, including a subdirectory when applicable, for example:
   - `https://example.com/`
   - `https://example.com/blog/`
7. Select **Enable** and accept Chromium's native host-permission prompt.
8. Reload Ghost Admin.

Do not enter `/ghost/` itself in the setup field; enter the installation base URL. Access is dynamically narrowed to that installation's `/ghost/*` pages.

## Test the release

The extension ships with one bundled default, **Starter Post**. Make it yours:

1. Open the extension **Options** page.
2. Under _Presets_, select **Edit** on Starter Post — or start a new preset.
3. Configure body source, field modes, tags, excerpt, and (when needed) custom-template filename/mode in **Advanced**.
4. Save the preset.
5. Open a supported Ghost editor and click the extension toolbar button.
6. Review the read-only field plan, confirm it, and apply the preset.
7. If a prompt-mode field is returned, answer it in the popup panel.
8. Use **Undo last apply** before the editor’s automatic refresh if you need to restore the previous fields.

The body options are intentionally literal: `inline-lexical` applies structured Lexical JSON, `inline-text` converts plain text into paragraphs, and `ghost-snippet` resolves a named Ghost snippet. Inline HTML is fail-closed unless the live capability explicitly allows it. Custom-template modes support replace, only-if-empty, and prompt. Plain-text lines become paragraphs and blank lines separate paragraphs; HTML-looking and Markdown-looking characters remain literal text.

You can move presets between machines with **Export** / **Import** (JSON) at the bottom of the Options page.

## Feature image (the editor's top image)

A preset can also carry the post's **feature image**:

1. In the Options page, pick a photo under **Feature image (top image)**. It is cached in this
   browser, not in the preset: the preset only stores the photo's id, so preset documents stay tiny
   and exports never carry image bytes.
2. Choose the mode: `only-if-empty` (default), `replace`, or `prompt`.
   You can type an existing image URL instead of picking a photo.
3. Apply the preset on a post. The first apply uploads the photo to _that_ Ghost installation through
   Ghost's own admin image endpoint and remembers the returned URL, so repeat applies reuse the same
   media instead of duplicating files.

If the photo is not cached in the current browser (for example after importing a preset exported
elsewhere), the apply is **blocked with an explicit reason** — no post is ever half-applied without its
image. Re-pick the image to fix it.

The default editor refresh is delayed long enough for an explicit Undo and is canceled after a successful Undo. Navigation or a full page reload ends the in-memory Undo window.

## Import an existing post as a preset

Instead of writing a template by hand, you can turn a post you already published into a preset:

1. Open the extension popup on any Ghost Admin screen.
2. Under **Import a post as a preset**, pick the source: the post open in the editor, or any post/page
   from this site (the picker is filled from your own Admin API).
3. Give the preset a name (it defaults to the post's title) and choose whether the **title** should be
   captured too — it is off by default, because a preset that carries a title renames every post it is
   applied to.
4. Press **Import as preset**.

What is captured:

| Field           | Captured as                                                  | Default mode               |
| --------------- | ------------------------------------------------------------ | -------------------------- |
| Body            | the post's serialized Lexical document                       | `replace`                  |
| Excerpt         | `custom_excerpt`                                             | `only-if-empty`            |
| Tags            | the post's tag names                                         | `merge`                    |
| Custom template | `custom_template` (only when it ends in `.hbs`)              | `only-if-empty`            |
| Feature image   | the post's image URL, stored as a portable `/content/…` path | `only-if-empty`            |
| Title           | `title`                                                      | only when you tick the box |

The captured preset goes through the same schema validation as any other preset, lands in the
**Imported** group, and can be edited in the Options page afterwards (mode changes, photo cache,
naming, deletion). On the editor screen the generated toolbar also offers
**Save this post as a preset** for a one-click import of the post you are looking at (it asks for the
name and never captures the title).

Import is **fail-closed**, so a half-understood post never becomes a template:

- an unreadable or blank body aborts the import with a reason (a post whose body is only an empty
  paragraph has nothing to template);
- a `custom_template` that is not an `.hbs` filename, or a feature-image URL the preset schema cannot
  accept, is skipped with a warning instead of being written;
- an excerpt longer than 300 characters is trimmed to the schema limit and reported;
- the import reads the **stored** record through your authenticated Admin API when the editor is
  clean, so the captured body is the saved one; if the editor has unsaved changes it says so and uses
  the live body instead.

## Project layout

- `manifest.json` — MV3 manifest with `storage` and `scripting`, no static host permission.
- `src/background-main.ts` — service worker and popup/content-script relay.
- `src/content-script-main.ts` — isolated-world orchestration and capability activation/deactivation.
- `src/main-bridge-main.ts` — dormant-by-default MAIN-world Ghost adapter.
- `src/apply-pipeline.ts`, `src/ghost-api.ts`, `src/ghost-state.ts` — preset dependency resolution and one native-save transaction.
- `src/preset-store.ts`, `options/`, `popup/`, `setup/` — preset storage and extension pages.
- `presets/presets.json` — read-only bundled seed presets.
- `tests/` — unit, contract, accessibility, and real-browser proof harnesses.
- `evidence/` — redacted release evidence; never place credentials here.

## Release state

The automated suite and genuine headed Chromium C8 Disable/re-enable lifecycle are green. See [`docs/release-status.md`](docs/release-status.md) and the redacted evidence under `evidence/`. Final release acceptance remains the repository owner's decision after following `TESTING.md`.
