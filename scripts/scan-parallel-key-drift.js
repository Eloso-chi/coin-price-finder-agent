#!/usr/bin/env node
'use strict';

/**
 * scripts/scan-parallel-key-drift.js
 *
 * Wave 2 / Batch G of the QA test plan -- scale-aware regression
 * detector for the #267H failure class ("lookupComps returns empty
 * parallel-key dataset over populated one").
 *
 * For every populated dataset in data/terapeak-meta.json, calls
 * terapeakService.lookupComps(searchTerm) and classifies the result:
 *
 *   ok               -- lookupComps returned the same key with comps > 0
 *   drift-empty      -- lookupComps returned null or an empty stub (#267H)
 *   drift-different  -- lookupComps returned a DIFFERENT populated key
 *                       (potential alias-map merge candidate, or a
 *                       fuzzy-scoring drift worth flagging)
 *   skip             -- entry has no searchTerm or compCount === 0
 *
 * Output: docs/reports/parallel-key-drift-report.json + console summary.
 *
 * SAFETY:
 *  - Reads data/terapeak-meta.json only. NEVER writes to it.
 *  - Writes only to docs/reports/parallel-key-drift-report.json.
 *  - Does not mutate the terapeakService store (lookupComps is read-only).
 *
 * Usage:
 *   node scripts/scan-parallel-key-drift.js              # full scan
 *   node scripts/scan-parallel-key-drift.js --top 50     # console-print top N drifts
 *   node scripts/scan-parallel-key-drift.js --quiet      # JSON report only, no console
 */

const fs = require('fs');
const path = require('path');

const META_PATH = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const REPORT_PATH = path.join(__dirname, '..', 'docs', 'reports', 'parallel-key-drift-report.json');

/**
 * Classify a single dataset's lookupComps result.
 * Pure function -- no I/O, deterministic given (entry, lookupComps).
 *
 * @param {object} entry - { searchTerm, expectedKey, expectedCompCount }
 * @param {function} lookupComps - terapeakService.lookupComps or compatible stub
 * @returns {object} - { searchTerm, expectedKey, expectedCompCount, actualKey, actualCompCount, status, error? }
 */
function classifyLookup(entry, lookupComps) {
  const { searchTerm, expectedKey, expectedCompCount } = entry;

  // Skip cases: nothing to assert if no query or no expected data
  if (!searchTerm || expectedCompCount === 0) {
    return {
      searchTerm,
      expectedKey,
      expectedCompCount,
      actualKey: null,
      actualCompCount: 0,
      status: 'skip',
    };
  }

  let result;
  try {
    result = lookupComps(searchTerm);
  } catch (err) {
    // A throw from lookupComps is a worse-than-drift outcome but we
    // surface it as drift-empty so the report stays uniform.
    return {
      searchTerm,
      expectedKey,
      expectedCompCount,
      actualKey: null,
      actualCompCount: 0,
      status: 'drift-empty',
      error: err && err.message ? err.message : String(err),
    };
  }

  // Null / undefined result -- runtime can't find the data we know exists
  if (!result) {
    return {
      searchTerm,
      expectedKey,
      expectedCompCount,
      actualKey: null,
      actualCompCount: 0,
      status: 'drift-empty',
    };
  }

  const actualKey = result.key || null;
  const actualCompCount = (result.comps && result.comps.length) || 0;

  // Empty stub returned -- the #267H regression class
  if (actualCompCount === 0) {
    return {
      searchTerm,
      expectedKey,
      expectedCompCount,
      actualKey,
      actualCompCount,
      status: 'drift-empty',
    };
  }

  // Different populated key -- alias-map merge candidate or fuzzy-scoring drift
  if (actualKey && actualKey !== expectedKey) {
    return {
      searchTerm,
      expectedKey,
      expectedCompCount,
      actualKey,
      actualCompCount,
      status: 'drift-different',
    };
  }

  // Same key, populated -- invariant holds
  return {
    searchTerm,
    expectedKey,
    expectedCompCount,
    actualKey,
    actualCompCount,
    status: 'ok',
  };
}

/**
 * Run the scanner across a whole store snapshot.
 *
 * @param {object} args - { store, lookupComps }
 *   store: object keyed by normalized search key, each value has at
 *          least { searchTerm, comps: [] } -- matches the shape of
 *          terapeakService's internal _store and is compatible with
 *          fixture data.
 *   lookupComps: terapeakService.lookupComps or compatible stub.
 * @returns {object} - report shape (see README for the field list)
 */
function runScan({ store, lookupComps }) {
  const startedAt = Date.now();
  const generatedAt = new Date(startedAt).toISOString();

  const entries = Object.entries(store || {});
  const populated = entries.filter(([, v]) => (v.comps || []).length > 0);

  const byStatus = { ok: 0, 'drift-empty': 0, 'drift-different': 0, skip: 0 };
  const drifts = [];
  let scanned = 0;

  for (const [key, value] of entries) {
    const result = classifyLookup({
      searchTerm: value.searchTerm,
      expectedKey: key,
      expectedCompCount: (value.comps || []).length,
    }, lookupComps);

    byStatus[result.status] += 1;
    if (result.status === 'ok' || result.status === 'drift-empty' ||
        result.status === 'drift-different' || result.status === 'skip') {
      scanned += 1;
    }
    if (result.status === 'drift-empty' || result.status === 'drift-different') {
      drifts.push(result);
    }
  }

  return {
    generatedAt,
    durationMs: Date.now() - startedAt,
    totalDatasets: entries.length,
    populatedDatasets: populated.length,
    emptyDatasets: entries.length - populated.length,
    datasetsScanned: scanned,
    byStatus,
    drifts,
  };
}

// ── CLI entrypoint ───────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const topIdx = args.indexOf('--top');
  const topN = topIdx >= 0 ? parseInt(args[topIdx + 1], 10) || 50 : 50;

  if (!fs.existsSync(META_PATH)) {
    console.error(`[scan-parallel-key-drift] meta file not found: ${META_PATH}`);
    process.exit(1);
  }

  // The scanner uses meta.json as its store-shape input. Each entry in
  // meta.json already has { searchTerm, compCount, aggregationMeta },
  // but no `comps` array (only the count). Reshape so the classifier
  // sees a synthetic comps array of the right length.
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  const store = {};
  for (const [key, value] of Object.entries(meta)) {
    const compCount = value.compCount || 0;
    store[key] = {
      searchTerm: value.searchTerm,
      comps: new Array(compCount), // length is all the classifier checks
    };
  }

  // Lazy-require so the test can mock without loading the service.
  const terapeakService = require('../src/services/terapeakService');
  const report = runScan({
    store,
    lookupComps: terapeakService.lookupComps,
  });

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

  if (!quiet) {
    console.log('');
    console.log('=== Parallel-Key Drift Scan ===');
    console.log(`Generated:         ${report.generatedAt}`);
    console.log(`Duration:          ${report.durationMs} ms`);
    console.log(`Total datasets:    ${report.totalDatasets}`);
    console.log(`Populated:         ${report.populatedDatasets}`);
    console.log(`Empty / skipped:   ${report.emptyDatasets}`);
    console.log(`Scanned:           ${report.datasetsScanned}`);
    console.log('');
    console.log('Status breakdown:');
    console.log(`  ok                ${report.byStatus.ok}`);
    console.log(`  drift-empty       ${report.byStatus['drift-empty']}   <-- #267H regression class`);
    console.log(`  drift-different   ${report.byStatus['drift-different']}   <-- alias-map merge candidates`);
    console.log(`  skip              ${report.byStatus.skip}`);
    console.log('');

    if (report.drifts.length === 0) {
      console.log('No drifts detected. Invariant holds across the entire store.');
    } else {
      const printable = report.drifts.slice(0, topN);
      console.log(`Top ${printable.length} drifts (of ${report.drifts.length}):`);
      console.log('');
      for (const d of printable) {
        const tag = d.status === 'drift-empty' ? '[EMPTY]' : '[DIFFR]';
        console.log(`  ${tag} expected: ${d.expectedKey}  (compCount=${d.expectedCompCount})`);
        console.log(`           query:    ${d.searchTerm}`);
        console.log(`           actual:   ${d.actualKey || '(null)'}  (compCount=${d.actualCompCount})`);
        if (d.error) console.log(`           error:    ${d.error}`);
        console.log('');
      }
      if (report.drifts.length > printable.length) {
        console.log(`...and ${report.drifts.length - printable.length} more in ${REPORT_PATH}`);
      }
    }

    console.log(`Report written to ${REPORT_PATH}`);
  }

  // Exit code: 0 if no drift-empty (the actionable failure class).
  // drift-different is informational, not blocking.
  process.exit(report.byStatus['drift-empty'] > 0 ? 2 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { classifyLookup, runScan };
