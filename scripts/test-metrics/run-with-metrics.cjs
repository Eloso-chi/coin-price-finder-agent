'use strict';

/**
 * run-with-metrics.cjs
 *
 * Wraps the repo's canonical Jest test command, captures results,
 * and appends a metrics record to .test-metrics/test-runs.jsonl.
 *
 * Usage:
 *   node scripts/test-metrics/run-with-metrics.cjs [-- jest-args...]
 *   npm run test:metrics
 *   npm run test:metrics -- --runInBand
 *   npm run test:metrics -- --testPathPattern=cache
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const METRICS_DIR = path.join(ROOT, '.test-metrics');
const JSONL_PATH = path.join(METRICS_DIR, 'test-runs.jsonl');

// ── helpers ────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function gitInfo() {
  const run = (cmd) => {
    try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim(); }
    catch { return 'unknown'; }
  };
  return {
    branch: run('git rev-parse --abbrev-ref HEAD'),
    commit: run('git rev-parse --short HEAD'),
  };
}

// ── main ───────────────────────────────────────────────────────────────

(function main() {
  ensureDir(METRICS_DIR);

  // Forward extra CLI args to Jest (everything after --)
  const extraArgs = process.argv.slice(2);

  // Temporary file for Jest JSON output
  const tmpJson = path.join(os.tmpdir(), `jest-results-${Date.now()}.json`);

  // Build the Jest command
  const jestBin = path.join(ROOT, 'node_modules', '.bin', 'jest');
  const jestArgs = [
    '--verbose',
    '--json',
    `--outputFile=${tmpJson}`,
    ...extraArgs,
  ];

  const startMs = Date.now();
  const result = spawnSync(process.execPath, [jestBin, ...jestArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  const durationMs = Date.now() - startMs;
  const success = result.status === 0;

  // ── Parse Jest JSON results (best-effort) ──────────────────────────

  let jestData = null;
  try {
    if (fs.existsSync(tmpJson)) {
      jestData = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
    }
  } catch {
    // JSON output unavailable -- fall back to duration + pass/fail only
  } finally {
    try { if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson); } catch {}
  }

  // ── Build metrics record ───────────────────────────────────────────

  const git = gitInfo();
  const record = {
    timestamp: new Date().toISOString(),
    branch: git.branch,
    commit: git.commit,
    nodeVersion: process.version,
    command: `jest --verbose ${extraArgs.join(' ')}`.trim(),
    durationMs,
    success,
    numPassed: null,
    numFailed: null,
    numTotal: null,
    failingTests: [],
    slowestFiles: [],
    slowestTests: [],
    flakeHint: false,
  };

  if (jestData) {
    record.numPassed = jestData.numPassedTests || 0;
    record.numFailed = jestData.numFailedTests || 0;
    record.numTotal = jestData.numTotalTests || 0;

    // Failing tests
    if (jestData.testResults) {
      for (const suite of jestData.testResults) {
        if (suite.status === 'failed') {
          const relFile = path.relative(ROOT, suite.name);
          for (const t of (suite.assertionResults || [])) {
            if (t.status === 'failed') {
              record.failingTests.push({
                file: relFile,
                name: t.fullName || t.title,
              });
            }
          }
        }
      }
    }

    // Slowest files (top 5 by wall time)
    if (jestData.testResults) {
      const fileTimes = jestData.testResults
        .map(s => ({
          file: path.relative(ROOT, s.name),
          durationMs: (s.endTime || 0) - (s.startTime || 0),
        }))
        .filter(f => f.durationMs > 0)
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 5);
      record.slowestFiles = fileTimes;
    }

    // Slowest individual tests (top 10)
    if (jestData.testResults) {
      const allTests = [];
      for (const suite of jestData.testResults) {
        const relFile = path.relative(ROOT, suite.name);
        for (const t of (suite.assertionResults || [])) {
          if (typeof t.duration === 'number') {
            allTests.push({
              file: relFile,
              name: t.fullName || t.title,
              durationMs: t.duration,
            });
          }
        }
      }
      record.slowestTests = allTests
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10);
    }

    // Flake hint: did any test retry and then pass? (Jest retryTimes)
    // Also: if previous run failed this test but now it passes, flag it.
    if (jestData.testResults) {
      for (const suite of jestData.testResults) {
        for (const t of (suite.assertionResults || [])) {
          if ((t.retryReasons || []).length > 0) {
            record.flakeHint = true;
          }
          if (t.status === 'passed' && (t.invocations || 1) > 1) {
            record.flakeHint = true;
          }
        }
      }
    }
  }

  // ── Cross-run flake detection ──────────────────────────────────────

  if (!record.flakeHint && record.failingTests.length === 0) {
    // Check if any of the now-passing tests failed in the previous run
    try {
      if (fs.existsSync(JSONL_PATH)) {
        const lines = fs.readFileSync(JSONL_PATH, 'utf8')
          .trim().split('\n').filter(Boolean);
        if (lines.length > 0) {
          const prev = JSON.parse(lines[lines.length - 1]);
          if (prev.failingTests && prev.failingTests.length > 0) {
            // Previous run had failures, this run is clean -- possible flake
            record.flakeHint = true;
          }
        }
      }
    } catch {}
  }

  // ── Append record ──────────────────────────────────────────────────

  fs.appendFileSync(JSONL_PATH, JSON.stringify(record) + '\n', 'utf8');

  const statusIcon = success ? 'PASS' : 'FAIL';
  const counts = record.numTotal !== null
    ? ` (${record.numPassed} passed, ${record.numFailed} failed, ${record.numTotal} total)`
    : '';
  console.log(`\n[test-metrics] ${statusIcon}${counts} in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`[test-metrics] Record appended to .test-metrics/test-runs.jsonl`);

  if (record.flakeHint) {
    console.log('[test-metrics] ** Flake hint detected -- review with npm run test:summary');
  }

  process.exit(result.status || 0);
})();
