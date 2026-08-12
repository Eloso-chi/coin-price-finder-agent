'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE_SCRIPT = path.join(__dirname, '..', 'scripts', 'commit-terapeak-progress.sh');

function run(command, args, options = {}) {
  return childProcess.spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 10000,
  });
}

function git(cwd, ...args) {
  const result = run('git', args, { cwd });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function toBashPath(winPath) {
  const normalized = winPath.replace(/\\/g, '/');
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function removeFixture(fixture) {
  if (process.platform === 'win32') {
    const escaped = toBashPath(fixture).replace(/'/g, `'"'"'`);
    run('bash', ['-lc', `cd / && rm -rf -- '${escaped}'`]);
    return;
  }
  fs.rmSync(fixture, { recursive: true, force: true });
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-progress-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cache', 'terapeak-runs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'terapeak'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'cache/\ntest-bin/\ngh-args.txt\n');
  fs.copyFileSync(SOURCE_SCRIPT, path.join(root, 'scripts', 'commit-terapeak-progress.sh'));
  fs.writeFileSync(path.join(root, 'data', 'terapeak', 'sample.csv'), 'title,price\nold,1\n');
  fs.writeFileSync(path.join(root, 'data', 'terapeak-meta.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'cache', 'terapeak-operator-codespace.state.json'), JSON.stringify({ run_id: '20260811T120000Z-42' }));
  fs.writeFileSync(path.join(root, 'cache', 'terapeak-runs', 'passes.jsonl'), [
    JSON.stringify({ run_id: 'other', attempted: 99, succeeded: 99, new_rows: 99 }),
    JSON.stringify({ run_id: '20260811T120000Z-42', attempted: 3, succeeded: 2, empty: 1, failed: 0, new_rows: 7, dup_rows: 2 }),
    JSON.stringify({ run_id: '20260811T120000Z-42', attempted: 2, succeeded: 1, empty: 0, failed: 1, new_rows: 4, dup_rows: 3 }),
  ].join('\n') + '\n');

  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'add', '.gitignore', 'scripts', 'data');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

function runScript(root, ...args) {
  return run('bash', ['scripts/commit-terapeak-progress.sh', ...args], { cwd: root });
}

describe('commit-terapeak-progress.sh', () => {
  const fixtures = [];

  afterEach(() => {
    while (fixtures.length) {
      removeFixture(fixtures.pop());
    }
  });

  test('dry-run reports exact files and aggregated run totals without mutating Git', () => {
    const root = makeFixture();
    fixtures.push(root);
    fs.appendFileSync(path.join(root, 'data', 'terapeak', 'sample.csv'), 'new,2\n');
    fs.writeFileSync(path.join(root, 'data', 'terapeak', 'new.csv'), 'title,price\nnew,3\n');

    const before = git(root, 'rev-parse', 'HEAD');
    const result = runScript(root, '--dry-run');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('passes=2 attempted=5 succeeded=3 empty=1 failed=1 new=11 duplicates=5');
    expect(result.stdout).toContain('branch=data/terapeak-refresh-20260811T120000Z-42');
    expect(result.stdout).toContain('file=data/terapeak/sample.csv');
    expect(result.stdout).toContain('file=data/terapeak/new.csv');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(root, 'branch', '--show-current')).toBe('main');
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  });

  test('returns success when no Terapeak data changed', () => {
    const root = makeFixture();
    fixtures.push(root);
    const result = runScript(root, '--dry-run');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('nothing to commit');
  });

  test('refuses non-main branches and pre-staged changes', () => {
    const root = makeFixture();
    fixtures.push(root);
    fs.appendFileSync(path.join(root, 'data', 'terapeak', 'sample.csv'), 'new,2\n');
    git(root, 'switch', '-c', 'work');
    let result = runScript(root, '--dry-run');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Must run on main');

    git(root, 'switch', 'main');
    git(root, 'add', 'data/terapeak/sample.csv');
    result = runScript(root, '--dry-run');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pre-staged changes');
  });

  test('refuses unusual untracked files and invalid telemetry', () => {
    const root = makeFixture();
    fixtures.push(root);
    fs.appendFileSync(path.join(root, 'data', 'terapeak', 'sample.csv'), 'new,2\n');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'unexpected\n');
    let result = runScript(root, '--dry-run');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing unusual untracked file: notes.txt');

    fs.rmSync(path.join(root, 'notes.txt'));
    fs.writeFileSync(path.join(root, 'data', 'terapeak', 'bad name.csv'), 'unsafe\n');
    result = runScript(root, '--dry-run');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing unusual untracked file: data/terapeak/bad name.csv');

    fs.rmSync(path.join(root, 'data', 'terapeak', 'bad name.csv'));
    fs.writeFileSync(path.join(root, 'cache', 'terapeak-runs', 'passes.jsonl'),
      `${JSON.stringify({ run_id: '20260811T120000Z-42', attempted: 1, succeeded: 2 })}\n`);
    result = runScript(root, '--dry-run');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('outcomes do not equal attempted');
  });

  test('refuses apply mode when local main does not match origin/main', () => {
    const root = makeFixture();
    fixtures.push(root);
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-progress-remote-'));
    fixtures.push(remote);
    git(remote, 'init', '--bare');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-u', 'origin', 'main');
    git(root, 'remote', 'set-url', 'origin', `file://${toBashPath(remote)}`);
    fs.appendFileSync(path.join(root, 'scripts', 'commit-terapeak-progress.sh'), '\n# local commit\n');
    git(root, 'add', 'scripts/commit-terapeak-progress.sh');
    git(root, 'commit', '-m', 'local-only commit');
    fs.appendFileSync(path.join(root, 'data', 'terapeak', 'sample.csv'), 'new,2\n');

    const result = runScript(root, '--gh-bin', 'true', '--repo', 'test/coin-price-finder-agent');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Local main must exactly match origin/main');
    expect(git(root, 'branch', '--show-current')).toBe('main');
  });

  test('refuses apply mode when origin has a different push URL', () => {
    const root = makeFixture();
    fixtures.push(root);
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-progress-remote-'));
    const pushRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-progress-push-'));
    fixtures.push(remote, pushRemote);
    git(remote, 'init', '--bare');
    git(pushRemote, 'init', '--bare');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-u', 'origin', 'main');
    git(root, 'remote', 'set-url', 'origin', `file://${toBashPath(remote)}`);
    git(root, 'remote', 'set-url', '--push', 'origin', `file://${toBashPath(pushRemote)}`);
    fs.appendFileSync(path.join(root, 'data', 'terapeak', 'sample.csv'), 'new,2\n');

    const result = runScript(root, '--gh-bin', 'true', '--repo', 'test/coin-price-finder-agent');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('origin push URL must match its fetch URL');
    expect(git(root, 'branch', '--show-current')).toBe('main');
  });

  test('apply mode commits only allowed data, pushes, and opens a PR with run stats', () => {
    const root = makeFixture();
    fixtures.push(root);
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-progress-remote-'));
    fixtures.push(remote);
    git(remote, 'init', '--bare');
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-u', 'origin', 'main');
    git(root, 'remote', 'set-url', 'origin', `file://${toBashPath(remote)}`);

    fs.appendFileSync(path.join(root, 'data', 'terapeak', 'sample.csv'), 'new,2\n');
    const bin = path.join(root, 'test-bin');
    fs.mkdirSync(bin);
    const ghLog = path.join(root, 'gh-args.txt');
    fs.writeFileSync(path.join(bin, 'gh'), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" > gh-args.txt\nprintf '%s\\n' 'https://example.invalid/pr/1'\n");
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    const result = run('bash', [
      'scripts/commit-terapeak-progress.sh',
      '--gh-bin',
      toBashPath(path.join(bin, 'gh')),
      '--repo',
      'test/coin-price-finder-agent',
    ], {
      cwd: root,
      env: process.env,
      timeout: 30000,
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual(
      expect.objectContaining({ status: 0 })
    );
    expect(git(root, 'branch', '--show-current')).toBe('data/terapeak-refresh-20260811T120000Z-42');
    expect(git(root, 'show', '--pretty=', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean)).toEqual([
      'data/terapeak/sample.csv',
    ]);
    const commitBody = git(root, 'log', '-1', '--pretty=%B');
    expect(commitBody).toContain('passes=2 attempted=5 succeeded=3 empty=1 failed=1 new=11 duplicates=5');
    const args = fs.readFileSync(ghLog, 'utf8');
    expect(args).toContain('pr create --repo test/coin-price-finder-agent --base main --head data/terapeak-refresh-20260811T120000Z-42');
    expect(args).toContain('New rows: 11');
    expect(result.stdout).toContain('PR=https://example.invalid/pr/1');
  });
});
