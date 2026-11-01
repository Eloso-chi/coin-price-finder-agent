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

// Error excerpts must be bounded to 200 characters for every failure form.
const LONG_LOG = [
  'Exporting 4 coins...',
  '  [ 25%] Coin A... SAVED (upload pending)',
  `  [ 50%] Coin B...   [async upload] Coin A: failed -- Network ${'y'.repeat(500)}`,
  'SAVED (upload pending)',
  `  [ 75%] Coin C... SAVED but upload failed: ${'z'.repeat(500)}`,
  `  [100%] Coin D... ERROR: ${'e'.repeat(500)}`,
  `  [async upload] Coin B: failed -- ${'w'.repeat(500)}`,
];

// A tagged dormant line is authoritative: an unknown term is ignored (never credited to the open
// coin), a tag may name an earlier coin, and a term that itself contains brackets still resolves.
const ODD_TAG_LOG = [
  'Exporting 3 coins...',
  '  [ 33%] Coin A... OK (1 new, 0 dups)',
  '  [ 67%] Odd [1oz] Coin... OK (2 new, 0 dups)',
  '  (dormant: 3 consecutive empty attempts) [Odd [1oz] Coin]',
  '  [100%] Coin B... OK (3 new, 0 dups)',
  '  (dormant: 3 consecutive empty attempts) [Never Parsed ] Term]',
  '  (dormant: 4 consecutive empty attempts) [Coin A]',
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

from _terapeak_risk import main as risk_main

logs = {
    "legacy": json.loads(${pyString(LEGACY_LOG)}),
    "tagged": json.loads(${pyString(TAGGED_LOG)}),
    "sync": json.loads(${pyString(SYNC_LOG)}),
    "long": json.loads(${pyString(LONG_LOG)}),
    "oddtags": json.loads(${pyString(ODD_TAG_LOG)}),
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
        cli_out = io.StringIO()
        with contextlib.redirect_stdout(cli_out):
            cluster_rc = risk_main(["no-comps-cluster", "--summary-file", str(summary)])
        out[name] = {
            "status": status,
            "stdout": stdout.getvalue(),
            "summary": json.loads(summary.read_text(encoding="utf-8")),
            "clusterRc": cluster_rc,
            "clusterOut": cli_out.getvalue().strip(),
        }
    out["cluster_cases"] = [
        [n, m, pass_parser.is_no_comps_cluster({"no_comps": n, "attempted": m})]
        for n, m in ((0, 5), (1, 1), (2, 2), (3, 3), (3, 10), (3, 11), (4, 15), (5, 15), (7, 22), (6, 22))
    ]
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

  test('error excerpts are clipped to 200 characters for async, same-line upload and ERROR failures', () => {
    const coins = coinsByName(harness.long.summary);
    expect(coins['Coin A'].status).toBe('failed');
    expect(coins['Coin A'].error).toHaveLength(200);
    expect(coins['Coin C'].status).toBe('failed');
    expect(coins['Coin C'].error).toHaveLength(200);
    expect(coins['Coin D'].status).toBe('failed');
    expect(coins['Coin D'].error).toHaveLength(200);
    expect(coins['Coin D'].error).toMatch(/^ERROR: e+$/);
    // Coin B's own result arrives later as a standalone drain line and is clipped too.
    expect(coins['Coin B'].error).toHaveLength(200);
    expect(coins['Coin B'].error).toMatch(/^w+$/);
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

  test('a tagged dormant line is authoritative: unknown terms are ignored, bracketed terms resolve', () => {
    const coins = coinsByName(harness.oddtags.summary);
    expect(coins['Odd [1oz] Coin'].dormant).toBe(true);
    // The line tagged with an unknown term must not be credited to the coin that happens to be open.
    expect(coins['Coin B'].dormant).toBe(false);
    // A tag may name an earlier coin that is no longer the open one.
    expect(coins['Coin A'].dormant).toBe(true);
    expect(harness.oddtags.summary.pass.dormant).toBe(2);
  });

  test('no_comps cluster thresholds: at least 3 coins and at least 30 percent of the batch', () => {
    const verdicts = Object.fromEntries(harness.cluster_cases.map(([n, m, flag]) => [`${n}/${m}`, flag]));
    expect(verdicts).toEqual({
      '0/5': false,
      '1/1': false, // isolated rejections (including a 1-coin canary) are routine headless datasets
      '2/2': false,
      '3/3': true,
      '3/10': true, // exactly 30 percent
      '3/11': false,
      '4/15': false,
      '5/15': true,
      '7/22': true,
      '6/22': false,
    });
  });

  test('operator CLI reads the cluster flag from the pass summary and is fail-closed', () => {
    expect(harness.tagged.clusterRc).toBe(2);
    expect(harness.tagged.clusterOut).toBe('true');
    expect(harness.legacy.clusterRc).toBe(0);
    expect(harness.legacy.clusterOut).toBe('false');
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
import datetime as dt
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
risk_samples = {}

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
    risk_samples[term] = [signals["challenge_signal_count"], signals["soft_risk_signal_count"]]
    return {
        "counts": list(counts),
        "reportedNow": reported[before:],
        "stdout": text,
        "failedTerms": progress.get("failed", []),
        "stillTracked": term in exporter._new_dataset_paths,
    }

out = {}

# New dataset created by this run, rejected with 422: set aside, content preserved.
exporter._begin_run()
dest = stage("new rejected", "new_rejected.csv", ["Coin X,111,2026-01-01,10.00"])
original = dest.read_text(encoding="utf-8")
out["newRejected"] = settle("new rejected", False, NO_COMPS)
out["newRejected"].update({"destExists": dest.exists(), "rejected": rejected_files(),
    "rejectedContent": (exporter.REJECTED_DIR / rejected_files()[0]).read_text(encoding="utf-8") if rejected_files() else None,
    "original": original})

# Dataset that existed before the run: merged into, never set aside.
exporter._begin_run()
dest = stage("old rejected", "old_rejected.csv", ["Coin Y,222,2026-01-02,11.00"], existing_rows=["Coin Z,333,2026-01-03,12.00"])
out["existingRejected"] = settle("old rejected", False, NO_COMPS)
out["existingRejected"].update({"destExists": dest.exists(), "rejected": rejected_files()})

# Two terms map to one filename: the second merge makes the file non-disposable for the first.
exporter._begin_run()
shared = stage("term A", "shared.csv", ["A row,444,2026-01-04,13.00"])
stage("term B", "shared.csv", ["B row,555,2026-01-05,14.00"])
out["collision"] = settle("term A", False, NO_COMPS)
out["collision"].update({"destExists": shared.exists(), "content": shared.read_text(encoding="utf-8"),
    "rejected": rejected_files()})

# The file changed after this run created it: keep it.
exporter._begin_run()
changed = stage("changed term", "changed.csv", ["Coin C,666,2026-01-06,15.00"])
with open(changed, "a", encoding="utf-8") as handle:
    handle.write("Coin D,777,2026-01-07,16.00\\n")
out["changed"] = settle("changed term", False, NO_COMPS)
out["changed"].update({"destExists": changed.exists()})

# Genuine failures keep the CSV and are not reported as no data.
exporter._begin_run()
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

# Systemic fault breaker: after 3 consecutive no-comps rejections, stop reporting no data and keep the CSVs
# until an upload succeeds.
exporter._begin_run()
breaker = []
for index in range(1, 6):
    term = "breaker %d" % index
    path = stage(term, "breaker%d.csv" % index, ["Coin B%d,50%d,2026-02-0%d,1.00" % (index, index, index)])
    run = settle(term, False, NO_COMPS)
    run["destExists"] = path.exists()
    breaker.append(run)
out["breaker"] = breaker
path = stage("breaker ok", "breaker_ok.csv", ["Coin K,600,2026-02-06,1.00"])
out["breakerReset"] = settle("breaker ok", True, "1 new, 0 dups")
path = stage("breaker after", "breaker_after.csv", ["Coin L,601,2026-02-07,1.00"])
out["breakerAfter"] = settle("breaker after", False, NO_COMPS)
out["breakerAfter"]["destExists"] = path.exists()

# _begin_run resets both pieces of run-scoped tracking.
exporter._new_dataset_paths["stale"] = {"path": root / "stale.csv", "size": 1, "mtime_ns": 1}
exporter._consecutive_no_comps = 9
exporter._begin_run()
out["beginRun"] = {"tracked": dict(exporter._new_dataset_paths), "consecutive": exporter._consecutive_no_comps}

# stat() failing with something other than FileNotFoundError must not escape the settle step.
exporter._begin_run()
path = stage("denied term", "denied.csv", ["Coin P,700,2026-03-01,1.00"])
real_path_class = exporter.Path
class DeniedPath:
    def __init__(self, value):
        self.name = os.path.basename(str(value))
    def stat(self, *args, **kwargs):
        raise PermissionError("denied")
exporter.Path = DeniedPath
try:
    out["statDenied"] = settle("denied term", False, NO_COMPS)
finally:
    exporter.Path = real_path_class
out["statDenied"]["destExists"] = path.exists()

# An unwritable quarantine location leaves the CSV where it is and keeps counts intact.
exporter._begin_run()
blocker = root / "blocker"
blocker.write_text("not a directory", encoding="utf-8")
real_rejected = exporter.REJECTED_DIR
exporter.REJECTED_DIR = blocker / "sub"
path = stage("blocked term", "blocked.csv", ["Coin Q,800,2026-03-02,1.00"])
try:
    out["blockedQuarantine"] = settle("blocked term", False, NO_COMPS)
finally:
    exporter.REJECTED_DIR = real_rejected
out["blockedQuarantine"]["destExists"] = path.exists()

# A quarantine target that already exists is never overwritten.
exporter._begin_run()
path = stage("clash term", "clash.csv", ["Coin R,900,2026-03-03,1.00"])
real_datetime = exporter.datetime
class FixedDatetime:
    @staticmethod
    def now():
        return dt.datetime(2026, 11, 1, 0, 0, 0, 123456)
exporter.datetime = FixedDatetime
exporter.REJECTED_DIR.mkdir(parents=True, exist_ok=True)
clash_target = exporter.REJECTED_DIR / "clash-20261101T000000123456.csv"
clash_target.write_text("earlier quarantined content", encoding="utf-8")
try:
    out["clash"] = settle("clash term", False, NO_COMPS)
finally:
    exporter.datetime = real_datetime
out["clash"].update({"destExists": path.exists(), "targetContent": clash_target.read_text(encoding="utf-8")})

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
    expect(run.rejected[0]).toMatch(/^new_rejected-\d{8}T\d{6}\d{6}\.csv$/);
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
    expect(run.rejected).toEqual(harness.newRejected.rejected); // nothing new was set aside
  });

  test('keeps a file that another term merged into after this run created it', () => {
    const run = harness.collision;
    expect(run.reportedNow).toEqual(['term A']);
    expect(run.destExists).toBe(true);
    expect(run.content).toContain('A row');
    expect(run.content).toContain('B row');
    expect(run.rejected).toEqual(harness.newRejected.rejected); // nothing new was set aside
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
    const terms = Object.keys(harness.riskSamples);
    expect(terms.length).toBeGreaterThanOrEqual(20);
    for (const term of terms) {
      expect({ term, signals: harness.riskSamples[term] }).toEqual({ term, signals: [0, 0] });
    }
  });

  test('more than three consecutive no-comps rejections stop reporting no data and keep the CSVs', () => {
    const runs = harness.breaker;
    for (const index of [0, 1, 2]) {
      expect(runs[index].reportedNow).toEqual([`breaker ${index + 1}`]);
      expect(runs[index].destExists).toBe(false);
    }
    for (const index of [3, 4]) {
      expect(runs[index].reportedNow).toEqual([]);
      expect(runs[index].destExists).toBe(true);
      expect(runs[index].counts).toEqual([0, 0, 1]);
      expect(runs[index].stdout).toMatch(/\[dataset\] WARN breaker \d: \d+ consecutive no-valid-comps rejections look systemic/);
    }
  });

  test('a successful upload resets the breaker', () => {
    expect(harness.breakerReset.counts).toEqual([1, 1, 0]);
    expect(harness.breakerAfter.reportedNow).toEqual(['breaker after']);
    expect(harness.breakerAfter.destExists).toBe(false);
  });

  test('_begin_run clears run-scoped tracking', () => {
    expect(harness.beginRun).toEqual({ tracked: {}, consecutive: 0 });
  });

  test('a stat() failure other than a missing file is reported without escaping or moving the CSV', () => {
    const run = harness.statDenied;
    expect(run.counts).toEqual([0, 0, 1]);
    expect(run.reportedNow).toEqual(['denied term']);
    expect(run.destExists).toBe(true);
    expect(run.stdout).toMatch(/\[dataset\] WARN denied term: no valid comps; reported as no data, could not inspect CSV denied\.csv: denied/);
  });

  test('an unwritable quarantine location leaves the CSV in place with a loud warning and intact counts', () => {
    const run = harness.blockedQuarantine;
    expect(run.counts).toEqual([0, 0, 1]);
    expect(run.reportedNow).toEqual(['blocked term']);
    expect(run.destExists).toBe(true);
    expect(run.stdout).toMatch(/\[dataset\] WARN blocked term: .*could not set CSV aside, blocked\.csv stays in data\/terapeak\//);
  });

  test('an existing quarantine target is never overwritten', () => {
    const run = harness.clash;
    expect(run.destExists).toBe(true);
    expect(run.targetContent).toBe('earlier quarantined content');
    expect(run.stdout).toMatch(/could not set CSV aside/);
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

  test('resets run-scoped tracking through _begin_run before any dataset is staged', () => {
    const begin = run.indexOf('_begin_run()');
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(run.indexOf('_stage_dataset('));
  });
});

describe('#328H operators stop on a no_comps cluster as a data-quality stop', () => {
  const operators = {
    h: fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'terapeak-operator.sh'), 'utf8'),
    codespace: fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'terapeak-operator-codespace.sh'), 'utf8'),
  };

  test.each(['h', 'codespace'])('%s operator hands the pass summary to the parser and evaluates the cluster flag after the hard-challenge and pass-exit checks', name => {
    const source = operators[name];
    const parse = source.indexOf('_parse-terapeak-pass.py');
    const summaryArg = source.indexOf('--summary-output', parse);
    const check = source.indexOf('no-comps-cluster --summary-file');
    const hardChallenge = source.indexOf('CHALLENGE_SIGNAL_COUNT > 0') > -1
      ? source.indexOf('CHALLENGE_SIGNAL_COUNT > 0')
      : source.indexOf('challenge_signal_count > 0');
    expect(parse).toBeGreaterThan(-1);
    expect(summaryArg).toBeGreaterThan(parse);
    expect(check).toBeGreaterThan(summaryArg);
    expect(check).toBeGreaterThan(hardChallenge);
  });

  test.each(['h', 'codespace'])('%s operator stop is fail-closed and does not change the risk state', name => {
    const source = operators[name];
    const start = source.indexOf('no-comps-cluster --summary-file');
    const end = source.indexOf('\n  fi\n', start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block).toMatch(/NO_COMPS_CLUSTER_RC == 2/);
    expect(block).toMatch(/NO_COMPS_CLUSTER_RC != 0/);
    expect(block).toMatch(/risk state unchanged/);
    // Not a risk signal: the stop must not touch the persisted risk state or Cooldown.
    expect(block).not.toMatch(/_terapeak_risk\.py (challenge|reset)/);
    expect(block).not.toMatch(/Cooldown/);
  });

  test('risk CLI subcommand is read-only and fails closed on an unreadable summary', () => {
    const risk = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', '_terapeak_risk.py'), 'utf8');
    const start = risk.indexOf('if args.command == "no-comps-cluster"');
    const block = risk.slice(start, risk.indexOf('if args.command in', start) > start ? risk.indexOf('if args.command in', start) : start + 1200);
    expect(block).toContain('return 3');
    expect(block).not.toContain('write_state');
  });
});
