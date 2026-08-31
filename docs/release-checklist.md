# Release-safety checklist

Use this checklist before opening or approving a release pull request. The GitHub Issue and linked Kanban card remain the durable work record; this page is an index and execution aid, not a replacement for those policies.

## Before implementation

- [ ] Confirm the work is recorded in the applicable GitHub Issue and linked Kanban card.
- [ ] Create or update an accepted OpenSpec proposal under `openspec/changes/<issue>-<slug>/`.
- [ ] Read the architecture decision and implementation guide; record the relevant Ghost compatibility source.
- [ ] Use a fresh isolated worktree: `npm run worktree:init -- --name <slug>`.
- [ ] Confirm the assigned worker lane/provider/model is approved and available. Never place credentials in the repository, cards, issues, logs, or screenshots.

If the proposal, owner approval, or required provider lane is missing, stop and record the blocker rather than proceeding.

## Isolated worktree initializer

From a Git worktree root, create a new writer workspace with a lowercase
3–64-character slug and an optional commit-capable base ref:

```bash
npm run worktree:init -- --name <slug>
npm run worktree:init -- --name <slug> --base origin/main
```

The first command prints `worktree=<absolute path>`, `branch=wt/<slug>`, and
`base=<ref>` on success (exit code 0). It creates only
`.worktrees/<slug>` inside the selected repository and a new `wt/<slug>`
branch; it does not read credentials or modify any existing worktree.

The initializer exits 2 before mutation for an invalid slug, invalid/non-commit
base ref, non-Git root, unsafe/symlinked `.worktrees` parent, or existing target
or branch. A repeated invocation is therefore safe and idempotent with respect
to repository state: it refuses reuse/overwrite and leaves the first worktree
unchanged. Exit code 1 means `git worktree add` itself failed; record its
sanitized error and do not delete or overwrite the target to retry.

## Automated release gate

From the repository root, run:

```bash
npm run verify
npm run audit:high
```

`npm run verify` runs formatting, lint, TypeScript checks, the production build, tests, manifest validation, the governance gate, and the repository safety scanner. Each command must exit successfully (exit code 0). Any non-zero result is a release failure until fixed, rerun, and recorded. `npm run audit:high` must also exit 0; high-severity dependency findings require remediation or an explicitly documented owner disposition.

For focused checks, the individual commands are:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
npm run manifest:validate
npm run governance:check
npm run safety:check
```

The safety scanner checks tracked files and generated artifacts for secrets, unsafe release inputs, dangerous commands, symlink/hardlink hazards, and tracked runtime configuration. Do not bypass it by relying on ignore rules or by deleting evidence.

## Evidence boundary

- Keep raw browser, console, network, and command output in ignored `evidence/local/`.
- Only reviewed, redacted boolean summaries belong in tracked `evidence/`.
- Redact cookies, tokens, credentials, private content, personal data, capability values, and unrelated host details.
- Do not describe headless or synthetic checks as genuine headed-browser acceptance.
- Link the reviewed summary and state whether each real-browser case is `PASS`, `BLOCKED`, or `FAIL`.

Use `docs/manual-test-matrix.md` for the owner Ghost/Chromium scenarios and negative cases. A `FAIL` requires a defect card; a `BLOCKED` result requires the environment or human decision to be recorded.

## Review and merge

- [ ] Request independent review; do not self-approve.
- [ ] Confirm CI runs the repository verification workflow on the proposed change and record the actual result.
- [ ] Confirm manifest, permissions, generated `dist/`, and safety-scan results are current for the exact release tip.
- [ ] Obtain owner acceptance/disposition for the manual browser matrix and any requirement that cannot be automated.
- [ ] The owner performs the final merge. Agents must not self-merge, force-push, bypass checks, or treat advisory CODEOWNERS/branch settings as enforceable protection.

## Escalation

Stop and escalate to the owner/architecture reviewer when an OpenSpec conflict, unsupported Ghost capability, missing required provider, unavailable browser environment, failed safety check, failed CI check, or unresolved security finding prevents a trustworthy release decision. Include the issue/card link, exact command or matrix ID, sanitized error, and the smallest decision or environment change needed; never include secrets or raw private proof.

## Requirements that are not fully automatable

The scripts and CI can verify repository shape, build/test results, manifest constraints, safety rules, and structurally valid Issue/card references (including the canonical GitHub repository when an `origin` remote is available). They cannot prove a live Kanban-card backlink, owner approval, independent human review, enforceable GitHub branch protection on every repository plan, truthful real Ghost/Chromium behavior, or that redaction preserved privacy. Those remain explicit owner/reviewer gates and must be recorded against the Issue and Kanban card.
