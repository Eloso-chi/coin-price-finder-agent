'use strict';

const childProcess = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const PARSER = path.join(PROJECT_ROOT, 'scripts', '_parse-terapeak-pass.py');
const VALIDATOR = path.join(PROJECT_ROOT, 'scripts', 'validate-pass-telemetry.py');

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function runTelemetryHarness() {
  const parserPath = process.platform === 'win32' ? toWslPath(PARSER) : PARSER;
  const validatorPath = process.platform === 'win32' ? toWslPath(VALIDATOR) : VALIDATOR;
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
    parser_spec = importlib.util.spec_from_file_location("pass_parser", ${JSON.stringify(parserPath)})
    pass_parser = importlib.util.module_from_spec(parser_spec)
    parser_spec.loader.exec_module(pass_parser)
    validator_spec = importlib.util.spec_from_file_location("telemetry_validator", ${JSON.stringify(validatorPath)})
    validator = importlib.util.module_from_spec(validator_spec)
    validator_spec.loader.exec_module(validator)

    first_log = pathlib.Path(temp_dir) / "pass.log"
    first_summary = pathlib.Path(temp_dir) / "pass-summary.json"
    first_log.write_text("\\n".join([
        "Exporting 2 coins...",
        "  [ 50%] 2024 Silver Eagle... OK (3 new, 2 dups)",
        "  [100%] 2023 Silver Eagle... WARNING: No data rows found",
        "NO EXPORT",
        "  Succeeded: 1",
        "  Failed: 0",
    ]), encoding="utf-8")
    with contextlib.redirect_stdout(io.StringIO()):
        first_status = pass_parser.main([
            "--pass-log", str(first_log), "--run-id", "run-284H",
            "--pass-num", "4", "--batch-size", "2",
            "--start-ts", "2026-07-29T10:00:00Z",
            "--end-ts", "2026-07-29T10:01:30Z", "--machine", "H",
            "--operator", "terapeak-operator", "--cookie-health-status", "HEALTHY",
            "--state-before", "Normal", "--state-after", "Normal",
            "--summary-output", str(first_summary),
        ])

    blocked_log = pathlib.Path(temp_dir) / "blocked.log"
    blocked_log.write_text("We've detected unusual activity from your computer network.\\nHTTP 403", encoding="utf-8")
    blocked_state = pathlib.Path(temp_dir) / "risk-state.json"
    blocked_transition = pathlib.Path(temp_dir) / "risk-transition.tsv"
    with contextlib.redirect_stdout(io.StringIO()):
        blocked_status = pass_parser.main([
            "--pass-log", str(blocked_log), "--run-id", "blocked-run",
            "--pass-num", "1", "--batch-size", "30", "--pass-exit-code", "1",
        "--state-file", str(blocked_state),
        "--transition-output", str(blocked_transition),
        ])

    async_log = pathlib.Path(temp_dir) / "async.log"
    async_summary = pathlib.Path(temp_dir) / "async-summary.json"
    async_log.write_text("\\n".join([
        "Exporting 4 coins...",
        "  [ 25%] Coin A... SAVED (upload pending)",
        "  [ 50%] Coin B...   [async upload] Coin A: OK (3 new, 2 dups)",
        "SAVED (upload pending)",
        "  [ 75%] Coin C...   [async upload] Coin B: failed -- Cannot connect",
        "WARNING: No data rows found",
        "NO EXPORT (no results or button not found)",
        "  [100%] Coin D... BOT BLOCKED",
        "BOT BLOCKED",
        "  Succeeded: 1",
        "  Failed: 3",
    ]), encoding="utf-8")
    with contextlib.redirect_stdout(io.StringIO()):
        async_status = pass_parser.main([
            "--pass-log", str(async_log), "--run-id", "async-run",
            "--pass-num", "1", "--batch-size", "4",
            "--summary-output", str(async_summary),
        ])

    records = [json.loads(line) for line in pathlib.Path(pass_parser.PASSES_PATH).read_text(encoding="utf-8").splitlines()]
    valid_record = {
        "run_id": "run-1", "pass_id": 1,
        "started_at": "2026-07-29T10:00:00Z", "ended_at": "2026-07-29T10:01:00Z", "duration_sec": 60,
        "batch_size_requested": 1, "batch_size_executed": 1,
        "new_count": 1, "dup_count": 0, "no_data_count": 0, "no_export_count": 0,
        "cookie_health_status": "HEALTHY", "probe_status": "SKIPPED", "challenge_signal_count": 0,
        "state_before": "Normal", "state_after": "Normal", "transition_reason": None,
    }
    telemetry = pathlib.Path(temp_dir) / "validate.jsonl"
    telemetry.write_text(json.dumps(valid_record) + "\\n", encoding="utf-8")
    valid_failures = validator.validate_files([str(telemetry)])
    telemetry.write_text(telemetry.read_text(encoding="utf-8") + '{"run_id":"incomplete"}\\n', encoding="utf-8")
    empty_telemetry = pathlib.Path(temp_dir) / "empty.jsonl"
    empty_telemetry.write_text("", encoding="utf-8")
    invalid_failures = validator.validate_files([str(telemetry), str(empty_telemetry)])

    print(json.dumps({
        "first_status": first_status,
        "first_summary": json.loads(first_summary.read_text(encoding="utf-8")),
        "blocked_status": blocked_status,
        "blocked_transition": blocked_transition.read_text(encoding="utf-8").strip().split("\t"),
        "async_status": async_status,
        "async_summary": json.loads(async_summary.read_text(encoding="utf-8")),
        "records": records,
        "valid_failures": valid_failures,
        "invalid_failures": invalid_failures,
    }))
`;
  if (process.platform === 'win32') {
    const scriptDir = toWslPath(path.join(PROJECT_ROOT, 'scripts'));
    return childProcess.spawnSync('wsl', [
      'env', `PYTHONPATH=${scriptDir}`, 'python3', '-c', snippet,
    ], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  }
  return childProcess.spawnSync('python3', ['-c', snippet], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: path.join(PROJECT_ROOT, 'scripts') },
  });
}

describe('#284H pass telemetry contract', () => {
  let harness;

  beforeAll(() => {
    const result = runTelemetryHarness();
    expect(result.status).toBe(0);
    harness = JSON.parse(result.stdout);
  });

  test('emits required pass fields while retaining legacy report fields', () => {
    expect(harness.first_status).toBe(0);
    const record = harness.records[0];
    expect(record).toEqual(expect.objectContaining({
      run_id: 'run-284H',
      pass_id: 4,
      started_at: '2026-07-29T10:00:00Z',
      ended_at: '2026-07-29T10:01:30Z',
      duration_sec: 90,
      batch_size_requested: 2,
      batch_size_executed: 2,
      new_count: 3,
      dup_count: 2,
      no_data_count: 1,
      no_export_count: 1,
      cookie_health_status: 'HEALTHY',
      probe_status: 'SKIPPED',
      challenge_signal_count: 0,
      state_before: 'Normal',
      state_after: 'Normal',
      transition_reason: null,
      pass: 4,
      new_rows: 3,
      dup_rows: 2,
    }));
    expect(harness.first_summary.pass).toEqual(record);
    expect(harness.first_summary.coins).toHaveLength(2);
  });

  test('counts challenge evidence and records a failed transition', () => {
    expect(harness.blocked_status).toBe(0);
    const record = harness.records[1];
    expect(record.challenge_signal_count).toBe(2);
    expect(record.pass_exit_code).toBe(1);
    expect(record.state_before).toBe('Normal');
    expect(record.state_after).toBe('Cooldown');
    expect(record.transition_reason).toBe('hard_challenge_signal');
    expect(harness.blocked_transition).toEqual([
      'Normal', 'Cooldown', 'hard_challenge_signal', '2', '0',
    ]);
  });

  test('attributes interleaved async results and hard challenges to the correct coins', () => {
    expect(harness.async_status).toBe(0);
    expect(harness.async_summary.pass).toEqual(expect.objectContaining({
      attempted: 4,
      succeeded: 1,
      empty: 1,
      failed: 2,
      unknown: 0,
      new_rows: 3,
      dup_rows: 2,
      succeeded_reported: 1,
      failed_reported: 3,
    }));
    expect(harness.async_summary.coins).toEqual([
      expect.objectContaining({ coin: 'Coin A', status: 'ok', new: 3, dups: 2 }),
      expect.objectContaining({ coin: 'Coin B', status: 'failed', error: 'Cannot connect' }),
      expect.objectContaining({ coin: 'Coin C', status: 'empty' }),
      expect.objectContaining({ coin: 'Coin D', status: 'failed', error: 'BOT BLOCKED' }),
    ]);
  });

  test('validator reports valid and malformed records in machine-readable form', () => {
    expect(harness.valid_failures).toEqual([]);
    expect(harness.invalid_failures).toHaveLength(2);
    expect(harness.invalid_failures[0].errors).toContain('missing field: pass_id');
    expect(harness.invalid_failures[1].errors).toContain('empty telemetry file');
  });
});