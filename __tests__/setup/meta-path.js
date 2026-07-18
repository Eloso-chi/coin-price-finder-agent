// __tests__/setup/meta-path.js -- #273H jest worker isolation for terapeak-meta.json
//
// Why this exists
// ---------------
// The terapeak service writes a debounced sidecar at data/terapeak-meta.json.
// When jest runs multiple workers in parallel, several suites trigger that
// write path (directly via importComps, or by spawning generate-freshness-report.js
// as a subprocess). All workers contend on the same on-disk file, which:
//   1. corrupts the working-tree copy between writers, and
//   2. produces the recurring auditDuplicateKeys.test.js canary failure --
//      "does NOT mutate data/terapeak-meta.json" -- because the audit script's
//      pre/post sha256 races against another worker's write.
//
// What this setup does
// --------------------
// Before any test in a worker loads, we:
//   * create a unique tmpdir for the worker,
//   * point process.env.META_PATH at a file inside it,
//   * seed that file with the real data/terapeak-meta.json contents (if present)
//     so tests that read existing data still see realistic input.
//
// Code that honors process.env.META_PATH (terapeakService._resolveMetaSidecarPath,
// scripts/generate-freshness-report.js) will now write to the per-worker tmpdir.
// The real working-tree data/terapeak-meta.json is left untouched, so the
// auditDuplicateKeys.test.js canary -- which intentionally targets the real file
// to verify the audit script is read-only -- becomes deterministic again.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpf-meta-'));
const tmpMeta = path.join(tmpDir, 'terapeak-meta.json');
const tmpReport = path.join(tmpDir, 'freshness-report.json');

const realMeta = path.join(__dirname, '..', '..', 'data', 'terapeak-meta.json');
if (fs.existsSync(realMeta)) {
  fs.copyFileSync(realMeta, tmpMeta);
} else {
  fs.writeFileSync(tmpMeta, '{}\n');
}

process.env.META_PATH = tmpMeta;
process.env.FRESHNESS_REPORT_PATH = tmpReport;
