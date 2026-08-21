# Phase-1 contract fixtures

The contract fixture suite is deterministic and browser-free. It covers:

- post, page, snippet, and active-theme records;
- root and subdirectory Admin API path derivation;
- plural `posts[]`, `pages[]`, `snippets[]`, and `themes[]` envelopes;
- clean versus dirty editor snapshots, including unsaved metadata/body state;
- `replace`, `only-if-empty`, and `prompt` mode decisions;
- missing-snippet, invalid-template, and native-save collision responses.

Fixtures are exported from `tests/helpers/contract-fixtures.ts` and exercised by
`tests/contract/fixtures.test.ts`.

## Exact commands and logs

From the repository root:

```sh
npm ci > logs/npm-ci.log 2>&1
npm test -- --run tests/contract/fixtures.test.ts > logs/contract-green-vitest.log 2>&1
npm run verify > logs/verify.log 2>&1
```

The intentional RED run (before the helper existed) is recorded in
`logs/contract-red-vitest.log`; it failed because the helper module was absent.
The focused GREEN run records 7 passing tests in `logs/contract-green-vitest.log`.
The full verification log is `logs/verify.log`.

These are unit/contract fixtures only. They do not claim live Ghost or browser
integration evidence.
