'use strict';

// #328H: a 422 "No valid comps found in CSV" upload result is a no-data outcome, not an upload failure.
// #323H: pass outcome counts must agree with the pass log (ok + empty + failed == attempted, no unknown).
// Fixtures are shaped after real operator pass logs (runs 20261031T003645Z-230493 and 20261031T154735Z-235989).

const childProcess = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PARSER = path.join(PROJECT_ROOT, 'scripts', '_parse-terapeak-pass.py');
const EXPORTER = path.join(PROJECT_ROOT, 'scripts', 'terapeak-export.py');

const NO_COMPS_BODY = '{"error":"No valid comps found in CSV","details":{"totalRows":7,"skipped":7}}';
const WEIGHT_BODY = '{"error":"Contradictory explicit weights in search term:  oz","code":"CONTRADICTORY_WEIGHT","explicitWeights":[]}';

// Async uploads: results print on the NEXT coin's line, and the dormant line that follows a 422
// belongs to the coin whose upload was rejected. The last upload is drained after the final coin.
const ASYNC_LOG = [
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

// Outcomes printed on the coin line itself, and the sync-upload fallback form.
const SYNC_LOG = [
  'Exporting 6 coins...',
  '  [ 17%] Coin A... TIMEOUT',
  '  [ 33%] Coin B... ERROR: net::ERR_CONNECTION_RESET',
  '  [ 50%] Coin C... EMPTY (file too small: 12B)',
  '  [ 67%] Coin D... SAVED but upload failed: HTTP 500: {"error":"boom"}',
  `  [ 83%] Coin E... SAVED but upload failed: HTTP 422: ${NO_COMPS_BODY}`,
  '  (dormant: 3 consecutive empty attempts)',
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

logs = {"async": json.loads(${pyString(ASYNC_LOG)}), "sync": json.loads(${pyString(SYNC_LOG)})}
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
    coin_records = [json.loads(line) for line in pathlib.Path(pass_parser.COINS_PATH).read_text(encoding="utf-8").splitlines()]
    out["coin_records"] = coin_records
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

  test('async log: standalone async failure line cannot flip another coin', () => {
    const coins = coinsByName(harness.async.summary);
    expect(coins['Coin E'].status).toBe('empty');
    expect(coins['Coin E'].error).toBeNull();
    expect(coins['Coin D'].status).toBe('failed');
    expect(coins['Coin D'].error).toMatch(/^HTTP 400/);
  });

  test('async log: totals are internally consistent and match the log', () => {
    const pass = harness.async.summary.pass;
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

  test('sync log: TIMEOUT, ERROR, tiny-file and same-line upload failures are failed, never unknown', () => {
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
});

describe('#328H no-valid-comps outcome in pass telemetry', () => {
  let harness;

  beforeAll(() => {
    harness = parseOutput(runParserHarness());
  });

  test('async 422 no-valid-comps is an empty outcome flagged no_comps, and owns the dormant line', () => {
    const coins = coinsByName(harness.async.summary);
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

  test('sync-form 422 no-valid-comps is also an empty no_comps outcome', () => {
    const coins = coinsByName(harness.sync.summary);
    expect(coins['Coin E']).toEqual(expect.objectContaining({ status: 'empty', no_comps: true, dormant: true }));
  });

  test('pass record counts no_comps separately and reports it in the operator line', () => {
    expect(harness.async.summary.pass.no_comps).toBe(1);
    expect(harness.sync.summary.pass.no_comps).toBe(1);
    expect(harness.async.stdout).toMatch(/\[parse\] pass=1 attempted=5 ok=2 empty=2 failed=1 no_comps=1 /);
  });

  test('genuine upload failures are not counted as no_comps', () => {
    const coins = coinsByName(harness.async.summary);
    expect(coins['Coin D'].no_comps).toBeFalsy();
    const syncCoins = coinsByName(harness.sync.summary);
    expect(syncCoins['Coin D'].no_comps).toBeFalsy();
  });

  test('per-coin ledger records carry the no_comps flag', () => {
    const records = harness.coin_records.filter(r => r.run_id === 'run-async');
    expect(records.find(r => r.coin === 'Coin A')).toEqual(expect.objectContaining({
      status: 'empty',
      no_comps: true,
    }));
    expect(records.find(r => r.coin === 'Coin B').no_comps).toBe(false);
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
import sys
import tempfile
import types

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

reported = []
exporter._report_no_data = lambda term: reported.append(term)
NO_COMPS = "HTTP 422: " + ${JSON.stringify(NO_COMPS_BODY)}

def run_case(term, result_msg, ok, register, extra_existing=False):
    with tempfile.TemporaryDirectory() as temp_dir:
        path = os.path.join(temp_dir, term.replace(" ", "_") + ".csv")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("Item Title,Item ID,Date,Price\\n")
        if register:
            exporter._new_dataset_paths[term] = path
        before = len(reported)
        progress = {}
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            counts = exporter._record_upload_result({"term": term, "ok": ok, "msg": result_msg}, progress)
        return {
            "counts": list(counts),
            "fileExists": os.path.exists(path),
            "reportedNow": reported[before:],
            "stdout": stdout.getvalue(),
            "failedTerms": progress.get("failed", []),
            "stillTracked": term in exporter._new_dataset_paths,
        }

out = {
    "newDatasetRejected": run_case("new rejected", NO_COMPS, False, True),
    "existingDatasetRejected": run_case("old rejected", NO_COMPS, False, False),
    "weightError": run_case("weight", "HTTP 400: " + ${JSON.stringify(WEIGHT_BODY)}, False, True),
    "serverError": run_case("server", "HTTP 500: boom", False, True),
    "networkError": run_case("network", "Cannot connect", False, True),
    "success": run_case("success", "3 new, 0 dups", True, True),
}

with tempfile.TemporaryDirectory() as temp_dir:
    path = os.path.join(temp_dir, "sync.csv")
    open(path, "w", encoding="utf-8").write("x")
    exporter._new_dataset_paths["sync term"] = path
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        removed = exporter._discard_no_comps_dataset("sync term")
    out["discardHelper"] = {"removed": removed, "fileExists": os.path.exists(path), "stdout": stdout.getvalue()}
    out["discardHelperUnknown"] = exporter._discard_no_comps_dataset("never registered")

print(json.dumps(out))
`);
}

describe('#328H exporter treats a 422 no-valid-comps upload as no data', () => {
  let harness;

  beforeAll(() => {
    harness = parseOutput(runExporterHarness());
  });

  test('reports no data, removes the unusable CSV it created, and says so distinctly', () => {
    const run = harness.newDatasetRejected;
    expect(run.reportedNow).toEqual(['new rejected']);
    expect(run.fileExists).toBe(false);
    expect(run.stillTracked).toBe(false);
    expect(run.stdout).toMatch(/no valid comps/i);
    expect(run.stdout).toMatch(/removed/i);
  });

  test('keeps the failed-count contract so pass totals do not change', () => {
    expect(harness.newDatasetRejected.counts).toEqual([0, 0, 1]);
    expect(harness.newDatasetRejected.failedTerms).toEqual(['new rejected']);
  });

  test('never deletes a dataset file that existed before this run', () => {
    const run = harness.existingDatasetRejected;
    expect(run.reportedNow).toEqual(['old rejected']);
    expect(run.fileExists).toBe(true);
    expect(run.counts).toEqual([0, 0, 1]);
  });

  test.each(['weightError', 'serverError', 'networkError'])('genuine upload failure %s keeps the CSV and is not reported as no data', name => {
    const run = harness[name];
    expect(run.reportedNow).toEqual([]);
    expect(run.fileExists).toBe(true);
    expect(run.stillTracked).toBe(false);
    expect(run.counts).toEqual([0, 0, 1]);
    expect(run.stdout).toMatch(/failed -- /);
    expect(run.stdout).not.toMatch(/no valid comps --/i);
  });

  test('successful upload keeps the CSV and forgets the tracking entry', () => {
    const run = harness.success;
    expect(run.counts).toEqual([1, 1, 0]);
    expect(run.fileExists).toBe(true);
    expect(run.stillTracked).toBe(false);
    expect(run.reportedNow).toEqual([]);
  });

  test('shared discard helper removes only registered files', () => {
    expect(harness.discardHelper).toEqual(expect.objectContaining({ removed: true, fileExists: false }));
    expect(harness.discardHelper.stdout).toMatch(/removed/i);
    expect(harness.discardHelperUnknown).toBe(false);
  });

  test('new exporter output never trips the soft-risk classifier', () => {
    const run = harness.newDatasetRejected;
    expect(run.stdout).not.toMatch(/NO EXPORT|timeout|timed out/i);
  });
});
