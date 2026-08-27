'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPT_DIR = path.join(PROJECT_ROOT, 'scripts');
const EXPORTER = path.join(SCRIPT_DIR, 'terapeak-export.py');

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

function runHarness() {
  const exporterPath = process.platform === 'win32' ? toWslPath(EXPORTER) : EXPORTER;
  const snippet = `
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
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

def fake_upload(path, term, meta=None):
    time.sleep(0.12)
    return True, "1 new, 0 dups"

exporter.upload_csv = fake_upload
progress = {}
upload_calls = []

def tracked_upload(path, term, meta=None):
  upload_calls.append(term)
  return True, "tracked"

exporter.upload_csv = tracked_upload
exporter.upload_csv_async("deep-0", "deep-0")
exporter.upload_csv_async("deep-1", "deep-1")
deep_final_result = exporter.drain_upload()

with tempfile.NamedTemporaryFile(delete=False) as cleanup_file:
  cleanup_path = cleanup_file.name
exporter.upload_csv_async(cleanup_path, "cleanup", cleanup=True)
exporter.drain_upload()
cleanup_removed = not os.path.exists(cleanup_path)

background_started = threading.Event()
background_release = threading.Event()
def controlled_upload(path, term, meta=None):
  background_started.set()
  background_release.wait(timeout=1)
  return True, "controlled"

exporter.upload_csv = controlled_upload
exporter.upload_csv_async("controlled", "controlled")
started_before_release = background_started.wait(timeout=1)
background_release.set()
controlled_result = exporter.drain_upload()

sequential_start = time.perf_counter()
exporter.upload_csv = fake_upload
for index in range(3):
    time.sleep(0.08)
    fake_upload(str(index), str(index))
sequential_elapsed = time.perf_counter() - sequential_start

pipeline_start = time.perf_counter()
for index in range(3):
    time.sleep(0.08)
    result = exporter.drain_upload()
    exporter._record_upload_result(result, progress)
    exporter.upload_csv_async(str(index), str(index))
final_result = exporter.drain_upload()
exporter._record_upload_result(final_result, progress)
pipeline_elapsed = time.perf_counter() - pipeline_start

reported_no_data = []
exporter._report_no_data = lambda term: reported_no_data.append(term)
failure_counts = exporter._record_upload_result({
  "term": "empty-term",
  "ok": False,
  "msg": "HTTP 422: no valid comps",
}, progress)

class TimeoutThenComplete:
  def __init__(self):
    self.joins = 0

  def join(self, timeout=None):
    self.joins += 1
    if self.joins == 2:
      exporter._last_upload_result["ok"] = True
      exporter._last_upload_result["msg"] = "eventual success"

  def is_alive(self):
    return self.joins < 2

exporter._async_upload_timeouts = 0
exporter._async_upload_disabled = False
for index in range(2):
  exporter._last_upload_result.update({
    "ok": None,
    "msg": None,
    "term": f"slow-{index}",
    "thread": TimeoutThenComplete(),
  })
  exporter.drain_upload(timeout=0.01)
fallback_result = exporter.upload_csv_async("fallback", "fallback")

class NeverCompletes:
  def join(self, timeout=None):
    pass

  def is_alive(self):
    return True

exporter._last_upload_result.update({
  "ok": None,
  "msg": None,
  "term": "stalled",
  "thread": NeverCompletes(),
})
try:
  exporter.drain_upload(timeout=10)
  stalled_raised = False
except exporter.UploadPipelineStalled:
  stalled_raised = True
finally:
  exporter._last_upload_result["thread"] = None

print(json.dumps({
    "completed": progress["completed"],
    "cleanupRemoved": cleanup_removed,
  "controlledResult": controlled_result,
  "deepCalls": upload_calls,
  "deepFinalResult": deep_final_result,
    "fallback": exporter._async_upload_disabled,
  "fallbackResult": fallback_result,
    "failureCounts": failure_counts,
    "pending": exporter._last_upload_result["thread"] is not None,
    "pipeline": pipeline_elapsed,
    "reportedNoData": reported_no_data,
    "sequential": sequential_elapsed,
    "stalledRaised": stalled_raised,
    "startedBeforeRelease": started_before_release,
}))
`;

  if (process.platform === 'win32') {
    return childProcess.spawnSync('wsl', ['python3', '-c', snippet], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
    });
  }
  return childProcess.spawnSync('python3', ['-c', snippet], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
}

describe('#279H page-1 asynchronous upload pipeline', () => {
  test('overlaps upload latency, drains the final result, and falls back after repeated timeouts', () => {
    const result = runHarness();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    const measurements = JSON.parse(result.stdout.trim().split('\n').at(-1));

    expect(measurements.completed).toEqual(['0', '1', '2']);
    expect(measurements.cleanupRemoved).toBe(true);
    expect(measurements.controlledResult).toEqual({ term: 'controlled', ok: true, msg: 'controlled' });
    expect(measurements.deepCalls).toEqual(['deep-0', 'deep-1', 'cleanup']);
    expect(measurements.deepFinalResult).toEqual({ term: 'deep-1', ok: true, msg: 'tracked' });
    expect(measurements.fallback).toBe(true);
    expect(measurements.fallbackResult).toEqual({ term: 'fallback', ok: true, msg: '1 new, 0 dups' });
    expect(measurements.failureCounts).toEqual([0, 0, 1]);
    expect(measurements.pending).toBe(false);
    expect(measurements.reportedNoData).toEqual(['empty-term']);
    expect(measurements.stalledRaised).toBe(true);
    expect(measurements.startedBeforeRelease).toBe(true);
  });

  test('page-1 starts asynchronous uploads and guarantees a final drain', () => {
    const source = fs.readFileSync(EXPORTER, 'utf8');
    const run = source.slice(source.indexOf('def do_export_run(args):'), source.indexOf('\n# ── CLI'));

    expect(run).toContain('prior_result = drain_upload(log_result=False)');
    expect(run).toContain('upload_csv_async(dest, term, aggregation_meta=meta)');
    expect(run).toContain('if not _async_upload_disabled:');
    expect(run).toContain('final_result = drain_upload(log_result=False)');

    expect(source).toContain('connection_timeout=10');
    expect(source).toContain('read_timeout=30');
    expect(source).toContain('retry_total=0');
  });
});