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
2. Under _Presets_, select **Edit** on Starter Post — or just start a new preset.
3. Fill in:
   - **Preset name** — anything; the internal id is derived from it.
   - **Post title** _(optional)_ — applied when the preset runs.
   - **Template text** — ordinary multiline text (see semantics below).
   - **Tags** — comma-separated; merged into the post's existing tags.
   - **Custom excerpt** _(optional)_ — only applied if the post has no excerpt yet.
4. Select **Save preset**, then apply it from an open Ghost post/page editor.

Template text semantics: each line becomes one Ghost paragraph, and blank lines separate paragraphs. Text is never parsed as HTML or Markdown, so `<b>` and `##` stay literal text — write plain words where you want headings, then apply heading formatting in the Ghost editor. Empty templates are rejected. Your presets live in `chrome.storage.local`; nothing is synced or uploaded.

You can also move presets between machines with **Export** / **Import** (JSON) at the bottom of the Options page.

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
