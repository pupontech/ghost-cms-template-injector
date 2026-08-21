# Ghost Preset Toolbar — Phase-1 scaffold

Minimal MV3 TypeScript Chromium extension foundation. This scaffold has **no active
behavior**: no preset logic, no Ghost API client, no MAIN-world bridge, no storage
writes, no UI. Later phases build on these contracts (see
`docs/architecture-contract.md` in the parent repository).

## Requirements

- Node.js 20+ (developed on 22), npm 10+
- Chromium 116+ (manifest `minimum_chrome_version`)

## Setup

```bash
npm install        # install dev dependencies (lockfile committed)
npm run verify     # format:check, lint, typecheck, tests, manifest validation, production build
```

## Layout

- `manifest.json` — MV3 manifest; `storage` permission only, no host permissions, no remote code.
- `src/background.ts` / `src/background-main.ts` — inert service worker (one `onInstalled` listener, no side effects).
- `src/content-script.ts` / `src/content-script-main.ts` — isolated-world content script on `/ghost/` paths; fail-closes all bridge probes with `UNSUPPORTED_CAPABILITY` until the Phase-3 bridge exists.
- `scripts/build.mjs` — esbuild production bundle into `dist/`.
- `scripts/validate-manifest.mjs` — manifest + built-artifact security checks.
- `tests/unit/` — Vitest unit baseline.

## Loading in Chromium (development)

```bash
npm run build
# chrome://extensions → Developer mode → Load unpacked → select this directory
```

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
