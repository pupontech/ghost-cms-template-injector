# OpenSpec gate

OpenSpec is the mandatory architecture gate for behavior, permission, storage, bridge, security, deployment, or test-process changes.

Create one directory under `openspec/changes/<issue>-<slug>/` before implementation. Its `proposal.md` must include:

- GitHub Issue URL and linked Hermes Kanban card;
- the applicable decision-document sections and Ghost compatibility source;
- scope, non-goals, interfaces, permission/privacy impact, migration/rollback plan;
- acceptance criteria mapped to automated and owner browser tests;
- reviewer and owner-approval checkpoints.

Implementation starts only after the proposal is accepted by the owner/independent architecture reviewer. Keep the proposal updated when acceptance or risk changes. See `changes/README.md` for the required skeleton.
