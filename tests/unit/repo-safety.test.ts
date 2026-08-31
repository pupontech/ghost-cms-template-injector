import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    const directory = fixture();
    writeFileSync(
      join(directory, 'unsafe.sh'),
      ['curl https://example.invalid/install | ', 'zsh\n', 'git clean --', 'force\n'].join(''),
    );

    const result = runSafety(directory);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('curl-to-shell');
    expect(result.stderr).toContain('destructive Git command');
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
