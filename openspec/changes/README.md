# OpenSpec change directory template

Create `openspec/changes/<issue-number>-<slug>/proposal.md`:

```md
# <title>

- Issue: https://github.com/<owner>/<repository>/issues/<number>
- Kanban: <board> / t_<8+ lowercase-hex card-id>
- Owner approval: pending/approved/blocked
- Independent reviewer: pending/approved/blocked

## Problem and non-goals

## Architecture and Ghost compatibility evidence

## Security, privacy, permissions, and rollback

## File ownership / worktree plan

## Acceptance matrix

- [ ] automated checks
- [ ] manifest and artifact safety checks
- [ ] real browser/Ghost owner evidence, or explicit blocker

## Implementation and review log
```

Do not mark the proposal complete until the linked PR, CI evidence, and human-acceptance result are recorded.
