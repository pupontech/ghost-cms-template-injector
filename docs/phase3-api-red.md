# Phase-3 Admin API client — RED evidence

`npx vitest run tests/unit/ghost-api.test.ts` before implementation:

```
Error: Cannot find module '../../src/ghost-api' imported from
  'tests/unit/ghost-api.test.ts'
 ❯ tests/unit/ghost-api.test.ts:3:1

 Test Files  1 failed (1)
      Tests  no tests
```

Fails because `src/ghost-api.ts` does not exist yet — the C1/C6/C7 contract
suite is written first.
