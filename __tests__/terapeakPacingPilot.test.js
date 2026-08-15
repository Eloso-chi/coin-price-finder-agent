'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPT_DIR = path.join(PROJECT_ROOT, 'scripts');
const ANALYZER = path.join(SCRIPT_DIR, 'analyze-pacing-pilot.py');
const VALIDATOR = path.join(SCRIPT_DIR, 'validate-pass-telemetry.py');

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function runPython(snippet) {
  const command = process.platform === 'win32' ? 'wsl' : 'python3';
  const args = process.platform === 'win32'
    ? ['env', `PYTHONPATH=${SCRIPT_DIR.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)}`, 'python3', '-c', snippet]
    : ['-c', snippet];
  return childProcess.spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: SCRIPT_DIR },
  });
}

describe('#280H pacing profile policy', () => {
  test('defaults to baseline and scales only Normal tuned runs', () => {
    const result = runPython(`
import json
from _terapeak_pacing import effective_profile, requested_profile, scale_range

print(json.dumps({
  "default": requested_profile({}),
  "normal": effective_profile("normal-tuned", "Normal"),
  "elevated": effective_profile("normal-tuned", "Elevated"),
  "cooldown": effective_profile("normal-tuned", "Cooldown"),
  "baseline_range": scale_range((5, 12), "baseline"),
  "tuned_range": scale_range((5, 12), "normal-tuned"),
}))
`);

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      default: 'baseline',
      normal: 'normal-tuned',
      elevated: 'baseline',
      cooldown: 'baseline',
      baseline_range: [5, 12],
      tuned_range: [4, 9.600000000000001],
    });
  });

  test('rejects unknown profiles instead of silently changing pacing', () => {
    const result = runPython(`
from _terapeak_pacing import validate_profile
validate_profile("fast")
`);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid Terapeak pacing profile');
  });

  test('analyzer compares Normal passes and requires six passes per arm', () => {
    const analyzerPath = process.platform === 'win32' ? toWslPath(ANALYZER) : ANALYZER;
    const result = runPython(`
import importlib.util
import json

spec = importlib.util.spec_from_file_location("pacing_analyzer", ${JSON.stringify(analyzerPath)})
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)

records = []
for index, profile in enumerate(analyzer.EXPECTED_SEQUENCE):
    tuned = profile == "normal-tuned"
    records.append({
        "run_id": f"run-{index}", "pacing_pilot_id": "pilot-1",
        "pacing_profile_requested": profile, "pacing_profile_effective": profile,
        "state_before": "Normal", "state_after": "Normal",
        "machine": "H", "operator": "terapeak-operator", "include_thin": False,
        "pacing_batch_min": 30, "pacing_batch_max": 35,
        "pacing_p01_fixed": 15, "pacing_upload_mode": "blob",
        "attempted": 10, "succeeded": 10 if tuned else 9,
        "failed": 0 if tuned else 1, "empty": 0, "unknown": 0,
        "duration_sec": 480 if tuned else 600,
        "challenge_signal_count": 0, "no_export_count": 0,
    })
print(json.dumps(analyzer.summarize(records, "pilot-1")))
`);

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({
      baseline: expect.objectContaining({
        passes: 6,
        attempts: 60,
        seconds_per_attempt: 60,
        success_rate: 0.9,
        failure_rate: 0.1,
        normal_to_elevated_rate: 0,
        normal_to_cooldown_rate: 0,
      }),
      'normal-tuned': expect.objectContaining({
        passes: 6,
        attempts: 60,
        seconds_per_attempt: 48,
        success_rate: 1,
        failure_rate: 0,
        normal_to_elevated_rate: 0,
        normal_to_cooldown_rate: 0,
      }),
      speed_improvement_pct: 20,
      ready: true,
      sequence_valid: true,
      hard_challenge: false,
      recommendation: 'adopt',
    }));
  });

  test('analyzer rejects incomplete data and hard challenges', () => {
    const analyzerPath = process.platform === 'win32' ? toWslPath(ANALYZER) : ANALYZER;
    const result = runPython(`
import importlib.util
import json

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

analyzer = load("pacing_analyzer", ${JSON.stringify(analyzerPath)})
records = []
for index, profile in enumerate(analyzer.EXPECTED_SEQUENCE):
  records.append({
    "run_id": f"run-{index}", "pacing_pilot_id": "pilot-2",
    "pacing_profile_requested": profile, "pacing_profile_effective": profile,
    "state_before": "Normal", "state_after": "Cooldown" if index == 1 else "Normal",
    "machine": "H", "operator": "terapeak-operator", "include_thin": False,
    "pacing_batch_min": 30, "pacing_batch_max": 35,
    "pacing_p01_fixed": 15, "pacing_upload_mode": "blob",
    "attempted": 10, "succeeded": 10, "failed": 0, "empty": 0, "unknown": 0,
    "duration_sec": 500, "challenge_signal_count": 1 if index == 1 else 0,
    "no_export_count": 0,
  })
incomplete = [dict(row) for row in records]
incomplete[0]["duration_sec"] = None
mixed = [dict(row) for row in records]
mixed[-1]["pacing_upload_mode"] = "api"
elevated_extra = [dict(row) for row in records]
elevated_extra.insert(1, dict(records[0], run_id="elevated-extra", state_before="Elevated"))
non_finite = [dict(row) for row in records]
non_finite[0]["duration_sec"] = float("nan")
non_finite_batch = [dict(row) for row in records]
non_finite_batch[0]["pacing_batch_min"] = float("inf")
many_invalid = [dict(records[0], run_id=f"bad-{index}", duration_sec=None) for index in range(25)]
print(json.dumps({
  "challenged": analyzer.summarize(records, "pilot-2"),
  "incomplete": analyzer.summarize(incomplete, "pilot-2"),
  "mixed": analyzer.summarize(mixed, "pilot-2"),
  "elevated_extra": analyzer.summarize(elevated_extra, "pilot-2"),
  "non_finite": analyzer.summarize(non_finite, "pilot-2"),
  "non_finite_batch": analyzer.summarize(non_finite_batch, "pilot-2"),
  "many_invalid": analyzer.summarize(many_invalid, "pilot-2"),
}))
`);

  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  const parsed = JSON.parse(result.stdout);
  expect(parsed.challenged).toEqual(expect.objectContaining({
    ready: true,
    hard_challenge: true,
    recommendation: 'reject',
  }));
  expect(parsed.challenged['normal-tuned'].normal_to_cooldown_rate).toBeCloseTo(1 / 6, 4);
  expect(parsed.incomplete.ready).toBe(false);
  expect(parsed.incomplete.recommendation).toBe('insufficient-data');
  expect(parsed.incomplete.validation_errors).toContain('run-0: missing/invalid duration_sec');
    expect(parsed.mixed.ready).toBe(false);
    expect(parsed.mixed.comparability_errors).toEqual([
      "mixed pacing_upload_mode: ['api', 'blob']",
    ]);
    expect(parsed.elevated_extra.ready).toBe(false);
    expect(parsed.elevated_extra.validation_errors).toContain(
      'elevated-extra: scoped pilot pass must start in Normal'
    );
    expect(parsed.non_finite.ready).toBe(false);
    expect(parsed.non_finite.validation_errors).toContain('run-0: non-finite duration_sec');
    expect(parsed.non_finite_batch.ready).toBe(false);
    expect(parsed.non_finite_batch.validation_errors).toContain('run-0: missing/invalid pacing_batch_min');
    expect(parsed.many_invalid.validation_errors).toHaveLength(20);
  });

  test('validator preserves legacy rows and rejects impossible pacing telemetry', () => {
  const validatorPath = process.platform === 'win32' ? toWslPath(VALIDATOR) : VALIDATOR;
  const result = runPython(`
import importlib.util
import json

spec = importlib.util.spec_from_file_location("telemetry_validator", ${JSON.stringify(validatorPath)})
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
base_record = {
    "run_id": "run", "pass_id": 1,
    "started_at": "2026-08-12T00:00:00Z", "ended_at": "2026-08-12T00:01:00Z",
    "duration_sec": 60, "batch_size_requested": 1, "batch_size_executed": 1,
    "new_count": 0, "dup_count": 0, "no_data_count": 0, "no_export_count": 0,
    "cookie_health_status": "HEALTHY", "probe_status": "SKIPPED",
    "challenge_signal_count": 0, "state_before": "Normal", "state_after": "Normal",
    "transition_reason": None,
}
paired = dict(base_record, pacing_profile_requested="baseline", pacing_profile_effective="baseline")
unpaired = dict(base_record, pacing_profile_requested="baseline")
impossible = dict(base_record, pacing_profile_requested="normal-tuned", pacing_profile_effective="normal-tuned", pacing_pilot_id="pilot-1", state_before="Elevated")
missing_id = dict(base_record, pacing_profile_requested="normal-tuned", pacing_profile_effective="baseline")
normal_downgrade = dict(base_record, pacing_profile_requested="normal-tuned", pacing_profile_effective="baseline", pacing_pilot_id="pilot-1")
bad_id = dict(paired, pacing_pilot_id="bad id")
print(json.dumps({
    "legacy_errors": validator.validate_record(base_record),
    "paired_errors": validator.validate_record(paired),
    "unpaired_errors": validator.validate_record(unpaired),
  "impossible_errors": validator.validate_record(impossible),
  "missing_id_errors": validator.validate_record(missing_id),
  "normal_downgrade_errors": validator.validate_record(normal_downgrade),
  "bad_id_errors": validator.validate_record(bad_id),
}))
`);

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      legacy_errors: [],
      paired_errors: [],
      unpaired_errors: ['pacing profile fields must appear together'],
      impossible_errors: ['normal-tuned effective profile requires Normal state and normal-tuned request'],
      missing_id_errors: [
        'Normal-state normal-tuned request must produce normal-tuned effective profile',
        'normal-tuned request requires pacing pilot ID',
      ],
      normal_downgrade_errors: ['Normal-state normal-tuned request must produce normal-tuned effective profile'],
      bad_id_errors: ['invalid pacing pilot ID'],
    });
  });

  test('exporter independently downgrades tuned pacing outside persisted Normal state', () => {
    const exporterPath = process.platform === 'win32'
      ? toWslPath(path.join(SCRIPT_DIR, 'terapeak-export.py'))
      : path.join(SCRIPT_DIR, 'terapeak-export.py');
    const result = runPython(`
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types
from _terapeak_risk import write_state

playwright = types.ModuleType("playwright")
sync_api = types.ModuleType("playwright.sync_api")
sync_api.sync_playwright = lambda: None
sync_api.TimeoutError = TimeoutError
playwright.sync_api = sync_api
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = sync_api
sys.modules["requests"] = types.ModuleType("requests")

def load_exporter(name):
    spec = importlib.util.spec_from_file_location(name, ${JSON.stringify(exporterPath)})
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.EFFECTIVE_PACING_PROFILE

with tempfile.TemporaryDirectory() as temp_dir:
    state_path = pathlib.Path(temp_dir) / "risk.json"
    os.environ["TERAPEAK_EFFECTIVE_PACING_PROFILE"] = "normal-tuned"
    os.environ["TERAPEAK_PACING_PROFILE"] = "normal-tuned"
    os.environ["TERAPEAK_PACING_PILOT_ID"] = "pilot-test"
    os.environ["TERAPEAK_RISK_STATE_FILE"] = str(state_path)
    write_state(state_path, "Normal", "test", "run")
    normal = load_exporter("exporter_normal")
    write_state(state_path, "Elevated", "test", "run")
    elevated = load_exporter("exporter_elevated")
    missing_path = pathlib.Path(temp_dir) / "missing.json"
    os.environ["TERAPEAK_RISK_STATE_FILE"] = str(missing_path)
    nonexistent = load_exporter("exporter_nonexistent")
    del os.environ["TERAPEAK_RISK_STATE_FILE"]
    missing = load_exporter("exporter_missing")
print(json.dumps({"normal": normal, "elevated": elevated, "nonexistent": nonexistent, "missing": missing}))
`);

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      normal: 'normal-tuned',
      elevated: 'baseline',
      nonexistent: 'baseline',
      missing: 'baseline',
    });
  });

  test.each(['terapeak-operator.sh', 'terapeak-operator-codespace.sh'])(
    '%s forces baseline outside Normal and records requested/effective profiles',
    (fileName) => {
      const source = fs.readFileSync(path.join(SCRIPT_DIR, fileName), 'utf8');
      expect(source).toContain('TERAPEAK_PACING_PROFILE:-baseline');
      expect(source).toMatch(/effective_pacing_profile="baseline"|EFFECTIVE_PACING_PROFILE="baseline"/);
      expect(source).toContain('== "Normal"');
      expect(source).toContain('--pacing-profile-requested');
      expect(source).toContain('--pacing-profile-effective');
      expect(source).toContain('TERAPEAK_EFFECTIVE_PACING_PROFILE');
      if (fileName === 'terapeak-operator.sh') {
        expect(source).toContain('--include-thin "$INCLUDE_THIN"');
      }
    }
  );
});