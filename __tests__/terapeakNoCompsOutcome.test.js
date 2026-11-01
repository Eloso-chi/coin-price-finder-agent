'use strict';

// #328H: a 422 "No valid comps found in CSV" upload result is a no-data outcome, not an upload failure.
// #323H: pass outcome counts must agree with the pass log (ok + empty + failed == attempted, no unknown).
// Parser fixtures are shaped after real operator pass logs (runs 20261031T003645Z-230493 and
// 20261031T154735Z-235989); the exporter tests drive the real staging, merge and settle helpers.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PARSER = path.join(PROJECT_ROOT, 'scripts', '_parse-terapeak-pass.py');
const EXPORTER = path.join(PROJECT_ROOT, 'scripts', 'terapeak-export.py');

const NO_COMPS_BODY = '{"error":"No valid comps found in CSV","details":{"totalRows":7,"skipped":7}}';
const WEIGHT_BODY = '{"error":"Contradictory explicit weights in search term:  oz","code":"CONTRADICTORY_WEIGHT","explicitWeights":[]}';

// Older exporter output (no term tag on the dormant line, no [dataset] line). Async results print
// on the NEXT coin's line, the dormant line that follows a 422 belongs to the rejected coin, and the
// last upload is drained after the final coin as a standalone line.
const LEGACY_LOG = [
  'Exporting 5 coins...',
  '  [ 20%] Coin A... SAVED (upload pending)',
  `  [ 40%] Coin B...   [async upload] Coin A: failed -- HTTP 422: ${NO_COMPS_BODY}`,
  '  (dormant: 4 consecutive empty attempts)',
  'SAVED (upload pending)',
  '  [ 60%] Coin C...   [async upload] Coin B: OK (8 new, 0 dups)',
  'SAVED (upload pending)',
  '  [ 80%] Coin D...   [async upload] Coin C: OK (3 new, 1 dups)',
  'SAVED (upload pending)',
  '  [100%] Coin E...',
  'NO EXPORT (no results or button not found)',
  '  (dormant: 3 consecutive empty attempts)',
  `  [async upload] Coin D: failed -- HTTP 400: ${WEIGHT_BODY}`,
  '',
  '=== Export Complete ===',
  '  Succeeded:  2',
  '  Uploaded:   2',
  '  Failed:     3',
];

// Current exporter output, in the order it really prints: async line, tagged dormant line (only once
// the counter reaches 2), then the [dataset] line, then the coin's own SAVED line. Coin B is rejected
// without a dormant line, and the NO EXPORT coin that follows owns its own tagged dormant line. Coin F
// is rejected by the final drain after the last coin.
const TAGGED_LOG = [
  'Exporting 6 coins...',
  '  [ 17%] Coin A... SAVED (upload pending)',
  `  [ 33%] Coin B...   [async upload] Coin A: failed -- HTTP 422: ${NO_COMPS_BODY}`,
  '  (dormant: 4 consecutive empty attempts) [Coin A]',
  '  [dataset] Coin A: no valid comps; reported as no data, moved unusable CSV to cache/terapeak-rejected/Coin_A-20261101T000000.csv',
  'SAVED (upload pending)',
  `  [ 50%] Coin C...   [async upload] Coin B: failed -- HTTP 422: ${NO_COMPS_BODY}`,
  '  [dataset] Coin B: no valid comps; reported as no data, CSV already gone',
  'SAVED (upload pending)',
  '  [ 67%] Coin D...',
  'NO EXPORT (no results or button not found)',
  '  (dormant: 3 consecutive empty attempts) [Coin D]',
  '  [ 83%] Coin E...   [async upload] Coin C: OK (4 new, 1 dups)',
  'SAVED (upload pending)',
  `  [100%] Coin F...   [async upload] Coin E: failed -- HTTP 422: ${NO_COMPS_BODY}`,
  '  (dormant: 3 consecutive empty attempts) [Coin E]',
  '  [dataset] Coin E: no valid comps; reported as no data, moved unusable CSV to cache/terapeak-rejected/Coin_E-20261101T000001.csv',
  'SAVED (upload pending)',
  `  [async upload] Coin F: failed -- HTTP 422: ${NO_COMPS_BODY}`,
  '  (dormant: 3 consecutive empty attempts) [Coin F]',
  '  [dataset] Coin F: no valid comps; reported as no data, moved unusable CSV to cache/terapeak-rejected/Coin_F-20261101T000002.csv',
  '',
  '=== Export Complete ===',
];

// Outcomes printed on the coin line itself, and the sync-upload fallback form.
const SYNC_LOG = [
  'Exporting 6 coins...',
  '  [ 17%] Coin A... TIMEOUT',
  '  [ 33%] Coin B... ERROR: net::ERR_CONNECTION_RESET',
  '  [ 50%] Coin C... EMPTY (file too small: 12B)',
  '  [ 67%] Coin D... SAVED but upload failed: HTTP 500: {"error":"boom"}',
  `  [ 83%] Coin E... SAVED but upload failed: HTTP 422: ${NO_COMPS_BODY}`,
  '  (dormant: 3 consecutive empty attempts) [Coin E]',
  '  [dataset] Coin E: no valid comps; reported as no data, moved unusable CSV to cache/terapeak-rejected/Coin_E-20261101T000003.csv',
  '  [100%] Coin F... OK (5 new, 2 dups)',
];

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function pyString(value) {
  return JSON.stringify(JSON.stringify(value));
}

function runPython(snippet) {
  if (process.platform === 'win32') {
    const scriptDir = toWslPath(path.join(PROJECT_ROOT, 'scripts'));
    return childProcess.spawnSync('wsl', ['env', `PYTHONPATH=${scriptDir}`, 'python3', '-c', snippet], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
  }
  return childProcess.spawnSync('python3', ['-c', snippet], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: path.join(PROJECT_ROOT, 'scripts') },
  });
}

function parseOutput(result) {
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

function runParserHarness() {
  const parserPath = process.platform === 'win32' ? toWslPath(PARSER) : PARSER;
  return runPython(`
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile

logs = {
    "legacy": json.loads(${pyString(LEGACY_LOG)}),
    "tagged": json.loads(${pyString(TAGGED_LOG)}),
    "sync": json.loads(${pyString(SYNC_LOG)}),
}
out = {}
with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["TERAPEAK_RUNS_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("pass_parser", ${JSON.stringify(parserPath)})
    pass_parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pass_parser)
    for name, lines in logs.items():
        log = pathlib.Path(temp_dir) / (name + ".log")
        summary = pathlib.Path(temp_dir) / (name + "-summary.json")
        log.write_text("\\n".join(lines), encoding="utf-8")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            status = pass_parser.main([
                "--pass-log", str(log), "--run-id", "run-" + name,
                "--pass-num", "1", "--batch-size", str(len(lines)),
                "--summary-output", str(summary),
            ])
        out[name] = {
            "status": status,
            "stdout": stdout.getvalue(),
            "summary": json.loads(summary.read_text(encoding="utf-8")),
        }
    out["coin_records"] = [
        json.loads(line)
        for line in pathlib.Path(pass_parser.COINS_PATH).read_text(encoding="utf-8").splitlines()
    ]
print(json.dumps(out))
`);
}

function coinsByName(summary) {
  return Object.fromEntries(summary.coins.map(coin => [coin.coin, coin]));
}

describe('#323H pass outcome counts agree with the pass log', () => {
  let harness;

  beforeAll(() => {
    harness = parseOutput(runParserHarness());
  });

  test('standalone async failure line cannot flip another coin', () => {
    const coins = coinsByName(harness.legacy.summary);
    expect(coins['Coin E'].status).toBe('empty');
    expect(coins['Coin E'].error).toBeNull();
    expect(coins['Coin D'].status).toBe('failed');
    expect(coins['Coin D'].error).toMatch(/^HTTP 400/);
  });

  test('async error text is bounded', () => {
    const coins = coinsByName(harness.legacy.summary);
    expect(coins['Coin D'].error.length).toBeLessThanOrEqual(200);
  });

  test('legacy-format totals are internally consistent and match the log', () => {
    const pass = harness.legacy.summary.pass;
    expect(pass).toEqual(expect.objectContaining({
      attempted: 5,
      succeeded: 2,
      empty: 2,
      failed: 1,
      unknown: 0,
      new_rows: 11,
      dup_rows: 1,
    }));
    expect(pass.succeeded + pass.empty + pass.failed).toBe(pass.attempted);
  });

  test('TIMEOUT, ERROR, tiny-file and same-line upload failures are failed, never unknown', () => {
    const coins = coinsByName(harness.sync.summary);
    expect(coins['Coin A']).toEqual(expect.objectContaining({ status: 'failed', error: 'TIMEOUT' }));
    expect(coins['Coin B']).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(coins['Coin B'].error).toMatch(/^ERROR: net::ERR_CONNECTION_RESET/);
    expect(coins['Coin C']).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(coins['Coin C'].error).toMatch(/file too small/);
    expect(coins['Coin D']).toEqual(expect.objectContaining({ status: 'failed', error: 'HTTP 500' }));
    expect(coins['Coin F']).toEqual(expect.objectContaining({ status: 'ok', new: 5, dups: 2 }));
    const pass = harness.sync.summary.pass;
    expect(pass.unknown).toBe(0);
    expect(pass.succeeded + pass.empty + pass.failed).toBe(pass.attempted);
  });

  test('current-format log is consistent too', () => {
    const pass = harness.tagged.summary.pass;
    expect(pass).toEqual(expect.objectContaining({ attempted: 6, succeeded: 1, empty: 5, failed: 0, unknown: 0 }));
    expect(pass.succeeded + pass.empty + pass.failed).toBe(pass.attempted);
  });
});

describe('#328H no-valid-comps outcome in pass telemetry', () => {
  let harness;

  beforeAll(() => {
    harness = parseOutput(runParserHarness());
  });

  test('legacy log: async 422 no-valid-comps is empty with no_comps, and owns the adjacent dormant line', () => {
    const coins = coinsByName(harness.legacy.summary);
    expect(coins['Coin A']).toEqual(expect.objectContaining({
      status: 'empty',
      no_comps: true,
      dormant: true,
      new: 0,
      dups: 0,
    }));
    expect(coins['Coin B'].dormant).toBe(false);
    expect(coins['Coin E'].dormant).toBe(true);
    expect(coins['Coin E'].no_comps).toBeFalsy();
  });

  test('tagged log: dormant lines are attributed by term, including after a standalone final drain', () => {
    const coins = coinsByName(harness.tagged.summary);
    expect(coins['Coin A']).toEqual(expect.objectContaining({ status: 'empty', no_comps: true, dormant: true }));
    // 422 without a dormant line must not inherit the next coin's dormant line.
    expect(coins['Coin B']).toEqual(expect.objectContaining({ status: 'empty', no_comps: true, dormant: false }));
    expect(coins['Coin C']).toEqual(expect.objectContaining({ status: 'ok', new: 4, dups: 1, dormant: false }));
    expect(coins['Coin D']).toEqual(expect.objectContaining({ status: 'empty', dormant: true }));
    expect(coins['Coin D'].no_comps).toBeFalsy();
    expect(coins['Coin E']).toEqual(expect.objectContaining({ status: 'empty', no_comps: true, dormant: true }));
    expect(coins['Coin F']).toEqual(expect.objectContaining({ status: 'empty', no_comps: true, dormant: true }));
  });

  test('sync-form 422 no-valid-comps is also an empty no_comps outcome', () => {
    const coins = coinsByName(harness.sync.summary);
    expect(coins['Coin E']).toEqual(expect.objectContaining({ status: 'empty', no_comps: true, dormant: true }));
  });

  test('pass record counts no_comps separately and reports it in the operator line', () => {
    expect(harness.legacy.summary.pass.no_comps).toBe(1);
    expect(harness.sync.summary.pass.no_comps).toBe(1);
    expect(harness.tagged.summary.pass.no_comps).toBe(4);
    expect(harness.legacy.stdout).toMatch(/\[parse\] pass=1 attempted=5 ok=2 empty=2 failed=1 no_comps=1 /);
  });

  test('genuine upload failures are not counted as no_comps', () => {
    expect(coinsByName(harness.legacy.summary)['Coin D'].no_comps).toBeFalsy();
    expect(coinsByName(harness.sync.summary)['Coin D'].no_comps).toBeFalsy();
  });

  test('per-coin ledger records carry the no_comps flag', () => {
    const records = harness.coin_records.filter(r => r.run_id === 'run-legacy');
    expect(records.find(r => r.coin === 'Coin A')).toEqual(expect.objectContaining({ status: 'empty', no_comps: true }));
    expect(records.find(r => r.coin === 'Coin B').no_comps).toBe(false);
  });

  test('a cluster of no_comps rejections is flagged and warned about; an isolated one is not', () => {
    expect(harness.tagged.summary.pass.no_comps_cluster).toBe(true);
    expect(harness.tagged.stdout).toMatch(/\[parse\] WARN no_comps cluster: 4 of 6 coins/);
    expect(harness.legacy.summary.pass.no_comps_cluster).toBe(false);
    expect(harness.legacy.stdout).not.toMatch(/WARN no_comps cluster/);
    expect(harness.sync.summary.pass.no_comps_cluster).toBe(false);
  });
});

function runExporterHarness() {
  const exporterPath = process.platform === 'win32' ? toWslPath(EXPORTER) : EXPORTER;
  return runPython(`
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import types

from _terapeak_risk import classify_log_lines

playwright = types.ModuleType("playwright")
sync_api = types.ModuleType("playwright.sync_api")
sync_api.sync_playwright = lambda: None
sync_api.TimeoutError = TimeoutError
playwright.sync_api = sync_api
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = sync_api
sys.modules["requests"] = types.ModuleType("requests")

spec = importlib.util.spec_from_file_location("terapeak_export", ${JSON.stringify(exporterPath)})
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

NO_COMPS = "HTTP 422: " + ${JSON.stringify(NO_COMPS_BODY)}
WEIGHT = "HTTP 400: " + ${JSON.stringify(WEIGHT_BODY)}
HEADER = "Item Title,Item ID,Date,Price\\n"

real_report = exporter._report_no_data
reported = []
exporter._report_no_data = lambda term: reported.append(term)

root = pathlib.Path(tempfile.mkdtemp())
data_dir = root / "data"
incoming_dir = root / "incoming"
exporter.REJECTED_DIR = root / "rejected"
data_dir.mkdir()
incoming_dir.mkdir()
risk_samples = []

def write(path, rows):
    path.write_text(HEADER + "".join(row + "\\n" for row in rows), encoding="utf-8")

def stage(term, filename, rows, existing_rows=None):
    dest = data_dir / filename
    if existing_rows is not None:
        write(dest, existing_rows)
    incoming = incoming_dir / filename
    write(incoming, rows)
    return exporter._stage_dataset(incoming, dest, term)

def rejected_files():
    return sorted(p.name for p in exporter.REJECTED_DIR.glob("*.csv")) if exporter.REJECTED_DIR.exists() else []

def settle(term, ok, msg, sync=False):
    before = len(reported)
    progress = {}
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        if sync:
            counts = exporter._record_sync_upload_result(term, ok, msg, progress)
        else:
            counts = exporter._record_upload_result({"term": term, "ok": ok, "msg": msg}, progress)
    text = stdout.getvalue()
    signals = classify_log_lines(text.splitlines())
    risk_samples.append([signals["challenge_signal_count"], signals["soft_risk_signal_count"]])
    return {
        "counts": list(counts),
        "reportedNow": reported[before:],
        "stdout": text,
        "failedTerms": progress.get("failed", []),
        "stillTracked": term in exporter._new_dataset_paths,
    }

out = {}

# New dataset created by this run, rejected with 422: set aside, content preserved.
dest = stage("new rejected", "new_rejected.csv", ["Coin X,111,2026-01-01,10.00"])
original = dest.read_text(encoding="utf-8")
out["newRejected"] = settle("new rejected", False, NO_COMPS)
out["newRejected"].update({"destExists": dest.exists(), "rejected": rejected_files(),
    "rejectedContent": (exporter.REJECTED_DIR / rejected_files()[0]).read_text(encoding="utf-8") if rejected_files() else None,
    "original": original})

# Dataset that existed before the run: merged into, never set aside.
dest = stage("old rejected", "old_rejected.csv", ["Coin Y,222,2026-01-02,11.00"], existing_rows=["Coin Z,333,2026-01-03,12.00"])
out["existingRejected"] = settle("old rejected", False, NO_COMPS)
out["existingRejected"].update({"destExists": dest.exists(), "rejected": rejected_files()})

# Two terms map to one filename: the second merge makes the file non-disposable for the first.
shared = stage("term A", "shared.csv", ["A row,444,2026-01-04,13.00"])
stage("term B", "shared.csv", ["B row,555,2026-01-05,14.00"])
out["collision"] = settle("term A", False, NO_COMPS)
out["collision"].update({"destExists": shared.exists(), "content": shared.read_text(encoding="utf-8"),
    "rejected": rejected_files()})

# The file changed after this run created it: keep it.
changed = stage("changed term", "changed.csv", ["Coin C,666,2026-01-06,15.00"])
with open(changed, "a", encoding="utf-8") as handle:
    handle.write("Coin D,777,2026-01-07,16.00\\n")
out["changed"] = settle("changed term", False, NO_COMPS)
out["changed"].update({"destExists": changed.exists()})

# Genuine failures keep the CSV and are not reported as no data.
for name, msg in (("weight", WEIGHT), ("server", "HTTP 500: boom"), ("network", "Cannot connect")):
    path = stage(name, name + ".csv", ["Coin " + name + ",888,2026-01-08,17.00"])
    out[name + "Error"] = settle(name, False, msg)
    out[name + "Error"].update({"destExists": path.exists()})

# Success keeps the CSV and forgets the entry.
path = stage("success", "success.csv", ["Coin S,999,2026-01-09,18.00"])
out["success"] = settle("success", True, "3 new, 0 dups")
out["success"].update({"destExists": path.exists()})

# Synchronous fallback path uses the same rules.
path = stage("sync rejected", "sync_rejected.csv", ["Coin R,121,2026-01-10,19.00"])
out["syncRejected"] = settle("sync rejected", False, NO_COMPS, sync=True)
out["syncRejected"].update({"destExists": path.exists()})
path = stage("sync ok", "sync_ok.csv", ["Coin O,122,2026-01-11,20.00"])
out["syncOk"] = settle("sync ok", True, "1 new, 0 dups", sync=True)
out["syncOk"].update({"destExists": path.exists()})
path = stage("sync server", "sync_server.csv", ["Coin V,123,2026-01-12,21.00"])
out["syncServerError"] = settle("sync server", False, "HTTP 500: boom", sync=True)
out["syncServerError"].update({"destExists": path.exists()})

# Unknown term: nothing to set aside.
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    out["discardUnknown"] = {"moved": exporter._discard_no_comps_dataset("never registered"), "stdout": stdout.getvalue()}

# The dormant line carries the term so the pass parser can attribute it.
class Resp:
    status_code = 200
    text = ""
    def json(self):
        return {"noDataCount": 3}
exporter.requests = types.SimpleNamespace(post=lambda *args, **kwargs: Resp())
stdout = io.StringIO()
with contextlib.redirect_stdout(stdout):
    real_report("Some Term")
out["dormantLine"] = stdout.getvalue()

out["riskSamples"] = risk_samples
print(json.dumps(out))
`);
}

describe('#328H exporter treats a 422 no-valid-comps upload as no data', () => {
  let harness;

  beforeAll(() => {
    harness = parseOutput(runExporterHarness());
  });

  test('reports no data and moves the unusable CSV it created to the git-ignored quarantine', () => {
    const run = harness.newRejected;
    expect(run.reportedNow).toEqual(['new rejected']);
    expect(run.destExists).toBe(false);
    expect(run.stillTracked).toBe(false);
    expect(run.rejected).toHaveLength(1);
    expect(run.rejected[0]).toMatch(/^new_rejected-\d{8}T\d{6}\.csv$/);
    expect(run.rejectedContent).toBe(run.original);
    expect(run.stdout).toMatch(/no valid comps; reported as no data, moved unusable CSV to cache\/terapeak-rejected\//);
  });

  test('keeps the failed-count contract so pass totals do not change', () => {
    expect(harness.newRejected.counts).toEqual([0, 0, 1]);
    expect(harness.newRejected.failedTerms).toEqual(['new rejected']);
  });

  test('never touches a dataset file that existed before this run', () => {
    const run = harness.existingRejected;
    expect(run.reportedNow).toEqual(['old rejected']);
    expect(run.destExists).toBe(true);
    expect(run.counts).toEqual([0, 0, 1]);
    expect(run.rejected).toHaveLength(1); // only the earlier test case's file
  });

  test('keeps a file that another term merged into after this run created it', () => {
    const run = harness.collision;
    expect(run.reportedNow).toEqual(['term A']);
    expect(run.destExists).toBe(true);
    expect(run.content).toContain('A row');
    expect(run.content).toContain('B row');
    expect(run.rejected).toHaveLength(1);
  });

  test('keeps a file that changed after this run created it', () => {
    const run = harness.changed;
    expect(run.reportedNow).toEqual(['changed term']);
    expect(run.destExists).toBe(true);
    expect(run.stdout).toMatch(/kept changed\.csv \(changed since this run created it\)/);
  });

  test.each(['weightError', 'serverError', 'networkError'])('genuine upload failure %s keeps the CSV and is not reported as no data', name => {
    const run = harness[name];
    expect(run.reportedNow).toEqual([]);
    expect(run.destExists).toBe(true);
    expect(run.stillTracked).toBe(false);
    expect(run.counts).toEqual([0, 0, 1]);
    expect(run.stdout).toMatch(/^\s*\[async upload\] .+: failed -- /);
    expect(run.stdout).not.toMatch(/\[dataset\]/);
  });

  test('successful upload keeps the CSV and forgets the tracking entry', () => {
    const run = harness.success;
    expect(run.counts).toEqual([1, 1, 0]);
    expect(run.destExists).toBe(true);
    expect(run.stillTracked).toBe(false);
    expect(run.reportedNow).toEqual([]);
  });

  test('synchronous fallback applies the same rules', () => {
    expect(harness.syncRejected.counts).toEqual([0, 0, 1]);
    expect(harness.syncRejected.reportedNow).toEqual(['sync rejected']);
    expect(harness.syncRejected.destExists).toBe(false);
    expect(harness.syncRejected.stdout).toMatch(/^SAVED but upload failed: HTTP 422/);
    expect(harness.syncOk.counts).toEqual([1, 1, 0]);
    expect(harness.syncOk.destExists).toBe(true);
    expect(harness.syncOk.stdout).toMatch(/^OK \(1 new, 0 dups\)/);
    expect(harness.syncServerError.counts).toEqual([0, 0, 1]);
    expect(harness.syncServerError.reportedNow).toEqual([]);
    expect(harness.syncServerError.destExists).toBe(true);
  });

  test('discarding an unregistered term moves nothing', () => {
    expect(harness.discardUnknown.moved).toBe(false);
    expect(harness.discardUnknown.stdout).toMatch(/reported as no data/);
  });

  test('dormant line carries the term for the pass parser', () => {
    expect(harness.dormantLine).toBe('  (dormant: 3 consecutive empty attempts) [Some Term]\n');
  });

  test('no exporter output from any case counts as a challenge or soft-risk signal', () => {
    expect(harness.riskSamples).toHaveLength(11);
    for (const sample of harness.riskSamples) {
      expect(sample).toEqual([0, 0]);
    }
  });
});

describe('#328H exporter main loop uses the tested helpers', () => {
  const source = fs.readFileSync(EXPORTER, 'utf8');
  const run = source.slice(source.indexOf('def do_export_run(args):'), source.indexOf('\n# ', source.indexOf('def do_export_run(args):') + 1));

  test('stages datasets through _stage_dataset instead of merging directly', () => {
    expect(run).toContain('dest = _stage_dataset(csv_path, dest, term)');
    expect(run).not.toContain('_merge_csv(csv_path, dest)');
  });

  test('settles synchronous uploads through the shared helper', () => {
    expect(run).toContain('_record_sync_upload_result(');
  });

  test('resets run-scoped tracking at the start of a run', () => {
    expect(run).toContain('_new_dataset_paths.clear()');
  });
});
