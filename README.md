# Ghost Preset Toolbar

A private Manifest V3 Chromium extension for applying validated presets to Ghost Admin posts and pages. It provides local preset management, an optional injected toolbar, explicit per-installation host consent, and a narrowly capability-gated MAIN-world bridge for Ghost-native editor updates and saves.

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

`npm run verify` runs formatting checks, ESLint, strict TypeScript, a production build, the complete Vitest suite, and manifest/built-artifact validation. The generated extension bundles are placed in `dist/` and are intentionally not committed.

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

Follow [`TESTING.md`](TESTING.md) for the owner acceptance procedure. It covers build verification, enabling narrowly scoped access, applying and persisting a preset, Disable behavior in current and new Admin documents, and re-enable behavior.

## Author body templates in the extension

Open the extension Options page and choose **Plain text template** as the body source. Type ordinary text in the multiline editor and save the preset; each line becomes one Ghost Lexical paragraph, and blank lines become empty paragraphs. CRLF and CR newlines are normalized to LF. Text is never parsed as HTML, so tags such as `<b>` remain literal text. Empty or whitespace-only templates are rejected. Existing `ghost-snippet`, `inline-lexical`, and imported `inline-html` presets continue to round-trip; inline HTML remains intentionally unavailable for live writes.

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

## Useful commands

| Command                     | Purpose                                  |
| --------------------------- | ---------------------------------------- |
| `npm run build`             | Type-check and produce `dist/` bundles   |
| `npm test`                  | Run the Vitest suite                     |
| `npm run format:check`      | Check Prettier formatting                |
| `npm run lint`              | Run ESLint                               |
| `npm run typecheck`         | Run strict TypeScript checks             |
| `npm run manifest:validate` | Validate permissions and built artifacts |
| `npm run verify`            | Run every automated release gate         |

## Privacy

Use a disposable test post/page when possible. Never commit cookies, login details, API tokens, CSRF values, TLS private keys, Chromium profiles, or screenshots containing private content. See [`SECURITY.md`](SECURITY.md).

## Release state

The automated suite and genuine headed Chromium C8 Disable/re-enable lifecycle are green. See [`docs/release-status.md`](docs/release-status.md) and the redacted evidence under `evidence/`. Final release acceptance remains the repository owner's decision after following `TESTING.md`.
