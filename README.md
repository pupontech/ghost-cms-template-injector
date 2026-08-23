# Ghost Preset Toolbar — release candidate (browser evidence pending)

MV3 TypeScript Chromium extension for applying validated presets to Ghost Admin
posts and pages. It includes preset storage and options CRUD, API dependency
resolution, a capability-gated MAIN-world bridge, native-save transaction glue,
popup and optional injected toolbar UI, and explicit host-permission setup.

This is **not yet accepted for release**: automated gates pass, but the required
real Ghost/browser matrix is still blocked. See `docs/release-status.md` before
using this candidate beyond disposable QA.

## Requirements

- Node.js 20+ (developed on 22), npm 10+
- Chromium 116+ (manifest `minimum_chrome_version`)

## Setup

```bash
npm install        # install dev dependencies (lockfile committed)
npm run verify     # format:check, lint, typecheck, tests, manifest validation, production build
```

## Layout

- `manifest.json` — MV3 manifest with `storage`/`scripting`, no static host permission, and optional explicit Ghost-origin permission.
- `src/background.ts` / `src/background-main.ts` — service worker and fixed same-tab popup-to-content-script relay.
- `src/content-script.ts` / `src/content-script-main.ts` — isolated-world orchestrator that fails closed when the bridge capability is unsupported.
- `src/main-bridge.ts` / `src/main-bridge-main.ts` — narrowly scoped MAIN-world bridge protocol for supported Ghost editor capabilities.
- `src/apply-pipeline.ts`, `src/ghost-api.ts`, `src/ghost-state.ts` — validated dependency resolution and one native-save apply transaction.
- `src/preset-store.ts`, `options/`, `popup/`, `setup/` — local preset persistence, options/import-export, popup, and explicit permission UI.
- `scripts/build.mjs` — esbuild production bundle into `dist/`.
- `scripts/validate-manifest.mjs` — manifest + built-artifact security checks.
- `tests/unit/` — Vitest unit baseline.

## Loading in Chromium for disposable QA

```bash
npm run build
# chrome://extensions → Developer mode → Load unpacked → select this directory
```

Then open the extension setup page, enter the exact HTTPS Ghost Admin origin,
and choose Enable. This explicitly requests access and dynamically registers the
content script for that origin's `/ghost/*` pages; reload Ghost Admin afterward.

Use a disposable, authenticated Ghost installation and record only redacted
evidence in `docs/manual-test-matrix.md`. Do not enter or export cookies, API
tokens, CSRF values, or other credentials.

## Scripts

| Script                            | Purpose                                  |
| --------------------------------- | ---------------------------------------- |
| `npm run format` / `format:check` | Prettier                                 |
| `npm run lint`                    | ESLint (typescript-eslint recommended)   |
| `npm run typecheck`               | `tsc --noEmit` (strict)                  |
| `npm test`                        | Vitest unit baseline                     |
| `npm run manifest:validate`       | Manifest/artifact security validation    |
| `npm run build`                   | Typecheck + production bundle to `dist/` |
| `npm run verify`                  | All of the above in order                |
