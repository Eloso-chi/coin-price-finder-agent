#!/usr/bin/env node
/**
 * generate-freshness-report.js
 *
 * Reads data/terapeak-meta.json, classifies each dataset by composition and
 * grade, computes staleness from newestSaleDate, determines next actions,
 * and writes cache/freshness-report.json.
 *
 * Freshness statuses:
 *   Fresh              -- newestSaleDate within threshold
 *   Stale              -- newestSaleDate beyond threshold, sufficient data to confirm
 *   LowSignalMarketData -- too few comps to reliably determine freshness/staleness
 *   Missing            -- no data at all (no comps, no CSV)
 *
 * Usage:
 *   node scripts/generate-freshness-report.js              # Generate report
 *   node scripts/generate-freshness-report.js --summary    # Print summary only (no file write)
 *   node scripts/generate-freshness-report.js --stale 15   # Override stale threshold (default 15)
 *   node scripts/generate-freshness-report.js --low-signal 10  # Override low-signal threshold (default 10)
 *   node scripts/generate-freshness-report.js --composition gold   # Filter to gold-containing keys only
 *   node scripts/generate-freshness-report.js --batch 100         # Also write a batch file (top N by priority)
 *   node scripts/generate-freshness-report.js --mode default|low-signal|bullion|all  # Batch mode filter
 *   node scripts/generate-freshness-report.js --composition silver --batch 100  # Silver-only batch
 *   node scripts/generate-freshness-report.js --metal gold            # Filter to gold-metal datasets only
 *   node scripts/generate-freshness-report.js --metal silver --batch 50  # Silver-metal batch
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { classifyComposition, classifyGradeCategory, getCoinMetalProfile } = require('../src/utils/coinMetalProfile');
const { normalizeSearchKey } = require('../src/services/terapeakService');

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

// Low-signal threshold: datasets with comps > 0 but < this value are classified
// LowSignalMarketData instead of Fresh/Stale. Default 10, configurable.
const lowSigIdx = args.indexOf('--low-signal');
const LOW_SIGNAL_THRESHOLD = lowSigIdx >= 0 ? parseInt(args[lowSigIdx + 1]) || 10 : 10;

// Composition filter: only include datasets whose key contains this word
// e.g. --composition gold, --composition silver, --composition bullion
const compIdx = args.indexOf('--composition');
const COMPOSITION_FILTER = compIdx >= 0 ? (args[compIdx + 1] || '').toLowerCase() : null;

// Batch generation: write top N entries to cache/freshness-batch-100.json
const batchIdx = args.indexOf('--batch');
const BATCH_SIZE = batchIdx >= 0 ? parseInt(args[batchIdx + 1]) || 100 : 0;

// Metal filter: only include datasets whose detected metal matches
// e.g. --metal silver, --metal gold, --metal platinum
const metalIdx = args.indexOf('--metal');
const METAL_FILTER = metalIdx >= 0 ? (args[metalIdx + 1] || '').toLowerCase() : null;

// Batch mode: controls which datasets are included in the batch file.
//   default    -- excludes LowSignalMarketData (normal stale/missing only)
//   low-signal -- includes only LowSignalMarketData datasets
//   bullion    -- includes only bullion-tagged datasets
//   all        -- includes everything
const modeIdx = args.indexOf('--mode');
const BATCH_MODE = modeIdx >= 0 ? (args[modeIdx + 1] || 'default') : 'default';

// ── Load meta sidecar ───────────────────────────────────────
if (!fs.existsSync(META_PATH)) {
  console.error(`ERROR: ${META_PATH} not found. Run the server or backfill first.`);
  process.exit(1);
}

const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
const today = new Date();
const todayStr = today.toISOString().split('T')[0];

// ── Build normalized CSV lookup ─────────────────────────────
// Uses normalizeSearchKey (same as server) for consistent matching.
// Also builds a word-set index for fuzzy fallback (catches word-order and
// country/adjective differences like "mexico" vs "mexican").
const TERAPEAK_DIR = path.join(__dirname, '..', 'data', 'terapeak');
const csvNormSet = new Set();
const csvWordSets = new Set();
if (fs.existsSync(TERAPEAK_DIR)) {
  for (const f of fs.readdirSync(TERAPEAK_DIR)) {
    if (f.endsWith('.csv')) {
      // Primary: derive search term the same way the server does
      const searchTerm = f.slice(0, -4).replace(/[_]+/g, ' ').trim();
      csvNormSet.add(normalizeSearchKey(searchTerm));
      // Fallback: word-set with country->adjective normalization
      const ws = f.slice(0, -4).toLowerCase()
        .replace(/[_-]/g, ' ')
        .replace(/\bmexican\b/g, 'mexico')
        .replace(/\bcanadian\b/g, 'canada')
        .replace(/\bchinese\b/g, 'china')
        .replace(/\baustralian\b/g, 'australia')
        .replace(/\baustrian\b/g, 'austria')
        .replace(/\bbritish\b/g, 'britain')
        .split(/\s+/).filter(Boolean).sort().join(' ');
      csvWordSets.add(ws);
    }
  }
}
function hasCSVOnDisk(key) {
  // 1. Try normalizeSearchKey match (covers mint-mark and fraction normalization)
  if (csvNormSet.has(normalizeSearchKey(key))) return true;
  // 2. Try word-set match (covers word-order and country/adjective mismatches)
  const ws = key.toLowerCase()
    .replace(/[_-]/g, ' ')
    .replace(/\bmexican\b/g, 'mexico')
    .replace(/\bcanadian\b/g, 'canada')
    .replace(/\bchinese\b/g, 'china')
    .replace(/\baustralian\b/g, 'australia')
    .replace(/\baustrian\b/g, 'austria')
    .replace(/\bbritish\b/g, 'britain')
    .split(/\s+/).filter(Boolean).sort().join(' ');
  return csvWordSets.has(ws);
}

// ── Classify and compute ────────────────────────────────────
const datasets = [];
const compositionSummary = {};

for (const [key, entry] of Object.entries(meta)) {
  // Apply composition filter if specified
  if (COMPOSITION_FILTER && !key.includes(COMPOSITION_FILTER)) continue;

  const composition = classifyComposition(key);
  const { metal } = getCoinMetalProfile(key);

  // Apply metal filter if specified
  if (METAL_FILTER && metal !== METAL_FILTER) continue;
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

  // ── Freshness classification (mutually exclusive) ──────────
  // Priority: Missing > LowSignalMarketData > Stale > Fresh
  let freshnessStatus;
  let freshnessReason;
  const csvExists = hasCSVOnDisk(key);

  if (compCount === 0 && newestSaleDate === null) {
    freshnessStatus = 'Missing';
    freshnessReason = csvExists
      ? 'CSV exists but meta not backfilled; needs re-import'
      : 'No data collected yet';
  } else if (compCount > 0 && compCount < LOW_SIGNAL_THRESHOLD) {
    freshnessStatus = 'LowSignalMarketData';
    freshnessReason = `Only ${compCount} comp(s); insufficient to determine staleness`;
  } else if (staleDays !== null && staleDays >= STALE_THRESHOLD) {
    freshnessStatus = 'Stale';
    freshnessReason = `Newest sale ${staleDays}d ago (threshold: ${STALE_THRESHOLD}d)`;
  } else if (staleDays !== null) {
    freshnessStatus = 'Fresh';
    freshnessReason = `Newest sale ${staleDays}d ago`;
  } else {
    // compCount > 0 but no newestSaleDate (edge case: comps without dates)
    freshnessStatus = 'LowSignalMarketData';
    freshnessReason = `${compCount} comp(s) but no sale dates; cannot assess freshness`;
  }

  // ── Determine actions (backward-compatible) ────────────────
  const actions = [];

  // Dormant detection: datasets with >= 2 consecutive no-data attempts
  // within the last 60 days are marked dormant and excluded from refresh queues.
  const noDataCount = entry.noDataCount || 0;
  const noDataAt = entry.noDataAt || null;
  const noDataAgeDays = noDataAt ? Math.floor((today - new Date(noDataAt)) / 86400000) : null;
  const isDormant = noDataCount >= 2 && noDataAgeDays !== null && noDataAgeDays < 60;

  if (isDormant) {
    actions.push('dormant');
  } else if (freshnessStatus === 'Missing' && !csvExists) {
    actions.push('needs-data');
  } else if (freshnessStatus === 'Missing' && csvExists) {
    actions.push('refresh-page1');
  } else if (freshnessStatus === 'LowSignalMarketData') {
    actions.push('low-signal');
  } else if (freshnessStatus === 'Stale') {
    actions.push('refresh-page1');
  }
  if (compCount >= 50 && !hasDeepAt) {
    actions.push('deep-paginate');
  }
  // Keep backward-compatible needs-data for very low comps that aren't LowSignal
  if (compCount > 0 && compCount < 20 && freshnessStatus !== 'LowSignalMarketData') {
    actions.push('needs-data');
  }
  if (actions.length === 0) {
    actions.push('ok');
  }

  // ── Identifier integration (fast path from terapeak-meta.json) ──
  const storedIds = entry.identifiers || null;
  // Fallback: derive bullion tag from classifyComposition if no stored identifier
  const isBullion = storedIds
    ? storedIds.is_bullion
    : (composition === 'bullion' || composition === 'bar' || composition.startsWith('bullion-'));
  const isLowVolumeCandidate = storedIds
    ? storedIds.is_low_volume_candidate
    : (compCount > 0 && compCount < LOW_SIGNAL_THRESHOLD);

  const identifiers = storedIds || {
    is_low_volume_candidate: isLowVolumeCandidate,
    is_bullion: isBullion,
    identifier_reason: isBullion
      ? `${composition} detected via classifyComposition`
      : (isLowVolumeCandidate ? `${compCount} comps below threshold` : 'no stored identifiers'),
    identifier_source: storedIds ? storedIds.identifier_source : 'fallback_live',
    identifier_confidence: storedIds ? storedIds.identifier_confidence : 'Low',
  };

  const record = {
    key,
    searchTerm: entry.searchTerm || key.replace(/(^|\s)\S/g, c => c.toUpperCase()),
    freshnessStatus,
    freshnessReason,
    composition,
    metal: metal || 'other',
    gradeCategory,
    newestSaleDate,
    staleDays,
    compCount,
    hasDeepAt,
    actions,
    identifiers,
    ...(noDataCount > 0 ? { noDataCount, noDataAt } : {}),
  };
  datasets.push(record);

  // Accumulate composition summary
  if (!compositionSummary[composition]) {
    compositionSummary[composition] = { total: 0, stale15d: 0, stale30d: 0, lowComps: 0, lowSignal: 0, fresh: 0, missing: 0 };
  }
  const cs = compositionSummary[composition];
  cs.total++;
  if (freshnessStatus === 'Missing') {
    cs.missing++;
  } else if (freshnessStatus === 'LowSignalMarketData') {
    cs.lowSignal++;
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
const fresh = datasets.filter(d => d.freshnessStatus === 'Fresh').length;
const stale15d = datasets.filter(d => d.freshnessStatus === 'Stale' && d.staleDays < VERY_STALE_THRESHOLD).length;
const stale30d = datasets.filter(d => d.freshnessStatus === 'Stale' && d.staleDays >= VERY_STALE_THRESHOLD).length;
const missing = datasets.filter(d => d.freshnessStatus === 'Missing').length;
const lowSignal = datasets.filter(d => d.freshnessStatus === 'LowSignalMarketData').length;
const lowComps = datasets.filter(d => d.compCount > 0 && d.compCount < LOW_COMP_THRESHOLD).length;

const summary = {
  total,
  fresh,
  stale15d,
  stale30d,
  missing,
  lowSignal,
  lowComps,
  lowSignalThreshold: LOW_SIGNAL_THRESHOLD,
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
const filterLabel = COMPOSITION_FILTER ? ` [filter: ${COMPOSITION_FILTER}]` : '';
console.log(`\nFreshness Report (${todayStr})${filterLabel}`);
console.log(`  Total datasets:    ${total}`);
console.log(`  Fresh (<${STALE_THRESHOLD}d):      ${fresh}`);
console.log(`  Low-signal (<${LOW_SIGNAL_THRESHOLD} comps): ${lowSignal}`);
console.log(`  Stale (${STALE_THRESHOLD}-${VERY_STALE_THRESHOLD}d):    ${stale15d}`);
console.log(`  Very stale (>${VERY_STALE_THRESHOLD}d): ${stale30d}`);
console.log(`  Missing data:      ${missing}`);
console.log(`  Low comps (<${LOW_COMP_THRESHOLD}):  ${lowComps}`);
console.log('');
console.log('  By composition:');
const compOrder = ['bullion', 'bullion-proof', 'bullion-multioz', 'bullion-fractional-gold', 'bullion-fractional-silver', 'silver-numismatic', 'gold-numismatic', 'base-metal', 'set', 'bar', 'junk-silver', 'junk-silver-denom', 'unknown'];
for (const comp of compOrder) {
  const cs = compositionSummary[comp];
  if (!cs) continue;
  const pct = Math.round((cs.fresh / cs.total) * 100);
  console.log(`    ${comp.padEnd(26)} ${String(cs.total).padStart(5)} total  ${String(cs.fresh).padStart(5)} fresh (${pct}%)  ${String(cs.lowSignal || 0).padStart(5)} low-sig  ${String(cs.stale15d + cs.stale30d).padStart(5)} stale  ${String(cs.lowComps).padStart(5)} low-comps`);
}
console.log('');

// By metal summary
const metalSummary = {};
for (const d of datasets) {
  const m = d.metal || 'other';
  if (!metalSummary[m]) metalSummary[m] = { total: 0, fresh: 0, lowSignal: 0, stale: 0, missing: 0 };
  const ms = metalSummary[m];
  ms.total++;
  if (d.freshnessStatus === 'Fresh') ms.fresh++;
  else if (d.freshnessStatus === 'LowSignalMarketData') ms.lowSignal++;
  else if (d.freshnessStatus === 'Missing') ms.missing++;
  else ms.stale++;
}
console.log('  By metal:');
const metalOrder = ['silver', 'gold', 'platinum', 'palladium', 'other'];
for (const m of metalOrder) {
  const ms = metalSummary[m];
  if (!ms) continue;
  const pct = Math.round((ms.fresh / ms.total) * 100);
  console.log(`    ${m.padEnd(12)} ${String(ms.total).padStart(5)} total  ${String(ms.fresh).padStart(5)} fresh (${pct}%)  ${String(ms.lowSignal).padStart(5)} low-sig  ${String(ms.stale).padStart(5)} stale  ${String(ms.missing).padStart(5)} missing`);
}
console.log('');

// Top 10 stalest with data
const stalestWithData = datasets.filter(d => d.freshnessStatus === 'Stale' && d.compCount > 0);
if (stalestWithData.length > 0) {
  console.log(`  Top 10 stalest (with data):`);
  for (const d of stalestWithData.slice(0, 10)) {
    console.log(`    ${String(d.staleDays).padStart(3)}d  ${String(d.compCount).padStart(4)} comps  ${d.composition.padEnd(26)} ${d.key}`);
  }
  if (stalestWithData.length > 10) {
    console.log(`    ... and ${stalestWithData.length - 10} more`);
  }
  console.log('');
}

// Low-signal market data section
const lowSignalItems = datasets.filter(d => d.freshnessStatus === 'LowSignalMarketData');
if (lowSignalItems.length > 0) {
  console.log(`  Low-signal market data (${lowSignalItems.length} datasets, <${LOW_SIGNAL_THRESHOLD} comps):`);
  const bullionLowSig = lowSignalItems.filter(d => d.identifiers.is_bullion);
  const otherLowSig = lowSignalItems.filter(d => !d.identifiers.is_bullion);
  if (bullionLowSig.length > 0) {
    console.log(`    Bullion: ${bullionLowSig.length}`);
  }
  if (otherLowSig.length > 0) {
    console.log(`    Non-bullion: ${otherLowSig.length}`);
  }
  for (const d of lowSignalItems.slice(0, 5)) {
    const bull = d.identifiers.is_bullion ? ' [BULLION]' : '';
    console.log(`    ${String(d.compCount).padStart(4)} comps  ${d.composition.padEnd(26)} ${d.key}${bull}`);
  }
  if (lowSignalItems.length > 5) {
    console.log(`    ... and ${lowSignalItems.length - 5} more`);
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

// ── Batch generation ──────────────────────────────────────────
if (BATCH_SIZE > 0) {
  let batchPool;

  if (BATCH_MODE === 'low-signal') {
    // Low-signal mode: only LowSignalMarketData datasets
    batchPool = datasets
      .filter(d => d.freshnessStatus === 'LowSignalMarketData')
      .sort((a, b) => (a.compCount || 0) - (b.compCount || 0));
  } else if (BATCH_MODE === 'bullion') {
    // Bullion mode: only bullion-tagged datasets (any freshness status)
    batchPool = datasets
      .filter(d => d.identifiers.is_bullion && d.freshnessStatus !== 'Fresh')
      .sort((a, b) => (b.staleDays || 9999) - (a.staleDays || 9999));
  } else if (BATCH_MODE === 'all') {
    // All mode: everything that isn't Fresh
    const needsData = datasets
      .filter(d => d.actions.includes('needs-data'))
      .sort((a, b) => (b.staleDays || 9999) - (a.staleDays || 9999));
    const lowSig = datasets
      .filter(d => d.freshnessStatus === 'LowSignalMarketData')
      .sort((a, b) => (a.compCount || 0) - (b.compCount || 0));
    const refreshPage1 = datasets
      .filter(d => d.actions.includes('refresh-page1') && !d.actions.includes('needs-data'))
      .sort((a, b) => (b.staleDays || 0) - (a.staleDays || 0));
    batchPool = [...needsData, ...lowSig, ...refreshPage1];
  } else {
    // Default mode: excludes LowSignalMarketData
    const needsData = datasets
      .filter(d => d.actions.includes('needs-data') && d.freshnessStatus !== 'LowSignalMarketData')
      .sort((a, b) => (b.staleDays || 9999) - (a.staleDays || 9999));
    const refreshPage1 = datasets
      .filter(d => d.actions.includes('refresh-page1') && !d.actions.includes('needs-data'))
      .sort((a, b) => (b.staleDays || 0) - (a.staleDays || 0));
    batchPool = [...needsData, ...refreshPage1];
  }

  const batchItems = batchPool.slice(0, BATCH_SIZE);

  const batchFile = path.join(path.dirname(OUTPUT_PATH), 'freshness-batch-100.json');
  const batchOut = {
    generatedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 86400000).toISOString(),
    staleThresholdDays: STALE_THRESHOLD,
    lowSignalThreshold: LOW_SIGNAL_THRESHOLD,
    batchMode: BATCH_MODE,
    compositionFilter: COMPOSITION_FILTER || null,
    summary: {
      total: batchItems.length,
      needsData: batchItems.filter(d => d.actions.includes('needs-data')).length,
      lowSignal: batchItems.filter(d => d.freshnessStatus === 'LowSignalMarketData').length,
      refresh: batchItems.filter(d => d.actions.includes('refresh-page1')).length,
    },
    datasets: batchItems,
  };
  fs.writeFileSync(batchFile, JSON.stringify(batchOut, null, 2) + '\n');
  console.log(`  Batch written: ${batchFile} (${batchItems.length} items, mode: ${BATCH_MODE}${COMPOSITION_FILTER ? ', filter: ' + COMPOSITION_FILTER : ''})`);
}
