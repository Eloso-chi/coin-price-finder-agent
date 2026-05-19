#!/usr/bin/env node
// scripts/bar-pricing-health.js -- Sanity-check bar pricing across sizes/brands
// Usage: node scripts/bar-pricing-health.js [--base-url http://localhost:3000]
'use strict';

const BASE_URL = (() => {
  const eq = process.argv.find(a => a.startsWith('--base-url='));
  if (eq) return eq.split('=')[1];
  const idx = process.argv.indexOf('--base-url');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return 'http://localhost:3000';
})();

const API_KEY = process.env.ADMIN_API_KEY || 'terapeak-1775345508';

// ── Test cases: [query, expectedMetal, minFmv, maxFmv, sizeGrams] ──
const CASES = [
  // ── Generic (no brand) ────────────────────────────────────
  // Gold -- small
  { query: '.5g gold geiger', metal: 'gold', sizeG: 0.5, minFmv: 30, maxFmv: 300 },
  { query: '0.5 gram gold geiger', metal: 'gold', sizeG: 0.5, minFmv: 30, maxFmv: 300 },
  { query: '1g gold bar', metal: 'gold', sizeG: 1, minFmv: 60, maxFmv: 400 },
  { query: '2.5 gram gold bar', metal: 'gold', sizeG: 2.5, minFmv: 150, maxFmv: 600 },
  { query: '5 gram gold bar', metal: 'gold', sizeG: 5, minFmv: 300, maxFmv: 1200 },
  { query: '10 gram gold bar', metal: 'gold', sizeG: 10, minFmv: 500, maxFmv: 2000 },
  // Gold -- large
  { query: '1 oz gold bar', metal: 'gold', sizeG: 31.1035, minFmv: 2000, maxFmv: 6000 },
  // Silver
  { query: '1 oz silver bar', metal: 'silver', sizeG: 31.1035, minFmv: 25, maxFmv: 150 },
  { query: '10 oz silver bar', metal: 'silver', sizeG: 311.035, minFmv: 250, maxFmv: 900 },

  // ── PAMP Suisse ───────────────────────────────────────────
  { query: '1g gold pamp fortuna', metal: 'gold', sizeG: 1, minFmv: 60, maxFmv: 500 },
  { query: '5g gold pamp fortuna', metal: 'gold', sizeG: 5, minFmv: 300, maxFmv: 1300 },
  { query: '1 oz gold pamp fortuna', metal: 'gold', sizeG: 31.1035, minFmv: 2000, maxFmv: 6500 },
  { query: '1g gold pamp rosa', metal: 'gold', sizeG: 1, minFmv: 60, maxFmv: 500 },
  { query: '1g gold pamp lunar', metal: 'gold', sizeG: 1, minFmv: 60, maxFmv: 500 },
  { query: '2.5g gold pamp suisse', metal: 'gold', sizeG: 2.5, minFmv: 150, maxFmv: 700 },

  // ── Geiger Edelmetalle ────────────────────────────────────
  { query: '1 oz silver geiger edelmetalle', metal: 'silver', sizeG: 31.1035, minFmv: 30, maxFmv: 120 },
  { query: '1g gold geiger edelmetalle', metal: 'gold', sizeG: 1, minFmv: 60, maxFmv: 400 },
  { query: '10g gold geiger square', metal: 'gold', sizeG: 10, minFmv: 500, maxFmv: 2200 },
  { query: '1 oz silver geiger square', metal: 'silver', sizeG: 31.1035, minFmv: 30, maxFmv: 150 },

  // ── Scottsdale ────────────────────────────────────────────
  { query: '1 oz silver scottsdale stacker', metal: 'silver', sizeG: 31.1035, minFmv: 25, maxFmv: 150 },
  { query: '10 oz silver scottsdale stacker', metal: 'silver', sizeG: 311.035, minFmv: 250, maxFmv: 1000 },
  { query: '1 oz gold scottsdale', metal: 'gold', sizeG: 31.1035, minFmv: 2000, maxFmv: 6500 },

  // ── Valcambi ──────────────────────────────────────────────
  { query: '1g gold valcambi', metal: 'gold', sizeG: 1, minFmv: 60, maxFmv: 400 },
  { query: '1 oz gold valcambi combibar', metal: 'gold', sizeG: 31.1035, minFmv: 2000, maxFmv: 6500 },
  { query: '1 oz silver valcambi', metal: 'silver', sizeG: 31.1035, minFmv: 25, maxFmv: 150 },

  // ── Heraeus ───────────────────────────────────────────────
  { query: '1g gold heraeus', metal: 'gold', sizeG: 1, minFmv: 60, maxFmv: 400 },
  { query: '1 oz gold heraeus kinebar', metal: 'gold', sizeG: 31.1035, minFmv: 2000, maxFmv: 6500 },
  { query: '1 oz silver heraeus', metal: 'silver', sizeG: 31.1035, minFmv: 25, maxFmv: 150 },

  // ── Credit Suisse ─────────────────────────────────────────
  { query: '1 oz gold credit suisse', metal: 'gold', sizeG: 31.1035, minFmv: 2000, maxFmv: 6500 },
  { query: '10g gold credit suisse', metal: 'gold', sizeG: 10, minFmv: 500, maxFmv: 2200 },

  // ── Perth Mint ────────────────────────────────────────────
  { query: '1 oz gold perth mint bar', metal: 'gold', sizeG: 31.1035, minFmv: 2000, maxFmv: 6500 },
  { query: '10 oz silver perth mint bar', metal: 'silver', sizeG: 311.035, minFmv: 250, maxFmv: 1000 },
  { query: '1 oz silver perth mint kangaroo bar', metal: 'silver', sizeG: 31.1035, minFmv: 25, maxFmv: 150 },
];

// ── Assertions ──────────────────────────────────────────────

function assertWeight(result, expectedGrams) {
  const expectedOz = expectedGrams / 31.1035;
  const actual = result.weight;
  if (actual == null) return { pass: false, msg: `weight is null (expected ${expectedOz.toFixed(5)} oz)` };
  if (Math.abs(actual - expectedOz) > 0.001) return { pass: false, msg: `weight ${actual.toFixed(5)} != expected ${expectedOz.toFixed(5)}` };
  return { pass: true };
}

function assertFmvRange(result, min, max) {
  const fmv = result.fmv;
  if (fmv == null) return { pass: false, msg: 'fmv is null' };
  if (fmv < min) return { pass: false, msg: `fmv $${fmv} < min $${min}` };
  if (fmv > max) return { pass: false, msg: `fmv $${fmv} > max $${max}` };
  return { pass: true };
}

function assertMeltFloor(result) {
  if (result.fmv == null || result.meltValue == null) return { pass: true }; // skip if no data
  if (result.fmv < result.meltValue * 0.9) {
    return { pass: false, msg: `fmv $${result.fmv} < 90% melt $${result.meltValue}` };
  }
  return { pass: true };
}

function assertComps(result) {
  if ((result.compCount || 0) === 0) return { pass: false, msg: 'zero comps found' };
  return { pass: true };
}

// ── Runner ──────────────────────────────────────────────────

async function runHealthCheck() {
  console.log(`Bar Pricing Health Check`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Cases: ${CASES.length}`);
  console.log('─'.repeat(70));

  // Submit bulk job
  const items = CASES.map(c => ({ query: c.query, qty: 1 }));
  const submitRes = await fetch(`${BASE_URL}/api/bulk-evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ items }),
  });
  const submitData = await submitRes.json();
  if (!submitData.jobId) {
    console.error('ERROR: Failed to submit job:', submitData);
    process.exit(1);
  }
  console.log(`Job submitted: ${submitData.jobId}`);

  // Poll for results
  let results = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const pollRes = await fetch(`${BASE_URL}/api/bulk-evaluate/${submitData.jobId}`, {
      headers: { 'x-api-key': API_KEY },
    });
    const pollData = await pollRes.json();
    if (pollData.results && pollData.results.length === CASES.length) {
      results = pollData.results;
      break;
    }
    process.stdout.write('.');
  }
  if (!results) {
    console.error('\nERROR: Job timed out after 120s');
    process.exit(1);
  }
  console.log(`\nResults received (${results.length} items)\n`);

  // Run assertions
  let passed = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < CASES.length; i++) {
    const tc = CASES[i];
    const r = results[i];
    if (!r || r.error) {
      failed++;
      const msg = r?.error || 'null result';
      console.log(`  FAIL  ${tc.query.padEnd(35)} ERROR: ${msg}`);
      failures.push({ query: tc.query, errors: msg, result: r || {} });
      continue;
    }
    const checks = [
      ['weight', assertWeight(r, tc.sizeG)],
      ['fmv-range', assertFmvRange(r, tc.minFmv, tc.maxFmv)],
      ['melt-floor', assertMeltFloor(r)],
      ['has-comps', assertComps(r)],
    ];

    const failedChecks = checks.filter(([, c]) => !c.pass);
    if (failedChecks.length === 0) {
      passed++;
      console.log(`  PASS  ${tc.query.padEnd(35)} FMV=$${r.fmv}  comps=${r.compCount}`);
    } else {
      failed++;
      const msgs = failedChecks.map(([name, c]) => `${name}: ${c.msg}`).join('; ');
      console.log(`  FAIL  ${tc.query.padEnd(35)} ${msgs}`);
      failures.push({ query: tc.query, errors: msgs, result: r });
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${CASES.length}`);

  if (failures.length) {
    console.log('\nFailure details:');
    for (const f of failures) {
      console.log(`  ${f.query}: ${f.errors}`);
      console.log(`    raw: fmv=${f.result.fmv} weight=${f.result.weight} melt=${f.result.meltValue} comps=${f.result.compCount}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

runHealthCheck().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
