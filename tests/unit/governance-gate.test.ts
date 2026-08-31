import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gcti-governance-'));
  temporaryRoots.push(directory);
  return directory;
}

function writeGovernanceFixture(
  directory: string,
  options: {
    agents?: string;
    proposal?: string;
    pullRequestTemplate?: string;
    origin?: string;
  } = {},
) {
  const agents =
    options.agents ??
    [
      'The GitHub Issue is the authoritative product/work record.',
      'The ghost-preset-toolbar Hermes Kanban card executes that issue and must link back to it.',
      'No implementation begins before an OpenSpec proposal.',
      'Agents must never self-approve, self-merge, or bypass required checks.',
    ].join('\n');
  const proposal =
    options.proposal ??
    [
      '# Fixture governance change',
      '',
      '- Issue: https://github.com/example/repository/issues/4',
      '- Kanban: `ghost-preset-toolbar` / `t_1234abcd`',
      '- Owner approval: approved',
      '- Independent reviewer: pending',
      '',
      '## Problem and non-goals',
      '## Architecture and Ghost compatibility evidence',
      '## Security, privacy, permissions, and rollback',
      '## File ownership / worktree plan',
      '## Acceptance matrix',
      '## Implementation and review log',
    ].join('\n');
  const pullRequestTemplate =
    options.pullRequestTemplate ??
    [
      '## Authoritative records',
      '- Issue: https://github.com/example/repository/issues/4',
      '- Kanban board/card: `ghost-preset-toolbar` / `t_1234abcd`',
      '',
      '## Safety and evidence',
      '- [ ] I am not self-approving or self-merging this PR.',
      '- [ ] The owner performs the final merge only after CI, independent review, and acceptance gates are current.',
    ].join('\n');

  mkdirSync(join(directory, '.github'), { recursive: true });
  mkdirSync(join(directory, 'openspec', 'changes', '4-fixture'), { recursive: true });
  if (options.origin) {
    spawnSync('git', ['init', '--quiet', directory]);
    spawnSync('git', ['-C', directory, 'remote', 'add', 'origin', options.origin]);
  }
  writeFileSync(join(directory, 'AGENTS.md'), `${agents}\n`);
  writeFileSync(join(directory, '.github', 'pull_request_template.md'), `${pullRequestTemplate}\n`);
  writeFileSync(
    join(directory, 'openspec', 'changes', '4-fixture', 'proposal.md'),
    `${proposal}\n`,
  );
}

function runGovernanceGate(directory: string) {
  return spawnSync('node', ['scripts/verify-governance.mjs', '--root', directory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

describe('governance gate', () => {
  it('accepts a complete OpenSpec, issue-to-Kanban linkage, and no-self-merge policy', () => {
    const directory = fixture();
    writeGovernanceFixture(directory);

    const result = runGovernanceGate(directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('governance check OK');
  });

  it('rejects an OpenSpec that names a board without a Kanban card ID', () => {
    const directory = fixture();
    writeGovernanceFixture(directory, {
      proposal: [
        '# Incomplete Kanban linkage',
        '',
        '- Issue: https://github.com/example/repository/issues/4',
        '- Kanban: ghost-preset-toolbar / release-safety',
        '- Owner approval: approved',
        '- Independent reviewer: pending',
        '',
        '## Problem and non-goals',
        '## Architecture and Ghost compatibility evidence',
        '## Security, privacy, permissions, and rollback',
        '## File ownership / worktree plan',
        '## Acceptance matrix',
        '## Implementation and review log',
      ].join('\n'),
    });

    const result = runGovernanceGate(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Kanban linkage');
  });

  it('rejects an OpenSpec directory whose issue prefix disagrees with its Issue URL', () => {
    const directory = fixture();
    writeGovernanceFixture(directory, {
      proposal: [
        '# Incorrect issue linkage',
        '',
        '- Issue: https://github.com/example/repository/issues/5',
        '- Kanban: ghost-preset-toolbar / t_1234abcd',
        '- Owner approval: approved',
        '- Independent reviewer: pending',
        '',
        '## Problem and non-goals',
        '## Architecture and Ghost compatibility evidence',
        '## Security, privacy, permissions, and rollback',
        '## File ownership / worktree plan',
        '## Acceptance matrix',
        '## Implementation and review log',
      ].join('\n'),
    });

    const result = runGovernanceGate(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Issue URL number must match proposal directory prefix');
  });

  it('rejects an Issue URL that points outside the canonical origin repository', () => {
    const directory = fixture();
    writeGovernanceFixture(directory, {
      origin: 'https://github.com/example/repository.git',
      proposal: [
        '# Incorrect repository linkage',
        '',
        '- Issue: https://github.com/unrelated/repository/issues/4',
        '- Kanban: ghost-preset-toolbar / t_1234abcd',
        '- Owner approval: approved',
        '- Independent reviewer: pending',
        '',
        '## Problem and non-goals',
        '## Architecture and Ghost compatibility evidence',
        '## Security, privacy, permissions, and rollback',
        '## File ownership / worktree plan',
        '## Acceptance matrix',
        '## Implementation and review log',
      ].join('\n'),
    });

    const result = runGovernanceGate(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Issue URL must reference canonical origin repository');
  });

  it('rejects arbitrary owner-approval states', () => {
    const directory = fixture();
    writeGovernanceFixture(directory, {
      proposal: [
        '# Invalid approval state',
        '',
        '- Issue: https://github.com/example/repository/issues/4',
        '- Kanban: ghost-preset-toolbar / t_1234abcd',
        '- Owner approval: verified',
        '- Independent reviewer: pending',
        '',
        '## Problem and non-goals',
        '## Architecture and Ghost compatibility evidence',
        '## Security, privacy, permissions, and rollback',
        '## File ownership / worktree plan',
        '## Acceptance matrix',
        '## Implementation and review log',
      ].join('\n'),
    });

    const result = runGovernanceGate(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('owner approval checkpoint');
  });

  it('rejects a non-hex Kanban card ID', () => {
    const directory = fixture();
    writeGovernanceFixture(directory, {
      proposal: [
        '# Invalid card ID',
        '',
        '- Issue: https://github.com/example/repository/issues/4',
        '- Kanban: ghost-preset-toolbar / t_zzzzzzzz',
        '- Owner approval: approved',
        '- Independent reviewer: pending',
        '',
        '## Problem and non-goals',
        '## Architecture and Ghost compatibility evidence',
        '## Security, privacy, permissions, and rollback',
        '## File ownership / worktree plan',
        '## Acceptance matrix',
        '## Implementation and review log',
      ].join('\n'),
    });

    const result = runGovernanceGate(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Kanban linkage');
  });

  it('does not count fenced Markdown examples as proposal metadata', () => {
    const directory = fixture();
    writeGovernanceFixture(directory, {
      proposal: [
        '# Empty proposal',
        '',
        '```md',
        '- Issue: https://github.com/example/repository/issues/4',
        '- Kanban: ghost-preset-toolbar / t_1234abcd',
        '- Owner approval: approved',
        '- Independent reviewer: pending',
        '## Problem and non-goals',
        '## Architecture and Ghost compatibility evidence',
        '## Security, privacy, permissions, and rollback',
        '## File ownership / worktree plan',
        '## Acceptance matrix',
        '## Implementation and review log',
        '```',
      ].join('\n'),
    });

    const result = runGovernanceGate(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GitHub Issue URL');
  });

  it('keeps mismatched fence delimiters inside the same Markdown code block', () => {
    const directory = fixture();
    writeGovernanceFixture(directory, {
      proposal: [
        '# Empty proposal',
        '',
        '~~~~md',
        '```',
        '- Issue: https://github.com/example/repository/issues/4',
        '- Kanban: ghost-preset-toolbar / t_1234abcd',
        '- Owner approval: approved',
        '- Independent reviewer: pending',
        '## Problem and non-goals',
        '## Architecture and Ghost compatibility evidence',
        '## Security, privacy, permissions, and rollback',
        '## File ownership / worktree plan',
        '## Acceptance matrix',
        '## Implementation and review log',
        '~~~~',
      ].join('\n'),
    });

    const result = runGovernanceGate(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GitHub Issue URL');
  });

  it('fails with actionable messages when a proposal or merge policy is incomplete', () => {
    const missingProposalField = fixture();
    writeGovernanceFixture(missingProposalField, {
      proposal: '# Incomplete\n\n- Issue: https://github.com/example/repository/issues/4\n',
    });
    const proposalResult = runGovernanceGate(missingProposalField);
    expect(proposalResult.status).toBe(1);
    expect(proposalResult.stderr).toContain('Kanban linkage');
    expect(proposalResult.stderr).toContain('owner approval');

    const missingMergePolicy = fixture();
    writeGovernanceFixture(missingMergePolicy, {
      pullRequestTemplate:
        '## Authoritative records\n- Issue: https://github.com/example/repository/issues/4\n',
    });
    const mergePolicyResult = runGovernanceGate(missingMergePolicy);
    expect(mergePolicyResult.status).toBe(1);
    expect(mergePolicyResult.stderr).toContain('self-merging');
  });
});
