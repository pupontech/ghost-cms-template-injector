# Phase-1 scaffold RED log

Run: `npx vitest run` before any `src/` implementation exists.

Observed output (excerpt):

```
FAIL  tests/unit/content-script.test.ts [tests/unit/content-script.test.ts]
Error: Failed to resolve import "../../src/content-script" from "tests/unit/content-script.test.ts". Does the file exist?

FAIL  tests/unit/background.test.ts [tests/unit/background.test.ts]
Error: Failed to resolve import "../../src/background" from "tests/unit/background.test.ts". Does the file exist?

Test Files  2 failed (2)
     Tests  no tests
```

`tests/unit/manifest.test.ts` also fails: manifest.json does not exist yet
(`ENOENT ... manifest.json`). This file records the observed RED baseline for the
Phase-1 review card.
