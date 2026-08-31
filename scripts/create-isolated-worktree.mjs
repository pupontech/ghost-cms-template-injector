#!/usr/bin/env node
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function tryLstat(candidate) {
  try {
    return lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/create-isolated-worktree.mjs --name <slug> [--root <repo>] [--base <ref>]',
  );
  console.log(
    'Creates one new wt/<slug> branch and worktree. It never removes or overwrites a worktree.',
  );
  console.log('The --base ref must resolve to a commit, not a tree or blob.');
  process.exit(0);
}

const name = value('--name');
let root;
try {
  root = realpathSync(path.resolve(value('--root') ?? process.cwd()));
} catch {
  console.error('not a Git worktree root');
  process.exit(2);
}
const base = value('--base') ?? 'origin/main';
if (!base || base.startsWith('-') || /[\0\r\n]/.test(base)) {
  console.error('--base must be a valid Git ref');
  process.exit(2);
}
if (!name || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(name)) {
  console.error('--name must be a lowercase slug of 3–64 letters, digits, or hyphens');
  process.exit(2);
}
const gitMetadata = tryLstat(path.join(root, '.git'));
if (!gitMetadata || gitMetadata.isSymbolicLink()) {
  console.error(`not a Git worktree root: ${root}`);
  process.exit(2);
}

function git(...parameters) {
  return execFileSync('git', ['-C', root, ...parameters], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

try {
  git('rev-parse', '--is-inside-work-tree');
  git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
} catch {
  console.error(`base ref is unavailable: ${base}`);
  process.exit(2);
}

const branch = `wt/${name}`;
const worktreeParent = path.join(root, '.worktrees');
const parentMetadata = tryLstat(worktreeParent);
if (parentMetadata?.isSymbolicLink()) {
  console.error(`refusing symlinked worktree parent: ${worktreeParent}`);
  process.exit(2);
}
if (parentMetadata && !parentMetadata.isDirectory()) {
  console.error(`worktree parent is not a directory: ${worktreeParent}`);
  process.exit(2);
}
if (!parentMetadata) mkdirSync(worktreeParent, { recursive: true });
const resolvedParent = realpathSync(worktreeParent);
if (!isWithin(root, resolvedParent) || tryLstat(worktreeParent)?.isSymbolicLink()) {
  console.error(`refusing worktree parent outside repository: ${worktreeParent}`);
  process.exit(2);
}

const target = path.join(resolvedParent, name);
if (!isWithin(root, target)) {
  console.error(`refusing worktree target outside repository: ${target}`);
  process.exit(2);
}
if (tryLstat(target)) {
  console.error(`refusing to overwrite existing worktree: ${target}`);
  process.exit(2);
}
const branchProbe = spawnSync(
  'git',
  ['-C', root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
  { stdio: 'ignore' },
);
if (branchProbe.status === 0) {
  console.error(`refusing to reuse existing branch: ${branch}`);
  process.exit(2);
}
if (branchProbe.status !== 1) {
  console.error(`unable to inspect branch safely: ${branch}`);
  process.exit(2);
}

try {
  git('worktree', 'add', '-b', branch, target, base);
  const createdInfo = tryLstat(target);
  if (!createdInfo?.isDirectory() || createdInfo.isSymbolicLink()) {
    throw new Error('created worktree is not a regular directory');
  }
  if (realpathSync(target) !== target) {
    throw new Error('created worktree resolved outside the repository');
  }
  console.log(`worktree=${target}`);
  console.log(`branch=${branch}`);
  console.log(`base=${base}`);
} catch (error) {
  console.error(error.stderr?.toString() || error.message);
  process.exit(1);
}
