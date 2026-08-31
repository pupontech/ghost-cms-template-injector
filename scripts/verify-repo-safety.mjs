#!/usr/bin/env node
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const rootArgument = rootIndex >= 0 ? args[rootIndex + 1] : process.cwd();
const root = rootArgument ? path.resolve(rootArgument) : '';
const noFollow = fsConstants.O_NOFOLLOW ?? 0;

if (args.includes('--help')) {
  console.log('Usage: node scripts/verify-repo-safety.mjs [--root <directory>]');
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

const ignoredDirectories = new Set([
  '.git',
  '.worktrees',
  'node_modules',
  'coverage',
  'evidence/local',
  'playwright-report',
  'test-results',
]);
const commandExtensions = new Set([
  '.bash',
  '.bat',
  '.cmd',
  '.fish',
  '.js',
  '.json',
  '.mjs',
  '.ps1',
  '.sh',
  '.ts',
  '.tsx',
  '.yml',
  '.yaml',
  '.zsh',
]);
const forbiddenConfigNames = new Set(['config.js', 'config.local.js', '.env']);
const allowedConfigExamples = new Set(['.env.example', '.env.sample', '.env.template']);
const findings = [];
const findingKeys = new Set();
const stagedBlobMaxBuffer = 256 * 1024 * 1024;
const trackedPaths = readTrackedPaths();
const trackedSet = new Set(trackedPaths ?? []);

function tryLstat(candidate) {
  try {
    return lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function record(relative, reason) {
  const normalized = relative || '.';
  const key = `${normalized}: ${reason}`;
  if (findingKeys.has(key)) return;
  findingKeys.add(key);
  findings.push(key);
}

function shouldIgnore(relative) {
  return [...ignoredDirectories].some(
    (directory) => relative === directory || relative.startsWith(`${directory}/`),
  );
}

function normalizeRelative(absolute) {
  return path.posix.normalize(path.relative(root, absolute).split(path.sep).join('/'));
}

function isForbiddenConfigName(relative) {
  const basename = path.basename(relative);
  return (
    forbiddenConfigNames.has(basename) ||
    (basename.startsWith('.env.') && !allowedConfigExamples.has(basename))
  );
}

function readTrackedPaths() {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'buffer' });
    return output
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((relative) => path.posix.normalize(relative.split(path.sep).join('/')));
  } catch {
    return null;
  }
}

function readStagedMode(relative) {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '--stage', '-z', '--', relative], {
      encoding: 'utf8',
    });
    const entry = output.split('\0').find(Boolean);
    return entry?.split(/\s+/, 2)[0] ?? null;
  } catch {
    return null;
  }
}

function readStagedContent(relative) {
  try {
    return execFileSync('git', ['-C', root, 'show', `:${relative}`], {
      encoding: 'buffer',
      maxBuffer: stagedBlobMaxBuffer,
    });
  } catch {
    return null;
  }
}

function isGitIgnored(absolute) {
  const relative = normalizeRelative(absolute);
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '--no-index', '--quiet', '--', relative], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

const secretPatterns = [
  { pattern: /\bgithub_pat_[A-Za-z0-9_\-]{20,}\b/i, reason: 'possible credential token' },
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_\-]{16,}\b/i,
    reason: 'possible credential token',
  },
  { pattern: /\bxox[bporas]-[A-Za-z0-9-]{16,}\b/i, reason: 'possible credential token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: 'possible credential token' },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/, reason: 'possible credential token' },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/, reason: 'possible credential token' },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    reason: 'possible private key',
  },
  {
    pattern: /\b(?:authorization|proxy-authorization)\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
    reason: 'possible bearer credential',
  },
  {
    pattern:
      /\b(?:accessToken|api[_-]?key|client[_-]?secret|password|secret|token|cookie)\s*[:=]\s*['"]([^'"\r\n]{8,})['"]/i,
    reason: 'possible credential assignment',
  },
  {
    pattern:
      /(?:^|[^\w])(?:[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL)[A-Z0-9_]*)\s*=\s*['"]?([^\s'"`]{8,})/m,
    reason: 'possible credential assignment',
  },
];
const placeholderValues = new Set([
  'changeme',
  'change-me',
  'dummy',
  'example',
  'example-token',
  'fake',
  'not-a-secret',
  'not_a_secret',
  'placeholder',
  'redacted',
  'replace-me',
  'replace_me',
]);
const shellPipelinePattern =
  /\b(?:curl|wget)\b[^\n|]*(?:\|\s*(?:sudo\s+)?(?:env\s+\S+\s+)?(?:ba|z|fi)?sh\b|\|\s*(?:sudo\s+)?(?:python3?|perl)\b)/i;
const destructiveGitPattern =
  /\bgit\s+(?:clean\b[^\n]*(?:-f\b|--force\b)|reset\b[^\n]*--hard\b|checkout\b[^\n]*\.\s*$)/im;

function scanWindow(relative, text, scanCommands) {
  for (const { pattern, reason } of secretPatterns) {
    const match = pattern.exec(text);
    const assignmentValue = match?.[1]?.trim().toLowerCase();
    if (
      match &&
      !(reason === 'possible credential assignment' && placeholderValues.has(assignmentValue))
    ) {
      record(relative, reason);
    }
  }
  if (!scanCommands) return;
  if (shellPipelinePattern.test(text)) record(relative, 'unverified curl-to-shell installer');
  if (destructiveGitPattern.test(text)) record(relative, 'destructive Git command');
}

function inspectFile(absolute, relative, tracked) {
  const info = tryLstat(absolute);
  if (!info) return;
  if (info.isSymbolicLink()) {
    record(relative, 'symbolic link is not allowed in release inputs');
    return;
  }
  if (!info.isFile()) return;
  if (tracked && isForbiddenConfigName(relative)) {
    record(relative, 'tracked-style runtime configuration is forbidden');
    return;
  }

  let descriptor;
  try {
    descriptor = openSync(absolute, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      record(relative, 'opened release input is not a regular file');
      return;
    }

    const buffer = Buffer.alloc(64 * 1024);
    const scanCommands = commandExtensions.has(path.extname(relative).toLowerCase());
    let carry = '';
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      const nulIndex = chunk.indexOf(0);
      const text = carry + chunk.subarray(0, nulIndex >= 0 ? nulIndex : bytesRead).toString('utf8');
      scanWindow(relative, text, scanCommands);
      if (nulIndex >= 0) break;
      carry = text.slice(-8192);
    }
  } catch {
    record(relative, 'unable to inspect release input safely');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function scanStagedFile(relative) {
  const mode = readStagedMode(relative);
  if (!mode) {
    record(relative, 'unable to inspect staged Git entry');
    return;
  }
  if (mode === '120000') {
    record(relative, 'staged symbolic link is not allowed in release inputs');
    return;
  }
  if (mode !== '100644' && mode !== '100755') {
    record(relative, `unsupported staged Git mode: ${mode}`);
    return;
  }
  if (isForbiddenConfigName(relative)) {
    record(relative, 'tracked-style runtime configuration is forbidden');
  }

  const content = readStagedContent(relative);
  if (content === null) {
    record(relative, 'unable to inspect staged file');
    return;
  }
  const nulIndex = content.indexOf(0);
  scanWindow(
    relative,
    content.subarray(0, nulIndex >= 0 ? nulIndex : content.length).toString('utf8'),
    commandExtensions.has(path.extname(relative).toLowerCase()),
  );
}

function walk(directory, relative = '', generated = false) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryRelative = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (shouldIgnore(entryRelative)) continue;
    const absolute = path.join(directory, entry.name);
    const entryGenerated =
      generated || entryRelative === 'dist' || entryRelative.startsWith('dist/');
    const entryTracked = trackedSet.has(entryRelative);

    if (entry.isDirectory()) {
      if (trackedPaths && !entryGenerated && isGitIgnored(absolute)) continue;
      walk(absolute, entryRelative, entryGenerated);
    } else if (entry.isSymbolicLink()) {
      if (!trackedPaths || entryTracked || entryGenerated || !isGitIgnored(absolute)) {
        record(entryRelative, 'symbolic link is not allowed in release inputs');
      }
    } else if (entry.isFile() && !entryTracked) {
      if (trackedPaths && !entryGenerated && isGitIgnored(absolute)) continue;
      inspectFile(absolute, entryRelative, false);
    }
  }
}

if (trackedPaths) {
  for (const relative of trackedPaths) {
    inspectFile(path.join(root, relative), relative, true);
    scanStagedFile(relative);
  }
}
walk(root);

if (findings.length) {
  console.error('repository safety check FAILED:');
  for (const finding of findings) console.error(` - ${finding}`);
  process.exit(1);
}
console.log(`repository safety check OK: ${root}`);
