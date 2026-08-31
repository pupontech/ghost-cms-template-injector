import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function tryLstat(candidate) {
  try {
    return lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function requireNonSymlink(candidate, label) {
  const info = tryLstat(candidate);
  if (info?.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  return info;
}

function isGitIgnored(root, absolute) {
  const relative = path.relative(root, absolute);
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '--no-index', '--quiet', '--', relative], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function isGitTracked(root, absolute) {
  const relative = path.relative(root, absolute);
  try {
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relative], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function hasSymlinkComponent(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    if (tryLstat(current)?.isSymbolicLink()) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function hasParentTraversal(candidate) {
  return String(candidate)
    .split(/[\\/]+/)
    .includes('..');
}

export function resolveProofPaths(repositoryRoot, cookieJarInput) {
  if (!cookieJarInput) throw new Error('GHOST_PROOF_COOKIE_JAR is required');
  if (hasParentTraversal(cookieJarInput)) {
    throw new Error('GHOST_PROOF_COOKIE_JAR path must not contain parent traversal');
  }

  const root = realpathSync(path.resolve(repositoryRoot));
  const evidenceParent = path.join(root, 'evidence');
  const evidenceDirectory = path.join(evidenceParent, 'local');
  const evidenceParentInfo = requireNonSymlink(evidenceParent, 'evidence directory');
  if (evidenceParentInfo && !evidenceParentInfo.isDirectory())
    throw new Error('evidence must be a directory');
  requireNonSymlink(evidenceDirectory, 'evidence/local');
  mkdirSync(evidenceDirectory, { recursive: true });
  requireNonSymlink(evidenceParent, 'evidence directory');
  requireNonSymlink(evidenceDirectory, 'evidence/local');

  const resolvedEvidenceDirectory = realpathSync(evidenceDirectory);
  if (!isWithin(root, resolvedEvidenceDirectory) || !isGitIgnored(root, evidenceDirectory)) {
    throw new Error('evidence/local must remain inside the repository and be Git-ignored');
  }

  const cookieJar = path.resolve(cookieJarInput);
  if (hasSymlinkComponent(cookieJar)) {
    throw new Error('GHOST_PROOF_COOKIE_JAR path must not contain a symbolic link');
  }
  const cookieInfo = tryLstat(cookieJar);
  if (!cookieInfo || !cookieInfo.isFile())
    throw new Error('GHOST_PROOF_COOKIE_JAR must name a regular file');
  if (cookieInfo.isSymbolicLink())
    throw new Error('GHOST_PROOF_COOKIE_JAR must not be a symbolic link');

  const resolvedCookieJar = realpathSync(cookieJar);
  if (
    isWithin(root, resolvedCookieJar) &&
    (isGitTracked(root, cookieJar) || !isGitIgnored(root, cookieJar))
  ) {
    throw new Error('GHOST_PROOF_COOKIE_JAR must be outside the repository or Git-ignored');
  }

  return { cookieJar: resolvedCookieJar, evidenceDirectory: resolvedEvidenceDirectory };
}

export function writeProofArtifact(repositoryRoot, evidenceDirectory, filename, content) {
  if (!SAFE_ARTIFACT_NAME.test(filename)) {
    throw new Error('proof artifact filename must be a simple relative filename');
  }

  const root = realpathSync(path.resolve(repositoryRoot));
  const expectedDirectory = path.join(root, 'evidence', 'local');
  const resolvedDirectory = realpathSync(evidenceDirectory);
  if (resolvedDirectory !== expectedDirectory || !isWithin(root, resolvedDirectory)) {
    throw new Error('proof artifact directory is outside evidence/local');
  }
  const directoryInfo = requireNonSymlink(resolvedDirectory, 'evidence/local');
  if (!directoryInfo?.isDirectory()) throw new Error('evidence/local must be a directory');
  if (!isGitIgnored(root, resolvedDirectory)) {
    throw new Error('evidence/local must be Git-ignored');
  }

  const target = path.join(resolvedDirectory, filename);
  if (path.dirname(target) !== resolvedDirectory) {
    throw new Error('proof artifact path escaped evidence/local');
  }
  if (isGitTracked(root, target)) {
    throw new Error(`proof artifact destination is Git-tracked: ${target}`);
  }
  const existing = tryLstat(target);
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error(`proof artifact is a symbolic link: ${target}`);
    if (existing.isFile() && existing.nlink > 1)
      throw new Error(`proof artifact is a hard link: ${target}`);
    throw new Error(`proof artifact already exists: ${target}`);
  }

  let directoryDescriptor;
  let descriptor;
  let targetOpenPath = target;
  let created = false;
  try {
    if (process.platform === 'linux') {
      directoryDescriptor = openSync(
        resolvedDirectory,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NO_FOLLOW,
      );
      const openedDirectory = fstatSync(directoryDescriptor);
      if (!openedDirectory.isDirectory()) {
        throw new Error(`evidence/local is not a directory: ${resolvedDirectory}`);
      }
      const procDirectory = `/proc/self/fd/${directoryDescriptor}`;
      if (!tryLstat(procDirectory)) {
        throw new Error('secure evidence directory handles are unavailable');
      }
      targetOpenPath = path.join(procDirectory, filename);
    }

    descriptor = openSync(
      targetOpenPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    created = true;
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`proof artifact is not a regular file: ${target}`);
    if (opened.nlink !== 1) throw new Error(`proof artifact is a hard link: ${target}`);
    const bytes = Buffer.from(String(content), 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
  } catch (error) {
    if (created) {
      try {
        unlinkSync(targetOpenPath);
      } catch {
        // Keep the fail-closed behavior if cleanup is interrupted.
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
  return target;
}
