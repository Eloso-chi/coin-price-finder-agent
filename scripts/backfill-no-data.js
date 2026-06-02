#!/usr/bin/env node
/**
 * backfill-no-data.js
 *
 * One-shot historical backfill for BACKLOG #245 Fix C.
 *
 * Scans cache/terapeak*.log files for "NO EXPORT (no results...)" events and
 * stamps `aggregationMeta.noDataCount` + `noDataAt` on the matching dataset in
 * data/terapeak-meta.json (via terapeakService.updateDatasetMeta).
 *
 * Activates the freshness-classifier dormancy guard retroactively. Without
 * this backfill, `noDataCount` is 0 for every entry in the corpus and
 * `isDormant` can never fire.
 *
 * Usage:
 *   node scripts/backfill-no-data.js              # dry-run (default)
 *   node scripts/backfill-no-data.js --apply      # persist via updateDatasetMeta
 *   node scripts/backfill-no-data.js --since YYYY-MM-DD   # restrict to logs newer than date
 *
 * Output: cache/backfill-no-data-report.json (always written; --apply also persists meta)
 *
 * Idempotency: noDataCount only increases (max of existing + new); noDataAt
 * only advances forward. Safe to re-run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const terapeakService = require('../src/services/terapeakService');

// Hydrate the in-memory _store from the git-tracked sidecar BEFORE we touch
// listDatasets / updateDatasetMeta. Without this, the store is loaded from
// cache/terapeak_sold.json only, which is missing the evidence-only orphans
// (entries with just an `identifiers` block, no comps). saveMetaSidecar()
// would then write a truncated sidecar, deleting ~400 valid orphan entries.
terapeakService.loadMetaSidecar();

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const REPORT_PATH = path.join(CACHE_DIR, 'backfill-no-data-report.json');
const NO_DATA_CAP = 5; // never stamp more than 5 -- enough to trigger dormancy with margin

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const sinceIdx = args.indexOf('--since');
const SINCE = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const sinceMs = SINCE ? new Date(SINCE).getTime() : 0;

// ── Step 1. Find log files ─────────────────────────────────
function findLogFiles() {
  const files = fs.readdirSync(CACHE_DIR)
    .filter(f => /^terapeak.*\.log$/i.test(f))
    .map(f => {
      const full = path.join(CACHE_DIR, f);
      const stat = fs.statSync(full);
      return { name: f, path: full, mtimeMs: stat.mtimeMs };
    })
    .filter(f => f.mtimeMs >= sinceMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  return files;
}

// ── Step 2. Parse logs for NO EXPORT events ────────────────
// Format (consecutive lines):
//   [ XX%] SEARCH TERM...     WARNING: No data rows found (...)
// NO EXPORT (no results or button not found)
const TERM_LINE_RE = /^\s+\[\s*\d+%\]\s+(.+?)\.\.\./;

function parseLog(file) {
  const lines = fs.readFileSync(file.path, 'utf8').split(/\r?\n/);
  const hits = []; // { term, logName, logMtimeMs }
  let lastTerm = null;
  for (const line of lines) {
    const m = line.match(TERM_LINE_RE);
    if (m) {
      lastTerm = m[1].trim();
      continue;
    }
    if (/^NO EXPORT \(no results/.test(line) && lastTerm) {
      hits.push({ term: lastTerm, logName: file.name, logMtimeMs: file.mtimeMs });
      lastTerm = null; // consume
    }
  }
  return hits;
}

// ── Step 3. Aggregate by normalized key ────────────────────
function aggregateHits(allHits) {
  const byKey = new Map(); // normalizedKey -> { searchTerm, hitCount, lastHitMs, logs:Set, originalTerm }
  for (const h of allHits) {
    const key = terapeakService.normalizeSearchKey(h.term);
    if (!byKey.has(key)) {
      byKey.set(key, {
        normalizedKey: key,
        searchTerm: h.term,
        hitCount: 0,
        lastHitMs: 0,
        logs: new Set(),
      });
    }
    const agg = byKey.get(key);
    agg.hitCount++;
    if (h.logMtimeMs > agg.lastHitMs) agg.lastHitMs = h.logMtimeMs;
    agg.logs.add(h.logName);
  }
  return [...byKey.values()];
}

// ── Step 4. Compute the update plan vs existing meta ───────
function buildPlan(aggregated) {
  const existing = terapeakService.listDatasets();
  const byKey = new Map(existing.map(d => [d.key, d]));
  const plan = [];
  for (const a of aggregated) {
    const existingEntry = byKey.get(a.normalizedKey);
    const prevNoDataCount = existingEntry?.aggregationMeta?.noDataCount || 0;
    const prevNoDataAtMs = existingEntry?.aggregationMeta?.noDataAt
      ? new Date(existingEntry.aggregationMeta.noDataAt).getTime() : 0;
    // Use the sidecar's stored compCount marker rather than the in-memory
    // comps.length: in slim deployments (e.g. codespaces hydrating only the
    // sidecar, not Cosmos), comps.length is 0 for every entry while the
    // stored compCount marker still reflects the true historical depth.
    const sidecarCompCount = existingEntry?.aggregationMeta?.compCount;
    const liveCompCount = existingEntry?.compCount || 0;
    const prevCompCount = Math.max(liveCompCount, sidecarCompCount || 0);

    // Skip datasets that already have comps -- their last-known state is data, not no-data.
    // Treat as a successful run that reset noDataCount.
    if (prevCompCount > 0) {
      plan.push({
        ...a,
        action: 'skip',
        reason: 'dataset has comps; do not stamp historical no-data',
        prevNoDataCount,
        prevNoDataAt: existingEntry?.aggregationMeta?.noDataAt || null,
        newNoDataCount: prevNoDataCount,
        newNoDataAt: existingEntry?.aggregationMeta?.noDataAt || null,
      });
      continue;
    }

    const newNoDataCount = Math.max(prevNoDataCount, Math.min(a.hitCount, NO_DATA_CAP));
    const newNoDataAtMs = Math.max(prevNoDataAtMs, a.lastHitMs);

    if (newNoDataCount === prevNoDataCount && newNoDataAtMs === prevNoDataAtMs) {
      plan.push({
        ...a,
        action: 'skip',
        reason: 'no change (idempotent)',
        prevNoDataCount,
        prevNoDataAt: existingEntry?.aggregationMeta?.noDataAt || null,
        newNoDataCount,
        newNoDataAt: new Date(newNoDataAtMs).toISOString(),
      });
      continue;
    }

    plan.push({
      ...a,
      action: 'stamp',
      reason: existingEntry ? 'update existing meta' : 'create skeleton entry',
      prevNoDataCount,
      prevNoDataAt: existingEntry?.aggregationMeta?.noDataAt || null,
      newNoDataCount,
      newNoDataAt: new Date(newNoDataAtMs).toISOString(),
    });
  }
  return plan;
}

// ── Step 5. Apply (or dry-run) ─────────────────────────────
function applyPlan(plan) {
  let applied = 0;
  for (const p of plan) {
    if (p.action !== 'stamp') continue;
    terapeakService.updateDatasetMeta(p.searchTerm, {
      noDataCount: p.newNoDataCount,
      noDataAt: p.newNoDataAt,
    });
    applied++;
  }
  return applied;
}

// ── Main ───────────────────────────────────────────────────
function main() {
  const logs = findLogFiles();
  if (!logs.length) {
    console.error('No terapeak*.log files matched in', CACHE_DIR);
    process.exit(1);
  }
  console.log(`Scanning ${logs.length} log file(s)${SINCE ? ` since ${SINCE}` : ''}...`);

  let allHits = [];
  for (const f of logs) {
    const hits = parseLog(f);
    allHits = allHits.concat(hits);
  }
  console.log(`  Found ${allHits.length} "NO EXPORT" events across all logs.`);

  const aggregated = aggregateHits(allHits);
  console.log(`  Aggregated into ${aggregated.length} unique dataset keys.`);

  const plan = buildPlan(aggregated);
  const stampCount = plan.filter(p => p.action === 'stamp').length;
  const skipCount = plan.length - stampCount;
  console.log(`  Plan: ${stampCount} stamp, ${skipCount} skip.`);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    sinceFilter: SINCE,
    logsScanned: logs.map(l => ({ name: l.name, mtime: new Date(l.mtimeMs).toISOString() })),
    totalEvents: allHits.length,
    uniqueKeys: aggregated.length,
    stampCount,
    skipCount,
    plan: plan.map(p => ({
      ...p,
      logs: [...p.logs],
    })),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`  Report written: ${REPORT_PATH}`);

  if (APPLY) {
    const applied = applyPlan(plan);
    console.log(`\nAPPLIED: ${applied} dataset(s) updated.`);
  } else {
    console.log(`\nDRY-RUN: no changes written. Re-run with --apply to persist.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { findLogFiles, parseLog, aggregateHits, buildPlan, NO_DATA_CAP };
