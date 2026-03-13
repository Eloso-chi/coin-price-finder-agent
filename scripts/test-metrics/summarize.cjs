'use strict';

/**
 * summarize.cjs
 *
 * Reads .test-metrics/test-runs.jsonl and prints an actionable summary:
 *   a) Failure frequency by test
 *   b) Flakiness heuristic (tests that fail intermittently)
 *   c) Duration trends + top slow tests/files
 *   d) New failures since last successful run
 *
 * Usage:
 *   node scripts/test-metrics/summarize.cjs
 *   npm run test:summary
 *   npm run test:summary -- --last=20   (limit to last N runs)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const JSONL_PATH = path.join(ROOT, '.test-metrics', 'test-runs.jsonl');

// ── helpers ────────────────────────────────────────────────────────────

function loadRecords(maxRecords) {
  if (!fs.existsSync(JSONL_PATH)) return [];
  const lines = fs.readFileSync(JSONL_PATH, 'utf8')
    .trim().split('\n').filter(Boolean);
  let records = lines.map((line, i) => {
    try { return JSON.parse(line); }
    catch { console.error(`[warn] Skipping malformed record on line ${i + 1}`); return null; }
  }).filter(Boolean);
  if (maxRecords && maxRecords < records.length) {
    records = records.slice(-maxRecords);
  }
  return records;
}

function fmtDuration(ms) {
  if (ms == null) return '?';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtDate(iso) {
  if (!iso) return '?';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

// ── analysis ───────────────────────────────────────────────────────────

function failureFrequency(records) {
  const counts = {};  // testKey -> { count, lastSeen, file }
  for (const r of records) {
    for (const f of (r.failingTests || [])) {
      const key = `${f.file} > ${f.name}`;
      if (!counts[key]) counts[key] = { count: 0, lastSeen: r.timestamp, file: f.file };
      counts[key].count++;
      counts[key].lastSeen = r.timestamp;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1].count - a[1].count);
}

function flakyTests(records) {
  // A test is flaky if it failed in some runs but passed in others.
  // Build a map of test -> [pass, fail, pass, ...] across runs.
  const testRuns = {};  // testKey -> { passes: N, failures: N, total: N }

  // First, collect all unique tests that ever failed
  const failedKeys = new Set();
  for (const r of records) {
    for (const f of (r.failingTests || [])) {
      failedKeys.add(`${f.file} > ${f.name}`);
    }
  }

  // For each run, mark whether these tests passed or failed
  for (const key of failedKeys) {
    testRuns[key] = { failures: 0, totalRuns: records.length };
  }
  for (const r of records) {
    const failedInRun = new Set(
      (r.failingTests || []).map(f => `${f.file} > ${f.name}`)
    );
    for (const key of failedKeys) {
      if (failedInRun.has(key)) {
        testRuns[key].failures++;
      }
    }
  }

  // Flaky = failed in some runs but not all
  return Object.entries(testRuns)
    .filter(([, v]) => v.failures > 0 && v.failures < v.totalRuns)
    .map(([key, v]) => ({
      test: key,
      failRate: `${v.failures}/${v.totalRuns}`,
      pct: ((v.failures / v.totalRuns) * 100).toFixed(0),
    }))
    .sort((a, b) => parseFloat(b.pct) - parseFloat(a.pct));
}

function durationTrends(records) {
  const durations = records
    .filter(r => r.durationMs != null)
    .map(r => ({ ts: r.timestamp, ms: r.durationMs, commit: r.commit }));
  if (durations.length === 0) return null;

  const recent = durations.slice(-10);
  const avg = Math.round(recent.reduce((s, d) => s + d.ms, 0) / recent.length);
  const min = Math.min(...recent.map(d => d.ms));
  const max = Math.max(...recent.map(d => d.ms));

  return { avg, min, max, recent };
}

function topSlowTests(records) {
  // Aggregate slowest tests across all runs, pick the most consistently slow
  const testTimes = {};  // testKey -> [durations]
  for (const r of records) {
    for (const t of (r.slowestTests || [])) {
      const key = `${t.file} > ${t.name}`;
      if (!testTimes[key]) testTimes[key] = [];
      testTimes[key].push(t.durationMs);
    }
  }
  return Object.entries(testTimes)
    .map(([key, times]) => ({
      test: key,
      avgMs: Math.round(times.reduce((s, t) => s + t, 0) / times.length),
      maxMs: Math.max(...times),
      appearances: times.length,
    }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 10);
}

function topSlowFiles(records) {
  const fileTimes = {};
  for (const r of records) {
    for (const f of (r.slowestFiles || [])) {
      if (!fileTimes[f.file]) fileTimes[f.file] = [];
      fileTimes[f.file].push(f.durationMs);
    }
  }
  return Object.entries(fileTimes)
    .map(([file, times]) => ({
      file,
      avgMs: Math.round(times.reduce((s, t) => s + t, 0) / times.length),
      maxMs: Math.max(...times),
    }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 5);
}

function newFailuresSinceLastGreen(records) {
  // Find the last fully successful run, then list any failures after it
  let lastGreenIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].success && (records[i].numFailed || 0) === 0) {
      lastGreenIdx = i;
      break;
    }
  }
  if (lastGreenIdx === -1) return { since: 'no successful run found', failures: [] };
  if (lastGreenIdx === records.length - 1) return { since: 'latest run', failures: [] };

  const sinceRecord = records[lastGreenIdx];
  const newFailures = new Set();
  for (let i = lastGreenIdx + 1; i < records.length; i++) {
    for (const f of (records[i].failingTests || [])) {
      newFailures.add(`${f.file} > ${f.name}`);
    }
  }
  return {
    since: fmtDate(sinceRecord.timestamp),
    commit: sinceRecord.commit,
    failures: [...newFailures],
  };
}

// ── output ─────────────────────────────────────────────────────────────

function printSummary(records) {
  console.log('='.repeat(70));
  console.log('  TEST METRICS SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Records analyzed: ${records.length}`);

  if (records.length === 0) {
    console.log('\n  No test run data found. Run: npm run test:metrics\n');
    return;
  }

  const latest = records[records.length - 1];
  console.log(`  Latest run: ${fmtDate(latest.timestamp)} (${latest.commit})`);
  console.log(`  Status: ${latest.success ? 'PASS' : 'FAIL'}`);
  if (latest.numTotal != null) {
    console.log(`  Results: ${latest.numPassed} passed, ${latest.numFailed} failed, ${latest.numTotal} total`);
  }
  console.log(`  Duration: ${fmtDuration(latest.durationMs)}`);

  // ── Section A: Failure frequency ─────────────────────────────────

  const failures = failureFrequency(records);
  console.log('\n' + '-'.repeat(70));
  console.log('  FAILURE FREQUENCY');
  console.log('-'.repeat(70));
  if (failures.length === 0) {
    console.log('  No failures recorded.');
  } else {
    for (const [key, val] of failures.slice(0, 15)) {
      console.log(`  [${val.count}x] ${key}`);
      console.log(`        last: ${fmtDate(val.lastSeen)}`);
    }
    if (failures.length > 15) {
      console.log(`  ... and ${failures.length - 15} more`);
    }
  }

  // ── Section B: Flakiness ─────────────────────────────────────────

  const flakes = flakyTests(records);
  console.log('\n' + '-'.repeat(70));
  console.log('  FLAKY TESTS (fail intermittently)');
  console.log('-'.repeat(70));
  if (flakes.length === 0) {
    console.log('  No flaky tests detected.');
  } else {
    for (const f of flakes.slice(0, 10)) {
      console.log(`  [${f.failRate} runs = ${f.pct}%] ${f.test}`);
    }
  }

  // ── Section C: Duration trends ───────────────────────────────────

  const trends = durationTrends(records);
  console.log('\n' + '-'.repeat(70));
  console.log('  DURATION TRENDS (last 10 runs)');
  console.log('-'.repeat(70));
  if (trends) {
    console.log(`  Avg: ${fmtDuration(trends.avg)}  Min: ${fmtDuration(trends.min)}  Max: ${fmtDuration(trends.max)}`);
    console.log('  Timeline:');
    for (const d of trends.recent) {
      const bar = '#'.repeat(Math.max(1, Math.round(d.ms / 1000)));
      console.log(`    ${d.commit} ${fmtDuration(d.ms).padStart(7)} ${bar}`);
    }
  }

  // ── Slowest files ────────────────────────────────────────────────

  const slowFiles = topSlowFiles(records);
  console.log('\n' + '-'.repeat(70));
  console.log('  SLOWEST TEST FILES');
  console.log('-'.repeat(70));
  if (slowFiles.length === 0) {
    console.log('  No file timing data available.');
  } else {
    for (const f of slowFiles) {
      console.log(`  ${fmtDuration(f.avgMs).padStart(7)} avg  ${fmtDuration(f.maxMs).padStart(7)} max  ${f.file}`);
    }
  }

  // ── Slowest individual tests ─────────────────────────────────────

  const slowTests = topSlowTests(records);
  console.log('\n' + '-'.repeat(70));
  console.log('  SLOWEST INDIVIDUAL TESTS (top 10)');
  console.log('-'.repeat(70));
  if (slowTests.length === 0) {
    console.log('  No individual test timing data available.');
  } else {
    for (const t of slowTests) {
      console.log(`  ${fmtDuration(t.avgMs).padStart(7)} avg  ${fmtDuration(t.maxMs).padStart(7)} max  ${t.test}`);
    }
  }

  // ── Section D: New failures since last green ─────────────────────

  const newFails = newFailuresSinceLastGreen(records);
  console.log('\n' + '-'.repeat(70));
  console.log('  NEW FAILURES SINCE LAST GREEN RUN');
  console.log('-'.repeat(70));
  if (newFails.failures.length === 0) {
    console.log(`  None -- last green: ${newFails.since}`);
  } else {
    console.log(`  Last green: ${newFails.since} (${newFails.commit})`);
    for (const f of newFails.failures) {
      console.log(`  - ${f}`);
    }
  }

  // ── Flake hints from recorder ────────────────────────────────────

  const flakeHintRuns = records.filter(r => r.flakeHint);
  if (flakeHintRuns.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('  FLAKE HINT FLAGS');
    console.log('-'.repeat(70));
    console.log(`  ${flakeHintRuns.length} of ${records.length} runs flagged potential flakiness.`);
    const recentHints = flakeHintRuns.slice(-3);
    for (const r of recentHints) {
      console.log(`    ${fmtDate(r.timestamp)} (${r.commit}) -- ${r.success ? 'passed' : 'failed'}`);
    }
  }

  console.log('\n' + '='.repeat(70));
}

// ── main ───────────────────────────────────────────────────────────────

const args = parseArgs();
const maxRecords = args.last ? parseInt(args.last, 10) : undefined;
const records = loadRecords(maxRecords);
printSummary(records);
