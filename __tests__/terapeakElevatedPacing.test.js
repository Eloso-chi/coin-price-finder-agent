'use strict';

/**
 * #325H / #320H -- Elevated pacing must wait on the exporter gate's own clock,
 * and a pass that attempted nothing must not clear the Elevated state.
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPT_DIR = path.join(PROJECT_ROOT, 'scripts');
const OPERATOR_SCRIPT = path.join(SCRIPT_DIR, 'terapeak-operator.sh');

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function runPython(snippet) {
  const scriptDir = process.platform === 'win32' ? toWslPath(SCRIPT_DIR) : SCRIPT_DIR;
  const code = snippet.replace(/__SCRIPT_DIR__/g, scriptDir);
  if (process.platform === 'win32') {
    return childProcess.spawnSync('wsl', [
      'env', `PYTHONPATH=${scriptDir}`, 'python3', '-c', code,
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 60000 });
  }
  return childProcess.spawnSync('python3', ['-c', code], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PYTHONPATH: SCRIPT_DIR },
  });
}

function runHarness() {
  const snippet = `
import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

import _terapeak_risk as risk
from _terapeak_risk import evaluate_transition

results = {}
now = datetime(2026, 10, 31, 16, 0, 0, tzinfo=timezone.utc)


def iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def record(state, seconds_ago):
    return {
        "state": state,
        "reason": "soft_risk_cluster",
        "run_id": "test",
        "changed_at": iso(now - timedelta(seconds=seconds_ago)),
    }


# --- #320H: transition decisions -------------------------------------------
results["held_when_pass_not_clean"] = list(evaluate_transition("Elevated", {}, stateful=True, pass_clean=False))
results["clean_pass_returns_normal"] = list(evaluate_transition("Elevated", {}, stateful=True, pass_clean=True))
results["default_is_clean"] = list(evaluate_transition("Elevated", {}))
results["normal_unaffected"] = list(evaluate_transition("Normal", {}, stateful=True, pass_clean=False))
results["soft_cluster_still_elevates"] = list(evaluate_transition("Normal", {"soft_risk_signal_count": 3}, pass_clean=False))
results["challenge_still_cooldown"] = list(evaluate_transition("Elevated", {"challenge_signal_count": 1}, pass_clean=False))

# --- #325H: remaining-seconds helper mirrors the exporter gate -------------
remaining = risk.elevated_pause_remaining_seconds
results["remaining_short"] = remaining(record("Elevated", 853), 900, now=now)
results["remaining_exact"] = remaining(record("Elevated", 900), 900, now=now)
results["remaining_past"] = remaining(record("Elevated", 901), 900, now=now)
results["remaining_normal"] = remaining(record("Normal", 10), 900, now=now)
results["remaining_last_run_wins"] = remaining(
    record("Elevated", 1000), 900, last_run_text=iso(now - timedelta(seconds=100)), now=now,
)
results["remaining_last_run_older"] = remaining(
    record("Elevated", 853), 900, last_run_text=iso(now - timedelta(seconds=5000)), now=now,
)
results["remaining_invalid_timestamp"] = remaining(
    {"state": "Elevated", "changed_at": "not-a-time"}, 900, now=now,
)

# --- CLI: pause-remaining exit codes ---------------------------------------
workdir = pathlib.Path(tempfile.mkdtemp(prefix="elevated-pacing-"))
state_file = workdir / "risk-state.json"


def write_state_file(state, seconds_ago):
    wall_now = datetime.now(timezone.utc)
    body = {
        "state": state,
        "reason": "soft_risk_cluster",
        "run_id": "test",
        "changed_at": iso(wall_now - timedelta(seconds=seconds_ago)),
    }
    state_file.write_text(json.dumps(body), encoding="utf-8")


def run_cli(argv):
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = risk.main(argv)
    return {"code": code, "stdout": out.getvalue().strip(), "stderr": err.getvalue()}


write_state_file("Elevated", 10)
pending = run_cli(["pause-remaining", "--state-file", str(state_file), "--minimum-seconds", "900"])
results["cli_pending"] = {"code": pending["code"], "remaining": int(pending["stdout"])}
write_state_file("Elevated", 905)
done = run_cli(["pause-remaining", "--state-file", str(state_file), "--minimum-seconds", "900"])
results["cli_done"] = {"code": done["code"], "stdout": done["stdout"]}

# --- wait loop converges even when sleep returns early (observed ~5% on H) --
real_sleep = time.sleep
requested = []


def early_sleep(seconds):
    requested.append(seconds)
    real_sleep(seconds * 0.5)


risk.time.sleep = early_sleep
write_state_file("Elevated", 1)
started = time.monotonic()
waited = run_cli([
    "wait-elevated-pause", "--state-file", str(state_file),
    "--minimum-seconds", "4", "--margin-seconds", "1",
])
elapsed = time.monotonic() - started
risk.time.sleep = real_sleep
check = run_cli(["pause-remaining", "--state-file", str(state_file), "--minimum-seconds", "4"])
results["wait_with_early_sleep"] = {
    "code": waited["code"],
    "stdout": waited["stdout"],
    "iterations": len(requested),
    "gate_open_after_wait": check["code"] == 0,
    "elapsed_at_least_remaining": elapsed >= 2.0,
}

write_state_file("Normal", 1)
normal = run_cli(["wait-elevated-pause", "--state-file", str(state_file), "--minimum-seconds", "900"])
results["wait_skips_when_not_elevated"] = {"code": normal["code"], "stdout": normal["stdout"]}

# --- #320H end to end through the pass parser ------------------------------
parser_script = pathlib.Path("__SCRIPT_DIR__") / "_parse-terapeak-pass.py"


def run_parser(log_text, exit_code):
    case_dir = pathlib.Path(tempfile.mkdtemp(prefix="elevated-parse-", dir=str(workdir)))
    pass_log = case_dir / "pass.log"
    pass_log.write_text(log_text, encoding="utf-8")
    state_path = case_dir / "risk-state.json"
    state_path.write_text(json.dumps({
        "state": "Elevated", "reason": "soft_risk_cluster", "run_id": "earlier",
        "changed_at": "2026-10-31T15:00:00Z",
    }), encoding="utf-8")
    transition = case_dir / "pass.risk.tsv"
    summary = case_dir / "pass.summary.json"
    completed = subprocess.run([
        sys.executable, str(parser_script),
        "--pass-log", str(pass_log), "--run-id", "parse-test", "--pass-num", "2",
        "--batch-size", "15", "--start-ts", "2026-10-31T16:00:00Z", "--end-ts", "2026-10-31T16:00:03Z",
        "--machine", "H", "--operator", "terapeak-operator", "--pass-exit-code", str(exit_code),
        "--include-thin", "false", "--cookie-health-status", "HEALTHY", "--probe-status", "SKIPPED",
        "--pacing-profile-requested", "baseline", "--pacing-profile-effective", "baseline",
        "--pacing-pilot-id", "", "--pacing-batch-min", "30", "--pacing-batch-max", "35",
        "--pacing-p01-fixed", "15", "--pacing-upload-mode", "api",
        "--state-file", str(state_path), "--stateful", "true",
        "--transition-output", str(transition), "--summary-output", str(summary),
    ], cwd=str(case_dir), capture_output=True, text=True)
    final_state = json.loads(state_path.read_text(encoding="utf-8"))["state"]
    return {
        "returncode": completed.returncode,
        "stderr": completed.stderr.strip()[-300:],
        "final_state": final_state,
        "transition": transition.read_text(encoding="utf-8").strip() if transition.exists() else None,
    }


gate_fail_log = "[risk:FAIL] Elevated pacing requires 900s between passes; 28s remain\\n"
clean_log = (
    "Exporting 1 coins...\\n"
    "  [100%] 1oz Test Coin... SAVED (upload pending)\\n"
    "  [async upload] 1oz Test Coin: OK (2 new, 1 dups)\\n"
)
results["parser_zero_attempt_nonzero_exit"] = run_parser(gate_fail_log, 2)
results["parser_clean_pass"] = run_parser(clean_log, 0)

import shutil
shutil.rmtree(workdir, ignore_errors=True)
print(json.dumps(results))
`;
  return runPython(snippet);
}

describe('#325H Elevated pause waits on the gate clock; #320H zero-attempt pass holds Elevated', () => {
  let results;

  beforeAll(() => {
    const result = runHarness();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    results = JSON.parse(result.stdout);
  }, 90000);

  test('a pass that was not clean leaves Elevated unchanged and records no transition', () => {
    expect(results.held_when_pass_not_clean).toEqual(['Elevated', null]);
  });

  test('a clean pass still returns Elevated to Normal (default behavior unchanged)', () => {
    expect(results.clean_pass_returns_normal).toEqual(['Normal', 'clean_pass_after_elevated']);
    expect(results.default_is_clean).toEqual(['Normal', 'clean_pass_after_elevated']);
  });

  test('pass cleanliness does not affect Normal, soft-cluster, or hard-challenge transitions', () => {
    expect(results.normal_unaffected).toEqual(['Normal', null]);
    expect(results.soft_cluster_still_elevates).toEqual(['Elevated', 'soft_risk_cluster']);
    expect(results.challenge_still_cooldown).toEqual(['Cooldown', 'hard_challenge_signal']);
  });

  test('remaining seconds mirror the exporter gate arithmetic', () => {
    expect(results.remaining_short).toBe(47);
    expect(results.remaining_exact).toBe(0);
    expect(results.remaining_past).toBe(0);
    expect(results.remaining_normal).toBe(0);
  });

  test('a later last-run marker wins over changed_at, an older one is ignored', () => {
    expect(results.remaining_last_run_wins).toBe(800);
    expect(results.remaining_last_run_older).toBe(47);
  });

  test('an unreadable timestamp fails closed with the full pause', () => {
    expect(results.remaining_invalid_timestamp).toBe(900);
  });

  test('pause-remaining prints seconds and exits 2 while pending, 0 once the gate would pass', () => {
    expect(results.cli_pending.code).toBe(2);
    expect(results.cli_pending.remaining).toBeGreaterThan(880);
    expect(results.cli_pending.remaining).toBeLessThanOrEqual(890);
    expect(results.cli_done).toEqual({ code: 0, stdout: '0' });
  });

  test('wait loop converges when sleep returns early, and the gate is open afterwards', () => {
    expect(results.wait_with_early_sleep.code).toBe(0);
    expect(results.wait_with_early_sleep.stdout).toBe('0');
    expect(results.wait_with_early_sleep.iterations).toBeGreaterThanOrEqual(2);
    expect(results.wait_with_early_sleep.gate_open_after_wait).toBe(true);
    expect(results.wait_with_early_sleep.elapsed_at_least_remaining).toBe(true);
  });

  test('wait is a no-op when the state is not Elevated', () => {
    expect(results.wait_skips_when_not_elevated).toEqual({ code: 0, stdout: '0' });
  });

  test('parser keeps Elevated after a non-zero pass that attempted nothing', () => {
    expect(results.parser_zero_attempt_nonzero_exit.stderr).toBe('');
    expect(results.parser_zero_attempt_nonzero_exit.returncode).toBe(0);
    expect(results.parser_zero_attempt_nonzero_exit.final_state).toBe('Elevated');
    expect(results.parser_zero_attempt_nonzero_exit.transition.split('\t').slice(0, 3))
      .toEqual(['Elevated', 'Elevated', 'none']);
  });

  test('parser still returns Elevated to Normal after a real clean pass', () => {
    expect(results.parser_clean_pass.stderr).toBe('');
    expect(results.parser_clean_pass.returncode).toBe(0);
    expect(results.parser_clean_pass.final_state).toBe('Normal');
    expect(results.parser_clean_pass.transition.split('\t').slice(0, 3))
      .toEqual(['Elevated', 'Normal', 'clean_pass_after_elevated']);
  });

  test('operator waits through the helper instead of a fixed sleep when Elevated', () => {
    const source = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
    expect(source).toContain('wait-elevated-pause');
    expect(source).toMatch(/_terapeak_risk\.py wait-elevated-pause[\s\\]*--state-file "\$RISK_STATE_FILE"/);
  });
});
