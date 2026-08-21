# Phase-3 ghost-state adapter — RED → GREEN evidence

Task: t_ecb2271b (Phase-3 live Ghost state adapter, C2/C4).
Owned files: `src/ghost-state.ts`, `tests/unit/ghost-state.test.ts`.
Based on reviewed Phase-2 tip `90596ff`. Strict TDD.

## Contracts covered

- **C2 — Capability discovery**: `discover()` returns a versioned
  `GhostCapability` only after proving identity/type, live record, live Lexical
  state, relation mutation path, one native-save path, and a rollback path are
  all reachable. Any missing capability returns `{supported:false,reason}`
  (UNSUPPORTED_CAPABILITY) with **no mutation**.
- **C4 — Live transaction, save, rollback**: `snapshot()` captures type/id/
  metadata/tags/Lexical/emptiness/dirty/`updated_at`/save activity; `planApply()`
  validates every dependency and mode before mutation; `apply()` captures a
  pre-apply rollback snapshot, mutates only after a valid plan, then invokes
  exactly one Ghost-native save and verifies clean state; on failure it rolls
  back through the same live path, and if rollback cannot be proven it escalates
  to `ROLLBACK_FAILED` and retains a recoverable failure.

## RED log (test written before implementation)

Initial run of the 13-test suite before the final fix:

```
 ❯ tests/unit/ghost-state.test.ts (13 tests | 1 failed) 19ms
   ✓ C2 capability discovery > ... (3 passing)
   ✓ C4 live snapshot > ...
   ✓ C4 planApply validation > ... (3 passing)
   × C4 apply → save → verify (single native transaction)
     → ghost-state: relation mutation unsupported for customTemplate
   ✓ C4 rollback on failure > ... (2 passing)
   ✓ C4 unsupported abort > ...
   ✓ adapter exposes a cohesive interface type > ...
 Test Files  1 failed (1)
      Tests  1 failed | 12 passed (13)
```

Root cause: `planApply()` compared against a non-existent private boolean
`this.#surface.canMutateRelations` instead of the actual `setField` capability.

## GREEN log (minimum implementation + fix)

After fixing `planApply` to check `typeof this.#surface.setField === 'function'`,
and exporting `ApplicationPlan`/`PlanAction` (and using a valid `PlanActionStatus`
in tests), full verify is green:

```
> npm run verify
format:check  ✓ (all files Prettier-clean)
lint          ✓ (eslint .)
typecheck     ✓ (tsc --noEmit)
test          ✓ 93 passed (8 files; ghost-state: 13)
manifest:validate ✓
build         ✓ tsc --noEmit && node scripts/build.mjs
```

Final `vitest run` for the owned module:

```
 ✓ tests/unit/ghost-state.test.ts (13 tests) 13ms
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

## Coupling / invariants

- `src/ghost-state.ts` imports ONLY `preset-engine` (types). No `ghost-api`, no
  `chrome.*`, no `fetch`, no DOM, no UI. The bridge responder (sibling C3 card)
  wires this adapter's exact surface (`discover`/`snapshot`/`planApply`/`apply`/
  `rollback`) into the fixed C3 allowlist — no API/UI code added here.
- `GhostLiveSurface` is the single capability seam: the page script injects the
  real Ember/Lexical handles; the adapter never reaches Ghost internals directly.
- Transactions are serialized by the C3 responder (`BUSY`). This adapter also
  guards `#busy` internally and captures rollback before any mutation.

## Real Ghost evidence

Gate-0 environment not re-attached in this run. The adapter is verified against a
capability surface mock (`capableSurface`) that mirrors the documented Ghost 6.x
internals (live record id-or-unsaved, Lexical column, native save pipeline,
rollback snapshot path). No live Ghost instance was exercised; per the task, real
browser evidence is the downstream `t_0e4cd2bb` recovery-test card's
responsibility after all Phase-3 modules are present. No credentials, cookies, or
tokens are present in source or artifacts.
