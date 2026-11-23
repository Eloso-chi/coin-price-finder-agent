'use strict';

/**
 * #330H -- pass-record fields for fallback fill / tier yield / drained, and the two operators'
 * drained handling. The operator tests execute the real operator scripts end to end against a
 * temporary project copy with stubbed exporter, preflight and monitor commands.
 */

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPT_DIR = path.join(PROJECT_ROOT, 'scripts');
const PARSER = path.join(SCRIPT_DIR, '_parse-terapeak-pass.py');
const VALIDATOR = path.join(SCRIPT_DIR, 'validate-pass-telemetry.py');

function shellPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Parser harness
// ---------------------------------------------------------------------------

function runParserHarness() {
  const snippet = `
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile

with tempfile.TemporaryDirectory() as temp_dir:
    os.environ["TERAPEAK_RUNS_DIR"] = temp_dir
    spec = importlib.util.spec_from_file_location("pass_parser", ${JSON.stringify(shellPath(PARSER))})
    pass_parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pass_parser)
    vspec = importlib.util.spec_from_file_location("telemetry_validator", ${JSON.stringify(shellPath(VALIDATOR))})
    validator = importlib.util.module_from_spec(vspec)
    vspec.loader.exec_module(validator)

    def run(name, lines, extra):
        log = pathlib.Path(temp_dir) / (name + ".log")
        summary = pathlib.Path(temp_dir) / (name + "-summary.json")
        log.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            status = pass_parser.main([
                "--pass-log", str(log), "--run-id", "run-" + name, "--pass-num", "1",
                "--batch-size", "5", "--machine", "H", "--operator", "terapeak-operator",
                "--cookie-health-status", "HEALTHY", "--probe-status", "SKIPPED",
                "--state-before", "Normal", "--state-after", "Normal",
                "--summary-output", str(summary),
            ] + extra)
        return status

    results = {}
    results["fallback_status"] = run("fallback", [
        "Exporting 4 coins...",
        "Fallback pool: 9 eligible (probe-with-data 2, near-viable 7)",
        "Fallback fill: 3 (probe-with-data 1, near-viable 2)",
        "  [ 25%] Coin A... OK (3 new, 2 dups)",
        "  [yield] tier=primary appended=5 term=Coin A",
        "  [ 50%] Coin B... OK (1 new, 0 dups)",
        "  [yield] tier=probe-with-data appended=2 term=Coin B",
        "  [ 75%] Coin C... OK (0 new, 4 dups)",
        "  [yield] tier=near-viable appended=0 term=Coin C",
        "  [100%] Coin D... OK (2 new, 1 dups)",
        "  [yield] tier=near-viable appended=3 term=Coin D",
        "  Succeeded: 4",
        "  Failed: 0",
    ], [])
    results["legacy_status"] = run("legacy", [
        "Exporting 1 coins...",
        "  [100%] 2024 Silver Eagle... OK (3 new, 2 dups)",
        "  Succeeded: 1",
        "  Failed: 0",
    ], [])
    results["drained_status"] = run("drained", [
        "Mixed backlog selection: P0.1 0/15, non-P0.1 0/20, total 0/35",
        "Fallback pool: 0 eligible ()",
        "Fallback fill: 0 ()",
        "DRAINED: no eligible dataset in P0-P2 or any fallback tier",
    ], ["--pass-exit-code", "0"])
    results["noise_status"] = run("noise", [
        "Exporting 1 coins...",
        "  [100%] Coin X... OK (1 new, 0 dups)",
        "  note: this coin text mentions DRAINED: but not at line start",
        "  note: [yield] tier=near-viable appended=oops term=bad",
        "  Succeeded: 1",
        "  Failed: 0",
    ], [])

    results["corrected_status"] = run("corrected", [
        "Exporting 3 coins...",
        "  [ 25%] Coin A... SAVED (upload pending)",
        "  [yield] tier=near-viable appended=4 term=Coin A",
        "  [ 50%] Coin B...   [async upload] Coin A: OK (4 new, 0 dups)",
        "SAVED (upload pending)",
        "  [yield] tier=near-viable appended=2 term=Coin B",
        "  [ 75%] Coin C...   [async upload] Coin B: failed -- HTTP 422 No valid comps found in CSV",
        "  [yield] tier=near-viable appended=0 term=Coin B",
        "SAVED (upload pending)",
        "  [yield] tier=primary appended=7 term=Coin C",
        "  Succeeded: 1",
        "  Failed: 1",
    ], [])

    results["headless_status"] = run("headless", [
        "Exporting 3 coins...",
        "Fallback pool: 20 eligible (near-viable=15, thin-low=5)",
        "Fallback fill: 3 (probe-with-data=0, near-viable=2, probe-no-data=0, thin-low=1, confirmed-thin=0)",
        "  [ 33%] Coin A... HEADLESS (14 rows without Item Title or Item ID; not merged or uploaded)",
        "  [ 67%] Coin B... SAVED (upload pending)",
        "  [yield] tier=near-viable appended=6 term=Coin B",
        "  [100%] Coin C...   [async upload] Coin B: OK (6 new, 0 dups)",
        "    WARNING: No data rows found (0 tables on page)",
        "NO EXPORT (no results or button not found)",
        "  Succeeded: 1",
        "  Failed: 2",
    ], [])

    results["headless_line_status"] = run("headlessline", [
        "Exporting 3 coins...",
        "  [ 33%] Coin A...",
        "HEADLESS (9 rows without Item Title or Item ID; not merged or uploaded)",
        "  [ 67%] Coin B... OK (1 new, 0 dups)",
        "  [100%] Coin C...",
        "HEADLESS (4 rows without Item Title or Item ID; not merged or uploaded)",
        "  Succeeded: 1",
        "  Failed: 2",
    ], [])

    records = [json.loads(line) for line in pathlib.Path(pass_parser.PASSES_PATH).read_text(encoding="utf-8").splitlines()]
    valid_failures = validator.validate_files([str(pass_parser.PASSES_PATH)])
    print(json.dumps({"results": results, "records": records, "validator_failures": valid_failures}))
`;
  if (process.platform === 'win32') {
    return childProcess.spawnSync('wsl', [
      'env', `PYTHONPATH=${shellPath(SCRIPT_DIR)}`, 'python3', '-c', snippet,
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 60000 });
  }
  return childProcess.spawnSync('python3', ['-c', snippet], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PYTHONPATH: SCRIPT_DIR },
  });
}

describe('#330H pass record carries fallback fill, tier yield and drained', () => {
  let harness;
  let byRun;

  beforeAll(() => {
    const result = runParserHarness();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    harness = JSON.parse(result.stdout);
    byRun = Object.fromEntries(harness.records.map(record => [record.run_id, record]));
  }, 90000);

  test('every parser invocation succeeded', () => {
    expect(harness.results).toEqual({
      fallback_status: 0, legacy_status: 0, drained_status: 0, noise_status: 0, corrected_status: 0, headless_status: 0, headless_line_status: 0,
    });
    expect(harness.records).toHaveLength(7);
  });

  test('records the fallback fill reported by the exporter', () => {
    expect(byRun['run-fallback'].fallback_filled).toBe(3);
    expect(byRun['run-fallback'].drained).toBe(false);
  });

  test('sums yield per tier and reports non-fallback datasets as primary', () => {
    expect(byRun['run-fallback'].tier_yield).toEqual({
      primary: { items: 1, appended_rows: 5 },
      'probe-with-data': { items: 1, appended_rows: 2 },
      'near-viable': { items: 2, appended_rows: 3 },
    });
  });

  test('a log without the new lines yields zeros and an empty yield map', () => {
    expect(byRun['run-legacy']).toEqual(expect.objectContaining({
      fallback_filled: 0, tier_yield: {}, drained: false, attempted: 1, succeeded: 1,
    }));
  });

  test('a drained pass is a completed zero-coin pass with a drained marker', () => {
    expect(byRun['run-drained']).toEqual(expect.objectContaining({
      drained: true, fallback_filled: 0, tier_yield: {}, attempted: 0, pass_exit_code: 0,
    }));
  });

  test('a later yield line for the same term replaces the earlier one', () => {
    expect(byRun['run-corrected'].tier_yield).toEqual({
      'near-viable': { items: 2, appended_rows: 4 },
      primary: { items: 1, appended_rows: 7 },
    });
  });

  test('a headless-skipped coin is empty and flagged, and it is not a soft-risk signal', () => {
    const record = byRun['run-headless'];
    expect(record).toEqual(expect.objectContaining({
      attempted: 3, succeeded: 1, empty: 2, failed: 0, headless: 1,
    }));
    // Only the NO EXPORT line of Coin C is a soft signal; the HEADLESS line must not add one.
    expect(record.soft_risk_signal_count).toBe(1);
  });

  test('the pass record carries per-tier attempted slots and productive items for the yield gate', () => {
    expect(byRun['run-headless'].tier_attempted).toEqual({ 'near-viable': 2, 'thin-low': 1 });
    expect(byRun['run-headless'].tier_productive).toEqual({ 'near-viable': 1 });
    expect(byRun['run-fallback'].tier_attempted).toEqual({});
    expect(byRun['run-fallback'].tier_productive).toEqual({ 'probe-with-data': 1, 'near-viable': 1 });
    expect(byRun['run-legacy'].tier_attempted).toEqual({});
    expect(byRun['run-legacy'].tier_productive).toEqual({});
  });

  test('a HEADLESS line printed on its own line still classifies the open coin', () => {
    expect(byRun['run-headlessline']).toEqual(expect.objectContaining({
      attempted: 3, succeeded: 1, empty: 2, failed: 0, headless: 2,
    }));
    expect(byRun['run-headlessline'].soft_risk_signal_count).toBe(0);
  });

  test('a yield line corrected to zero rows is not productive', () => {
    expect(byRun['run-corrected'].tier_productive).toEqual({ 'near-viable': 1 });
  });

  test('only line-anchored markers and well-formed yield lines count', () => {
    expect(byRun['run-noise'].drained).toBe(false);
    expect(byRun['run-noise'].tier_yield).toEqual({});
  });

  test('the telemetry validator accepts the extended records', () => {
    expect(harness.validator_failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Operator end-to-end harness
// ---------------------------------------------------------------------------

const MARKER = '@@CPF@@';

const TWO_PASS_PACING_SETUP = String.raw`
mkdir -p "$T/clock"
printf '0' > "$T/clock-seconds"
: > "$T/clock-events.jsonl"
: > "$T/login.log"
unset VIRTUAL_ENV
export PYTHONPATH="$T/clock:$T/scripts" TERAPEAK_RUNS_DIR="$T/cache/terapeak-runs"
export TERAPEAK_RISK_STATE_ENABLED=1 TERAPEAK_ELEVATED_PAUSE_SECONDS=900
export TERAPEAK_PACING_PROFILE=baseline TERAPEAK_PACING_PILOT_ID=""
cat > "$T/clock/sitecustomize.py" <<'PY'
import datetime
import json
import os
from pathlib import Path
import time

root = Path(os.environ["T"])
clock = root / "clock-seconds"
epoch = 1767225600
original_datetime = datetime.datetime

class SharedDatetime(original_datetime):
    @classmethod
    def now(cls, tz=None):
        return cls.fromtimestamp(epoch + float(clock.read_text()), tz)

def early_sleep(seconds):
    before = float(clock.read_text())
    after = before + float(seconds) / 2
    clock.write_text(str(after))
    with (root / "clock-events.jsonl").open("a") as log:
        log.write(json.dumps({
            "event": "sleep", "before": before, "after": after,
            "requested": seconds,
        }) + "\n")

datetime.datetime = SharedDatetime
time.sleep = early_sleep
PY
cat > "$T/bin/date" <<'SH'
#!/usr/bin/env bash
exec "$REAL_PY" -c 'from datetime import datetime, timezone; import sys; print(datetime.now(timezone.utc).strftime(sys.argv[-1].removeprefix("+")))' "$@"
SH
cat > "$T/bin/sleep" <<'SH'
#!/usr/bin/env bash
exec "$REAL_PY" -c 'import sys, time; time.sleep(float(sys.argv[1]))' "$@"
SH
cat > "$T/scripts/terapeak-display.sh" <<'SH'
printf 'display %s\n' "$1" >> "$T/login.log"
SH
cat > "$T/simulated-exporter.py" <<'PY'
import ast
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

from _terapeak_risk import load_state

root = Path(os.environ["T"])
clock = root / "clock-seconds"
state_path = root / "cache/terapeak-risk-state-H.json"

def event(name, **details):
    with (root / "clock-events.jsonl").open("a") as log:
        log.write(json.dumps({
            "event": name, "time": float(clock.read_text()), **details,
        }) + "\n")

if "--login" in sys.argv:
    input("Simulated login: press Enter (no browser or network).")
    with (root / "login.log").open("a") as log:
        log.write("login confirmed\n")
    sys.exit(0)

tree = ast.parse((root / "scripts/terapeak-export.py").read_text(encoding="utf-8"))
guard = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "guard_scraper_action")
exec(compile(ast.Module(body=[guard], type_ignores=[]), "guard", "exec"))

def check_gate(extra):
    args = SimpleNamespace(
        backlog="simulated-report.json", mixed_p01_fixed=15,
        mixed_extra_min=extra, mixed_extra_max=extra,
    )
    guard_scraper_action("run", state_path=state_path, args=args)

if "--assert-early-gate" in sys.argv:
    assert load_state(str(state_path))["state"] == "Elevated"
    try:
        check_gate(0)
    except RuntimeError as error:
        assert "900s between passes; 900s remain" in str(error), str(error)
        assert not Path(str(state_path) + ".last-run").exists()
        event("early-gate-rejected")
    else:
        raise AssertionError("Elevated gate admitted the next pass before waiting")
    sys.exit(0)

counter = root / "pass-count"
number = int(counter.read_text()) + 1 if counter.exists() else 1
counter.write_text(str(number))
assert number <= 3, "operator did not stop after the final drained pass"
extra = int(sys.argv[sys.argv.index("--mixed-extra-min") + 1])
check_gate(extra)
event("pass-admitted", number=number, state=load_state(str(state_path))["state"])
with Path(os.environ["ARGS_LOG"]).open("a") as log:
    log.write(" ".join(sys.argv[1:]) + "\n")
if number == 1:
    print("Exporting 4 coins...")
    print("  [ 25%] Test A... OK (1 new, 0 dups)")
    for percent, name in ((50, "B"), (75, "C"), (100, "D")):
        print(f"  [{percent}%] Test {name}...")
        print("NO EXPORT (no results or button not found)")
elif number == 2:
    print("Exporting 1 coins...")
    print("  [100%] Test E... OK (2 new, 0 dups)")
else:
    print("DRAINED: no eligible dataset in P0-P2 or any fallback tier")
    sys.exit(20)
PY
cat > "$T/scripts/run-surface-freshness-loop.sh" <<'SH'
exec "$REAL_PY" "$T/simulated-exporter.py" "$@"
SH
cat > "$T/bin/python3" <<'SH'
#!/usr/bin/env bash
if [[ "$1" == scripts/terapeak-export.py ]]; then
  exec "$REAL_PY" "$T/simulated-exporter.py" "$@"
fi
if [[ "$1" == scripts/_terapeak_risk.py && "$2" == wait-elevated-pause ]]; then
  "$REAL_PY" "$T/simulated-exporter.py" --assert-early-gate || exit 1
fi
exec "$REAL_PY" "$@"
SH
chmod +x "$T/bin/date" "$T/bin/sleep" "$T/bin/python3"
`;

function runOperatorHarness({
  operator, args = [], stubRc, stubOutput, riskFile, riskState = 'Elevated', env = {},
  twoPassPacing = false,
}) {
  const stateFile = operator === 'h' ? 'cache/terapeak-startup-state.json' : 'cache/terapeak-operator-codespace.state.json';
  const operatorScript = operator === 'h' ? 'terapeak-operator.sh' : 'terapeak-operator-codespace.sh';
  const harness = String.raw`#!/usr/bin/env bash
set -uo pipefail
SRC='${shellPath(SCRIPT_DIR)}'
T="$(mktemp -d /tmp/cpf-drained.XXXXXX)"
trap 'rm -rf "$T"' EXIT
REAL_PY="$(command -v python3)"
mkdir -p "$T/scripts" "$T/cache" "$T/bin" "$T/home"
cp "$SRC"/*.py "$SRC/${operatorScript}" "$T/scripts/"
printf '%s\n' '{"state":"${riskState}","reason":"soft_risk_cluster","run_id":"earlier","changed_at":"2026-10-31T15:00:00Z"}' > "$T/cache/${riskFile}"
: > "$T/env"
: > "$T/stub-output.txt"
cat > "$T/stub-output.txt" <<'OUT'
${stubOutput}
OUT
cat > "$T/stub-body.sh" <<'SH'
echo "$*" >> "$ARGS_LOG"
cat "$STUB_OUTPUT"
exit "$STUB_RC"
SH
cat > "$T/scripts/terapeak-startup-preflight.sh" <<'SH'
exit 0
SH
cat > "$T/scripts/operator-monitor.sh" <<'SH'
exit 0
SH
cat > "$T/scripts/run-surface-freshness-loop.sh" <<'SH'
bash "$(dirname "$0")/../stub-body.sh" "$@"
SH
cat > "$T/bin/node" <<'SH'
exit 0
SH
cat > "$T/bin/curl" <<'SH'
echo '{"used":1,"remaining":2,"limit":3}'
exit 0
SH
cat > "$T/bin/python3" <<'SH'
case "$1" in
  scripts/terapeak-export.py) bash "$T/stub-body.sh" "$@" ;;
  scripts/cookie-health-check.py) exit 0 ;;
  -c) case "$2" in *playwright*) exit 0 ;; esac; exec "$REAL_PY" "$@" ;;
  *) exec "$REAL_PY" "$@" ;;
esac
SH
chmod +x "$T/bin/node" "$T/bin/curl" "$T/bin/python3"
: > "$T/args.log"
export T REAL_PY ARGS_LOG="$T/args.log" STUB_OUTPUT="$T/stub-output.txt" STUB_RC='${stubRc}'
export ADMIN_API_KEY=placeholder-test-key HOME="$T/home"
${Object.entries(env).map(([key, value]) => `export ${key}='${value}'`).join('\n')}
${twoPassPacing ? TWO_PASS_PACING_SETUP : ''}
cd "$T"
set +e
${twoPassPacing
    ? `printf '\\n\\n' | PATH="$T/bin:$PATH" timeout 60 script -q -e -c "bash scripts/${operatorScript} --loop --env-file $T/env" /dev/null > "$T/operator.out" 2>&1`
    : `PATH="$T/bin:$PATH" timeout 60 bash scripts/${operatorScript} ${args.map(arg => `'${arg}'`).join(' ')} --env-file "$T/env" > "$T/operator.out" 2>&1`}
STATUS=$?
emit() { printf '\n%s\n' "${MARKER}$1"; shift; "$@" 2>/dev/null || true; }
emit status echo "$STATUS"
emit output cat "$T/operator.out"
emit state cat "$T/${stateFile}"
emit args cat "$T/args.log"
emit passes cat "$T/cache/terapeak-runs/passes.jsonl"
emit risk cat "$T/cache/${riskFile}"
emit events cat "$T/clock-events.jsonl"
emit login cat "$T/login.log"
emit clock cat "$T/clock-seconds"
emit lastRun cat "$T/cache/${riskFile}.last-run"
`;
  const harnessFile = path.join(os.tmpdir(), `cpf-drained-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(harnessFile, harness.replace(/\r\n/g, '\n'), 'utf8');
  try {
    const result = process.platform === 'win32'
      ? childProcess.spawnSync('wsl', ['bash', shellPath(harnessFile)], { encoding: 'utf8', timeout: 120000 })
      : childProcess.spawnSync('bash', [harnessFile], { encoding: 'utf8', timeout: 120000 });
    const sections = {};
    let current = null;
    for (const line of (result.stdout || '').split('\n')) {
      if (line.startsWith(MARKER)) {
        current = line.slice(MARKER.length);
        sections[current] = [];
      } else if (current) {
        sections[current].push(line);
      }
    }
    const text = name => (sections[name] || []).join('\n').trim();
    const jsonLines = name => text(name).split('\n').filter(Boolean).map(line => JSON.parse(line));
    return {
      harnessStatus: result.status,
      harnessStderr: result.stderr,
      status: Number(text('status')),
      output: text('output'),
      state: text('state') ? JSON.parse(text('state')) : null,
      calls: text('args').split('\n').filter(Boolean),
      passes: jsonLines('passes'),
      risk: text('risk') ? JSON.parse(text('risk')) : null,
      events: jsonLines('events'),
      login: text('login').split('\n').filter(Boolean),
      clock: text('clock') ? Number(text('clock')) : null,
      lastRun: text('lastRun'),
    };
  } finally {
    fs.rmSync(harnessFile, { force: true });
  }
}

const DRAINED_OUTPUT = [
  'Mixed backlog selection: P0.1 0/15, non-P0.1 0/20, total 0/35',
  'Fallback pool: 0 eligible ()',
  'Fallback fill: 0 ()',
  'DRAINED: no eligible dataset in P0-P2 or any fallback tier',
].join('\n');

const COIN_OUTPUT = [
  'Exporting 1 coins...',
  '  [100%] 2024 Silver Eagle... OK (3 new, 2 dups)',
  '  Succeeded: 1',
  '  Failed: 0',
].join('\n');

const INITIAL_RISK = { state: 'Elevated', reason: 'soft_risk_cluster', run_id: 'earlier', changed_at: '2026-10-31T15:00:00Z' };

describe('#330H terapeak-operator.sh (H): drained handling, executed end to end', () => {
  const baseArgs = ['--no-login', '--pause-between', '0'];

  test('two consecutive productive passes transition Normal -> Elevated -> Normal on one sleep/gate clock', () => {
    const run = runOperatorHarness({
      operator: 'h', riskFile: 'terapeak-risk-state-H.json',
      riskState: 'Normal', stubRc: 0, stubOutput: '', twoPassPacing: true,
    });
    expect({ status: run.harnessStatus, stderr: run.harnessStderr }).toEqual({ status: 0, stderr: '' });
    expect(run.status).toBe(0);
    expect(run.login).toEqual(['display start', 'display check', 'login confirmed']);
    expect(run.passes.map(pass => ({
      pass: pass.pass, before: pass.state_before, after: pass.state_after,
      attempted: pass.attempted, succeeded: pass.succeeded,
      soft: pass.soft_risk_signal_count, exit: pass.pass_exit_code, drained: pass.drained,
    }))).toEqual([
      { pass: 1, before: 'Normal', after: 'Elevated', attempted: 4, succeeded: 1, soft: 3, exit: 0, drained: false },
      { pass: 2, before: 'Elevated', after: 'Normal', attempted: 1, succeeded: 1, soft: 0, exit: 0, drained: false },
      { pass: 3, before: 'Normal', after: 'Normal', attempted: 0, succeeded: 0, soft: 0, exit: 0, drained: true },
    ]);
    expect(run.passes[0].batch_size).toBeGreaterThanOrEqual(30);
    expect(run.passes[0].batch_size).toBeLessThanOrEqual(35);
    expect(run.passes[1].batch_size).toBeGreaterThanOrEqual(15);
    expect(run.passes[1].batch_size).toBeLessThanOrEqual(20);
    const admitted = run.events.filter(event => event.event === 'pass-admitted');
    expect(admitted).toEqual([
      { event: 'pass-admitted', number: 1, state: 'Normal', time: 0 },
      { event: 'pass-admitted', number: 2, state: 'Elevated', time: 900.5 },
      { event: 'pass-admitted', number: 3, state: 'Normal', time: 1200.5 },
    ]);
    expect(run.events.filter(event => event.event === 'early-gate-rejected')).toEqual([
      { event: 'early-gate-rejected', time: 0 },
    ]);
    const sleeps = run.events.filter(event => event.event === 'sleep');
    expect(sleeps[0]).toEqual({ event: 'sleep', before: 0, after: 451, requested: 902 });
    expect(sleeps[sleeps.length - 1]).toEqual({
      event: 'sleep', before: 900.5, after: 1200.5, requested: 600,
    });
    expect(sleeps.slice(0, -1).reduce((total, sleep) => total + sleep.after - sleep.before, 0)).toBe(900.5);
    expect(run.lastRun).toBe('2026-01-01T00:15:00.500000Z');
    expect(run.passes.slice(0, 2).map(pass => pass.started_at)).toEqual([
      '2026-01-01T00:00:00Z', '2026-01-01T00:15:00Z',
    ]);
    expect(run.clock).toBe(1200.5);
    expect(run.risk.state).toBe('Normal');
    expect(run.state).toEqual(expect.objectContaining({ stage: 'drained', status: 'ok', exitCode: 0 }));
    expect(run.calls).toHaveLength(3);
  }, 150000);

  test('a drained pass exits 0, records a drained state, and leaves the risk state untouched', () => {
    const run = runOperatorHarness({
      operator: 'h', args: [...baseArgs, '--loop'], stubRc: 20, stubOutput: DRAINED_OUTPUT, riskFile: 'terapeak-risk-state-H.json',
    });
    expect({ status: run.harnessStatus, stderr: run.harnessStderr }).toEqual({ status: 0, stderr: '' });
    expect(run.status).toBe(0);
    expect(run.output).toContain('Queue drained');
    expect(run.state).toEqual(expect.objectContaining({ stage: 'drained', status: 'ok' }));
    expect(run.calls).toHaveLength(1);
    expect(run.passes).toHaveLength(1);
    expect(run.passes[0]).toEqual(expect.objectContaining({
      drained: true, attempted: 0, pass_exit_code: 0, fallback_filled: 0, tier_yield: {},
    }));
    expect(run.risk).toEqual(INITIAL_RISK);
  }, 150000);

  test('passes the fallback tiers and exit-on-drained flags by default', () => {
    const run = runOperatorHarness({
      operator: 'h', args: [...baseArgs, '--loop'], stubRc: 20, stubOutput: DRAINED_OUTPUT, riskFile: 'terapeak-risk-state-H.json',
    });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toContain('--fallback-tiers all');
    expect(run.calls[0]).toContain('--exit-on-drained');
    expect(run.calls[0]).not.toContain('--include-thin');
  }, 150000);

  test('--no-fallback passes neither flag and a normal pass ends in the done state', () => {
    const run = runOperatorHarness({
      operator: 'h', args: [...baseArgs, '--no-fallback'], stubRc: 0, stubOutput: COIN_OUTPUT, riskFile: 'terapeak-risk-state-H.json',
    });
    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).not.toContain('--fallback-tiers');
    expect(run.calls[0]).not.toContain('--exit-on-drained');
    expect(run.state).toEqual(expect.objectContaining({ stage: 'done', status: 'ok' }));
    expect(run.passes[0]).toEqual(expect.objectContaining({ drained: false, attempted: 1, pass_exit_code: 0 }));
  }, 150000);

  test('--include-thin turns the tiers off but keeps exit-on-drained', () => {
    const run = runOperatorHarness({
      operator: 'h', args: [...baseArgs, '--include-thin'], stubRc: 0, stubOutput: COIN_OUTPUT, riskFile: 'terapeak-risk-state-H.json',
    });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toContain('--include-thin');
    expect(run.calls[0]).toContain('--exit-on-drained');
    expect(run.calls[0]).not.toContain('--fallback-tiers');
  }, 150000);

  test('a failing exporter still stops the operator with a failed state, not a drained one', () => {
    const run = runOperatorHarness({
      operator: 'h', args: [...baseArgs, '--loop'], stubRc: 2, stubOutput: 'ERROR: boom', riskFile: 'terapeak-risk-state-H.json',
    });
    expect(run.status).toBe(1);
    expect(run.state).toEqual(expect.objectContaining({ stage: 'loop-pass', status: 'failed' }));
    expect(run.passes[0]).toEqual(expect.objectContaining({ drained: false, pass_exit_code: 2 }));
    expect(run.output).not.toContain('Queue drained');
  }, 150000);
});

describe('#330H terapeak-operator-codespace.sh (W): drained handling, executed end to end', () => {
  const baseArgs = ['--max-passes', '3', '--no-jitter', '--pause-between', '0'];

  test('a drained pass ends the run with exit 0 and a drained state, without a second pass', () => {
    const run = runOperatorHarness({
      operator: 'w', args: baseArgs, stubRc: 20, stubOutput: DRAINED_OUTPUT, riskFile: 'terapeak-risk-state-W.json',
    });
    expect({ status: run.harnessStatus, stderr: run.harnessStderr }).toEqual({ status: 0, stderr: '' });
    expect(run.status).toBe(0);
    expect(run.state).toEqual(expect.objectContaining({ stage: 'drained', status: 'ok' }));
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toContain('--fallback-tiers all');
    expect(run.calls[0]).toContain('--exit-on-drained');
    expect(run.passes).toHaveLength(1);
    expect(run.passes[0]).toEqual(expect.objectContaining({
      drained: true, attempted: 0, pass_exit_code: 0,
    }));
    expect(run.risk).toEqual(INITIAL_RISK);
  }, 150000);

  test('--no-fallback passes neither flag and a normal run finishes without draining', () => {
    const run = runOperatorHarness({
      operator: 'w', args: ['--max-passes', '1', '--no-jitter', '--pause-between', '0', '--no-fallback'],
      stubRc: 0, stubOutput: COIN_OUTPUT, riskFile: 'terapeak-risk-state-W.json',
    });
    expect(run.status).toBe(0);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).not.toContain('--fallback-tiers');
    expect(run.calls[0]).not.toContain('--exit-on-drained');
    expect(run.state).toEqual(expect.objectContaining({ stage: 'finished', status: 'ok' }));
  }, 150000);

  test('--include-thin turns the tiers off but keeps exit-on-drained', () => {
    const run = runOperatorHarness({
      operator: 'w', args: ['--max-passes', '1', '--no-jitter', '--pause-between', '0', '--include-thin'],
      stubRc: 0, stubOutput: COIN_OUTPUT, riskFile: 'terapeak-risk-state-W.json',
    });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toContain('--include-thin');
    expect(run.calls[0]).toContain('--exit-on-drained');
    expect(run.calls[0]).not.toContain('--fallback-tiers');
  }, 150000);

  test('a failing exporter still stops the run with a failure, not a drained state', () => {
    const run = runOperatorHarness({
      operator: 'w', args: baseArgs, stubRc: 2, stubOutput: 'ERROR: boom', riskFile: 'terapeak-risk-state-W.json',
    });
    expect(run.status).not.toBe(0);
    expect(run.state).toEqual(expect.objectContaining({ status: 'fail' }));
    expect(run.state.stage).not.toBe('drained');
  }, 150000);
});
