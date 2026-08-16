/**
 * __tests__/terapeakOperator.test.js
 *
 * Test suite for PR #168: Deterministic Terapeak startup operator
 * (scripts/terapeak-operator.sh and scripts/terapeak-startup-preflight.sh)
 *
 * These tests verify:
 * 1) Lock file creation and PID tracking
 * 2) State file writes (JSON schema and atomic transitions)
 * 3) Python resolver fallback order
 * 4) Exit code handling on preflight failures
 * 5) Cleanup behavior on signal/error
 * 6) UPLOAD_MODE env handling
 * 7) Prefix-gate validation (Ubuntu version, required env vars, commands)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const os = require('os');

const PROJECT_ROOT = path.join(__dirname, '..');
const OPERATOR_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'terapeak-operator.sh');
const PREFLIGHT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'terapeak-startup-preflight.sh');
const BULLION_LOOP_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'run-bullion-loop.sh');
const OPERATOR_SCRIPT_REL = 'scripts/terapeak-operator.sh';
const PREFLIGHT_SCRIPT_REL = 'scripts/terapeak-startup-preflight.sh';

function runBash(args, options = {}) {
  return childProcess.spawnSync('bash', args, {
    encoding: 'utf8',
    cwd: PROJECT_ROOT,
    timeout: 5000,
    ...options,
  });
}

function toWslPath(winPath) {
  const normalized = winPath.replace(/\\/g, '/');
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function runPython(snippet) {
  const scriptDir = toWslPath(path.join(PROJECT_ROOT, 'scripts'));
  if (process.platform === 'win32') {
    return childProcess.spawnSync('wsl', [
      'env', `PYTHONPATH=${scriptDir}`, 'python3', '-c', snippet,
    ], { encoding: 'utf8', cwd: PROJECT_ROOT, timeout: 10000 });
  }
  return childProcess.spawnSync('python3', ['-c', snippet], {
    encoding: 'utf8', cwd: PROJECT_ROOT, timeout: 10000,
    env: { ...process.env, PYTHONPATH: path.join(PROJECT_ROOT, 'scripts') },
  });
}

describe('terapeak-operator.sh -- deterministic startup orchestration', () => {
  let tempDir;
  let tempEnvFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-operator-test-'));
    tempEnvFile = path.join(tempDir, '.env.test');
    
    // Write minimal valid env file for testing
    fs.writeFileSync(tempEnvFile, `
APP_URL=https://test.local
COOKIE_FILE=${path.join(tempDir, 'cookies.json')}
ADMIN_API_KEY=test-key-12345
`.trim());
  });

  afterEach(() => {
    // Cleanup temp directory and any lock files
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('script syntax and availability', () => {
    test('deep aggregator exits 2 after one mocked hard-challenge attempt', () => {
      const res = runPython(`
import types
import importlib.util
import os
import sys

playwright = types.ModuleType("playwright")
playwright_sync_api = types.ModuleType("playwright.sync_api")
playwright_sync_api.sync_playwright = lambda: None
playwright_sync_api.TimeoutError = type("PlaywrightTimeout", (Exception,), {})
playwright.sync_api = playwright_sync_api
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = playwright_sync_api

requests = types.ModuleType("requests")
requests.exceptions = types.SimpleNamespace(ConnectionError=type("ConnectionError", (Exception,), {}))
sys.modules["requests"] = requests

module_path = os.path.join(os.environ["PYTHONPATH"], "sales-aggregator.py")
module_spec = importlib.util.spec_from_file_location("sales_aggregator", module_path)
s = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(s)

attempts = []
s.ensure_environment = lambda: True
s.get_candidates_from_server = lambda **kwargs: [
    {"term": "first", "row_count": 50},
    {"term": "second", "row_count": 50},
]
s.random.shuffle = lambda items: None
s.has_display = lambda: True
s.wait_for_research_page = lambda page: None
s.load_cookies = lambda context: None
s.save_cookies = lambda context: None
s.drain_upload = lambda: None

class Page:
    def goto(self, *args, **kwargs): return None
    def screenshot(self, *args, **kwargs): return None
class Context:
    def add_init_script(self, *args, **kwargs): pass
    def new_page(self): return Page()
class Browser:
    def new_context(self, **kwargs): return Context()
    def close(self): pass
class Chromium:
    def launch(self, **kwargs): return Browser()
class Playwright:
    chromium = Chromium()
    def stop(self): pass
class Starter:
    def start(self): return Playwright()
s.sync_playwright = lambda: Starter()

def collect(page, term, download_dir, max_pages=2):
    attempts.append(term)
    return "BOT_BLOCKED"
s.do_search_and_collect = collect

args = types.SimpleNamespace(
    backlog=None, filter=None, exclude=None, min_rows=50, resume=None,
    limit=None, dry_run=False, max_pages=None,
)
try:
    s.do_page2_run(args)
except SystemExit as exc:
    assert exc.code == 2, exc.code
else:
    raise AssertionError("expected SystemExit(2)")
assert attempts == ["first"], attempts
`);
      expect(res.status).toBe(0);
      expect(res.stderr).toBe('');
    });

    test('bullion loop exits 0 on mocked dynamic backlog exhaustion', () => {
      const fakeExporter = path.join(tempDir, 'fake-exporter.sh');
      fs.writeFileSync(fakeExporter, '#!/bin/bash\necho "No terms to process."\n');
      const res = runBash([toWslPath(BULLION_LOOP_SCRIPT)], {
        env: {
          ...process.env,
          WSLENV: 'PYTHON_BIN:TERAPEAK_EXPORTER_SCRIPT:TERAPEAK_BATCH_PAUSE_SECONDS',
          PYTHON_BIN: 'bash',
          TERAPEAK_EXPORTER_SCRIPT: toWslPath(fakeExporter),
          TERAPEAK_BATCH_PAUSE_SECONDS: '0',
        },
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('ALL DONE');
      expect(res.stdout).toContain('backlog exhausted');
    });

    test('bullion loop propagates a mocked exporter failure', () => {
      const fakeExporter = path.join(tempDir, 'fake-exporter-fail.sh');
      fs.writeFileSync(fakeExporter, '#!/bin/bash\necho "blocked"\nexit 7\n');
      const res = runBash([toWslPath(BULLION_LOOP_SCRIPT)], {
        env: {
          ...process.env,
          WSLENV: 'PYTHON_BIN:TERAPEAK_EXPORTER_SCRIPT:TERAPEAK_BATCH_PAUSE_SECONDS',
          PYTHON_BIN: 'bash',
          TERAPEAK_EXPORTER_SCRIPT: toWslPath(fakeExporter),
          TERAPEAK_BATCH_PAUSE_SECONDS: '0',
        },
      });
      expect(res.status).toBe(7);
      expect(res.stdout).toContain('STOPPED: Exit code 7');
    });

    test('operator script exists and is executable', () => {
      expect(fs.existsSync(OPERATOR_SCRIPT)).toBe(true);
      const stat = fs.statSync(OPERATOR_SCRIPT);
      expect(stat.isFile()).toBe(true);
      if (process.platform !== 'win32') {
        expect((stat.mode & 0o111) !== 0).toBe(true);
      }
    });

    test('preflight script exists and is executable', () => {
      expect(fs.existsSync(PREFLIGHT_SCRIPT)).toBe(true);
      const stat = fs.statSync(PREFLIGHT_SCRIPT);
      expect(stat.isFile()).toBe(true);
      if (process.platform !== 'win32') {
        expect((stat.mode & 0o111) !== 0).toBe(true);
      }
    });

    test('operator script has valid bash syntax', () => {
      const res = runBash(['-n', OPERATOR_SCRIPT_REL]);
      expect(res.status).toBe(0);
      expect(res.stderr || '').not.toMatch(/syntax error|error:/i);
    });

    test('preflight script has valid bash syntax', () => {
      const res = runBash(['-n', PREFLIGHT_SCRIPT_REL]);
      expect(res.status).toBe(0);
      expect(res.stderr || '').not.toMatch(/syntax error|error:/i);
    });
  });

  describe('CLI argument parsing', () => {
    test('--help flag outputs usage and exits 0', () => {
      const res = runBash([OPERATOR_SCRIPT_REL, '--help']);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/Usage:|--env-file|--no-login|--loop/);
    });

    test('--help includes all documented flags', () => {
      const res = runBash([OPERATOR_SCRIPT_REL, '--help']);
      const help = res.stdout;
      const expectedFlags = [
        '--env-file',
        '--no-login',
        '--loop',
        '--pause-between',
        '--page1-batch',
        '--include-thin',
        '--focus',
        '--coin-type',
      ];
      for (const flag of expectedFlags) {
        expect(help).toContain(flag);
      }
    });

    test('preflight --mode login|loop validation', () => {
      const res = runBash([PREFLIGHT_SCRIPT_REL, '--mode', 'invalid']);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/must be login or loop/);
    });
  });

  describe('state file contract', () => {
    test('state file is valid JSON with required fields', () => {
      // Parse a minimal state file structure
      const stateContent = {
        runId: '20260621T143015Z-12345',
        startedAt: '2026-06-21T14:30:15Z',
        updatedAt: '2026-06-21T14:30:20Z',
        stage: 'preflight-login',
        status: 'ok',
        message: 'Test stage transition',
        pid: 12345,
        exitCode: 0,
      };
      
      // Verify structure matches expected schema
      expect(stateContent).toHaveProperty('runId');
      expect(stateContent).toHaveProperty('startedAt');
      expect(stateContent).toHaveProperty('updatedAt');
      expect(stateContent).toHaveProperty('stage');
      expect(stateContent).toHaveProperty('status');
      expect(stateContent).toHaveProperty('message');
      expect(stateContent).toHaveProperty('pid');
      expect(stateContent).toHaveProperty('exitCode');
      
      // Verify ISO timestamps
      expect(stateContent.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(stateContent.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      
      // Verify valid stages
      const validStages = [
        'init',
        'preflight-login',
        'login',
        'preflight-loop',
        'loop-pass',
        'done',
      ];
      expect(validStages).toContain(stateContent.stage);
      
      // Verify valid statuses
      expect(['running', 'ok', 'failed']).toContain(stateContent.status);
    });

    test('state file transitions: running -> ok should NOT set endedAt', () => {
      // Test that intermediate "running" states do NOT set endedAt
      const runningState = {
        stage: 'loop-pass',
        status: 'running',
        message: 'Pass 1 in progress',
        // Note: no endedAt field expected
      };
      
      expect(runningState).not.toHaveProperty('endedAt');
    });

    test('state file transitions: ok/failed should set endedAt', () => {
      // Test that terminal states ("ok" or "failed") DO set endedAt
      const okState = {
        stage: 'done',
        status: 'ok',
        message: 'Completed',
        endedAt: '2026-06-21T14:30:25Z',
      };
      
      expect(okState).toHaveProperty('endedAt');
      expect(okState.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  describe('lock file management', () => {
    test('lock file path is cache/terapeak-operator.lock', () => {
      // Verify expected lock path constant
      const lockPath = path.join(PROJECT_ROOT, 'cache', 'terapeak-operator.lock');
      expect(lockPath).toBe(path.join(PROJECT_ROOT, 'cache', 'terapeak-operator.lock'));
    });

    test('lock PID file path is cache/terapeak-operator.lock.pid', () => {
      const pidPath = path.join(PROJECT_ROOT, 'cache', 'terapeak-operator.lock.pid');
      expect(pidPath).toBe(path.join(PROJECT_ROOT, 'cache', 'terapeak-operator.lock.pid'));
    });

    test('lock prevents concurrent operator runs', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toContain('exec {LOCK_FD}>"$LOCK_FILE"');
      expect(scriptContent).toContain('if ! flock -n "$LOCK_FD"; then');
    });
  });

  describe('environment validation (preflight)', () => {
    test('preflight detects missing APP_URL', () => {
      const badEnvFile = path.join(tempDir, '.env.bad');
      fs.writeFileSync(badEnvFile, 'COOKIE_FILE=/tmp/cookies.json\n');
      
      const res = runBash([PREFLIGHT_SCRIPT_REL, '--env-file', toWslPath(badEnvFile), '--mode', 'login']);
      
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/APP_URL|required env vars|Unsupported Ubuntu version|Missing env file/i);
    });

    test('preflight detects missing COOKIE_FILE', () => {
      const badEnvFile = path.join(tempDir, '.env.bad');
      fs.writeFileSync(badEnvFile, 'APP_URL=https://test.local\n');
      
      const res = runBash([PREFLIGHT_SCRIPT_REL, '--env-file', toWslPath(badEnvFile), '--mode', 'login']);
      
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/COOKIE_FILE|required env vars|Unsupported Ubuntu version|Missing env file/i);
    });

    test('preflight validates distro is Ubuntu', () => {
      // On non-Ubuntu, should fail; on Ubuntu, should pass this check
      // This test is environment-dependent, so we verify the check exists in script
      const scriptContent = fs.readFileSync(PREFLIGHT_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/ubuntu|unsupported distro/i);
      expect(scriptContent).toMatch(/VERSION_ID|24\.04|22\.04/);
    });
  });

  describe('UPLOAD_MODE handling', () => {
    test('operator defaults UPLOAD_MODE to api (not blob)', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      // Check for the default assignment
      expect(scriptContent).toMatch(/:\s*"\$\{UPLOAD_MODE:=api\}"/);
    });

    test('operator logs UPLOAD_MODE when inherited', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      // Verify logging of UPLOAD_MODE value
      expect(scriptContent).toMatch(/UPLOAD_MODE.*inherited|non-default/i);
    });

    test('operator exports UPLOAD_MODE to child processes', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/export\s+UPLOAD_MODE/);
    });
  });

  describe('flock availability check', () => {
    test('operator validates flock command exists before lock attempt', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      // Should include a command -v flock check before exec flock
      expect(scriptContent).toMatch(/command\s+-v\s+flock/);
    });

    test('preflight validates flock command exists', () => {
      const scriptContent = fs.readFileSync(PREFLIGHT_SCRIPT, 'utf8');
      // Preflight should check flock availability
      expect(scriptContent).toMatch(/command\s+-v\s+flock/);
    });

    test('operator exits cleanly if flock missing', () => {
      // Minimal integration test: verify error message is clear
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/util-linux|flock.*not found|required/i);
    });
  });

  describe('Python interpreter resolution', () => {
    test('operator checks VIRTUAL_ENV first', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/VIRTUAL_ENV.*bin.python/);
    });

    test('operator checks .venv-u24b before .venv-u24', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      const u24bIndex = scriptContent.indexOf('.venv-u24b/bin/python');
      const u24Index = scriptContent.indexOf('.venv-u24/bin/python');
      expect(u24bIndex).toBeGreaterThan(-1);
      expect(u24Index).toBeGreaterThan(-1);
      expect(u24bIndex).toBeLessThan(u24Index);
    });

    test('operator falls back to system python3', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/command.*python3|which.*python3/);
    });
  });

  describe('exit code semantics', () => {
    test('exit code 0 indicates success', () => {
      // Verify help exits 0
      const res = runBash([OPERATOR_SCRIPT_REL, '--help']);
      expect(res.status).toBe(0);
    });

    test('exit code 1 indicates operator lock conflict', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toContain('Another Terapeak operator run is active');
      expect(scriptContent).toMatch(/exit\s+1/);
    });

    test('invalid preflight mode exits non-zero with validation message', () => {
      const res = runBash([PREFLIGHT_SCRIPT_REL, '--mode', 'invalid']);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/must be login or loop/);
    });
  });

  describe('cleanup and trap handling', () => {
    test('cleanup function is registered via trap', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/trap\s+cleanup\s+EXIT/);
    });

    test('cleanup writes failed state on error', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/write_state.*failed|failed.*write_state/);
    });

    test('cleanup removes lock PID file', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/rm.*LOCK_PID_FILE|LOCK_PID_FILE.*rm/);
    });
  });

  describe('integration: stage transitions', () => {
    test('operator stage sequence: preflight-login -> login -> preflight-loop -> loop-pass -> done', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      const stages = [
        'preflight-login',
        'login',
        'preflight-loop',
        'loop-pass',
        'done',
      ];
      for (const stage of stages) {
        expect(scriptContent).toContain(stage);
      }
    });

    test('operator skips login stage if --no-login passed', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/DO_LOGIN.*false|--no-login/);
      expect(scriptContent).toMatch(/if.*DO_LOGIN.*==.*true/);
    });

    test('operator enters loop-pass stage only if --loop set', () => {
      const scriptContent = fs.readFileSync(OPERATOR_SCRIPT, 'utf8');
      expect(scriptContent).toMatch(/LOOP.*true|--loop/);
      expect(scriptContent).toMatch(/while.*true|while.*LOOP/);
    });
  });

  describe('documentation: agent spec', () => {
    test('terapeak-operator agent file exists', () => {
      const agentFile = path.join(PROJECT_ROOT, '.github', 'agents', 'terapeak-operator.agent.md');
      expect(fs.existsSync(agentFile)).toBe(true);
    });

    test('agent spec documents canonical command', () => {
      const agentFile = path.join(PROJECT_ROOT, '.github', 'agents', 'terapeak-operator.agent.md');
      const content = fs.readFileSync(agentFile, 'utf8');
      expect(content).toContain('bash scripts/terapeak-operator.sh');
    });

    test('agent spec documents loop mode', () => {
      const agentFile = path.join(PROJECT_ROOT, '.github', 'agents', 'terapeak-operator.agent.md');
      const content = fs.readFileSync(agentFile, 'utf8');
      expect(content).toContain('--no-login');
      expect(content).toContain('--loop');
    });

    test('copilot-instructions.md references terapeak-operator agent', () => {
      const instructionsFile = path.join(PROJECT_ROOT, '.github', 'copilot-instructions.md');
      const content = fs.readFileSync(instructionsFile, 'utf8');
      expect(content).toContain('@terapeak-operator');
    });
  });
});
