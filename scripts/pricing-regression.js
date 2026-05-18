#!/usr/bin/env node
/**
 * pricing-regression.js -- Golden-set pricing regression detector (#191)
 *
 * Runs a curated set of coin queries through /api/price and compares
 * results against known-good baselines. Detects regressions from code changes.
 *
 * Usage:
 *   node scripts/pricing-regression.js              # run against live server
 *   node scripts/pricing-regression.js --update     # update baseline from current results
 *   node scripts/pricing-regression.js --verbose    # show all coin results
 *
 * Requires server running at localhost:3000 (or set BASE_URL env var).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const BASELINE_PATH = path.join(__dirname, '..', 'cache', 'pricing-regression-baseline.json');

const args = process.argv.slice(2);
const UPDATE_MODE = args.includes('--update');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

// ── Golden Set of Test Coins ────────────────────────────────
// Each entry: { query, expectedPool, fmvFloor, fmvCeiling, minConfidence, tags }
const GOLDEN_SET = [
  // Business strike bullion
  { query: '2024 American Silver Eagle 1 oz', expectedPool: 'raw', fmvFloor: 25, fmvCeiling: 80, minConfidence: 50, tags: ['bullion', 'silver'] },
  { query: '2024 American Gold Eagle 1 oz', expectedPool: 'raw', fmvFloor: 1800, fmvCeiling: 4000, minConfidence: 40, tags: ['bullion', 'gold'] },
  { query: '2024 Mexican Silver Libertad 1 oz', expectedPool: 'raw', fmvFloor: 30, fmvCeiling: 120, minConfidence: 40, tags: ['bullion', 'silver'] },
  { query: '2020 China Silver Panda 30g', expectedPool: 'raw', fmvFloor: 30, fmvCeiling: 150, minConfidence: 40, tags: ['bullion', 'silver'] },
  { query: '2024 American Platinum Eagle 1 oz', expectedPool: 'raw', fmvFloor: 800, fmvCeiling: 2500, minConfidence: 30, tags: ['bullion', 'platinum'] },

  // Proof bullion
  { query: '2023 American Silver Eagle Proof', expectedPool: 'proof', fmvFloor: 40, fmvCeiling: 150, minConfidence: 30, tags: ['bullion', 'proof'] },
  { query: '2022 Mexican Silver Libertad Proof 1 oz', expectedPool: 'proof', fmvFloor: 50, fmvCeiling: 300, minConfidence: 20, tags: ['bullion', 'proof'] },

  // Graded numismatic
  { query: '1921 Morgan Silver Dollar MS63', expectedPool: 'graded', fmvFloor: 40, fmvCeiling: 200, minConfidence: 40, tags: ['numismatic', 'graded'] },
  { query: '1878 Morgan Silver Dollar MS65', expectedPool: 'graded', fmvFloor: 200, fmvCeiling: 1500, minConfidence: 30, tags: ['numismatic', 'graded'] },
  { query: '1923 Peace Silver Dollar MS64', expectedPool: 'graded', fmvFloor: 50, fmvCeiling: 300, minConfidence: 30, tags: ['numismatic', 'graded'] },

  // Raw numismatic
  { query: '1943 Walking Liberty Half Dollar', expectedPool: 'raw', fmvFloor: 8, fmvCeiling: 60, minConfidence: 30, tags: ['numismatic', 'raw'] },
  { query: '1944 Mercury Dime', expectedPool: 'raw', fmvFloor: 2, fmvCeiling: 20, minConfidence: 30, tags: ['numismatic', 'raw'] },

  // Proof-Like (must NOT enter proof pool)
  { query: '1881-S Morgan Silver Dollar PL', expectedPool: 'graded', fmvFloor: 50, fmvCeiling: 500, minConfidence: 20, tags: ['numismatic', 'proof-like'] },

  // Type variants
  { query: '2021 American Silver Eagle Type 1', expectedPool: 'raw', fmvFloor: 25, fmvCeiling: 80, minConfidence: 30, tags: ['bullion', 'variant'] },
  { query: '2021 American Gold Eagle Type 2', expectedPool: 'raw', fmvFloor: 1800, fmvCeiling: 4000, minConfidence: 30, tags: ['bullion', 'variant'] },

  // Burnished (must NOT enter proof pool)
  { query: '2008-W American Silver Eagle Burnished', expectedPool: 'raw', fmvFloor: 30, fmvCeiling: 200, minConfidence: 20, tags: ['bullion', 'burnished'] },

  // Perth Lunar
  { query: '2024 Perth Lunar Dragon 1 oz Silver', expectedPool: 'raw', fmvFloor: 30, fmvCeiling: 120, minConfidence: 30, tags: ['bullion', 'silver'] },

  // Gold Buffalo
  { query: '2024 American Gold Buffalo 1 oz', expectedPool: 'raw', fmvFloor: 1800, fmvCeiling: 4000, minConfidence: 30, tags: ['bullion', 'gold'] },

  // Key date numismatic
  { query: '1916-D Mercury Dime', expectedPool: 'raw', fmvFloor: 500, fmvCeiling: 10000, minConfidence: 15, tags: ['numismatic', 'key-date'] },

  // Barber
  { query: '1904 Barber Half Dollar', expectedPool: 'raw', fmvFloor: 10, fmvCeiling: 200, minConfidence: 20, tags: ['numismatic', 'raw'] },
];

// ── HTTP helper ─────────────────────────────────────────────
function httpRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ _raw: data, _status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  console.log(`\n  Pricing Regression Audit (${GOLDEN_SET.length} coins)\n`);
  console.log(`  Server: ${BASE}`);
  console.log(`  Mode: ${UPDATE_MODE ? 'UPDATE BASELINE' : 'REGRESSION CHECK'}\n`);

  // Load existing baseline
  let baseline = {};
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch { /* first run */ }

  const results = [];
  const failures = [];

  for (let i = 0; i < GOLDEN_SET.length; i++) {
    const coin = GOLDEN_SET[i];
    const label = `[${i + 1}/${GOLDEN_SET.length}]`;

    try {
      const resp = await httpRequest('POST', '/api/price', { query: coin.query });
      const v = resp?.valuation || {};
      const fmv = v.fmvCore ?? null;
      const confidence = v.confidence ?? 0;
      const pool = v.gradePool?.usedPool || 'unknown';
      const method = v.method || 'unknown';
      const compCount = v.compCount ?? 0;
      const browseOnly = v.dataSource?.browseOnly || false;

      const entry = { query: coin.query, fmv, confidence, pool, method, compCount, browseOnly };
      results.push(entry);

      // Check assertions
      const issues = [];

      // FMV range check
      if (fmv === null || fmv === 0) {
        issues.push('NULL_FMV: No FMV returned (pipeline-leak)');
      } else if (fmv < coin.fmvFloor) {
        issues.push(`FMV_LOW: $${fmv} below floor $${coin.fmvFloor}`);
      } else if (fmv > coin.fmvCeiling) {
        issues.push(`FMV_HIGH: $${fmv} above ceiling $${coin.fmvCeiling}`);
      }

      // Confidence check
      if (confidence < coin.minConfidence) {
        issues.push(`LOW_CONF: ${confidence} < min ${coin.minConfidence}`);
      }

      // Pool check
      if (coin.expectedPool && !pool.includes(coin.expectedPool)) {
        issues.push(`WRONG_POOL: "${pool}" expected to contain "${coin.expectedPool}"`);
      }

      // Baseline drift check
      const prev = baseline[coin.query];
      if (prev && fmv && prev.fmv) {
        const drift = Math.abs(fmv - prev.fmv) / prev.fmv;
        if (drift > 0.15) {
          issues.push(`DRIFT: FMV shifted ${(drift * 100).toFixed(1)}% from baseline ($${prev.fmv} -> $${fmv})`);
        }
        if (prev.pool !== pool) {
          issues.push(`POOL_CHANGE: Pool changed from "${prev.pool}" to "${pool}"`);
        }
      }

      const status = issues.length === 0 ? 'PASS' : 'FAIL';
      if (issues.length > 0) failures.push({ ...entry, issues });

      if (VERBOSE || issues.length > 0) {
        const icon = status === 'PASS' ? '  OK' : 'FAIL';
        console.log(`  ${icon} ${label} ${coin.query}`);
        if (fmv) console.log(`       FMV=$${fmv.toFixed(2)} conf=${confidence} pool=${pool} comps=${compCount}`);
        for (const issue of issues) console.log(`       !! ${issue}`);
      } else {
        process.stdout.write('.');
      }
    } catch (err) {
      const entry = { query: coin.query, fmv: null, confidence: 0, pool: 'error', error: err.message };
      results.push(entry);
      failures.push({ ...entry, issues: [`ERROR: ${err.message}`] });
      console.log(`  ERR ${label} ${coin.query}: ${err.message}`);
    }
  }

  if (!VERBOSE) console.log(''); // newline after dots

  // Summary
  const passed = results.length - failures.length;
  console.log(`\n  Results: ${passed}/${results.length} PASS, ${failures.length} FAIL\n`);

  if (failures.length > 0) {
    console.log('  Failures:');
    for (const f of failures) {
      console.log(`    - ${f.query}: ${f.issues.join('; ')}`);
    }
    console.log('');
  }

  // Update baseline if requested
  if (UPDATE_MODE) {
    const newBaseline = {};
    for (const r of results) {
      if (r.fmv != null) {
        newBaseline[r.query] = { fmv: r.fmv, confidence: r.confidence, pool: r.pool, method: r.method, date: new Date().toISOString() };
      }
    }
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2));
    console.log(`  Baseline updated: ${BASELINE_PATH} (${Object.keys(newBaseline).length} coins)\n`);
  }

  // Exit code
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(2);
});
