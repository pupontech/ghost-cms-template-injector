## Authoritative records

- Issue: https://github.com/pupontech/ghost-cms-template-injector/issues/4
- OpenSpec: `openspec/changes/4-governance-release-safety/proposal.md`
- Kanban board/card: `ghost-preset-toolbar` / `t_96555f52`
- Pull request: add the complete GitHub PR URL after opening it

## Safety and evidence

- [ ] `npm run verify` and `npm run audit:high` passed on the exact PR commit.
- [ ] `npm run safety:check` passed on the exact PR commit.
- [ ] Manifest/permission changes are explained, or explicitly marked unchanged.
- [ ] No token, cookie, private Ghost content, browser profile, or raw proof output is included.
- [ ] Real-browser/owner acceptance is linked, or the owner has explicitly recorded why it is not applicable.
- [ ] An independent reviewer is requested and the reviewer result is recorded in the Issue and Kanban card.
- [ ] The current test-file/test counts and version are recorded in `docs/release-status.md`.
- [ ] I am not self-approving or self-merging this PR.
- [ ] The owner performs the final merge only after CI, independent review, and acceptance gates are current.
