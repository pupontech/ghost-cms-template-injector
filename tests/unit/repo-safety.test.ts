import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gcti-safety-'));
  temporaryRoots.push(directory);
  return directory;
}

function gitFixture(): string {
  const directory = fixture();
  execFileSync('git', ['init', '--quiet', directory]);
  return directory;
}

function runSafety(directory: string) {
  return spawnSync('node', ['scripts/verify-repo-safety.mjs', '--root', directory], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('repository safety scripts', () => {
  it('accepts a clean fixture and rejects leaked credentials', () => {
    const directory = fixture();
    writeFileSync(join(directory, 'safe.js'), 'export const value = 1;\n');

    expect(runSafety(directory).status).toBe(0);

    writeFileSync(
      join(directory, 'leak.js'),
      `const ${'access' + 'Token'} = 'live-token-value';\n`,
    );
    const leaked = runSafety(directory);
    expect(leaked.status).toBe(1);
    expect(leaked.stderr).toContain('possible credential');

    const builtOnly = fixture();
    mkdirSync(join(builtOnly, 'dist'));
    writeFileSync(
      join(builtOnly, 'dist', 'bundle.js'),
      `const ${'access' + 'Token'} = 'built-token-value';\n`,
    );
    const builtLeak = runSafety(builtOnly);
    expect(builtLeak.status).toBe(1);
    expect(builtLeak.stderr).toContain('dist/bundle.js');

    const example = fixture();
    writeFileSync(join(example, 'example.md'), "// const accessToken = 'not-a-secret';\n");
    expect(runSafety(example).status).toBe(0);

    const intentionalIdentifier = fixture();
    writeFileSync(
      join(intentionalIdentifier, 'provider.example'),
      "const DEEPSEEK_API_KEY = 'placeholder';\n",
    );
    expect(runSafety(intentionalIdentifier).status).toBe(0);

    const binaryPrefix = fixture();
    writeFileSync(
      join(binaryPrefix, 'binary.dat'),
      Buffer.concat([
        Buffer.from(`const ${'access' + 'Token'} = 'binary-secret-value';\n`),
        Buffer.from([0, 1, 2, 3]),
      ]),
    );
    expect(runSafety(binaryPrefix).status).toBe(1);

    const ignoredConfig = gitFixture();
    writeFileSync(join(ignoredConfig, '.gitignore'), 'config.js\n');
    writeFileSync(
      join(ignoredConfig, 'config.js'),
      `const ${'access' + 'Token'} = 'ignored-local-secret-value';\n`,
    );
    expect(runSafety(ignoredConfig).status).toBe(0);
  });

  it('documents the worktree initializer interface', () => {
    const result = spawnSync('node', ['scripts/create-isolated-worktree.mjs', '--help'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('rejects tracked files hidden under ignored paths and tracked symlinks', () => {
    const directory = gitFixture();
    mkdirSync(join(directory, 'evidence', 'local'), { recursive: true });
    writeFileSync(
      join(directory, 'evidence', 'local', 'tracked-leak.js'),
      `const ${'access' + 'Token'} = 'tracked-secret-value';\n`,
    );
    execFileSync('git', ['-C', directory, 'add', '-f', 'evidence/local/tracked-leak.js']);

    const outside = join(tmpdir(), 'gcti-safety-symlink-target.js');
    temporaryRoots.push(outside);
    writeFileSync(outside, `const ${'access' + 'Token'} = 'symlink-secret-value';\n`);
    symlinkSync(outside, join(directory, 'tracked-link.js'));
    execFileSync('git', ['-C', directory, 'add', '-f', 'tracked-link.js']);

    const result = runSafety(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tracked-leak.js');
    expect(result.stderr).toContain('symbolic link');

    const redirected = gitFixture();
    mkdirSync(join(redirected, 'evidence', 'local'), { recursive: true });
    writeFileSync(
      join(redirected, 'evidence', 'local', 'redirected.js'),
      'export const safe = true;\n',
    );
    execFileSync('git', ['-C', redirected, 'add', '-f', 'evidence/local/redirected.js']);
    rmSync(join(redirected, 'evidence', 'local'), { recursive: true, force: true });
    const redirectedTarget = mkdtempSync(join(tmpdir(), 'gcti-safety-redirected-'));
    temporaryRoots.push(redirectedTarget);
    writeFileSync(join(redirectedTarget, 'redirected.js'), 'export const safe = true;\n');
    symlinkSync(redirectedTarget, join(redirected, 'evidence', 'local'));

    const redirectedResult = runSafety(redirected);
    expect(redirectedResult.status).toBe(1);
    expect(redirectedResult.stderr).toContain('evidence/local/redirected.js');
    expect(redirectedResult.stderr).toContain('symbolic link in release input path');
  });

  it('scans tracked text, source maps, large files, and common token formats', () => {
    const directory = gitFixture();
    const githubToken = ['gho', 'secret-token-value'].join('_');
    writeFileSync(join(directory, 'notes.md'), `Authorization: Bearer ${githubToken}\n`);
    writeFileSync(
      join(directory, 'bundle.js.map'),
      JSON.stringify({
        sourcesContent: [`const ${['DEEPSEEK_API', 'KEY'].join('_')} = 'deepseek-secret-value';`],
      }),
    );
    writeFileSync(
      join(directory, 'large.js'),
      `${'x'.repeat(2_000_001)}\nconst AWS_ACCESS_KEY_ID = '${['AKIA', 'IOSFODNN7EXAMPLE'].join('')}';\n`,
    );

    const result = runSafety(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('notes.md');
    expect(result.stderr).toContain('bundle.js.map');
    expect(result.stderr).toContain('large.js');
  });

  it('scans staged content even when the working copy is safe', () => {
    const directory = gitFixture();
    const staged = join(directory, 'staged.js');
    writeFileSync(
      staged,
      `const ${['DEEPSEEK_API', 'KEY'].join('_')} = 'staged-placeholder-value';\n`,
    );
    execFileSync('git', ['-C', directory, 'add', 'staged.js']);
    writeFileSync(staged, 'export const safe = true;\n');

    const stagedBinary = join(directory, 'staged-binary.bin');
    writeFileSync(
      stagedBinary,
      Buffer.concat([
        Buffer.from(`const ${['DEEPSEEK_API', 'KEY'].join('_')} = 'staged-binary-secret';\n`),
        Buffer.from([0, 1, 2]),
      ]),
    );
    execFileSync('git', ['-C', directory, 'add', 'staged-binary.bin']);
    writeFileSync(stagedBinary, Buffer.from([0, 1, 2]));

    const result = runSafety(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('staged.js');
    expect(result.stderr).toContain('staged-binary.bin');
  });

  it('rejects a staged symlink even when the working copy is regular', () => {
    const directory = gitFixture();
    const link = join(directory, 'staged-link.js');
    symlinkSync(join(tmpdir(), 'gcti-safety-missing-target'), link);
    execFileSync('git', ['-C', directory, 'add', '-f', 'staged-link.js']);
    rmSync(link);
    writeFileSync(link, 'export const safe = true;\n');

    const result = runSafety(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('staged-link.js');
    expect(result.stderr).toContain('staged symbolic link');
  });

  it('rejects tracked environment configuration variants', () => {
    const directory = gitFixture();
    writeFileSync(join(directory, '.env.local'), 'SAFE_EXAMPLE=1\n');
    execFileSync('git', ['-C', directory, 'add', '.env.local']);

    const result = runSafety(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.env.local');
    expect(result.stderr).toContain('runtime configuration');
  });

  it('detects shell and destructive Git command variants', () => {
    const curl = ['cu', 'rl'].join('');
    const pipe = ['|'].join('');
    const git = ['g', 'it'].join('');
    const clean = ['cl', 'ean'].join('');
    const restore = ['rest', 'ore'].join('');
    const checkout = ['check', 'out'].join('');
    const push = ['pu', 'sh'].join('');
    const branch = ['bran', 'ch'].join('');
    const forceShort = ['-', 'f'].join('');
    const deleteBranch = ['-', 'D'].join('');
    const deepseekApiKey = ['DEEPSEEK', 'API', 'KEY'].join('_');
    for (const { source, finding } of [
      {
        source: [curl, 'https://example.invalid/install', pipe, 'zsh'].join(' '),
        finding: 'curl-to-shell',
      },
      {
        source: [curl, 'https://example.invalid/install', pipe, '/bin/bash'].join(' '),
        finding: 'curl-to-shell',
      },
      {
        source: [curl, 'https://example.invalid/install', pipe, 'busybox sh'].join(' '),
        finding: 'curl-to-shell',
      },
      {
        source: [git, '-C /tmp/repo', clean, '-fdx'].join(' '),
        finding: 'destructive Git command',
      },
      { source: ['sudo', git, clean, '--force'].join(' '), finding: 'destructive Git command' },
      { source: [git, restore, '.'].join(' '), finding: 'destructive Git command' },
      { source: [git, checkout, '.'].join(' '), finding: 'destructive Git command' },
      { source: [git, push, forceShort].join(' '), finding: 'destructive Git command' },
      {
        source: [git, branch, deleteBranch, 'stale-branch'].join(' '),
        finding: 'destructive Git command',
      },
      { source: `${deepseekApiKey}=sanitized-demo-key\n`, finding: 'credential assignment' },
    ]) {
      const directory = fixture();
      writeFileSync(join(directory, 'unsafe.sh'), source);
      const result = runSafety(directory);
      expect(result.status, source).toBe(1);
      expect(result.stderr, source).toContain(finding);
    }
  });

  it('rejects source maps, symlinked dist directories, and references outside dist', () => {
    const manifest = {
      manifest_version: 3,
      name: 'fixture',
      version: '0.1.0',
      description: 'fixture',
      permissions: ['storage', 'scripting'],
      host_permissions: [],
      optional_host_permissions: ['https://*/*'],
      background: { service_worker: 'dist/background.js', type: 'module' },
      content_scripts: [],
      options_page: 'options/options.html',
      action: { default_popup: 'popup/popup.html' },
    };
    const setupPages = (directory: string, script = '../dist/setup.js') => {
      writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
      for (const page of ['setup/setup.html', 'popup/popup.html', 'options/options.html']) {
        mkdirSync(join(directory, page, '..'), { recursive: true });
        writeFileSync(join(directory, page), `<script src="${script}"></script>`);
      }
    };
    const mapDirectory = fixture();
    setupPages(mapDirectory);
    mkdirSync(join(mapDirectory, 'dist'), { recursive: true });
    for (const file of ['background.js', 'setup.js', 'popup.js', 'options.js'])
      writeFileSync(join(mapDirectory, 'dist', file), '');
    writeFileSync(
      join(mapDirectory, 'dist', 'debug.js.map'),
      '{"sourcesContent":["DEEPSEEK_API_KEY = sanitized-demo-key"]}',
    );
    const mapResult = spawnSync('node', [join(root, 'scripts/validate-manifest.mjs')], {
      cwd: mapDirectory,
      encoding: 'utf8',
    });
    expect(mapResult.status).toBe(1);
    expect(mapResult.stderr).toContain('source map');

    const outsideDirectory = fixture();
    setupPages(outsideDirectory, '../outside.js');
    mkdirSync(join(outsideDirectory, 'dist'), { recursive: true });
    for (const file of ['background.js', 'setup.js', 'popup.js', 'options.js'])
      writeFileSync(join(outsideDirectory, 'dist', file), '');
    writeFileSync(join(outsideDirectory, 'outside.js'), '');
    const outsideResult = spawnSync('node', [join(root, 'scripts/validate-manifest.mjs')], {
      cwd: outsideDirectory,
      encoding: 'utf8',
    });
    expect(outsideResult.status).toBe(1);
    expect(outsideResult.stderr).toContain('outside dist');

    const symlinkDirectory = fixture();
    setupPages(symlinkDirectory);
    const externalDist = fixture();
    for (const file of ['background.js', 'setup.js', 'popup.js', 'options.js'])
      writeFileSync(join(externalDist, file), '');
    symlinkSync(externalDist, join(symlinkDirectory, 'dist'), 'dir');
    const symlinkResult = spawnSync('node', [join(root, 'scripts/validate-manifest.mjs')], {
      cwd: symlinkDirectory,
      encoding: 'utf8',
    });
    expect(symlinkResult.status).toBe(1);
    expect(symlinkResult.stderr).toContain('symbolic link');

    const symlinkFileDirectory = fixture();
    setupPages(symlinkFileDirectory);
    mkdirSync(join(symlinkFileDirectory, 'dist'), { recursive: true });
    for (const file of ['background.js', 'setup.js', 'popup.js', 'options.js'])
      writeFileSync(join(symlinkFileDirectory, 'dist', file), '');
    const externalArtifact = join(fixture(), 'external.js');
    writeFileSync(externalArtifact, '');
    symlinkSync(externalArtifact, join(symlinkFileDirectory, 'dist', 'extra.js'));
    const symlinkFileResult = spawnSync('node', [join(root, 'scripts/validate-manifest.mjs')], {
      cwd: symlinkFileDirectory,
      encoding: 'utf8',
    });
    expect(symlinkFileResult.status).toBe(1);
    expect(symlinkFileResult.stderr).toContain('symbolic link');

    const hardlinkDirectory = fixture();
    setupPages(hardlinkDirectory);
    mkdirSync(join(hardlinkDirectory, 'dist'), { recursive: true });
    for (const file of ['background.js', 'setup.js', 'popup.js', 'options.js'])
      writeFileSync(join(hardlinkDirectory, 'dist', file), '');
    const hardlinkSource = join(fixture(), 'external-hardlink.js');
    writeFileSync(hardlinkSource, '');
    linkSync(hardlinkSource, join(hardlinkDirectory, 'dist', 'extra.js'));
    const hardlinkResult = spawnSync('node', [join(root, 'scripts/validate-manifest.mjs')], {
      cwd: hardlinkDirectory,
      encoding: 'utf8',
    });
    expect(hardlinkResult.status).toBe(1);
    expect(hardlinkResult.stderr).toContain('hard link in dist');

    const oversizedDirectory = fixture();
    setupPages(oversizedDirectory);
    mkdirSync(join(oversizedDirectory, 'dist'), { recursive: true });
    for (const file of ['background.js', 'setup.js', 'popup.js', 'options.js'])
      writeFileSync(join(oversizedDirectory, 'dist', file), '');
    writeFileSync(join(oversizedDirectory, 'dist', 'oversized.js'), Buffer.alloc(2_000_001, 0x61));
    const oversizedResult = spawnSync('node', [join(root, 'scripts/validate-manifest.mjs')], {
      cwd: oversizedDirectory,
      encoding: 'utf8',
    });
    expect(oversizedResult.status).toBe(1);
    expect(oversizedResult.stderr).toContain('exceeds 2000000 bytes');
  });

  it('refuses a symlinked worktree parent', () => {
    const directory = gitFixture();
    execFileSync('git', [
      '-C',
      directory,
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'user.name=Fixture',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    const outside = mkdtempSync(join(tmpdir(), 'gcti-worktrees-outside-'));
    temporaryRoots.push(outside);
    symlinkSync(outside, join(directory, '.worktrees'));

    const result = spawnSync(
      'node',
      [
        'scripts/create-isolated-worktree.mjs',
        '--root',
        directory,
        '--name',
        'symlink-parent',
        '--base',
        'HEAD',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses dangling worktree targets and creates a normal isolated worktree', () => {
    const directory = gitFixture();
    execFileSync('git', [
      '-C',
      directory,
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'user.name=Fixture',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'fixture',
    ]);
    mkdirSync(join(directory, '.worktrees'), { recursive: true });
    const danglingTarget = join(directory, '.worktrees', 'dangling-target');
    symlinkSync(join(tmpdir(), 'gcti-no-such-worktree'), danglingTarget);

    const rejected = spawnSync(
      'node',
      [
        'scripts/create-isolated-worktree.mjs',
        '--root',
        directory,
        '--name',
        'dangling-target',
        '--base',
        'HEAD',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(rejected.status).toBe(2);

    const created = spawnSync(
      'node',
      [
        'scripts/create-isolated-worktree.mjs',
        '--root',
        directory,
        '--name',
        'normal-target',
        '--base',
        'HEAD',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('branch=wt/normal-target');
    expect(readdirSync(join(directory, '.worktrees', 'normal-target'))).toContain('.git');
    execFileSync('git', [
      '-C',
      directory,
      'worktree',
      'remove',
      '--force',
      join(directory, '.worktrees', 'normal-target'),
    ]);
  });
});
