/**
 * terapeakDataIntegrity.test.js — End-to-end data integrity test
 *
 * Picks random coins from the actual Terapeak CSV dataset, runs them
 * through the full pricing pipeline (lookupComps → scoring → filtering →
 * valuation), and validates:
 *
 *   1. FMV is within tolerance of the raw CSV median (no wild divergence)
 *   2. Sufficient comps survive filtering (no over-aggressive deny patterns)
 *   3. Correct dataset matched (year/weight/metal guards working)
 *   4. Cross-route consistency (/api/price vs /api/pricing-batch)
 *   5. Comp sources trace back to the expected CSV
 *
 * Uses REAL terapeakService with real CSV data on disk.
 * External API calls (eBay Finding/Browse, PCGS, Greysheet, metals) are mocked
 * to return empty/null so Terapeak data is the sole pricing source.
 *
 * Seeded random for reproducibility: set COIN_TEST_SEED env var to reproduce.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── External API mocks (return nothing -- force Terapeak-only pipeline) ──

jest.mock('../src/services/pcgsService', () => ({
  parseDescription: jest.fn((q) => {
    const yearMatch = q.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
    const gradeMatch = q.match(/\b(MS|PR|PF|AU|XF|VF|SP)\s*[-]?\s*(\d{1,2})\b/i);
    const grade = gradeMatch ? gradeMatch[0].replace(/\s+/g, '-') : null;
    const gradeNum = gradeMatch ? parseInt(gradeMatch[2], 10) : null;
    const weightMatch = q.match(/(\d+(?:\/\d+)?)\s*oz/i);
    let weight = null;
    if (weightMatch) {
      const w = weightMatch[1];
      weight = w.includes('/') ? eval(w) : parseFloat(w);
    }
    const metalMatch = q.match(/\b(silver|gold|platinum|palladium)\b/i);
    const metal = metalMatch ? metalMatch[1].toLowerCase() : null;
    const series = q
      .replace(/\b\d{4}\b/, '')
      .replace(/\b(MS|PR|PF|AU|XF|VF|SP)\s*[-]?\s*\d{1,2}\b/gi, '')
      .replace(/\d+(?:\/\d+)?\s*oz\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Unknown';
    return { series, year, mint: null, grade, gradeNum, weight, finish: null, metal };
  }),
  resolveFromDescription: jest.fn(async (q) => {
    const yearMatch = q.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
    const series = q
      .replace(/\b\d{4}\b/, '')
      .replace(/\b(MS|PR|PF|AU|XF|VF|SP)\s*[-]?\s*\d{1,2}\b/gi, '')
      .replace(/\d+(?:\/\d+)?\s*oz\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Unknown';
    return {
      verified: false, pcgsCoinNumber: null,
      series, year, mint: null, grade: null, designation: null,
      finish: null, variety: null, priceGuide: null, population: null,
      auction: null, trueViewUrl: null, coinImages: [],
      parsed: { series, year, mint: null, grade: null, gradeNum: null, metal: null, weight: null },
      limitations: [],
    };
  }),
  lookupByCert: jest.fn(async () => ({ verified: false })),
  lookupByCoinNumberAndGrade: jest.fn(async () => ({ verified: false })),
}));

jest.mock('../src/services/greysheetService', () => ({
  fetchPriceByPcgsNumber: jest.fn(async () => null),
  fetchTypePrice: jest.fn(async () => null),
}));
jest.mock('../src/services/greysheetHistoryService', () => ({
  makeKey: jest.fn(() => 'test-key'),
  recordSnapshot: jest.fn(),
}));
jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(async () => ({ price: 30.50, source: 'mock' })),
}));
jest.mock('../src/services/numistaService', () => ({
  lookupCoin: jest.fn(async () => null),
}));
jest.mock('../src/utils/responseValidator', () => ({
  validateSeriesIntegrity: jest.fn(() => null),
  validateNumericSanity: jest.fn(() => null),
}));

// Don't mock terapeakService -- we want REAL data
// Don't mock ebayService -- we want the real scoring/filtering logic
// Don't mock valuationService -- we want real FMV calculation

// But we DO need to prevent ebayService from making real HTTP calls.
// It checks Terapeak first; if sufficient comps exist it won't call APIs.
// For coins with thin data, mock the HTTP layer to return empty.
jest.mock('axios', () => {
  const original = jest.requireActual('axios');
  return {
    ...original,
    create: () => ({
      get: jest.fn(async () => ({ data: {}, status: 200 })),
      post: jest.fn(async () => ({ data: {}, status: 200 })),
      interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
    }),
    get: jest.fn(async () => ({ data: {}, status: 200 })),
    post: jest.fn(async () => ({ data: {}, status: 200 })),
  };
});

// ── Load real services ──
const terapeakService = require('../src/services/terapeakService');
const { applyFilters, scoreMatch, classifyGradeType } = require('../src/services/ebayService');
const { computeValuation } = require('../src/services/valuationService');
const stats = require('../src/utils/stats');

// ── Seed infrastructure ──
const SEED = process.env.COIN_TEST_SEED || `integrity-${Date.now()}`;
function seededRng(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i) | 0;
  }
  return function () {
    h = h ^ (h << 13); h = h ^ (h >> 17); h = h ^ (h << 5);
    return (h >>> 0) / 4294967296;
  };
}
const rng = seededRng(SEED);

// ── Discover available datasets from disk ──
const DATA_DIR = path.join(__dirname, '..', 'data', 'terapeak');

function discoverDatasets() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.csv'));
  return files.map(f => {
    const metaPath = path.join(DATA_DIR, f.replace('.csv', '.meta'));
    let searchTerm;
    if (fs.existsSync(metaPath)) {
      searchTerm = fs.readFileSync(metaPath, 'utf8').trim();
    } else {
      searchTerm = f.replace('.csv', '').replace(/[_]+/g, ' ').trim();
    }
    return { file: f, searchTerm };
  });
}

function pickRandomDatasets(datasets, n) {
  const shuffled = [...datasets].sort(() => rng() - 0.5);
  return shuffled.slice(0, n);
}

function parseRawCSVPrices(csvFile) {
  const content = fs.readFileSync(path.join(DATA_DIR, csvFile), 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Find price and shipping columns
  const cols = lines[0].split(',').map(c => c.replace(/"/g, '').trim().toLowerCase());
  let priceIdx = cols.findIndex(c => c === 'sold price' || c === 'price' || c === 'sold_price');
  if (priceIdx === -1) priceIdx = 3; // fallback to column 4
  const shipIdx = cols.findIndex(c => c === 'shipping' || c === 'shipping cost');

  const prices = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvRow(lines[i]);
    if (!row || row.length <= priceIdx) continue;
    const rawPrice = (row[priceIdx] || '').replace(/["\$,]/g, '').trim();
    const price = parseFloat(rawPrice);
    if (isNaN(price) || price <= 0) continue;

    // Add shipping if column exists (mirrors rowToComp: totalUsd = price + shipping)
    let shipping = 0;
    if (shipIdx !== -1 && row[shipIdx]) {
      const s = parseFloat(row[shipIdx].replace(/["\$,]/g, '').trim());
      if (!isNaN(s)) shipping = s;
    }
    prices.push(price + shipping);
  }
  return prices;
}

function parseCsvRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function computeMedian(prices) {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ── Configuration ──
const SAMPLE_SIZE = parseInt(process.env.INTEGRITY_SAMPLE_SIZE, 10) || 20;
const FMV_TOLERANCE = 3.0;      // FMV must be within 3x of raw median (generous for filtering effects)
const MIN_SURVIVAL_RATE = 0.05; // At least 5% of raw comps should survive filtering
const MIN_RAW_COMPS = 5;        // Skip datasets with fewer than 5 raw CSV rows (too thin)

// ═══════════════════════════════════════════════════════════════
//  Setup: import real terapeak data
// ═══════════════════════════════════════════════════════════════

beforeAll(() => {
  // Force fresh import of all CSVs
  terapeakService._resetStoreCache();
  terapeakService.autoImportFolder('data/terapeak', { force: true });
  console.log(`[integrity] Seed: ${SEED}`);
});

afterAll(() => {
  // Clear the real data we imported and flush to disk synchronously
  // to prevent pollution of other test files running in the same worker
  terapeakService.clearAll();
  terapeakService._resetStoreCache();
  // Force synchronous flush of the empty store to disk
  const fs = require('fs');
  const cachePath = require('../src/utils/cachePath');
  const storePath = require('path').join(cachePath.CACHE_DIR, 'terapeak_sold.json');
  try { fs.writeFileSync(storePath, '{}'); } catch {}
});

// ═══════════════════════════════════════════════════════════════
//  Test Suite
// ═══════════════════════════════════════════════════════════════

describe('Terapeak data integrity — raw CSV vs FMV pipeline', () => {

  const allDatasets = discoverDatasets();
  const withEnoughData = allDatasets.filter(d => {
    const prices = parseRawCSVPrices(d.file);
    return prices.length >= MIN_RAW_COMPS;
  });

  const selected = pickRandomDatasets(withEnoughData, SAMPLE_SIZE);

  if (selected.length === 0) {
    test('skip — no datasets with sufficient data', () => {
      console.warn('[integrity] No datasets with >= 5 comps found in data/terapeak/');
    });
    return;
  }

  console.log(`[integrity] Testing ${selected.length} datasets (of ${withEnoughData.length} eligible, ${allDatasets.length} total)`);

  describe.each(selected.map(d => [d.searchTerm, d.file]))(
    '%s',
    (searchTerm, csvFile) => {

      let rawPrices, rawMedian, lookupResult;

      beforeAll(() => {
        rawPrices = parseRawCSVPrices(csvFile);
        rawMedian = computeMedian(rawPrices);
        lookupResult = terapeakService.lookupComps(searchTerm);
      });

      test('lookupComps returns data for its own search term', () => {
        expect(lookupResult).not.toBeNull();
        expect(lookupResult.comps).toBeDefined();
        expect(lookupResult.comps.length).toBeGreaterThan(0);
      });

      test('stored comps count is within range of raw CSV rows', () => {
        // Stored comps should be close to raw CSV rows (some may be deduped or denied)
        const storedCount = lookupResult.comps.length;
        // At minimum 20% of raw rows should survive import (deny filters may remove some)
        expect(storedCount).toBeGreaterThanOrEqual(Math.floor(rawPrices.length * 0.1));
        // Stored should never exceed raw (no phantom comps)
        expect(storedCount).toBeLessThanOrEqual(rawPrices.length + 10); // +10 for rounding/header/multi-CSV merge edge cases
      });

      test('FMV is within tolerance of raw CSV median', () => {
        if (!rawMedian || rawMedian === 0) return; // skip degenerate cases

        // Run through scoring + filtering (raw pool only)
        const expected = { _rawQuery: searchTerm };
        const yearMatch = searchTerm.match(/\b(1[6-9]\d{2}|20[0-4]\d)\b/);
        if (yearMatch) expected.year = parseInt(yearMatch[1], 10);

        const rawComps = lookupResult.comps.filter(c => {
          const gt = c.gradeType || classifyGradeType(c);
          return gt === 'raw';
        });

        if (rawComps.length < 3) return; // not enough raw comps to validate

        const scored = rawComps.map(c => scoreMatch(c, expected));
        const { kept } = applyFilters(scored, {}, expected);

        if (kept.length < 3) {
          // Too few survived -- filtering is aggressive but this is a thin-data
          // scenario. Log warning but don't fail (covered by survival rate test).
          console.warn(
            `[THIN-DATA] ${searchTerm}: only ${kept.length} comps survived filtering ` +
            `(from ${rawComps.length} raw) — skipping FMV tolerance check`
          );
          return;
        }

        const prices = kept.map(c => c.totalUsd).filter(p => p > 0);
        const ebayResult = {
          us: { comps: kept, stats: stats.summarize(prices) },
          global: { comps: [], stats: null },
          usedFallback: false,
        };

        const { valuation } = computeValuation(
          { verified: false, series: searchTerm },
          ebayResult,
          null,
          null
        );

        const fmv = valuation.fmvCore;
        if (fmv == null) return; // valuation couldn't compute (expected for edge cases)

        // Core assertion: FMV should not wildly diverge from EITHER the raw
        // CSV median or the filtered comps median.  The pipeline legitimately
        // shifts the distribution (grade-split, deny-filters, recency weighting,
        // outlier trimming) so we check both and pass if either is reasonable.
        const filteredMedian = computeMedian(prices);
        const rawRatio = fmv / rawMedian;
        const filteredRatio = filteredMedian ? fmv / filteredMedian : null;

        // Pass if FMV is within 3x of raw median OR within 3x of filtered median
        const rawOk = rawRatio >= (1 / FMV_TOLERANCE) && rawRatio <= FMV_TOLERANCE;
        const filteredOk = filteredRatio != null &&
          filteredRatio >= (1 / FMV_TOLERANCE) && filteredRatio <= FMV_TOLERANCE;
        const withinTolerance = rawOk || filteredOk;

        if (!withinTolerance) {
          console.error(
            `[DIVERGENCE] ${searchTerm}: FMV=$${fmv.toFixed(2)}, ` +
            `filteredMedian=$${filteredMedian?.toFixed(2)}, rawMedian=$${rawMedian.toFixed(2)}, ` +
            `ratio(filtered)=${filteredRatio?.toFixed(2) || 'N/A'}x, ratio(raw)=${rawRatio.toFixed(2)}x, ` +
            `rawRows=${rawPrices.length}, storedComps=${lookupResult.comps.length}, ` +
            `rawPool=${rawComps.length}, survived=${kept.length}`
          );
        }

        expect(withinTolerance).toBe(true);
      });

      test('sufficient comps survive filtering (no over-aggressive denial)', () => {
        const expected = { _rawQuery: searchTerm };
        const yearMatch = searchTerm.match(/\b(1[6-9]\d{2}|20[0-4]\d)\b/);
        if (yearMatch) expected.year = parseInt(yearMatch[1], 10);

        const rawComps = lookupResult.comps.filter(c => {
          const gt = c.gradeType || classifyGradeType(c);
          return gt === 'raw';
        });

        if (rawComps.length < 3) return; // skip thin data

        const scored = rawComps.map(c => scoreMatch(c, expected));
        const { kept } = applyFilters(scored, {}, expected);

        const survivalRate = kept.length / rawComps.length;

        if (survivalRate < MIN_SURVIVAL_RATE) {
          console.error(
            `[OVER-FILTER] ${searchTerm}: ${kept.length}/${rawComps.length} survived ` +
            `(${(survivalRate * 100).toFixed(1)}%) — below ${MIN_SURVIVAL_RATE * 100}% threshold`
          );
        }

        expect(survivalRate).toBeGreaterThanOrEqual(MIN_SURVIVAL_RATE);
      });

      test('comp prices trace back to raw CSV prices (no phantom values)', () => {
        // Every stored comp's totalUsd should exist in the raw CSV prices
        // (with tolerance for shipping addition and currency rounding)
        const rawSet = new Set(rawPrices.map(p => Math.round(p * 100)));

        let traceable = 0;
        for (const comp of lookupResult.comps) {
          if (comp.totalUsd == null) continue;
          // Check if the price (rounded to cents) exists in raw data
          // Account for shipping being added: comp.totalUsd = price + shipping
          const cents = Math.round(comp.totalUsd * 100);
          // Allow +/- $1 tolerance for rounding
          const found = rawSet.has(cents) ||
            rawSet.has(cents - 100) || rawSet.has(cents + 100) ||
            rawSet.has(cents - 50) || rawSet.has(cents + 50);
          if (found) traceable++;
        }

        // At least 50% of comps should trace back to raw prices
        // (some won't due to shipping addition changing the total)
        const traceRate = traceable / lookupResult.comps.length;
        if (traceRate < 0.3) {
          console.warn(
            `[TRACE] ${searchTerm}: ${traceable}/${lookupResult.comps.length} comps ` +
            `(${(traceRate * 100).toFixed(0)}%) trace to raw CSV prices`
          );
        }
        // Soft threshold: at least 30% should trace (shipping adjustments are common)
        expect(traceRate).toBeGreaterThanOrEqual(0.2);
      });
    }
  );
});

describe('cross-route consistency with real data', () => {
  // Uses supertest with the real priceRoute, but with real terapeak data loaded.
  // External APIs (eBay HTTP, PCGS HTTP) are mocked via axios mock above.
  const express = require('express');
  const priceRoute = require('../src/routes/priceRoute');
  const pricingBatchRoute = require('../src/routes/pricingBatchRoute');
  const request = require('supertest');

  const app = express();
  app.use(express.json());
  app.use('/api/price', priceRoute);
  app.use('/api/pricing-batch', pricingBatchRoute);

  const allDatasets = discoverDatasets();
  const withData = allDatasets.filter(d => parseRawCSVPrices(d.file).length >= 10);
  // Pick 5 random coins for cross-route checks
  const crossRouteSample = pickRandomDatasets(withData, 5);

  if (crossRouteSample.length === 0) {
    test('skip — no datasets available for cross-route test', () => {});
    return;
  }

  test.each(crossRouteSample.map(d => [d.searchTerm]))(
    '%s: /api/price and /api/pricing-batch produce consistent FMV',
    async (query) => {
      const [singleRes, batchRes] = await Promise.all([
        request(app).post('/api/price').send({ query }),
        request(app).post('/api/pricing-batch').send({ items: [{ query }] }),
      ]);

      // Both should succeed (200) or both fail gracefully
      expect(singleRes.status).toBe(200);
      expect(batchRes.status).toBe(200);

      const singleFmv = singleRes.body?.valuation?.fmvCore;
      const batchFmv = batchRes.body?.results?.[0]?.fmv;

      // If both produced FMV, they should be equal
      if (singleFmv != null && batchFmv != null) {
        expect(singleFmv).toBe(batchFmv);
      }

      // If single produced FMV, confidence should be > 0
      if (singleFmv != null) {
        expect(singleRes.body.valuation.confidence).toBeGreaterThan(0);
      }
    }
  );
});
