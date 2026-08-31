import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProofPaths, writeProofArtifact } from '../../scripts/proof-path-safety.mjs';

const repositoryRoot = process.cwd();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gcti-proof-safety-'));
  temporaryRoots.push(directory);
  execFileSync('git', ['init', '--quiet', directory]);
  writeFileSync(join(directory, '.gitignore'), 'evidence/local/\n');
  return directory;
}

function runResolver(root: string, cookieJar: string) {
  return spawnSync(
    'node',
    [
      '--input-type=module',
      '--eval',
      "import { resolveProofPaths } from './scripts/proof-path-safety.mjs'; console.log(JSON.stringify(resolveProofPaths(process.argv[1], process.argv[2])));",
      root,
      cookieJar,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
}

describe('live Ghost proof safety', () => {
  it('rejects an evidence/local symlink that redirects proof output', () => {
    const root = fixture();
    const cookieJar = join(tmpdir(), 'gcti-proof-safety-cookie.txt');
    temporaryRoots.push(cookieJar);
    writeFileSync(cookieJar, 'cookie');
    mkdirSync(join(root, 'evidence'));
    mkdirSync(join(root, 'tracked'));
    symlinkSync(join(root, 'tracked'), join(root, 'evidence', 'local'));

    const result = runResolver(root, cookieJar);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not be a symbolic link');
    expect(existsSync(join(root, 'tracked', 'live-proof.md'))).toBe(false);
  });

  it('rejects a cookie jar in a tracked repository path and through an ancestor link', () => {
    const root = fixture();
    mkdirSync(join(root, 'evidence', 'local'), { recursive: true });
    const cookieJar = join(root, 'tracked-cookie.jar');
    writeFileSync(cookieJar, 'cookie');
    execFileSync('git', ['-C', root, 'add', '-f', 'tracked-cookie.jar']);

    const result = runResolver(root, cookieJar);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be outside the repository or Git-ignored');

    const outsideDirectory = mkdtempSync(join(tmpdir(), 'gcti-cookie-outside-'));
    temporaryRoots.push(outsideDirectory);
    writeFileSync(join(outsideDirectory, 'cookie.jar'), 'cookie');
    symlinkSync(outsideDirectory, join(root, 'cookie-link'));

    expect(() => resolveProofPaths(root, join(root, 'cookie-link', 'cookie.jar'))).toThrow(
      /symbolic link/,
    );

    const externalRealDirectory = mkdtempSync(join(tmpdir(), 'gcti-cookie-real-'));
    const externalLink = join(tmpdir(), `gcti-cookie-link-${process.pid}`);
    temporaryRoots.push(externalRealDirectory, externalLink);
    writeFileSync(join(externalRealDirectory, 'session.jar'), 'cookie');
    symlinkSync(externalRealDirectory, externalLink);
    expect(() => resolveProofPaths(root, join(externalLink, 'session.jar'))).toThrow(
      /symbolic link/,
    );

    const traversalCookie = join(root, 'traversal-cookie.jar');
    writeFileSync(traversalCookie, 'cookie');
    expect(() => resolveProofPaths(root, `${root}/unused/../traversal-cookie.jar`)).toThrow(
      /parent traversal/,
    );
  });

  it('rejects a cookie jar that is both tracked and ignored', () => {
    const root = fixture();
    mkdirSync(join(root, 'evidence', 'local'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'evidence/local/\ncookies*.txt\n');
    const cookieJar = join(root, 'cookies-session.txt');
    writeFileSync(cookieJar, 'cookie');
    execFileSync('git', ['-C', root, 'add', '-f', 'cookies-session.txt']);

    const result = runResolver(root, cookieJar);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be outside the repository or Git-ignored');
  });

  it('accepts an external cookie jar and an ignored local evidence directory', () => {
    const root = fixture();
    const cookieJar = join(tmpdir(), 'gcti-proof-safety-valid-cookie.txt');
    temporaryRoots.push(cookieJar);
    writeFileSync(cookieJar, 'cookie');

    const command = runResolver(root, cookieJar);
    expect(command.status).toBe(0);
    const result = JSON.parse(command.stdout) as {
      cookieJar: string;
      evidenceDirectory: string;
    };
    expect(result.cookieJar).toBe(cookieJar);
    expect(result.evidenceDirectory).toBe(join(root, 'evidence', 'local'));
    expect(existsSync(result.evidenceDirectory)).toBe(true);
  });

  it('rejects existing proof output links and tracked destinations', () => {
    const root = fixture();
    const cookieJar = join(tmpdir(), 'gcti-proof-safety-output-cookie.txt');
    temporaryRoots.push(cookieJar);
    writeFileSync(cookieJar, 'cookie');
    const paths = resolveProofPaths(root, cookieJar);

    const created = writeProofArtifact(root, paths.evidenceDirectory, 'safe-proof.md', 'safe');
    expect(readFileSync(created, 'utf8')).toBe('safe');
    expect(statSync(created).mode & 0o777).toBe(0o600);
    expect(() =>
      writeProofArtifact(root, paths.evidenceDirectory, 'safe-proof.md', 'again'),
    ).toThrow(/already exists/);

    const failedPath = join(paths.evidenceDirectory, 'failed-proof.md');
    const failingContent = {
      toString() {
        throw new Error('content conversion failed');
      },
    } as unknown as string;
    expect(() =>
      writeProofArtifact(root, paths.evidenceDirectory, 'failed-proof.md', failingContent),
    ).toThrow(/content conversion failed/);
    expect(existsSync(failedPath)).toBe(false);

    const outside = join(tmpdir(), 'gcti-proof-safety-output-target.txt');
    temporaryRoots.push(outside);
    writeFileSync(outside, 'before');
    symlinkSync(outside, join(paths.evidenceDirectory, 'live-proof.md'));
    expect(() =>
      writeProofArtifact(root, paths.evidenceDirectory, 'live-proof.md', 'after'),
    ).toThrow(/symbolic link|already exists/);
    expect(readFileSync(outside, 'utf8')).toBe('before');

    const hardlinkSource = join(root, 'hardlink-source.txt');
    writeFileSync(hardlinkSource, 'before');
    linkSync(hardlinkSource, join(paths.evidenceDirectory, 'hardlink-proof.md'));
    expect(() =>
      writeProofArtifact(root, paths.evidenceDirectory, 'hardlink-proof.md', 'after'),
    ).toThrow(/hard link|already exists/);
    expect(readFileSync(hardlinkSource, 'utf8')).toBe('before');

    const tracked = join(paths.evidenceDirectory, 'tracked-proof.md');
    writeFileSync(tracked, 'before');
    execFileSync('git', ['-C', root, 'add', '-f', 'evidence/local/tracked-proof.md']);
    expect(() =>
      writeProofArtifact(root, paths.evidenceDirectory, 'tracked-proof.md', 'after'),
    ).toThrow(/tracked|already exists/);
    expect(readFileSync(tracked, 'utf8')).toBe('before');
  });

  it('creates a new private proof artifact inside the resolved evidence directory', () => {
    const root = fixture();
    const cookieJar = join(tmpdir(), 'gcti-proof-safety-private-cookie.txt');
    temporaryRoots.push(cookieJar);
    writeFileSync(cookieJar, 'cookie');
    const paths = resolveProofPaths(root, cookieJar);

    const target = writeProofArtifact(root, paths.evidenceDirectory, 'new-proof.md', 'safe proof');
    expect(target).toBe(join(paths.evidenceDirectory, 'new-proof.md'));
    expect(readFileSync(target, 'utf8')).toBe('safe proof');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('routes every live-proof harness through the safe path resolver', () => {
    for (const relativePath of [
      'tests/e2e/real-ghost-browser-proof.mjs',
      'tests/e2e/headless-rerun-ef2721b1.mjs',
      'tests/e2e/headed-disable-bridge-proof.mjs',
    ]) {
      const source = readFileSync(join(repositoryRoot, relativePath), 'utf8');
      expect(source).toContain(
        "import { resolveProofPaths, writeProofArtifact } from '../../scripts/proof-path-safety.mjs'",
      );
      expect(source).toMatch(
        /resolveProofPaths\(\s*ROOT,\s*process\.env\.GHOST_PROOF_COOKIE_JAR,\s*\)/,
      );
      expect(source).not.toContain("const COOKIE_JAR = '/tmp/cj.txt'");
      expect(source).not.toContain("path.join(ROOT, 'evidence')");
      expect(source).not.toContain('JSON.stringify(discoverRaw)');
      expect(source).not.toContain('JSON.stringify(applyRaw)');
    }
  });
});
