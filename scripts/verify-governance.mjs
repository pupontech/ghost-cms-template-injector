#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const rootArgument = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
const root = rootArgument ? path.resolve(rootArgument) : '';

if (args.includes('--help')) {
  console.log('Usage: node scripts/verify-governance.mjs [--root <directory>]');
  process.exit(0);
}

let rootInfo;
try {
  rootInfo = lstatSync(root);
} catch {
  rootInfo = null;
}
if (!rootInfo || !rootInfo.isDirectory()) {
  console.error(`invalid root: ${root}`);
  process.exit(2);
}

const findings = [];

function record(relative, reason) {
  findings.push(`${relative}: ${reason}`);
}

function readRequired(relative) {
  const absolute = path.join(root, relative);
  try {
    const info = lstatSync(absolute);
    if (info.isSymbolicLink() || !info.isFile()) {
      record(relative, 'must be a regular file');
      return null;
    }
    return readFileSync(absolute, 'utf8');
  } catch {
    record(relative, 'required governance artifact is missing');
    return null;
  }
}

function proposalFiles(directory, relative = 'openspec/changes') {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const entryRelative = path.posix.join(relative, entry.name);
    const entryAbsolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return proposalFiles(entryAbsolute, entryRelative);
    return entry.isFile() && entry.name === 'proposal.md' ? [entryRelative] : [];
  });
}

function withoutFencedCodeBlocks(markdown) {
  let fence = null;
  return markdown
    .split('\n')
    .filter((line) => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (!fenceMatch) return fence === null;

      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker;
        return false;
      }

      if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return false;
    })
    .join('\n');
}

function canonicalOriginRepository() {
  try {
    const remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    if (!match) return null;
    return { owner: match[1].toLowerCase(), repository: match[2].toLowerCase() };
  } catch {
    return null;
  }
}

const canonicalOrigin = canonicalOriginRepository();

function validateProposal(relative) {
  const content = readRequired(relative);
  if (content === null) return;
  const policyContent = withoutFencedCodeBlocks(content);
  const issueUrl = policyContent.match(
    /^\s*-\s*Issue:\s+https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\s*$/im,
  );

  if (!issueUrl) record(relative, 'missing GitHub Issue URL');
  else {
    const directoryIssue = relative.match(/^openspec\/changes\/(\d+)-[^/]+\/proposal\.md$/)?.[1];
    if (directoryIssue && issueUrl[3] !== directoryIssue)
      record(relative, 'Issue URL number must match proposal directory prefix');
    if (
      canonicalOrigin &&
      (issueUrl[1].toLowerCase() !== canonicalOrigin.owner ||
        issueUrl[2].toLowerCase() !== canonicalOrigin.repository)
    )
      record(relative, 'Issue URL must reference canonical origin repository');
  }
  if (
    !/^\s*-\s*Kanban:\s+(?=[^/\r\n]*\S)[^/\r\n]+\/\s*`?t_[a-f0-9]{8,}`?\s*$/im.test(policyContent)
  )
    record(relative, 'missing Kanban linkage (`- Kanban: <board> / <card>`)');
  if (!/^\s*-\s*Owner approval:\s+(?:pending|approved|blocked)\b(?:\s+.*)?$/im.test(policyContent))
    record(relative, 'missing owner approval checkpoint');
  if (
    !/^\s*-\s*Independent reviewers?:\s+(?:pending|approved|blocked)\b(?:\s+.*)?$/im.test(
      policyContent,
    )
  )
    record(relative, 'missing independent reviewer checkpoint');

  for (const { pattern, label } of [
    { pattern: 'Problem and non-goals', label: 'Problem and non-goals' },
    {
      pattern: 'Architecture.*compatibility evidence',
      label: 'Architecture and Ghost compatibility evidence',
    },
    {
      pattern: 'Security, privacy, permissions, and rollback',
      label: 'Security, privacy, permissions, and rollback',
    },
    { pattern: 'File ownership / worktree plan', label: 'File ownership / worktree plan' },
    { pattern: 'Acceptance matrix', label: 'Acceptance matrix' },
    { pattern: 'Implementation and review log', label: 'Implementation and review log' },
  ]) {
    if (!new RegExp(`^##\\s+${pattern}\\s*$`, 'im').test(policyContent))
      record(relative, `missing required section: ${label}`);
  }
}

const agents = readRequired('AGENTS.md');
if (agents !== null) {
  if (!/GitHub Issue is the authoritative/i.test(agents))
    record('AGENTS.md', 'must declare the GitHub Issue authoritative');
  if (!/Kanban card.+link back/i.test(agents))
    record('AGENTS.md', 'must require GitHub Issue-to-Kanban linkage');
  if (!/No implementation begins before an OpenSpec proposal/i.test(agents))
    record('AGENTS.md', 'must require the OpenSpec gate before implementation');
  if (!/never self-approve, self-merge/i.test(agents))
    record('AGENTS.md', 'must prohibit self-approval and self-merging');
}

const pullRequestTemplate = readRequired('.github/pull_request_template.md');
if (pullRequestTemplate !== null) {
  if (!/Issue:/i.test(pullRequestTemplate))
    record('.github/pull_request_template.md', 'must require an Issue link');
  if (!/Kanban (board\/card|card)/i.test(pullRequestTemplate))
    record('.github/pull_request_template.md', 'must require Kanban linkage');
  if (!/not self-approving or self-merging/i.test(pullRequestTemplate))
    record('.github/pull_request_template.md', 'must prohibit self-approving or self-merging');
  if (!/owner performs the final merge/i.test(pullRequestTemplate))
    record(
      '.github/pull_request_template.md',
      'must state that the owner performs the final merge',
    );
}

const proposals = proposalFiles(path.join(root, 'openspec', 'changes'));
if (proposals.length === 0) record('openspec/changes', 'no OpenSpec proposal.md files found');
for (const proposal of proposals) validateProposal(proposal);

if (findings.length) {
  console.error('governance check FAILED:');
  for (const finding of findings) console.error(` - ${finding}`);
  process.exit(1);
}

console.log(
  `governance check OK: ${root} (${proposals.length} OpenSpec proposal${proposals.length === 1 ? '' : 's'})`,
);
