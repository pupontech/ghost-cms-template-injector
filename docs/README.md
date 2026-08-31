# Documentation index

Start with `../GHOST_CMS_TEMPLATE_INJECTOR_DECISION.md` for architecture and
Ghost compatibility decisions, then use the implementation guide for the
delivery workflow. The following index points to the governing controls and
the evidence needed to release safely.

| Document                                                 | Purpose                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../AGENTS.md`                                           | Repository rules: OpenSpec, issue/Kanban linkage, isolated worktrees, independent review, no self-merge, evidence boundary, and safety requirements. |
| `../GHOST_CMS_TEMPLATE_INJECTOR_DECISION.md`             | Architecture and Ghost compatibility authority.                                                                                                      |
| `../GHOST_CMS_TEMPLATE_INJECTOR_IMPLEMENTATION_GUIDE.md` | Delivery workflow, approved model lanes, Kanban graph, review protocol, and release gates.                                                           |
| `../openspec/README.md`                                  | Mandatory proposal/specification gate and required proposal contents.                                                                                |
| `architecture-contract.md`                               | Implementation contract and compatibility/evidence requirements.                                                                                     |
| `manual-test-matrix.md`                                  | Owner Ghost/Chromium acceptance scenarios and negative cases.                                                                                        |
| `release-checklist.md`                                   | Concise prerequisites, commands, expected outcomes, evidence handling, and escalation guidance.                                                      |
| `release-status.md`                                      | Current candidate status, verification record, and owner gate.                                                                                       |
| `../SECURITY.md`                                         | Vulnerability reporting and secret-handling policy.                                                                                                  |
| `../TESTING.md`                                          | Clean-install and owner acceptance instructions.                                                                                                     |

The reusable worktree initializer is `npm run worktree:init -- --name <slug>`;
the governance gate is `npm run governance:check`; and the repository safety
scanner is `npm run safety:check`. Their usage and release interpretation are
summarized in `release-checklist.md` and defined by the linked repository rules
and scripts.

Tracked `evidence/` contains only reviewed redacted summaries. Raw owner/browser proof output belongs in ignored `evidence/local/`.
