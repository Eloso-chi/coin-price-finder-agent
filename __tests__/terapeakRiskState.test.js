'use strict';

const childProcess = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPT_DIR = path.join(PROJECT_ROOT, 'scripts');
const EXPORTER = path.join(SCRIPT_DIR, 'terapeak-export.py');

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function runRiskHarness() {
  const exporterPath = process.platform === 'win32' ? toWslPath(EXPORTER) : EXPORTER;
  const snippet = `
import contextlib
import fcntl
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from _terapeak_risk import classify_log_lines, evaluate_transition, load_state, main

results = {}
cases = {
  "hard": ("Normal", ["We've detected unusual activity"], True),
  "soft": ("Normal", ["timeout", "NO EXPORT", "browser crash"], True),
  "clean": ("Elevated", ["OK (2 new, 1 dups)"], True),
  "rollback": ("Normal", ["HTTP 429"], False),
}
for name, (state, lines, stateful) in cases.items():
  signals = classify_log_lines(lines)
  next_state, reason = evaluate_transition(state, signals, stateful)
  results[name] = {"signals": signals, "state": next_state, "reason": reason}

with tempfile.TemporaryDirectory() as temp_dir:
  malformed = pathlib.Path(temp_dir) / "malformed.json"
  malformed.write_text("{", encoding="utf-8")
  invalid = pathlib.Path(temp_dir) / "invalid.json"
  invalid.write_text('{"state":"Unexpected"}', encoding="utf-8")
  results["malformed_state"] = load_state(malformed)["state"]
  results["invalid_state"] = load_state(invalid)["state"]
  challenged = pathlib.Path(temp_dir) / "challenged.json"
  with contextlib.redirect_stdout(io.StringIO()):
    main(["challenge", "--state-file", str(challenged), "--run-id", "test-run"])
  results["cookie_challenge"] = load_state(challenged)
  challenged.unlink()
  results["deleted_state"] = load_state(challenged)["state"]
  challenged.write_text('{"state":"Normal"}', encoding="utf-8")
  results["rewritten_state"] = load_state(challenged)["state"]

playwright = types.ModuleType("playwright")
sync_api = types.ModuleType("playwright.sync_api")
sync_api.sync_playwright = lambda: None
sync_api.TimeoutError = TimeoutError
playwright.sync_api = sync_api
sys.modules.setdefault("playwright", playwright)
sys.modules.setdefault("playwright.sync_api", sync_api)
sys.modules.setdefault("requests", types.ModuleType("requests"))

spec = importlib.util.spec_from_file_location("terapeak_export", ${JSON.stringify(exporterPath)})
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

class Page:
  def __init__(self, body):
    self.url = "https://www.ebay.com/sh/research"
    self.body = body
  def content(self):
    return self.body
  def goto(self, _url, **_kwargs):
    return Response(200)
  def screenshot(self, **_kwargs):
    pass

class Response:
  def __init__(self, status):
    self.status = status

results["same_url_dom"] = exporter.challenge_indicators(Page("Security Measure: are you a human?"))
results["same_url_status"] = exporter.challenge_indicators(Page("research"), Response(429))
results["clean_page"] = exporter.challenge_indicators(Page("Terapeak product research"), Response(200))

class Context:
  def add_init_script(self, _script): pass
  def new_page(self): return Page("Terapeak product research")

class Browser:
  def new_context(self, **_kwargs): return Context()
  def close(self): pass

class Chromium:
  def launch(self, **_kwargs): return Browser()

class Playwright:
  chromium = Chromium()
  def stop(self): pass

class PlaywrightStarter:
  def start(self): return Playwright()

with tempfile.TemporaryDirectory() as temp_dir:
  temp_path = pathlib.Path(temp_dir)
  risk_project = temp_path / "risk-project"
  (risk_project / "cache").mkdir(parents=True)
  (risk_project / ".machine-id").write_text("H\\n", encoding="utf-8")
  exporter.PROJECT_DIR = risk_project
  cookie_file = temp_path / "cookies.json"
  cookie_file.write_text("[]", encoding="utf-8")
  exporter.COOKIE_FILE = cookie_file
  exporter.DOWNLOAD_DIR = temp_path / "downloads"
  exporter.CSV_DIR = temp_path / "csv"
  exporter.sync_playwright = lambda: PlaywrightStarter()
  exporter.get_search_terms = lambda: [{"term": "coin-term", "filename": "coin.csv"}]
  exporter.load_progress = lambda: {}
  exporter.load_cookies = lambda _context: None
  exporter.save_cookies = lambda _context: None
  exporter.wait_for_research_page = lambda _page: None
  exporter.is_logged_in = lambda _page: True
  exporter.has_display = lambda: True
  searches = []
  exporter.do_search_and_export = lambda *_args: searches.append("search") or "BOT_BLOCKED"
  saved = []
  exporter.save_progress = lambda progress: saved.append(dict(progress))
  exporter.time.sleep = lambda _seconds: (_ for _ in ()).throw(AssertionError("challenge retry sleep"))
  os.environ["TERAPEAK_RISK_STATE_ENABLED"] = "0"
  args = SimpleNamespace(
    dry_run=False, filter=None, priority_include=None, priority_exclude=None,
    backlog=None, mixed_p01_fixed=None, mixed_extra_min=None,
    mixed_extra_max=None, resume=False, refresh=False, max_age=7,
    min_comps=0, exclude_low_volume=False, priority=False, shuffle=False,
    limit=None,
  )
  with contextlib.redirect_stdout(io.StringIO()):
    run_status = exporter.do_export_run(args)
  results["rollback_exporter_stop"] = {
    "status": run_status,
    "searches": len(searches),
    "failed": saved[-1].get("failed"),
    "risk_state": load_state(exporter.scraper_risk_state_path())["state"],
  }
  challenged_state = exporter.scraper_risk_state_path()
  challenged_state.write_text(json.dumps({
    "state": "Normal", "reason": "test", "run_id": "test-run",
    "changed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
  }), encoding="utf-8")
  exporter.save_progress = lambda _progress: (_ for _ in ()).throw(OSError("progress disk full"))
  try:
    exporter.record_hard_challenge({}, "test coin")
  except OSError:
    pass
  results["challenge_cooldown_before_progress_failure"] = load_state(challenged_state)["state"]

  exporter.get_search_terms = lambda: [
    {"term": "first challenge", "filename": "first.csv"},
    {"term": "must not run", "filename": "second.csv"},
  ]
  searches_after_state_failure = []
  exporter.do_search_and_export = lambda *_args: searches_after_state_failure.append("searched") or "BOT_BLOCKED"
  exporter.save_progress = lambda _progress: None
  exporter.write_state = lambda *_args: (_ for _ in ()).throw(OSError("risk state disk full"))
  exporter.time.sleep = lambda _seconds: None
  with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
    state_failure_status = exporter.do_export_run(args)
  results["challenge_state_write_failure"] = {
    "status": state_failure_status,
    "searches": len(searches_after_state_failure),
  }

def risk_record(state, changed_at):
  return {
    "state": state,
    "reason": "test",
    "run_id": "risk-guard-test",
    "changed_at": changed_at.isoformat().replace("+00:00", "Z"),
  }

def check_action(action, state, changed_at, operator_context=None, elevated_args=False):
  state_path = pathlib.Path(tempfile.gettempdir()) / f"exporter-risk-{os.getpid()}-{action}.json"
  state_path.write_text(json.dumps(risk_record(state, changed_at)), encoding="utf-8")
  os.environ.pop("TERAPEAK_OPERATOR_CONTEXT", None)
  os.environ["TERAPEAK_ELEVATED_PAUSE_SECONDS"] = "900"
  action_args = SimpleNamespace(
    backlog="cache/freshness-report.json" if elevated_args else None,
    mixed_p01_fixed=15 if elevated_args else None,
    mixed_extra_min=5 if elevated_args else None,
    mixed_extra_max=5 if elevated_args else None,
  )
  try:
    with contextlib.redirect_stdout(io.StringIO()):
      with __import__("unittest.mock", fromlist=["patch"]).patch.object(
        exporter.subprocess,
        "run",
        return_value=SimpleNamespace(returncode=0, stderr="", stdout=""),
      ):
        exporter.guard_scraper_action(action, state_path, cooldown_seconds=7200, args=action_args)
    return {"allowed": True, "state_after": load_state(state_path)["state"]}
  except RuntimeError as error:
    return {"allowed": False, "message": str(error), "state_after": load_state(state_path)["state"]}
  finally:
    state_path.unlink(missing_ok=True)

now = datetime.now(timezone.utc)
cli_project = pathlib.Path(tempfile.mkdtemp())
(cli_project / "cache").mkdir(parents=True)
(cli_project / ".machine-id").write_text("H\\n", encoding="utf-8")
scripts_dir = cli_project / "scripts"
scripts_dir.mkdir()
display_check = scripts_dir / "terapeak-display.sh"
display_check.write_text("#!/usr/bin/env bash\\necho 'test display not verified' >&2\\nexit 1\\n", encoding="utf-8")
display_check.chmod(0o700)
exporter.PROJECT_DIR = cli_project
results["exporter_entrypoint_guard"] = {
  "normal_run": check_action("run", "Normal", now),
  "elevated_unbounded_run": check_action("run", "Elevated", now - timedelta(seconds=901)),
  "elevated_bounded_run": check_action("run", "Elevated", now - timedelta(seconds=901), elevated_args=True),
  "elevated_early_bounded_run": check_action("run", "Elevated", now, elevated_args=True),
  "challenged_run": check_action("run", "Challenged", now),
  "cooldown_run": check_action("run", "Cooldown", now),
  "active_cooldown_login": check_action("login", "Cooldown", now),
  "elapsed_cooldown_login": check_action("login", "Cooldown", now - timedelta(seconds=7201)),
  "elapsed_cooldown_run": check_action("run", "Cooldown", now - timedelta(seconds=7201)),
}

repeat_state = pathlib.Path(tempfile.gettempdir()) / f"exporter-risk-repeat-{os.getpid()}.json"
repeat_state.write_text(json.dumps(risk_record("Elevated", now - timedelta(seconds=901))), encoding="utf-8")
repeat_args = SimpleNamespace(backlog="cache/freshness-report.json", mixed_p01_fixed=15, mixed_extra_min=5, mixed_extra_max=5)
try:
  with contextlib.redirect_stdout(io.StringIO()):
    exporter.guard_scraper_action("run", repeat_state, args=repeat_args)
  try:
    with contextlib.redirect_stdout(io.StringIO()):
      exporter.guard_scraper_action("run", repeat_state, args=repeat_args)
    results["elevated_repeated_run"] = {"allowed": True}
  except RuntimeError as error:
    results["elevated_repeated_run"] = {"allowed": False, "message": str(error)}
finally:
  repeat_state.unlink(missing_ok=True)
  repeat_state.with_suffix(repeat_state.suffix + ".last-run").unlink(missing_ok=True)

race_state = cli_project / "cache" / "terapeak-risk-state-H.json"
race_state.write_text(json.dumps(risk_record("Elevated", now - timedelta(seconds=901))), encoding="utf-8")
os.environ["TERAPEAK_RISK_STATE_FILE"] = str(race_state)
race_script = r'''
import importlib.util, json, os, pathlib, sys, tempfile
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location("terapeak_export", sys.argv[2])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.PROJECT_DIR = pathlib.Path(sys.argv[3]).parent.parent
try:
    module.guard_scraper_action("run", pathlib.Path(sys.argv[3]), args=SimpleNamespace(backlog="cache/freshness-report.json", mixed_p01_fixed=15, mixed_extra_min=5, mixed_extra_max=5))
    print("allowed")
except RuntimeError as error:
    print(str(error))
'''
exporter_path_for_race = ${JSON.stringify(exporterPath)}
script_dir_for_race = str(pathlib.Path(exporter_path_for_race).parent)
race_processes = [
  subprocess.Popen(
    [sys.executable, "-c", race_script, script_dir_for_race, exporter_path_for_race, str(race_state)],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
  )
  for _ in range(2)
]
race_outputs = []
try:
  for process in race_processes:
    stdout, stderr = process.communicate(timeout=10)
    race_outputs.append({
      "returncode": process.returncode,
      "stdout": stdout.strip(),
      "stderr": stderr.strip(),
    })
except Exception:
  for process in race_processes:
    if process.poll() is None:
      process.terminate()
  for process in race_processes:
    try:
      process.wait(timeout=1)
    except subprocess.TimeoutExpired:
      process.kill()
      process.wait(timeout=1)
  raise
results["concurrent_elevated_runs"] = race_outputs
results["concurrent_elevated_allowed_count"] = sum(item["stdout"] == "allowed" for item in race_outputs)

cli_state = cli_project / "cache" / "terapeak-risk-state-H.json"
cli_state.write_text(json.dumps(risk_record("Cooldown", now)), encoding="utf-8")
os.environ["TERAPEAK_RISK_STATE_FILE"] = str(cli_state)
previous_argv = sys.argv
cli_stderr = io.StringIO()
try:
  sys.argv = ["terapeak-export.py", "--run"]
  with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(cli_stderr):
    exporter.main()
except SystemExit as error:
  results["direct_cli_cooldown_run"] = {
    "exit_code": error.code,
    "message": cli_stderr.getvalue().strip(),
  }
finally:
  sys.argv = previous_argv
  cli_state.unlink(missing_ok=True)

cli_state.write_text(json.dumps(risk_record("Normal", now)), encoding="utf-8")
action_lock_path = cli_project / "cache" / "terapeak-risk-state-H.scraper.lock"
lock_holder = subprocess.Popen(
  [sys.executable, "-c", "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); time.sleep(20)", str(action_lock_path)],
  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
try:
  if lock_holder.stdout.readline().strip() != "ready":
    raise RuntimeError("could not acquire exporter action lock in test")
  cli_run_stderr = io.StringIO()
  sys.argv = ["terapeak-export.py", "--run"]
  with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(cli_run_stderr):
    exporter.main()
except SystemExit as error:
  results["direct_cli_parallel_run"] = {
    "exit_code": error.code,
    "message": cli_run_stderr.getvalue().strip(),
  }
finally:
  sys.argv = previous_argv
  lock_holder.terminate()
  try:
    lock_holder.wait(timeout=1)
  except subprocess.TimeoutExpired:
    lock_holder.kill()
    lock_holder.wait(timeout=1)

cli_state.write_text(json.dumps(risk_record("Elevated", now - timedelta(seconds=901))), encoding="utf-8")
cli_state.with_suffix(cli_state.suffix + ".last-run").unlink(missing_ok=True)
lock_holder = subprocess.Popen(
  [sys.executable, "-c", "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); time.sleep(20)", str(action_lock_path)],
  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
try:
  if lock_holder.stdout.readline().strip() != "ready":
    raise RuntimeError("could not acquire exporter action lock in Elevated test")
  elevated_lock_stderr = io.StringIO()
  sys.argv = ["terapeak-export.py", "--run", "--backlog", "cache/freshness-report.json", "--mixed-p01-fixed", "15", "--mixed-extra-min", "5", "--mixed-extra-max", "5"]
  with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(elevated_lock_stderr):
    exporter.main()
except SystemExit as error:
  results["elevated_action_lock_conflict"] = {
    "exit_code": error.code,
    "message": elevated_lock_stderr.getvalue().strip(),
    "reserved": cli_state.with_suffix(cli_state.suffix + ".last-run").exists(),
  }
finally:
  sys.argv = previous_argv
  lock_holder.terminate()
  try:
    lock_holder.wait(timeout=1)
  except subprocess.TimeoutExpired:
    lock_holder.kill()
    lock_holder.wait(timeout=1)
  cli_state.with_suffix(cli_state.suffix + ".last-run").unlink(missing_ok=True)

cli_login_stderr = io.StringIO()
try:
  sys.argv = ["terapeak-export.py", "--login"]
  with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(cli_login_stderr):
    exporter.main()
except SystemExit as error:
  results["direct_cli_unverified_display_login"] = {
    "exit_code": error.code,
    "message": cli_login_stderr.getvalue().strip(),
  }
finally:
  sys.argv = previous_argv
  cli_state.unlink(missing_ok=True)

spoof_state = cli_project / "cache" / "other-machine-state.json"
spoof_state.write_text(json.dumps(risk_record("Normal", now)), encoding="utf-8")
os.environ["TERAPEAK_RISK_STATE_FILE"] = str(spoof_state)
cli_stderr = io.StringIO()
try:
  sys.argv = ["terapeak-export.py", "--run"]
  with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(cli_stderr):
    exporter.main()
except SystemExit as error:
  results["direct_cli_spoofed_state_path"] = {
    "exit_code": error.code,
    "message": cli_stderr.getvalue().strip(),
  }
finally:
  sys.argv = previous_argv
  spoof_state.unlink(missing_ok=True)
import shutil
shutil.rmtree(cli_project)
print(json.dumps(results))
`;
  if (process.platform === 'win32') {
    const wslScriptDir = SCRIPT_DIR.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
    return childProcess.spawnSync('wsl', [
      'env', `PYTHONPATH=${wslScriptDir}`, 'python3', '-c', snippet,
    ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  }
  return childProcess.spawnSync('python3', ['-c', snippet], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: SCRIPT_DIR },
  });
}

describe('#284H risk-state transitions', () => {
  let results;

  beforeAll(() => {
    const result = runRiskHarness();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    results = JSON.parse(result.stdout);
  });

  test('hard challenge moves directly to mandatory Cooldown', () => {
    expect(results.hard).toEqual({
      signals: { challenge_signal_count: 1, soft_risk_signal_count: 0 },
      state: 'Cooldown',
      reason: 'hard_challenge_signal',
    });
  });

  test('soft risk cluster elevates pacing without declaring a challenge', () => {
    const result = results.soft;
    expect(result.state).toBe('Elevated');
    expect(result.reason).toBe('soft_risk_cluster');
    expect(result.signals.challenge_signal_count).toBe(0);
  });

  test('clean pass returns Elevated state to Normal', () => {
    const result = results.clean;
    expect(result.state).toBe('Normal');
    expect(result.reason).toBe('clean_pass_after_elevated');
  });

  test('rollback mode still enforces Cooldown for a hard challenge', () => {
    const result = results.rollback;
    expect(result.state).toBe('Cooldown');
    expect(result.reason).toBe('hard_challenge_signal');
  });

  test('malformed and invalid existing state fail closed', () => {
    expect(results.malformed_state).toBe('Cooldown');
    expect(results.invalid_state).toBe('Cooldown');
    expect(results.deleted_state).toBe('Cooldown');
    expect(results.rewritten_state).toBe('Cooldown');
  });

  test('cookie-health challenge persists Cooldown telemetry', () => {
    expect(results.cookie_challenge).toEqual(expect.objectContaining({
      state: 'Cooldown',
      reason: 'cookie_health_challenged',
      run_id: 'test-run',
    }));
  });

  test('same-URL DOM and response status indicators detect challenges', () => {
    expect(results.same_url_dom).toContain('challenge DOM');
    expect(results.same_url_status).toContain('HTTP 429');
    expect(results.clean_page).toEqual([]);
  });

  test('exporter records and terminates the first hard block in rollback mode', () => {
    expect(results.rollback_exporter_stop).toEqual({
      status: false,
      searches: 1,
      failed: ['coin-term'],
      risk_state: 'Cooldown',
    });
    expect(results.challenge_cooldown_before_progress_failure).toBe('Cooldown');
    expect(results.challenge_state_write_failure).toEqual({
      status: false,
      searches: 1,
    });
  });

  test('exporter entrypoints block persisted Cooldown and preserve guarded recovery', () => {
    const guard = results.exporter_entrypoint_guard;
    expect(guard.normal_run.allowed).toBe(true);
    expect(guard.elevated_unbounded_run.allowed).toBe(false);
    expect(guard.elevated_bounded_run.allowed).toBe(true);
    expect(guard.elevated_early_bounded_run.allowed).toBe(false);
    expect(results.elevated_repeated_run.allowed).toBe(false);
    expect(results.elevated_repeated_run.message).toMatch(/between passes/);
    expect(guard.challenged_run.allowed).toBe(false);
    expect(guard.cooldown_run.allowed).toBe(false);
    expect(guard.active_cooldown_login.allowed).toBe(false);
    expect(guard.elapsed_cooldown_login).toEqual({
      allowed: true,
      state_after: 'Cooldown',
    });
    expect(guard.elapsed_cooldown_run.allowed).toBe(false);
    expect(guard.elapsed_cooldown_run.state_after).toBe('Cooldown');
  });

  test('concurrent Elevated exporter starts allow only one reservation', () => {
    expect(results.concurrent_elevated_runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ returncode: 0, stdout: 'allowed' }),
    ]));
    expect(results.concurrent_elevated_allowed_count).toBe(1);
    const refused = results.concurrent_elevated_runs.filter(result => result.stdout !== 'allowed');
    expect(refused).toHaveLength(1);
    expect(refused[0].stdout).toMatch(/between passes/);
  });

  test('direct --run CLI exits before collection while persisted Cooldown is active', () => {
    expect(results.direct_cli_cooldown_run.exit_code).toBe(2);
    expect(results.direct_cli_cooldown_run.message).toMatch(/collection is blocked/);
  });

  test('direct --run rejects alternate caller-selected risk-state paths', () => {
    expect(results.direct_cli_spoofed_state_path.exit_code).toBe(2);
    expect(results.direct_cli_spoofed_state_path.message).toMatch(/does not match the machine-specific risk-state file/);
  });

  test('direct --login refuses an unverified authenticated display', () => {
    expect(results.direct_cli_unverified_display_login.exit_code).toBe(2);
    expect(results.direct_cli_unverified_display_login.message).toMatch(/Authenticated VNC display is not verified/);
  });

  test('direct exporter action refuses a concurrent per-machine run', () => {
    expect(results.direct_cli_parallel_run.exit_code).toBe(2);
    expect(results.direct_cli_parallel_run.message).toMatch(/Another Terapeak exporter action is active/);
  });

  test('Elevated action-lock conflict does not reserve the next pacing interval', () => {
    expect(results.elevated_action_lock_conflict.exit_code).toBe(2);
    expect(results.elevated_action_lock_conflict.message).toMatch(/Another Terapeak exporter action is active/);
    expect(results.elevated_action_lock_conflict.reserved).toBe(false);
  });
});