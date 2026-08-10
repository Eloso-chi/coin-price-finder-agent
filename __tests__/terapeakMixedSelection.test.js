'use strict';

const childProcess = require('child_process');
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
import sys
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

print(json.dumps({
  "empty": exporter.mixed_selection_targets(15, 17, 0),
  "partial": exporter.mixed_selection_targets(15, 17, 3),
  "full": exporter.mixed_selection_targets(15, 17, 20),
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

describe('Terapeak mixed P0.1 selection', () => {
  test('backfills unused P0.1 slots to preserve the total target', () => {
    const result = runHarness();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      empty: [0, 32, 32],
      partial: [3, 29, 32],
      full: [15, 17, 32],
    });
  });
});