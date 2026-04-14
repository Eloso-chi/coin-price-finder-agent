#!/usr/bin/env node
// scripts/greysheet-refresh.js -- Bulk Greysheet price snapshot collector
//
// Usage:
//   node scripts/greysheet-refresh.js              # Full refresh (PCGS + Type GSIDs)
//   node scripts/greysheet-refresh.js --types-only  # Only 56 Type GSIDs (~30s)
//   node scripts/greysheet-refresh.js --dry-run     # Count targets, no API calls
//
// Designed to run:
//   1. Manually from the CLI for initial seeding
//   2. Automatically from server.js on startup (if >7 days since last refresh)
//
// CommonJS

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const greysheetService = require('../src/services/greysheetService');
const greysheetHistory = require('../src/services/greysheetHistoryService');
const { TYPE_GSID_MAP } = require('../src/data/greysheetTypeMap');

// ── Collect all PCGS numbers from the static table ──────────
function getAllPcgsNumbers() {
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '..', 'src', 'data', 'pcgsNumbers.js'), 'utf8'
  );
  const nums = new Set();
  const re = /:\s*(\d{3,5})\b/g;
  let m;
  while ((m = re.exec(src)) !== null) nums.add(parseInt(m[1], 10));
  return [...nums].sort((a, b) => a - b);
}

// ── Collect all Type GSIDs ──────────────────────────────────
function getAllTypeGsids() {
  const entries = [];
  for (const [key, gsid] of Object.entries(TYPE_GSID_MAP)) {
    entries.push({ key, gsid });
  }
  return entries;
}

// ── Throttled batch processor ───────────────────────────────
async function processBatch(items, fetchFn, label, delayMs = 500) {
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  const total = items.length;

  for (let i = 0; i < total; i++) {
    const item = items[i];
    try {
      const result = await fetchFn(item);
      if (result) {
        ok++;
      } else {
        skipped++;
      }
    } catch (err) {
      fail++;
      if (process.env.NODE_ENV !== 'test') {
        process.stderr.write(`  [${label}] Error on ${JSON.stringify(item)}: ${err.message}\n`);
      }
    }

    // Progress every 50 items
    if ((i + 1) % 50 === 0 || i === total - 1) {
      process.stdout.write(`  [${label}] ${i + 1}/${total} (${ok} ok, ${skipped} no-data, ${fail} errors)\n`);
    }

    // Throttle to avoid hammering the API
    if (i < total - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return { total, ok, fail, skipped };
}

// ── Main refresh logic (also called from server.js) ─────────
async function runRefresh(options = {}) {
  const typesOnly = options.typesOnly || false;
  const dryRun = options.dryRun || false;
  const defaultGrade = options.defaultGrade || 63; // MS-63 as baseline
  const delayMs = options.delayMs || 500;

  const typeEntries = getAllTypeGsids();
  const pcgsNumbers = typesOnly ? [] : getAllPcgsNumbers();

  console.log(`[greysheet-refresh] Targets: ${pcgsNumbers.length} PCGS numbers + ${typeEntries.length} Type GSIDs`);
  console.log(`[greysheet-refresh] Default grade: MS-${defaultGrade}`);

  if (dryRun) {
    console.log('[greysheet-refresh] Dry run -- no API calls.');
    return { pcgs: { total: pcgsNumbers.length }, types: { total: typeEntries.length }, dryRun: true };
  }

  // ── Phase 1: Type GSIDs (no grade -- these are series-level) ──
  console.log(`\n[greysheet-refresh] Phase 1: ${typeEntries.length} Type GSIDs...`);
  const typeResults = await processBatch(
    typeEntries,
    async (entry) => {
      const result = await greysheetService.fetchPriceByGsid(entry.gsid, null);
      if (result && (result.greyVal || result.cpgVal)) {
        const lookupKey = greysheetHistory.makeKey(entry.gsid, null);
        greysheetHistory.recordSnapshot(lookupKey, result.greyVal, result.cpgVal);
        return result;
      }
      return null;
    },
    'types',
    delayMs
  );

  // ── Phase 2: PCGS numbers (with default grade) ──
  let pcgsResults = { total: 0, ok: 0, fail: 0, skipped: 0 };
  if (pcgsNumbers.length > 0) {
    console.log(`\n[greysheet-refresh] Phase 2: ${pcgsNumbers.length} PCGS numbers (grade ${defaultGrade})...`);
    pcgsResults = await processBatch(
      pcgsNumbers,
      async (pcgsNum) => {
        const result = await greysheetService.fetchPriceByPcgsNumber(pcgsNum, defaultGrade);
        if (result && (result.greyVal || result.cpgVal)) {
          const lookupKey = greysheetHistory.makeKey(pcgsNum, defaultGrade);
          greysheetHistory.recordSnapshot(lookupKey, result.greyVal, result.cpgVal);
          return result;
        }
        return null;
      },
      'pcgs',
      delayMs
    );
  }

  // ── Record refresh date ──
  greysheetHistory.setLastRefreshDate();

  const summary = {
    pcgs: pcgsResults,
    types: typeResults,
    totalSnapshots: typeResults.ok + pcgsResults.ok,
    coinsTracked: greysheetHistory.coinCount()
  };

  console.log('\n[greysheet-refresh] Done!');
  console.log(`  Types:  ${typeResults.ok}/${typeResults.total} snapshots`);
  console.log(`  PCGS:   ${pcgsResults.ok}/${pcgsResults.total} snapshots`);
  console.log(`  Total:  ${summary.totalSnapshots} new snapshots, ${summary.coinsTracked} coins tracked`);

  return summary;
}

// ── CLI entry point ─────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const typesOnly = args.includes('--types-only');
  const dryRun = args.includes('--dry-run');

  console.log('[greysheet-refresh] Starting bulk Greysheet price refresh...');
  runRefresh({ typesOnly, dryRun }).then(summary => {
    if (!dryRun) {
      console.log(`\nRefresh date recorded: ${greysheetHistory.getLastRefreshDate()}`);
    }
    process.exit(0);
  }).catch(err => {
    console.error('[greysheet-refresh] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { runRefresh };
