'use strict';

// scripts/operator-status.py prints the runbook "Status report contract" plus a cumulative run view
// from the operator's own telemetry. Fixtures are written to a temp project dir; the script is read-only.

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.setTimeout(30000);

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'operator-status.py');
const RUN = '20261101T000000Z-1';

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function runStatus(projectDir, extraArgs = []) {
  const win = process.platform === 'win32';
  const args = ['--project-dir', win ? toWslPath(projectDir) : projectDir, '--skip-process-check', ...extraArgs];
  if (win) {
    return childProcess.spawnSync('wsl', ['python3', toWslPath(SCRIPT), ...args], { encoding: 'utf8' });
  }
  return childProcess.spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });
}

function passRecord(overrides) {
  return {
    run_id: RUN, pass: 1, attempted: 3, succeeded: 2, empty: 1, failed: 0, no_comps: 0,
    new_rows: 10, dup_rows: 3, no_export_count: 1, state_before: 'Normal', state_after: 'Normal',
    duration_sec: 600, cookie_health_status: 'HEALTHY', challenge_signal_count: 0, batch_size_executed: 3,
    ...overrides,
  };
}

function coinRecord(pass, coin, status, extra = {}) {
  return { run_id: RUN, pass, coin, status, new: 0, dups: 0, dormant: false, ...extra };
}

const OPERATOR_LOG = [
  'Actions needed:',
  '    refresh          1400',
  '    dormant          400',
  '    ok               100',
  '    deep-paginate    5',
  '    P0 refresh-urgent:  9999',
  '    ok: 77',
  '... later pass, same report block ...',
  'Actions needed:',
  '    refresh          1308',
  '    monitor-refresh  1342',
  '    dormant          491',
  '    ok               157',
  '    deep-paginate    10',
].join('\n');

const LIVE_LOG = [
  'Exporting 6 coins...',
  '  [ 17%] Coin H... SAVED (upload pending)',
  '  [ 33%] Coin I...   [async upload] Coin H: OK (7 new, 1 dups)',
  'SAVED (upload pending)',
  '  [ 50%] Coin J...   [async upload] Coin I: OK (3 new, 0 dups)',
  'SAVED (upload pending)',
  '  [ 67%] Coin K...',
  'NO EXPORT (no results or button not found)',
  '  (dormant: 3 consecutive empty attempts) [Coin K]',
  '  [ 83%] Coin L...',
].join('\n');

const made = [];

function makeProject({ passes, coins, operatorLog = OPERATOR_LOG, liveLog = null, livePass = 3, risk = 'Elevated', passDirRun = RUN }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstatus-'));
  made.push(dir);
  const runs = path.join(dir, 'cache', 'terapeak-runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'passes.jsonl'), passes.map(p => JSON.stringify(p)).join('\n') + '\n');
  fs.writeFileSync(path.join(runs, 'coins.jsonl'), coins.map(c => JSON.stringify(c)).join('\n') + '\n');
  if (operatorLog !== null) fs.writeFileSync(path.join(dir, 'cache', `terapeak-operator-${RUN}.log`), operatorLog);
  if (liveLog !== null) {
    const passDir = path.join(dir, 'cache', 'terapeak-operator-passes', passDirRun);
    fs.mkdirSync(passDir, { recursive: true });
    fs.writeFileSync(path.join(passDir, `pass-${String(livePass).padStart(4, '0')}.log`), liveLog);
  }
  fs.writeFileSync(path.join(dir, '.machine-id'), 'H\n');
  fs.writeFileSync(path.join(dir, 'cache', 'terapeak-risk-state-H.json'), JSON.stringify({ state: risk }));
  return dir;
}

function standardProject(extra = {}) {
  return makeProject({
    passes: [
      passRecord({ pass: 1 }),
      passRecord({ pass: 2, attempted: 4, succeeded: 2, empty: 1, failed: 1, new_rows: 12, dup_rows: 5, no_export_count: 1, state_after: 'Elevated', duration_sec: 90, batch_size_executed: 4 }),
    ],
    coins: [
      coinRecord(1, 'Coin E', 'ok', { new: 6, dups: 2 }),
      coinRecord(1, 'Coin F', 'ok', { new: 4, dups: 1 }),
      coinRecord(1, 'Coin G', 'empty'),
      coinRecord(2, 'Coin A', 'ok', { new: 8, dups: 3 }),
      coinRecord(2, 'Coin B', 'ok', { new: 4, dups: 2 }),
      coinRecord(2, 'Coin C', 'empty', { dormant: true }),
      coinRecord(2, 'Coin D', 'failed'),
    ],
    ...extra,
  });
}

const coinHeader = [`  ${'Coin'.padEnd(35)} ${'New'.padStart(4)}  ${'Dups'.padStart(4)}  Result`, `  ${'-'.repeat(35)} ${'-'.repeat(4)}  ${'-'.repeat(4)}  ${'-'.repeat(7)}`];
const coinRow = (name, newRows, dups, result) => `  ${name.padEnd(35)} ${newRows.padStart(4)}  ${dups.padStart(4)}  ${result}`;
const passHeader = [
  `  ${'Pass'.padStart(4)}  ${'Batch'.padStart(5)}  ${'OK'.padStart(4)}  ${'NO DATA'.padStart(7)}  ${'Failed'.padStart(6)}  ${'no_comps'.padStart(8)}  ${'New'.padStart(7)}  ${'Dups'.padStart(6)}  Risk state`,
  `  ${'-'.repeat(4)}  ${'-'.repeat(5)}  ${'-'.repeat(4)}  ${'-'.repeat(7)}  ${'-'.repeat(6)}  ${'-'.repeat(8)}  ${'-'.repeat(7)}  ${'-'.repeat(6)}  ${'-'.repeat(22)}`,
];
const passRow = (pass, batch, ok, noData, failed, noComps, newRows, dups, tail) =>
  `  ${String(pass).padStart(4)}  ${String(batch).padStart(5)}  ${String(ok).padStart(4)}  ${String(noData).padStart(7)}  ${String(failed).padStart(6)}  ${String(noComps).padStart(8)}  ${String(newRows).padStart(7)}  ${String(dups).padStart(6)}  ${tail}`;

afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

describe('operator-status.py: last completed pass', () => {
  test('prints the exact contract block and cumulative section', () => {
    const result = runStatus(standardProject());
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout.trimEnd().split('\n')).toEqual([
      'Pass 2 | Batch: 4 coins | ~2 min (complete)',
      '',
      '  Run totals: 7 coins | 22 new | 8 dups',
      '',
      ...coinHeader,
      coinRow('Coin A', '8', '3', 'OK'),
      coinRow('Coin B', '4', '2', 'OK'),
      coinRow('Coin C', '--', '--', 'NO DATA (dormant)'),
      '  (1 failed coin(s) not listed: Coin D)',
      '',
      '  Batch total: 12 new, 5 dups, 1 no-export out of 4 coins',
      '',
      '  Queue: 1,308 stale | 157 ok | 491 dormant | 10 deep-paginate pending',
      '',
      '  Highlights: risk state Elevated; 1 failed coin(s) in current pass',
      '',
      'Cumulative run view (run 20261101T000000Z-1, 2 completed pass(es))',
      '  Risk state: Elevated | challenge signals in run: 0 | cookie health: HEALTHY',
      '',
      ...passHeader,
      passRow(1, 3, 2, 1, 0, 0, 10, 3, 'Normal -> Normal'),
      passRow(2, 4, 2, 1, 1, 0, 12, 5, 'Normal -> Elevated'),
      `  ${'Run'.padStart(4)}  ${'7'.padStart(5)}  ${'4'.padStart(4)}  ${'2'.padStart(7)}  ${'1'.padStart(6)}  ${'0'.padStart(8)}  ${'22'.padStart(7)}  ${'8'.padStart(6)}  completed passes only`,
    ]);
  });

  test('takes each queue tier from its last report block and ignores look-alike lines', () => {
    const out = runStatus(standardProject()).stdout;
    expect(out).toContain('Queue: 1,308 stale | 157 ok | 491 dormant | 10 deep-paginate pending');
    expect(out).not.toContain('9999');
    expect(out).not.toContain('1,400');
  });

  test('reports n/a for every queue tier when there is no operator log', () => {
    const out = runStatus(standardProject({ operatorLog: null })).stdout;
    expect(out).toContain('Queue: n/a stale | n/a ok | n/a dormant | n/a deep-paginate pending');
  });

  test('Highlights is "none" only for a clean Normal pass', () => {
    const dir = makeProject({
      passes: [passRecord({ pass: 1 })],
      coins: [coinRecord(1, 'Coin E', 'ok', { new: 6, dups: 2 }), coinRecord(1, 'Coin G', 'empty')],
      risk: 'Normal',
    });
    expect(runStatus(dir).stdout).toContain('  Highlights: none\n');
  });

  test('Highlights names challenge signals and unhealthy cookies', () => {
    const dir = makeProject({
      passes: [passRecord({ pass: 1, challenge_signal_count: 1, cookie_health_status: 'EXPIRED' })],
      coins: [coinRecord(1, 'Coin E', 'ok', { new: 6, dups: 2 })],
      risk: 'Cooldown',
    });
    const out = runStatus(dir).stdout;
    expect(out).toContain('  Highlights: risk state Cooldown; 1 challenge signal(s) in run; cookie health EXPIRED\n');
    expect(out).toContain('Risk state: Cooldown | challenge signals in run: 1 | cookie health: EXPIRED');
  });

  test('--passes limits the per-pass rows but run totals still cover every pass', () => {
    const out = runStatus(standardProject(), ['--passes', '1']).stdout;
    expect(out).toContain('(1 earlier pass(es) not shown; totals include them)');
    expect(out).toContain(passRow(2, 4, 2, 1, 1, 0, 12, 5, 'Normal -> Elevated'));
    expect(out).not.toContain(passRow(1, 3, 2, 1, 0, 0, 10, 3, 'Normal -> Normal'));
    expect(out).toContain('  Run totals: 7 coins | 22 new | 8 dups');
  });
});

describe('operator-status.py: pass in progress', () => {
  let out;
  beforeAll(() => {
    const result = runStatus(standardProject({ liveLog: LIVE_LOG }));
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    out = result.stdout.trimEnd().split('\n');
  });

  test('current batch is the live pass with partial totals', () => {
    expect(out.slice(0, 12)).toEqual([
      'Pass 3 | Batch: 6 coins | in progress (5 of 6 started)',
      '',
      '  Run totals: 12 coins | 32 new | 9 dups',
      '',
      ...coinHeader,
      coinRow('Coin H', '7', '1', 'OK'),
      coinRow('Coin I', '3', '0', 'OK'),
      coinRow('Coin J', '--', '--', 'pending'),
      coinRow('Coin K', '--', '--', 'NO DATA (dormant)'),
      coinRow('Coin L', '--', '--', 'pending'),
      '',
    ]);
    expect(out).toContain('  Batch total (partial): 10 new, 1 dups, 1 no-export out of 5 coins started');
  });

  test('cumulative section keeps completed passes separate from the live row', () => {
    expect(out).toContain('Cumulative run view (run 20261101T000000Z-1, 2 completed pass(es), pass 3 in progress)');
    expect(out).toContain(passRow('3*', 5, 2, 1, 0, 0, 10, 1, 'in progress (partial)'));
    expect(out).toContain(`  ${'Run'.padStart(4)}  ${'7'.padStart(5)}  ${'4'.padStart(4)}  ${'2'.padStart(7)}  ${'1'.padStart(6)}  ${'0'.padStart(8)}  ${'22'.padStart(7)}  ${'8'.padStart(6)}  completed passes only`);
  });

  test('a pass log that is already recorded is not treated as in progress', () => {
    const dir = standardProject({ liveLog: LIVE_LOG, livePass: 2 });
    expect(runStatus(dir).stdout.split('\n')[0]).toBe('Pass 2 | Batch: 4 coins | ~2 min (complete)');
  });
});

describe('operator-status.py: input handling', () => {
  test('--run-id selects a run; the default is the newest run in the ledger', () => {
    const other = '20261030T000000Z-9';
    const dir = makeProject({
      passes: [passRecord({ pass: 5, run_id: other, new_rows: 99, dup_rows: 9 }), passRecord({ pass: 1 })],
      coins: [coinRecord(1, 'Coin E', 'ok', { new: 6, dups: 2 }), { ...coinRecord(5, 'Old coin', 'ok', { new: 99, dups: 9 }), run_id: other }],
    });
    expect(runStatus(dir).stdout.split('\n')[0]).toBe('Pass 1 | Batch: 3 coins | ~10 min (complete)');
    const selected = runStatus(dir, ['--run-id', other]).stdout;
    expect(selected.split('\n')[0]).toBe('Pass 5 | Batch: 3 coins | ~10 min (complete)');
    expect(selected).toContain(`Cumulative run view (run ${other}, 1 completed pass(es))`);
  });

  test('exits 2 with a plain message and no traceback when there is no run data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstatus-empty-'));
    made.push(dir);
    const result = runStatus(dir);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No operator run data found');
    expect(result.stderr).not.toContain('Traceback');
  });

  test('output is ASCII even when a coin name is not', () => {
    const dir = makeProject({
      passes: [passRecord({ pass: 1 })],
      coins: [coinRecord(1, 'Caf\u00e9 Libertad', 'ok', { new: 1, dups: 0 })],
      risk: 'Normal',
    });
    const out = runStatus(dir).stdout;
    expect(out).toContain('Caf? Libertad');
    expect(/^[\x00-\x7F]*$/.test(out)).toBe(true);
  });

  test('is read-only: no file under the project dir changes', () => {
    const dir = standardProject({ liveLog: LIVE_LOG });
    const snapshot = () => {
      const entries = [];
      const walk = current => {
        for (const name of fs.readdirSync(current).sort()) {
          const full = path.join(current, name);
          if (fs.statSync(full).isDirectory()) walk(full);
          else entries.push([path.relative(dir, full), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
        }
      };
      walk(dir);
      return entries;
    };
    const before = snapshot();
    expect(runStatus(dir).status).toBe(0);
    expect(snapshot()).toEqual(before);
  });
});

describe('operator-status.py: malformed telemetry never produces a traceback', () => {
  const clean = () => ({
    passes: [passRecord({ pass: 1 })],
    coins: [coinRecord(1, 'Coin E', 'ok', { new: 6, dups: 2 })],
    risk: 'Normal',
  });

  function expectPlainOutput(result) {
    expect(result.stderr).not.toContain('Traceback');
    expect(/^[\x00-\x7F]*$/.test(result.stdout)).toBe(true);
  }

  test('a non-numeric field counts as 0 and the report still prints', () => {
    const dir = makeProject({
      ...clean(),
      passes: [passRecord({ pass: 1, attempted: 'x', new_rows: 'many', dup_rows: null, duration_sec: 'soon' })],
    });
    const result = runStatus(dir);
    expectPlainOutput(result);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('Pass 1 | Batch: 3 coins | ~1 min (complete)');
    expect(result.stdout).toContain('  Run totals: 0 coins | 0 new | 0 dups');
  });

  test('Infinity and out-of-range numbers count as 0 instead of raising OverflowError', () => {
    const dir = makeProject(clean());
    const runs = path.join(dir, 'cache', 'terapeak-runs');
    // JSON.stringify cannot emit Infinity or 1e999, so write the records as raw text.
    fs.writeFileSync(path.join(runs, 'passes.jsonl'), `{"run_id":"${RUN}","pass":1,"attempted":Infinity,"succeeded":1e999,"empty":-Infinity,"failed":NaN,"new_rows":1e999,"dup_rows":0,"state_before":"Normal","state_after":"Normal","duration_sec":1e999,"batch_size_executed":2}\n`);
    const result = runStatus(dir);
    expectPlainOutput(result);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('Pass 1 | Batch: 2 coins | ~1 min (complete)');
    expect(result.stdout).toContain('  Run totals: 0 coins | 0 new | 0 dups');
  });

  test('a non-ASCII run id is replaced in the output', () => {
    const odd = '20261101T000000Z-\u00e9';
    const dir = makeProject({
      passes: [passRecord({ pass: 1, run_id: odd })],
      coins: [{ ...coinRecord(1, 'Coin E', 'ok', { new: 6, dups: 2 }), run_id: odd }],
      risk: 'Normal',
    });
    const result = runStatus(dir, ['--run-id', odd]);
    expectPlainOutput(result);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Cumulative run view (run 20261101T000000Z-?, 1 completed pass(es))');
  });

  test('lines that are not JSON objects are skipped', () => {
    const dir = makeProject(clean());
    const runs = path.join(dir, 'cache', 'terapeak-runs');
    fs.appendFileSync(path.join(runs, 'passes.jsonl'), '[1]\n"text"\nnot json\n42\n');
    fs.appendFileSync(path.join(runs, 'coins.jsonl'), 'null\n[]\n');
    const result = runStatus(dir);
    expectPlainOutput(result);
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('Pass 1 | Batch: 3 coins | ~10 min (complete)');
  });

  test('records without a run id or pass number are ignored', () => {
    const dir = makeProject(clean());
    const runs = path.join(dir, 'cache', 'terapeak-runs');
    fs.appendFileSync(path.join(runs, 'passes.jsonl'), `${JSON.stringify({ attempted: 5 })}\n${JSON.stringify({ run_id: RUN })}\n${JSON.stringify({ run_id: RUN, pass: 'two' })}\n`);
    const result = runStatus(dir);
    expectPlainOutput(result);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Cumulative run view (run 20261101T000000Z-1, 1 completed pass(es))');
  });

  test('a telemetry file that is a directory is reported as no data, not a crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opstatus-dir-'));
    made.push(dir);
    fs.mkdirSync(path.join(dir, 'cache', 'terapeak-runs', 'passes.jsonl'), { recursive: true });
    const result = runStatus(dir);
    expectPlainOutput(result);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No operator run data found');
  });

  test('non-ASCII state, cookie and transition values are replaced, keeping the output ASCII', () => {
    const dir = makeProject({
      passes: [passRecord({ pass: 1, cookie_health_status: 'H\u00c9ALTHY', state_before: 'Norm\u00e4l', state_after: 'Elev\u00e4ted' })],
      coins: [coinRecord(1, 'Coin E', 'ok', { new: 6, dups: 2 })],
      risk: 'Cool\u00f6own',
    });
    const result = runStatus(dir);
    expectPlainOutput(result);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cookie health: H?ALTHY');
    expect(result.stdout).toContain('Norm?l -> Elev?ted');
    expect(result.stdout).toContain('Risk state: Cool?own');
  });
});
