#!/usr/bin/env node
/**
 * generate-freshness-report.js
 *
 * Reads data/terapeak-meta.json, classifies each dataset by composition and
 * grade, computes staleness from newestSaleDate, determines next actions,
 * and writes cache/freshness-report.json.
 *
 * Usage:
 *   node scripts/generate-freshness-report.js              # Generate report
 *   node scripts/generate-freshness-report.js --summary    # Print summary only (no file write)
 *   node scripts/generate-freshness-report.js --stale 15   # Override stale threshold (default 15)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { classifyComposition, classifyGradeCategory } = require('../src/utils/coinMetalProfile');

const META_PATH = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'cache', 'freshness-report.json');
const VALIDITY_HOURS = 24;

// ── Parse args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const summaryOnly = args.includes('--summary');
const staleIdx = args.indexOf('--stale');
const STALE_THRESHOLD = staleIdx >= 0 ? parseInt(args[staleIdx + 1]) || 15 : 15;
const VERY_STALE_THRESHOLD = STALE_THRESHOLD * 2; // 30d if threshold is 15
const LOW_COMP_THRESHOLD = 100;

// ── Load meta sidecar ───────────────────────────────────────
if (!fs.existsSync(META_PATH)) {
  console.error(`ERROR: ${META_PATH} not found. Run the server or backfill first.`);
  process.exit(1);
}

const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
const today = new Date();
const todayStr = today.toISOString().split('T')[0];

// ── Classify and compute ────────────────────────────────────
const datasets = [];
const compositionSummary = {};

for (const [key, entry] of Object.entries(meta)) {
  const composition = classifyComposition(key);
  const gradeCategory = classifyGradeCategory(key);
  const newestSaleDate = entry.newestSaleDate || null;
  const compCount = entry.compCount || 0;
  const hasDeepAt = !!entry.deepAt;

  // Compute staleness
  let staleDays = null;
  if (newestSaleDate) {
    const diff = today - new Date(newestSaleDate);
    staleDays = Math.floor(diff / 86400000);
  }

  // Determine actions
  const actions = [];
  if (newestSaleDate === null && compCount === 0) {
    actions.push('needs-data');
  } else if (staleDays !== null && staleDays >= STALE_THRESHOLD) {
    actions.push('refresh-page1');
  }
  if (compCount >= 50 && !hasDeepAt) {
    actions.push('deep-paginate');
  }
  if (compCount > 0 && compCount < 20) {
    actions.push('needs-data');
  }
  if (actions.length === 0) {
    actions.push('ok');
  }

  const record = {
    key,
    searchTerm: entry.searchTerm || key.replace(/(^|\s)\S/g, c => c.toUpperCase()),
    composition,
    gradeCategory,
    newestSaleDate,
    staleDays,
    compCount,
    hasDeepAt,
    actions,
  };
  datasets.push(record);

  // Accumulate composition summary
  if (!compositionSummary[composition]) {
    compositionSummary[composition] = { total: 0, stale15d: 0, stale30d: 0, lowComps: 0, fresh: 0, missing: 0 };
  }
  const cs = compositionSummary[composition];
  cs.total++;
  if (newestSaleDate === null) {
    cs.missing++;
  } else if (staleDays >= VERY_STALE_THRESHOLD) {
    cs.stale30d++;
  } else if (staleDays >= STALE_THRESHOLD) {
    cs.stale15d++;
  } else {
    cs.fresh++;
  }
  if (compCount > 0 && compCount < LOW_COMP_THRESHOLD) {
    cs.lowComps++;
  }
}

// Sort: stalest first (null = infinitely stale)
datasets.sort((a, b) => {
  if (a.staleDays === null && b.staleDays === null) return 0;
  if (a.staleDays === null) return -1;
  if (b.staleDays === null) return 1;
  return b.staleDays - a.staleDays;
});

// ── Build summary ───────────────────────────────────────────
const total = datasets.length;
const fresh = datasets.filter(d => d.staleDays !== null && d.staleDays < STALE_THRESHOLD).length;
const stale15d = datasets.filter(d => d.staleDays !== null && d.staleDays >= STALE_THRESHOLD && d.staleDays < VERY_STALE_THRESHOLD).length;
const stale30d = datasets.filter(d => d.staleDays !== null && d.staleDays >= VERY_STALE_THRESHOLD).length;
const missing = datasets.filter(d => d.staleDays === null).length;
const lowComps = datasets.filter(d => d.compCount > 0 && d.compCount < LOW_COMP_THRESHOLD).length;

const summary = {
  total,
  fresh,
  stale15d,
  stale30d,
  missing,
  lowComps,
  byComposition: compositionSummary,
};

const report = {
  generatedAt: today.toISOString(),
  validUntil: new Date(today.getTime() + VALIDITY_HOURS * 3600000).toISOString(),
  staleThresholdDays: STALE_THRESHOLD,
  summary,
  datasets,
};

// ── Output ──────────────────────────────────────────────────
// Print human-readable summary
console.log(`\nFreshness Report (${todayStr})`);
console.log(`  Total datasets:    ${total}`);
console.log(`  Fresh (<${STALE_THRESHOLD}d):      ${fresh}`);
console.log(`  Stale (${STALE_THRESHOLD}-${VERY_STALE_THRESHOLD}d):    ${stale15d}`);
console.log(`  Very stale (>${VERY_STALE_THRESHOLD}d): ${stale30d}`);
console.log(`  Missing data:      ${missing}`);
console.log(`  Low comps (<${LOW_COMP_THRESHOLD}):  ${lowComps}`);
console.log('');
console.log('  By composition:');
const compOrder = ['bullion', 'silver-numismatic', 'gold-numismatic', 'base-metal', 'set', 'bar', 'junk-silver', 'unknown'];
for (const comp of compOrder) {
  const cs = compositionSummary[comp];
  if (!cs) continue;
  const pct = Math.round((cs.fresh / cs.total) * 100);
  console.log(`    ${comp.padEnd(20)} ${String(cs.total).padStart(5)} total  ${String(cs.fresh).padStart(5)} fresh (${pct}%)  ${String(cs.stale15d + cs.stale30d).padStart(5)} stale  ${String(cs.lowComps).padStart(5)} low-comps`);
}
console.log('');

// Top 10 stalest with data
const stalestWithData = datasets.filter(d => d.staleDays !== null && d.compCount > 0 && d.staleDays >= STALE_THRESHOLD);
if (stalestWithData.length > 0) {
  console.log(`  Top 10 stalest (with data):`);
  for (const d of stalestWithData.slice(0, 10)) {
    console.log(`    ${String(d.staleDays).padStart(3)}d  ${String(d.compCount).padStart(4)} comps  ${d.composition.padEnd(20)} ${d.key}`);
  }
  if (stalestWithData.length > 10) {
    console.log(`    ... and ${stalestWithData.length - 10} more`);
  }
  console.log('');
}

// Action breakdown
const actionCounts = {};
for (const d of datasets) {
  for (const a of d.actions) {
    actionCounts[a] = (actionCounts[a] || 0) + 1;
  }
}
console.log('  Actions needed:');
for (const [action, count] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${action.padEnd(16)} ${count}`);
}
console.log('');

if (!summaryOnly) {
  // Ensure cache dir exists
  const cacheDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + '\n');
  console.log(`  Written to: ${OUTPUT_PATH}`);
  console.log(`  Valid until: ${report.validUntil}`);
} else {
  console.log('  (--summary mode, no file written)');
}
