# Governance and release-safety hardening

- Issue: https://github.com/pupontech/ghost-cms-template-injector/issues/4
- Kanban: `ghost-preset-toolbar` / `t_96555f52`
- Pull request: https://github.com/pupontech/ghost-cms-template-injector/pull/5 (draft)
- Owner approval: approved 2026-08-28
- Independent reviewers: native Luna read-only review PASS on the earlier remediation; `ghostnim` read-only review PASS on the current remediation delta; DeepSeek Flash review blocked by official API HTTP 401

## Problem and non-goals

The repository had documented engineering controls but lacked a mandatory spec gate, explicit agent no-self-merge rule, reusable isolated-worktree helper, repository safety scan, safe live-proof output boundary, documentation index, PR/issue workflow templates, and enforceable public-branch protection.

This change establishes those delivery controls. It does not alter shipped extension behavior, Ghost API contracts, manifest permissions, or live Ghost content.

## Architecture and compatibility evidence

The change preserves the existing `GHOST_CMS_TEMPLATE_INJECTOR_DECISION.md` contracts. `AGENTS.md` now makes that decision and this proposal prerequisites for future production changes. The existing headless CDP bundle-proof harness remains owner-gated and is not headed-browser acceptance evidence; it now requires an explicit safe cookie-jar path and writes raw output only to ignored `evidence/local/`.

## Security, privacy, permissions, and rollback

- No new extension permissions or network endpoints are introduced.
- The safety scanner enumerates tracked files regardless of ignore rules and symlinked parents, scans generated `dist/` artifacts including source maps and large text files in chunks, rejects credential-like assignments/provider tokens, dangerous shell pipelines, destructive Git commands, symlinked release inputs, and tracked runtime-config filenames. Manifest validation additionally rejects source maps, symlinked/non-regular `dist` entries, out-of-bound references, and artifacts over 2,000,000 bytes.
- Proof artifacts use an exclusive no-follow writer that rejects symlinks, hardlinks, tracked destinations, traversal, and stale output paths.
- Worktree initialization creates a new unique `wt/<slug>` branch/worktree only, verifies a non-symlink in-repository `.worktrees` parent, and refuses reuse/overwrite.
- Rollback is a standard PR revert; no data migration is performed.

## File ownership / worktree plan

One writer owns this isolated remediation worktree. No other worktree is modified. GitHub issue #4 is the authoritative record; this proposal and the Kanban card link it to execution.

## Acceptance matrix

- [x] Focused RED→GREEN tests for repository safety helper and proof-harness local boundaries.
- [x] Current remediation working tree: `npm run verify`, `npm run audit:high`, manifest validation, and safety scan pass; exact commit and hosted CI run are recorded after push.
- [x] Package, lockfile, and manifest versions are synchronized at `0.2.3`.
- [x] GitHub `main` received protected-branch settings while public; after approved privacy change, GitHub Free cannot expose/enforce those controls on the private repository, documented as an external plan limitation.
- [x] Native Luna and `ghostnim` independent reviews are recorded in `docs/release-status.md`; official DeepSeek Flash review remains blocked until its credential is re-authenticated.
- [ ] Owner acceptance/disposition recorded; runtime browser acceptance may be marked N/A only with the owner's explicit approval because no extension behavior changed.

## Implementation and review log

Native Luna independent review: PASS for the earlier implementation and safety controls. `ghostnim` independently reviewed the current remediation delta and returned PASS with no security or logic blockers. Official DeepSeek Flash could not run because `https://api.deepseek.com/v1` returned HTTP 401. The current working tree passes the full local verification and high-severity audit; exact commit and hosted CI are recorded after push. One P2 `AGENTS.md` routing-policy conflict remains protected from automatic edit. The current branch remains unmerged. No agent will self-approve or self-merge.
