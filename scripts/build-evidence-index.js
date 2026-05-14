#!/usr/bin/env node
/**
 * build-evidence-index.js
 *
 * Reads prior Terapeak/eBay run logs (cache/*.log) and CSV files
 * (data/terapeak/*.csv), aggregates per-coin evidence, and stamps
 * durable identifiers into data/terapeak-meta.json.
 *
 * Identifiers produced per coin key:
 *   is_low_volume_candidate  -- recurring insufficient comps across runs
 *   is_bullion               -- generic bullion coin/bar/round
 *   identifier_reason        -- short human-readable explanation
 *   identifier_source        -- "historical_evidence_index"
 *   identifier_confidence    -- High | Medium | Low
 *   total_runs_seen          -- how many log runs mentioned this coin
 *   runs_with_insufficient_comps -- runs where export had < threshold comps
 *   median_comps_count       -- median comp count from CSV row counts
 *   bullion_signal_hits      -- count of bullion classification signals
 *   last_updated             -- ISO timestamp
 *
 * Usage:
 *   node scripts/build-evidence-index.js
 *   node scripts/build-evidence-index.js --dry-run          # Print results, don't write
 *   node scripts/build-evidence-index.js --min-runs 2       # Require N runs for low-volume (default 2)
 *   node scripts/build-evidence-index.js --min-pct 50       # Require X% insufficient runs (default 50)
 *   node scripts/build-evidence-index.js --low-comp-threshold 10  # Comps below this = insufficient (default 10)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { classifyComposition } = require('../src/utils/coinMetalProfile');
const { normalizeSearchKey } = require('../src/services/terapeakService');

const META_PATH = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const TERAPEAK_DIR = path.join(__dirname, '..', 'data', 'terapeak');

// ── Parse args ──────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function argInt(flag, defaultVal) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? (parseInt(args[idx + 1]) || defaultVal) : defaultVal;
}

const MIN_RUNS_FOR_LOW_VOLUME = argInt('--min-runs', 2);
const MIN_PCT_INSUFFICIENT = argInt('--min-pct', 50);
const LOW_COMP_THRESHOLD = argInt('--low-comp-threshold', 10);

// ── Centralized log parsing patterns ────────────────────────
// These patterns extract search terms and outcome signals from Terapeak
// export/aggregation logs. Kept in one place to avoid duplication.
const LOG_PATTERNS = {
  // Export log: "[  N%] SEARCH TERM... OK (X new, Y dups)"
  exportOk: /^\s*\[\s*\d+%\]\s+(.+?)\.\.\.\s+OK\s+\((\d+)\s+new,\s*(\d+)\s+dups?\)/,
  // Export log: "[  N%] SEARCH TERM... OK (+X scraped, upload: Y new, Z dups)"
  deepOk: /^\s*\[\s*\d+%\]\s+(.+?)\.\.\.\s+(?:p\d+:\d+\s*)+OK\s+\(\+(\d+)\s+scraped,\s*upload:\s*(\d+)\s+new,\s*(\d+)\s+dups?\)/,
  // No data: "WARNING: No data rows found"
  noData: /^\s*\[\s*\d+%\]\s+(.+?)\.\.\.\s+WARNING:\s+No data rows/,
  // No export: after a WARNING line, standalone "NO EXPORT"
  noExport: /^NO EXPORT/,
  // Error: "[  N%] SEARCH TERM... ERROR: ..."
  error: /^\s*\[\s*\d+%\]\s+(.+?)\.\.\.\s+ERROR:/,
};

// ── Per-coin evidence accumulator ───────────────────────────
// Map<normalizedKey, { runs_seen, insufficient_runs, comp_counts[], error_runs, terms: Set }>
const evidence = new Map();

function getEvidence(normKey) {
  if (!evidence.has(normKey)) {
    evidence.set(normKey, {
      runs_seen: 0,
      insufficient_runs: 0,
      comp_counts: [],
      error_runs: 0,
      terms: new Set(),
    });
  }
  return evidence.get(normKey);
}

// ── 1. Parse log files ──────────────────────────────────────
function parseLogFiles() {
  if (!fs.existsSync(CACHE_DIR)) return;

  const logFiles = fs.readdirSync(CACHE_DIR)
    .filter(f => /^(terapeak_|aggregator_|export_|refresh_).*\.log$/i.test(f))
    .map(f => path.join(CACHE_DIR, f));

  console.log(`  Scanning ${logFiles.length} log files...`);

  let totalEntries = 0;
  let lastSearchTerm = null; // Track for NO EXPORT lines that follow a WARNING

  for (const logPath of logFiles) {
    let lines;
    try {
      lines = fs.readFileSync(logPath, 'utf8').split('\n');
    } catch {
      continue;
    }

    for (const line of lines) {
      // Try export OK pattern
      let m = line.match(LOG_PATTERNS.exportOk);
      if (m) {
        const term = m[1].trim();
        const newComps = parseInt(m[2]) || 0;
        const dups = parseInt(m[3]) || 0;
        const totalComps = newComps + dups;
        const normKey = normalizeSearchKey(term);
        if (!normKey) continue;

        const ev = getEvidence(normKey);
        ev.runs_seen++;
        ev.terms.add(term);
        ev.comp_counts.push(totalComps);
        if (totalComps < LOW_COMP_THRESHOLD) ev.insufficient_runs++;
        lastSearchTerm = null;
        totalEntries++;
        continue;
      }

      // Try deep-aggregation OK pattern
      m = line.match(LOG_PATTERNS.deepOk);
      if (m) {
        const term = m[1].trim();
        const scraped = parseInt(m[2]) || 0;
        const newComps = parseInt(m[3]) || 0;
        const dups = parseInt(m[4]) || 0;
        const normKey = normalizeSearchKey(term);
        if (!normKey) continue;

        const ev = getEvidence(normKey);
        ev.runs_seen++;
        ev.terms.add(term);
        ev.comp_counts.push(newComps + dups);
        // Deep runs typically have many comps; only flag insufficient if scraped total is low
        if (scraped < LOW_COMP_THRESHOLD) ev.insufficient_runs++;
        lastSearchTerm = null;
        totalEntries++;
        continue;
      }

      // No data warning
      m = line.match(LOG_PATTERNS.noData);
      if (m) {
        const term = m[1].trim();
        lastSearchTerm = term;
        const normKey = normalizeSearchKey(term);
        if (!normKey) continue;

        const ev = getEvidence(normKey);
        ev.runs_seen++;
        ev.terms.add(term);
        ev.comp_counts.push(0);
        ev.insufficient_runs++;
        totalEntries++;
        continue;
      }

      // NO EXPORT (follows a WARNING line -- associate with last search term)
      if (LOG_PATTERNS.noExport.test(line) && lastSearchTerm) {
        // Already counted via noData above; just reset
        lastSearchTerm = null;
        continue;
      }

      // Error line
      m = line.match(LOG_PATTERNS.error);
      if (m) {
        const term = m[1].trim();
        const normKey = normalizeSearchKey(term);
        if (!normKey) continue;

        const ev = getEvidence(normKey);
        ev.runs_seen++;
        ev.terms.add(term);
        ev.error_runs++;
        lastSearchTerm = null;
        totalEntries++;
        continue;
      }
    }
  }

  console.log(`  Parsed ${totalEntries} log entries across ${evidence.size} coin keys`);
}

// ── 2. Count CSV rows and extract sale dates per dataset ────
function parseCSVRowCounts() {
  if (!fs.existsSync(TERAPEAK_DIR)) return;

  const csvFiles = fs.readdirSync(TERAPEAK_DIR).filter(f => f.endsWith('.csv'));
  console.log(`  Scanning ${csvFiles.length} CSV files for row counts...`);

  // Date parsing: "Jan 1, 2026" / "Dec 31, 2025" / ISO dates
  const MONTH_MAP = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  function parseSoldDate(val) {
    if (!val) return null;
    const s = val.replace(/^"|"$/g, '').trim();
    // Try "Mon DD, YYYY"
    const m = s.match(/^(\w{3})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m) {
      const mon = MONTH_MAP[m[1].toLowerCase()];
      if (mon != null) return new Date(parseInt(m[3]), mon, parseInt(m[2]));
    }
    // Try ISO
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  let counted = 0;
  for (const f of csvFiles) {
    try {
      const filePath = path.join(TERAPEAK_DIR, f);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const rowCount = Math.max(0, lines.length - 1); // subtract header

      const searchTerm = f.slice(0, -4).replace(/[_]+/g, ' ').trim();
      const normKey = normalizeSearchKey(searchTerm);
      if (!normKey) continue;

      const ev = getEvidence(normKey);
      ev.terms.add(searchTerm);

      // CSV row count is the most reliable comp count signal
      if (!ev._csvCounted) {
        ev.comp_counts.push(rowCount);
        ev._csvCounted = true;
        ev._csvCompCount = rowCount;
        // Don't increment runs_seen or insufficient_runs here --
        // a CSV on disk is not a separate "run", it's the result of one.
        // The log parsing already counted the run that produced this CSV.
        // Only set minimum runs_seen if no log mentions this key.
        if (ev.runs_seen === 0) ev.runs_seen = 1;
      }

      // Extract newest/oldest sale dates from Sold Date column
      if (lines.length > 1) {
        const header = lines[0].toLowerCase();
        // Find the Sold Date column index
        const cols = lines[0].split(',').map(c => c.replace(/^"|"$/g, '').trim().toLowerCase());
        const dateIdx = cols.indexOf('sold date');
        if (dateIdx >= 0) {
          let newest = null;
          let oldest = null;
          for (let i = 1; i < lines.length; i++) {
            // Simple CSV field extraction (handles quoted fields with commas)
            const fields = [];
            let field = '';
            let inQuotes = false;
            for (const ch of lines[i]) {
              if (ch === '"') { inQuotes = !inQuotes; continue; }
              if (ch === ',' && !inQuotes) { fields.push(field); field = ''; continue; }
              field += ch;
            }
            fields.push(field);
            const d = parseSoldDate(fields[dateIdx]);
            if (d) {
              if (!newest || d > newest) newest = d;
              if (!oldest || d < oldest) oldest = d;
            }
          }
          if (newest) ev._newestSaleDate = newest.toISOString().split('T')[0];
          if (oldest) ev._oldestSaleDate = oldest.toISOString().split('T')[0];
        }
      }

      counted++;
    } catch {
      // Skip unreadable files
    }
  }

  console.log(`  Counted rows for ${counted} CSV files`);
}

// ── 3. Compute identifiers ─────────────────────────────────
function computeIdentifiers() {
  const identifiers = new Map();
  const now = new Date().toISOString();

  for (const [normKey, ev] of evidence) {
    // -- Bullion detection: reuse classifyComposition from coinMetalProfile --
    const composition = classifyComposition(normKey);
    const isBullion = composition === 'bullion' || composition === 'bar' || composition.startsWith('bullion-fractional');
    const bullionSignalHits = isBullion ? 1 : 0;

    // -- Low-volume candidate detection --
    // Must have been seen in at least MIN_RUNS_FOR_LOW_VOLUME runs
    // AND have insufficient comps in >= MIN_PCT_INSUFFICIENT% of runs
    const totalRuns = ev.runs_seen;
    const insufficientRuns = ev.insufficient_runs;
    const insufficientPct = totalRuns > 0 ? (insufficientRuns / totalRuns) * 100 : 0;

    const isLowVolumeCandidate = totalRuns >= MIN_RUNS_FOR_LOW_VOLUME
      && insufficientPct >= MIN_PCT_INSUFFICIENT;

    // -- Median comps count --
    let medianComps = null;
    if (ev.comp_counts.length > 0) {
      const sorted = [...ev.comp_counts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianComps = sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    }

    // -- Confidence --
    // High: multiple runs with consistent signal
    // Medium: some data but limited runs
    // Low: single run or mostly errors
    let confidence;
    if (totalRuns >= 3 && ev.error_runs / totalRuns < 0.5) {
      confidence = 'High';
    } else if (totalRuns >= 2 || (totalRuns === 1 && ev.comp_counts.length > 0)) {
      confidence = 'Medium';
    } else {
      confidence = 'Low';
    }

    // -- Build reason string --
    const reasons = [];
    if (isLowVolumeCandidate) {
      reasons.push(`insufficient comps in ${insufficientRuns}/${totalRuns} runs (${Math.round(insufficientPct)}%)`);
    }
    if (medianComps !== null) {
      reasons.push(`median ${medianComps} comps`);
    }
    if (isBullion) {
      reasons.push(`${composition} detected via classifyComposition`);
    }
    if (ev.error_runs > 0) {
      reasons.push(`${ev.error_runs} error runs`);
    }

    identifiers.set(normKey, {
      is_low_volume_candidate: isLowVolumeCandidate,
      is_bullion: isBullion,
      identifier_reason: reasons.join('; ') || 'no actionable signals',
      identifier_source: 'historical_evidence_index',
      identifier_confidence: confidence,
      total_runs_seen: totalRuns,
      runs_with_insufficient_comps: insufficientRuns,
      median_comps_count: medianComps,
      bullion_signal_hits: bullionSignalHits,
      last_updated: now,
    });
  }

  return identifiers;
}

// ── 4. Merge into terapeak-meta.json (non-destructive) ──────
function persistIdentifiers(identifiers) {
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    if (!meta || typeof meta !== 'object') meta = {};
  } catch {
    meta = {};
  }

  let updated = 0;
  let created = 0;

  for (const [normKey, ids] of identifiers) {
    if (!meta[normKey]) {
      meta[normKey] = {};
      created++;
    }

    const existing = meta[normKey].identifiers || {};

    // Non-destructive merge: only overwrite if new evidence is stronger
    // or if no prior identifier exists
    const shouldUpdate = !existing.identifier_source
      || existing.identifier_confidence === 'Low'
      || ids.total_runs_seen > (existing.total_runs_seen || 0);

    if (shouldUpdate) {
      meta[normKey].identifiers = ids;
      updated++;
    }

    // Populate top-level meta fields from CSV evidence so that
    // generate-freshness-report.js can read compCount/newestSaleDate
    const ev = evidence.get(normKey);
    if (ev) {
      if (ev._csvCompCount != null && meta[normKey].compCount == null) {
        meta[normKey].compCount = ev._csvCompCount;
      }
      if (ev._newestSaleDate && !meta[normKey].newestSaleDate) {
        meta[normKey].newestSaleDate = ev._newestSaleDate;
      }
      if (ev._oldestSaleDate && !meta[normKey].oldestSaleDate) {
        meta[normKey].oldestSaleDate = ev._oldestSaleDate;
      }
    }
  }

  if (!dryRun) {
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');
  }

  return { updated, created, total: identifiers.size };
}

// ── Main ────────────────────────────────────────────────────
console.log('\nBuilding Historical Evidence Index...');
console.log(`  Config: min-runs=${MIN_RUNS_FOR_LOW_VOLUME}, min-pct=${MIN_PCT_INSUFFICIENT}%, low-comp-threshold=${LOW_COMP_THRESHOLD}`);
console.log('');

parseLogFiles();
parseCSVRowCounts();

const identifiers = computeIdentifiers();

// Print summary
const lowVolCount = [...identifiers.values()].filter(v => v.is_low_volume_candidate).length;
const bullionCount = [...identifiers.values()].filter(v => v.is_bullion).length;
const bothCount = [...identifiers.values()].filter(v => v.is_low_volume_candidate && v.is_bullion).length;

console.log('');
console.log(`  Evidence Index Summary:`);
console.log(`    Total coin keys:         ${identifiers.size}`);
console.log(`    Low-volume candidates:   ${lowVolCount}`);
console.log(`    Bullion-tagged:          ${bullionCount}`);
console.log(`    Both (low-vol + bullion): ${bothCount}`);
console.log('');

// Show sample identifiers
const samples = [...identifiers.entries()]
  .filter(([, v]) => v.is_low_volume_candidate || v.is_bullion)
  .slice(0, 5);
if (samples.length > 0) {
  console.log('  Sample identifiers:');
  for (const [key, ids] of samples) {
    const flags = [
      ids.is_low_volume_candidate ? 'LOW-VOL' : null,
      ids.is_bullion ? 'BULLION' : null,
    ].filter(Boolean).join('+');
    console.log(`    ${key.slice(0, 50).padEnd(50)} [${flags}] ${ids.identifier_confidence} -- ${ids.identifier_reason.slice(0, 80)}`);
  }
  console.log('');
}

if (dryRun) {
  console.log('  (--dry-run mode, no file written)');
} else {
  const result = persistIdentifiers(identifiers);
  console.log(`  Persisted to ${META_PATH}`);
  console.log(`    Updated: ${result.updated}, New entries: ${result.created}, Total keys: ${result.total}`);
}
console.log('');
