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
import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import types
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
  }
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
    });
  });
});