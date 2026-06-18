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
const { THRESHOLDS } = require('../src/services/freshnessClassifier');

// META_PATH may be overridden via env so jest tests can point at a per-worker
// tmpdir (#273H). Without the hook, parallel workers race on the real file.
const META_PATH = process.env.META_PATH || path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'cache', 'freshness-report.json');
const VALIDITY_HOURS = 24;

// ── Parse args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const summaryOnly = args.includes('--summary');
const staleIdx = args.indexOf('--stale');
const STALE_THRESHOLD = staleIdx >= 0 ? parseInt(args[staleIdx + 1]) || THRESHOLDS.STALE_THRESHOLD_DAYS : THRESHOLDS.STALE_THRESHOLD_DAYS;
const VERY_STALE_THRESHOLD = STALE_THRESHOLD * THRESHOLDS.VERY_STALE_MULTIPLIER;
const LOW_COMP_THRESHOLD = 100;

// Market depth thresholds (sourced from src/services/freshnessClassifier.js
// so adminService.getStaleDatasets() applies the same exclusions).
const THIN_MARKET_THRESHOLD = THRESHOLDS.THIN_MARKET_THRESHOLD;
const CONFIRMED_THIN_REFRESHES = THRESHOLDS.CONFIRMED_THIN_REFRESHES;
const THIN_MARKET_CADENCE_DAYS = THRESHOLDS.THIN_MARKET_CADENCE_DAYS;
const RECENTLY_REFRESHED_DAYS = THRESHOLDS.RECENTLY_REFRESHED_DAYS;

// Dry-refresh backoff: when refreshes consistently yield 0 new comps, extend cadence
const DRY_REFRESH_TIER1 = THRESHOLDS.DRY_REFRESH_TIER1;
const DRY_REFRESH_TIER2 = THRESHOLDS.DRY_REFRESH_TIER2;
const DRY_REFRESH_TIER1_DAYS = THRESHOLDS.DRY_REFRESH_TIER1_DAYS;
const DRY_REFRESH_TIER2_DAYS = THRESHOLDS.DRY_REFRESH_TIER2_DAYS;

// Low-signal threshold (backward compat): datasets with comps > 0 but < this value.
const lowSigIdx = args.indexOf('--low-signal');
const LOW_SIGNAL_THRESHOLD = lowSigIdx >= 0 ? parseInt(args[lowSigIdx + 1]) || 10 : THIN_MARKET_THRESHOLD;

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

  // ── Two-axis classification ────────────────────────────────
  // Axis 1: Freshness (temporal -- when was data last pulled?)
  // Axis 2: Market Depth (structural -- does this market have enough volume?)
  const csvExists = hasCSVOnDisk(key);
  const refreshCount = entry.refreshCount || 0;
  const lastRefreshAt = entry.lastRefreshAt || entry.page1At || null;
  const lastRefreshDays = lastRefreshAt ? Math.floor((today - new Date(lastRefreshAt)) / 86400000) : null;

  // Axis 1: Freshness
  let freshness;
  if (compCount === 0 && newestSaleDate === null) {
    freshness = csvExists ? 'stale' : 'missing';
  } else if (staleDays !== null && staleDays >= VERY_STALE_THRESHOLD) {
    freshness = 'very-stale';
  } else if (staleDays !== null && staleDays >= STALE_THRESHOLD) {
    freshness = 'stale';
  } else if (staleDays !== null) {
    freshness = 'fresh';
  } else {
    freshness = 'stale'; // comps but no dates = treat as stale
  }

  // Axis 2: Market Depth
  // #248: dry-confirmed-thin escalation -- mirrors classify() in
  // src/services/freshnessClassifier.js. A single refresh that added 0 new
  // comps while total comps stay <THIN_MARKET_THRESHOLD escalates immediately
  // to confirmed-thin (no need to wait for CONFIRMED_THIN_REFRESHES cycles).
  let marketDepth;
  const lastRefreshNewComps = entry.lastRefreshNewComps ?? null;
  const dryConfirmedThin = refreshCount >= 1 && entry.lastRefreshNewComps === 0;
  if (compCount === 0 && !csvExists && refreshCount === 0) {
    marketDepth = 'untested';
  } else if (compCount === 0) {
    marketDepth = 'empty';
  } else if (compCount < THIN_MARKET_THRESHOLD) {
    if (refreshCount >= CONFIRMED_THIN_REFRESHES || dryConfirmedThin) {
      marketDepth = 'confirmed-thin';
    } else {
      marketDepth = 'thin';
    }
  } else {
    marketDepth = 'viable';
  }

  // Dormant detection: datasets with >= 2 consecutive no-data attempts
  // within the last 60 days are marked dormant and excluded from refresh queues.
  const noDataCount = entry.noDataCount || 0;
  const noDataAt = entry.noDataAt || null;
  const noDataAgeDays = noDataAt ? Math.floor((today - new Date(noDataAt)) / 86400000) : null;
  const isDormant = noDataCount >= 2 && noDataAgeDays !== null && noDataAgeDays < 60;

  // Dry-refresh backoff: consecutive refreshes that yielded 0 new comps
  // (lastRefreshNewComps already declared above for #248 dryConfirmedThin gate)
  const consecutiveDryRefreshes = entry.consecutiveDryRefreshes || 0;

  // ── Backward-compat: derive legacy freshnessStatus ─────────
  let freshnessStatus;
  let freshnessReason;
  if (freshness === 'missing') {
    freshnessStatus = 'Missing';
    freshnessReason = csvExists ? 'CSV exists but meta not backfilled' : 'No data collected yet';
  } else if (marketDepth === 'thin' || marketDepth === 'confirmed-thin') {
    freshnessStatus = 'LowSignalMarketData';
    freshnessReason = `Only ${compCount} comp(s); thin market (${refreshCount} refreshes)`;
  } else if (freshness === 'stale' || freshness === 'very-stale') {
    freshnessStatus = 'Stale';
    freshnessReason = `Newest sale ${staleDays}d ago (threshold: ${STALE_THRESHOLD}d)`;
  } else {
    freshnessStatus = 'Fresh';
    freshnessReason = `Newest sale ${staleDays}d ago`;
  }

  // ── Priority-based actions (from matrix) ───────────────────
  const actions = [];
  let priority = null; // P0=urgent, P1=normal, P2=background, P3=monitor, null=skip

  // BACKLOG #245 Fix A: high-confidence historical evidence of low volume.
  // build-evidence-index.js stamps is_low_volume_candidate=true with
  // identifier_confidence='High' on datasets that returned 0 comps across
  // multiple runs. Skip these from the queue on quarterly cadence rather
  // than waiting for noDataCount-based dormancy to converge.
  const EVIDENCE_LOW_VOL_CADENCE_DAYS = 90;
  const storedIdsEarly = entry.identifiers || null;
  const isHighConfLowVol = !!(storedIdsEarly
    && storedIdsEarly.is_low_volume_candidate === true
    && storedIdsEarly.identifier_confidence === 'High');
  const evidenceLowVolSkip = isHighConfLowVol
    && (lastRefreshDays === null || lastRefreshDays < EVIDENCE_LOW_VOL_CADENCE_DAYS);

  // #248: Medium-confidence low-vol candidates that have never been
  // runtime-probed. Demote from P0/P1 refresh queues to a single P3
  // evidence-probe (page-1 fetch). Once refreshCount >= 1 they flow back
  // into normal classification: if still <THIN_MARKET_THRESHOLD and the
  // probe added 0 new comps they become confirmed-thin via dryConfirmedThin
  // above; otherwise they re-enter the standard refresh cadence.
  const isMediumConfLowVol = !!(storedIdsEarly
    && storedIdsEarly.is_low_volume_candidate === true
    && storedIdsEarly.identifier_confidence === 'Medium');
  const evidenceProbeNeeded = isMediumConfLowVol && refreshCount === 0;

  if (isDormant) {
    actions.push('dormant');
    priority = null;
  } else if (evidenceLowVolSkip) {
    actions.push('evidence-low-vol');
    priority = null;
  } else if (evidenceProbeNeeded) {
    actions.push('evidence-probe');
    priority = 'P3';
  } else if (freshness === 'missing' && marketDepth === 'untested') {
    actions.push('initial-fetch');
    priority = 'P2';
  } else if (marketDepth === 'confirmed-thin') {
    // Confirmed thin: only refresh on extended cadence (90d)
    if (lastRefreshDays !== null && lastRefreshDays >= 90) {
      actions.push('monitor-refresh');
      priority = 'P3';
    } else {
      actions.push('confirmed-thin-skip');
      priority = null;
    }
  } else if (marketDepth === 'thin') {
    // Thin market: refresh on 60d cadence only
    if (lastRefreshDays === null || lastRefreshDays >= THIN_MARKET_CADENCE_DAYS) {
      actions.push('monitor-refresh');
      priority = 'P3';
    } else {
      actions.push('thin-wait');
      priority = null;
    }
  } else if (marketDepth === 'empty') {
    actions.push('dormant');
    priority = null;
  } else if (freshness === 'very-stale' && marketDepth === 'viable') {
    if (lastRefreshDays !== null && lastRefreshDays < RECENTLY_REFRESHED_DAYS) {
      // Recently scraped but market has no new sales -- don't re-queue
      actions.push('recently-confirmed-stale');
      priority = null;
    } else if (consecutiveDryRefreshes >= DRY_REFRESH_TIER2 && lastRefreshDays !== null && lastRefreshDays < DRY_REFRESH_TIER2_DAYS) {
      actions.push('dry-refresh-backoff');
      priority = null;
    } else if (consecutiveDryRefreshes >= DRY_REFRESH_TIER1 && lastRefreshDays !== null && lastRefreshDays < DRY_REFRESH_TIER1_DAYS) {
      actions.push('dry-refresh-backoff');
      priority = null;
    } else {
      actions.push('refresh');
      priority = 'P0';
    }
  } else if (freshness === 'stale' && marketDepth === 'viable') {
    if (lastRefreshDays !== null && lastRefreshDays < RECENTLY_REFRESHED_DAYS) {
      actions.push('recently-confirmed-stale');
      priority = null;
    } else if (consecutiveDryRefreshes >= DRY_REFRESH_TIER2 && lastRefreshDays !== null && lastRefreshDays < DRY_REFRESH_TIER2_DAYS) {
      actions.push('dry-refresh-backoff');
      priority = null;
    } else if (consecutiveDryRefreshes >= DRY_REFRESH_TIER1 && lastRefreshDays !== null && lastRefreshDays < DRY_REFRESH_TIER1_DAYS) {
      actions.push('dry-refresh-backoff');
      priority = null;
    } else {
      actions.push('refresh');
      priority = 'P1';
    }
  } else if (freshness === 'fresh' && marketDepth === 'viable') {
    actions.push('ok');
    priority = null;
  } else {
    actions.push('ok');
    priority = null;
  }

  // Deep-paginate: viable + >=50 comps + not yet deep-paged + at least one runtime-confirmed page-1.
  // Gating on `refreshCount >= 1` (not `page1At`) is intentional -- see backlog #247: the Python
  // scraper stamps only `lastRefreshAt`, while the JS route stamps `page1At`; post-#245 Fix D,
  // `refreshCount` is the canonical "has been runtime-touched" marker. Evidence-hydrated entries
  // (refreshCount=0) graduate to deep-paginate naturally after the cheap page-1 refresh.
  if (compCount >= 50 && !hasDeepAt && marketDepth === 'viable' && refreshCount >= 1) {
    actions.push('deep-paginate');
  }
  if (actions.length === 0) actions.push('ok');

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
    // New two-axis classification
    freshness,
    marketDepth,
    priority,
    // Legacy (backward compat)
    freshnessStatus,
    freshnessReason,
    composition,
    metal: metal || 'other',
    gradeCategory,
    newestSaleDate,
    staleDays,
    compCount,
    refreshCount,
    lastRefreshDays,
    hasDeepAt,
    actions,
    identifiers,
    ...(noDataCount > 0 ? { noDataCount, noDataAt } : {}),
    ...(consecutiveDryRefreshes > 0 ? { consecutiveDryRefreshes, lastRefreshNewComps } : {}),
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

// Sort: by priority tier first (P0 > P1 > P2 > P3 > null), then stalest first
const priorityOrder = { P0: 0, P1: 1, P2: 2, P3: 3 };
datasets.sort((a, b) => {
  const pa = a.priority ? priorityOrder[a.priority] : 99;
  const pb = b.priority ? priorityOrder[b.priority] : 99;
  if (pa !== pb) return pa - pb;
  // Within same priority, stalest first
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

// New: priority-based counts
const recentlyConfirmedStale = datasets.filter(d => d.actions && d.actions.includes('recently-confirmed-stale')).length;
const dryRefreshBackoff = datasets.filter(d => d.actions && d.actions.includes('dry-refresh-backoff')).length;
const priorityCounts = {
  P0: datasets.filter(d => d.priority === 'P0').length,
  P1: datasets.filter(d => d.priority === 'P1').length,
  P2: datasets.filter(d => d.priority === 'P2').length,
  P3: datasets.filter(d => d.priority === 'P3').length,
  skip: datasets.filter(d => d.priority === null).length,
  recentlyConfirmedStale,
  dryRefreshBackoff,
};
const depthCounts = {
  viable: datasets.filter(d => d.marketDepth === 'viable').length,
  thin: datasets.filter(d => d.marketDepth === 'thin').length,
  'confirmed-thin': datasets.filter(d => d.marketDepth === 'confirmed-thin').length,
  empty: datasets.filter(d => d.marketDepth === 'empty').length,
  untested: datasets.filter(d => d.marketDepth === 'untested').length,
};

const summary = {
  total,
  fresh,
  stale15d,
  stale30d,
  missing,
  lowSignal,
  lowComps,
  lowSignalThreshold: LOW_SIGNAL_THRESHOLD,
  priorityCounts,
  depthCounts,
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
console.log('  Priority queue (action tiers):');
console.log(`    P0 refresh-urgent:  ${priorityCounts.P0}`);
console.log(`    P1 refresh:         ${priorityCounts.P1}`);
console.log(`    P2 initial-fetch:   ${priorityCounts.P2}`);
console.log(`    P3 monitor:         ${priorityCounts.P3}`);
console.log(`    Skip (ok/dormant):  ${priorityCounts.skip}`);
console.log(`    Actionable total:   ${priorityCounts.P0 + priorityCounts.P1 + priorityCounts.P2 + priorityCounts.P3}`);
console.log(`    Recently-confirmed-stale (scraped <${RECENTLY_REFRESHED_DAYS}d, no new sales): ${recentlyConfirmedStale}`);
console.log('');
console.log('  Market depth:');
console.log(`    Viable (>=10):      ${depthCounts.viable}`);
console.log(`    Thin (1-9):         ${depthCounts.thin}`);
console.log(`    Confirmed thin:     ${depthCounts['confirmed-thin']}`);
console.log(`    Empty (0 after try):${depthCounts.empty}`);
console.log(`    Untested:           ${depthCounts.untested}`);
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
    // Low-signal mode: thin + confirmed-thin datasets (backward compat)
    batchPool = datasets
      .filter(d => d.marketDepth === 'thin' || d.marketDepth === 'confirmed-thin')
      .sort((a, b) => (a.compCount || 0) - (b.compCount || 0));
  } else if (BATCH_MODE === 'bullion') {
    // Bullion mode: only bullion-tagged datasets that have an action
    batchPool = datasets
      .filter(d => d.identifiers.is_bullion && d.priority !== null)
      .sort((a, b) => (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99));
  } else if (BATCH_MODE === 'all') {
    // All mode: everything actionable (P0-P3), sorted by priority
    batchPool = datasets
      .filter(d => d.priority !== null)
      .sort((a, b) => (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99));
  } else {
    // Default mode: P0 + P1 only (viable markets needing refresh)
    batchPool = datasets
      .filter(d => d.priority === 'P0' || d.priority === 'P1')
      .sort((a, b) => (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99));
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
      P0: batchItems.filter(d => d.priority === 'P0').length,
      P1: batchItems.filter(d => d.priority === 'P1').length,
      P2: batchItems.filter(d => d.priority === 'P2').length,
      P3: batchItems.filter(d => d.priority === 'P3').length,
    },
    datasets: batchItems,
  };
  fs.writeFileSync(batchFile, JSON.stringify(batchOut, null, 2) + '\n');
  console.log(`  Batch written: ${batchFile} (${batchItems.length} items, mode: ${BATCH_MODE}${COMPOSITION_FILTER ? ', filter: ' + COMPOSITION_FILTER : ''})`);
}
