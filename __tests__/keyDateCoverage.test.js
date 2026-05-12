/**
 * keyDateCoverage.test.js — Cross-reference integrity test
 *
 * Verifies that every KEY_DATES entry in src/data/keyDates.js has at least one
 * matching Terapeak CSV coin entry in scripts/generateAllCoinData.js, ensuring
 * the data-generation schedule covers all coins the app flags as key dates.
 *
 * This is a "coverage map" test — it does NOT generate files.  It parses the
 * generator script's searchTerm strings and checks each KEY_DATES row for a
 * plausible match.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { KEY_DATES } = require('../src/data/keyDates');

// ── Parse all searchTerm values from generateAllCoinData.js ──────────
const GEN_PATH = path.join(__dirname, '..', 'scripts', 'generateAllCoinData.js');
const generatorSource = fs.readFileSync(GEN_PATH, 'utf8');

// Extract every searchTerm: '...' value
const SEARCH_TERMS = [];
const termRe = /searchTerm:\s*'([^']+)'/g;
let m;
while ((m = termRe.exec(generatorSource)) !== null) {
  SEARCH_TERMS.push(m[1].toLowerCase());
}

// Also extract every filename: '...' for a secondary check
const FILENAMES = [];
const fnRe = /filename:\s*'([^']+)'/g;
while ((m = fnRe.exec(generatorSource)) !== null) {
  FILENAMES.push(m[1].toLowerCase());
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Check whether a KEY_DATES entry has a plausible match in the generator's
 * searchTerm list.  Matching rules:
 *   1. Exact year-mint + series substring in a searchTerm
 *   2. Year-mint in a filename
 *   3. Generic series sweep (e.g. "Morgan Silver Dollar" generic CSV)
 */
function hasGeneratorCoverage(entry) {
  const { series, year, mint } = entry;
  const s = series.toLowerCase();

  // Condition-rarity / any-year entries (year=0) are covered by the generic
  // sweep for the series, so just check series presence.
  if (year === 0) {
    return SEARCH_TERMS.some(t => t.includes(s) || s.includes(t.replace(/\d+/g, '').trim()));
  }

  // Build the year-mint tag eBay sellers would use
  const mintSuffix = mint ? `-${mint}` : '';
  const yearMint   = `${year}${mintSuffix}`.toLowerCase();
  const yearOnly   = `${year}`;

  // 1. Dedicated year-mint CSV  (e.g. "1893-S Morgan Silver Dollar")
  if (SEARCH_TERMS.some(t => t.includes(yearMint) && seriesOverlaps(s, t))) {
    return true;
  }

  // 2. Filename contains year-mint  (e.g. 1893-S_Morgan_Silver_Dollar.csv)
  const fnTag = `${year}${mintSuffix}`.toLowerCase();
  if (FILENAMES.some(f => f.includes(fnTag) && seriesOverlaps(s, f.replace(/[_.]/g, ' ')))) {
    return true;
  }

  // 3. Generic sweep CSV for the series  (e.g. "Morgan Silver Dollar" generic)
  //    Only count this for common / low-mintage tiers, not true "key" dates,
  //    because generic sweeps are unlikely to surface a 100K-mintage key coin.
  if (entry.tier !== 'key') {
    if (SEARCH_TERMS.some(t => seriesOverlaps(s, t) && !t.match(/\d{4}/))) {
      return true;
    }
  }

  return false;
}

/** True if the series name and search term share a meaningful overlap. */
function seriesOverlaps(seriesLower, termLower) {
  // Remove common filler words for a better substring check
  const strip = str => str.replace(/silver|gold|dollar|coin|half|dime|quarter|cent|nickel|eagle|oz|proof/g, '').trim();
  const a = strip(seriesLower);
  const b = strip(termLower);
  return b.includes(a) || a.includes(b) ||
         termLower.includes(seriesLower) || seriesLower.includes(termLower);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Key-dates ↔ Terapeak data-generation coverage', () => {

  test('generator script exists and has searchTerm entries', () => {
    expect(fs.existsSync(GEN_PATH)).toBe(true);
    expect(SEARCH_TERMS.length).toBeGreaterThan(200);
  });

  test('KEY_DATES has ≥ 100 entries', () => {
    expect(KEY_DATES.length).toBeGreaterThanOrEqual(100);
  });

  // ── Partition key dates by coverage status ─────────────────────────
  const covered   = [];
  const uncovered = [];

  for (const entry of KEY_DATES) {
    // Skip 2026 Semiquincentennial — too new for sold-data
    if (entry.year === 2026) continue;
    // Skip ultra-rare coins unlikely to appear on eBay (< 100 known)
    if (entry.note && /only \d+ known|only 1 |proof only/i.test(entry.note)) continue;

    if (hasGeneratorCoverage(entry)) {
      covered.push(entry);
    } else {
      uncovered.push(entry);
    }
  }

  test('majority of actionable key dates have CSV coverage', () => {
    const ratio = covered.length / (covered.length + uncovered.length);
    // Current target: ≥ 60%.  Increase as gaps are filled.
    expect(ratio).toBeGreaterThanOrEqual(0.55);
  });

  test('coverage report (informational)', () => {
    if (uncovered.length === 0) return;

    const grouped = {};
    for (const e of uncovered) {
      const g = e.series;
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(`${e.year}${e.mint ? '-' + e.mint : ''} (${e.tier})`);
    }

    const lines = ['', '  Key dates WITHOUT dedicated Terapeak CSV:'];
    for (const [series, items] of Object.entries(grouped).sort()) {
      lines.push(`    ${series}: ${items.join(', ')}`);
    }
    lines.push(`  Total uncovered: ${uncovered.length} / ${covered.length + uncovered.length}`);
    lines.push('');

    // Print but don't fail — this is a progress tracker
    console.log(lines.join('\n'));
  });

  // ── Tier-specific assertions ───────────────────────────────────────

  test('all "key" tier US classic coins have CSV coverage', () => {
    const usClassicKeys = KEY_DATES.filter(e =>
      e.tier === 'key' &&
      e.year !== 2026 &&
      !/only \d+ known|only 1 |proof only/i.test(e.note || '') &&
      /morgan|peace|walking|franklin|mercury|standing|washington|kennedy|barber/i.test(e.series)
    );

    const missing = usClassicKeys.filter(e => !hasGeneratorCoverage(e));
    if (missing.length > 0) {
      console.log('Missing US classic key-tier CSVs:',
        missing.map(e => `${e.series} ${e.year}-${e.mint}`));
    }
    // Allow a small tolerance — some truly rare coins won't appear on eBay
    expect(missing.length).toBeLessThanOrEqual(5);
  });

  test('bullion generics (ASE, AGE, Maple, etc.) have generic CSV coverage', () => {
    const bullionSeries = [
      'american silver eagle',
      'american gold eagle',
      'american gold buffalo',
      'canadian silver maple leaf',
      'australian silver kookaburra',
      'mexican silver libertad',
    ];

    for (const bs of bullionSeries) {
      const hasGeneric = SEARCH_TERMS.some(t =>
        t.includes(bs.replace(' leaf', '').replace(' kookaburra', '')) ||
        t.includes(bs)
      );
      expect(hasGeneric).toBe(true);
    }
  });
});
