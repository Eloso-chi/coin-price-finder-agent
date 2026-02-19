// src/services/marketAggregator.js — eBay market matrix aggregator
// Produces a year × mint grid of median-completed + cheapest-BIN data
// for a given coin series.  Reuses existing eBay API tier functions.
// CommonJS

'use strict';

const { TTLCache } = require('../utils/cache');
const stats = require('../utils/stats');

// ── In-memory cache (5-minute TTL, not persisted to disk) ────
const _cache = new TTLCache({ defaultTTL: 5 * 60 * 1000 });

// Grade token regex — matches "MS65", "PR-69", "AU 58+", etc.
const GRADE_RE = /\b(MS|PR|PF|SP|AU|XF|EF|VF|F|VG|G|AG|PO)\s*[-]?\s*(\d{1,2})(\+)?\b/i;

// Bullion series that should use grade-based matrix instead of year×mint
const BULLION_SERIES_RE = /\b(silver\s*eagle|gold\s*eagle|platinum\s*eagle|libertad|maple\s*leaf|philharmonic|britannia|krugerrand|panda|kookaburra|koala|kangaroo|gold\s+buffalo|buffalo\s+gold|silver\s+buffalo|buffalo\s+silver|american\s+(gold|silver|platinum)|perth\s*mint|lunar|year\s+of\s+the)\b/i;

/**
 * Detect if a series name looks like bullion (grade matrix mode).
 * @param {string} series
 * @returns {boolean}
 */
function isBullionSeries(series) {
  return BULLION_SERIES_RE.test(series || '');
}

/**
 * Extract grade token from a listing title.
 * Returns normalized grade (e.g. "MS69", "PR70") or "RAW".
 */
function extractGrade(title) {
  if (!title) return 'RAW';
  const m = title.match(GRADE_RE);
  if (!m) return 'RAW';
  const prefix = m[1].toUpperCase().replace('PF', 'PR');
  const num = m[2];
  const plus = m[3] || '';
  return prefix + num + plus;
}

/**
 * Extract year from a listing title.
 * @param {string} title
 * @returns {number|null}
 */
function extractYear(title) {
  const m = (title || '').match(/\b(1[7-9]\d{2}|20[0-4]\d)\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract mint mark from a listing title, using year-adjacent patterns.
 * @param {string} title
 * @returns {string} — uppercase mint mark or 'P' for Philadelphia / unknown
 */
function extractMint(title) {
  if (!title) return 'P';
  // Year-adjacent: "1956-D", "1881 CC", "2020-S"
  const adj = title.match(/\b\d{4}\s*[-]?\s*(CC|[SDPWO])\b/i);
  if (adj) return adj[1].toUpperCase();
  // Standalone mint designators (less reliable, but common in eBay titles)
  const standalone = title.match(/\b(CC)\b/);
  if (standalone) return 'CC';
  return 'P';
}

/**
 * Check if a listing title matches a grade filter.
 * @param {string} title
 * @param {string|null} gradeFilter — e.g. "MS65", "PR69", or null/""/"All"
 * @returns {boolean}
 */
function matchesGrade(title, gradeFilter) {
  if (!gradeFilter || gradeFilter === 'All') return true;
  const filterNorm = gradeFilter.replace(/[\s-]/g, '').toUpperCase();
  // Build a regex that matches the grade token in the title
  const m = filterNorm.match(/^(MS|PR|PF|SP|AU|XF|EF|VF|F|VG|G|AG|PO)(\d{1,2}\+?)$/i);
  if (!m) return true; // unparseable filter → pass all
  const prefix = m[1];
  const num = m[2];
  const re = new RegExp(`\\b${prefix}\\s*[-]?\\s*${num.replace('+', '\\+')}\\b`, 'i');
  return re.test(title);
}

/**
 * Build the market matrix from raw eBay comp arrays.
 *
 * @param {object} params
 * @param {Array}  params.completedComps  — sold/completed comp objects (from Insights + Finding)
 * @param {Array}  params.activeComps     — active listing comp objects (from Browse API)
 * @param {string} params.series          — coin series for key-date lookup
 * @param {string|null} params.grade      — grade filter (e.g. "MS65" or null)
 * @param {number} params.lookbackDays    — how many days back for completed sales
 * @param {Function} params.lookupKeyDate — the lookupKeyDate function from keyDates
 * @returns {object} — the full matrix response
 */
function buildMarketMatrix({
  completedComps = [],
  activeComps = [],
  series = '',
  grade = null,
  lookbackDays = 90,
  lookupKeyDate = () => ({ isKeyDate: false }),
}) {
  const gradeFilter = (!grade || grade === 'All') ? null : grade;

  // ── 1. Bucket completed sales by year+mint ──
  const completedBuckets = {};  // key: "year-mint" → [prices...]
  for (const comp of completedComps) {
    const year = extractYear(comp.title);
    if (!year) continue;
    if (gradeFilter && !matchesGrade(comp.title, gradeFilter)) continue;
    const mint = extractMint(comp.title);
    const key = `${year}-${mint}`;
    if (!completedBuckets[key]) completedBuckets[key] = [];
    if (comp.totalUsd != null && comp.totalUsd > 0) {
      completedBuckets[key].push(comp.totalUsd);
    }
  }

  // ── 2. Bucket active BIN listings by year+mint ──
  const activeBuckets = {};  // key: "year-mint" → [{price, url}, ...]
  for (const comp of activeComps) {
    // Only fixed-price / BIN listings
    if (comp.listingType && !/fixed|buyitnow|bin/i.test(comp.listingType)) continue;
    const year = extractYear(comp.title);
    if (!year) continue;
    if (gradeFilter && !matchesGrade(comp.title, gradeFilter)) continue;
    const mint = extractMint(comp.title);
    const key = `${year}-${mint}`;
    if (!activeBuckets[key]) activeBuckets[key] = [];
    if (comp.totalUsd != null && comp.totalUsd > 0) {
      activeBuckets[key].push({ price: comp.totalUsd, url: comp.url || null });
    }
  }

  // ── 3. Collect all year-mint keys that have ANY data ──
  const allKeys = new Set([...Object.keys(completedBuckets), ...Object.keys(activeBuckets)]);

  // ── 4. Build cells ──
  const cells = [];
  const yearsSet = new Set();
  const mintsSet = new Set();

  for (const key of allKeys) {
    const [yearStr, mint] = key.split('-');
    const year = parseInt(yearStr, 10);
    yearsSet.add(year);
    mintsSet.add(mint);

    // Median completed
    const completedPrices = completedBuckets[key] || [];
    let medianCompleted = null;
    if (completedPrices.length > 0) {
      const sorted = [...completedPrices].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianCompleted = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    }

    // Cheapest BIN + next cheapest
    const activeItems = activeBuckets[key] || [];
    let cheapestBin = null;
    let nextCheapestBin = null;
    if (activeItems.length > 0) {
      activeItems.sort((a, b) => a.price - b.price);
      cheapestBin = { value: activeItems[0].price, currency: 'USD', url: activeItems[0].url };
      if (activeItems.length > 1) {
        nextCheapestBin = { value: activeItems[1].price, currency: 'USD' };
      }
    }

    // Key date?
    const kdResult = lookupKeyDate(series, year, mint === 'P' ? '' : mint);

    cells.push({
      year,
      mint,
      keyDate: kdResult.isKeyDate || false,
      keyDateTier: kdResult.tier || null,
      medianCompleted: medianCompleted != null
        ? { value: Math.round(medianCompleted * 100) / 100, currency: 'USD', sampleSize: completedPrices.length, lookbackDays }
        : null,
      cheapestBin: cheapestBin || null,
      nextCheapestBin: nextCheapestBin || null,
    });
  }

  // ── 5. Build sorted arrays ──
  const years = [...yearsSet].sort((a, b) => a - b);
  const mintMarks = [...mintsSet].sort((a, b) => {
    const order = { P: 0, D: 1, S: 2, O: 3, CC: 4, W: 5 };
    return (order[a] ?? 99) - (order[b] ?? 99);
  });

  // ── 6. Summary ──
  const totalCells = cells.length;
  const cellsWithPriceData = cells.filter(c => c.medianCompleted || c.cheapestBin).length;
  const summary = {
    totalCells,
    cellsWithPriceData,
    yearMin: years.length ? years[0] : null,
    yearMax: years.length ? years[years.length - 1] : null,
    mintCount: mintMarks.length,
  };

  return {
    mode: 'year-mint',
    grade: gradeFilter || 'All',
    years,
    mintMarks,
    summary,
    cells,
  };
}

/**
 * Build a grade-based market matrix for bullion coins.
 * Rows = years, columns = grades (RAW, MS69, MS70, etc.)
 * Only grades with at least one data point are included.
 *
 * @param {object} params  — same as buildMarketMatrix
 * @returns {object}
 */
function buildGradeMatrix({
  completedComps = [],
  activeComps = [],
  series = '',
  lookbackDays = 90,
  lookupKeyDate = () => ({ isKeyDate: false }),
}) {
  // ── 1. Bucket completed sales by year+grade ──
  const completedBuckets = {};
  for (const comp of completedComps) {
    const year = extractYear(comp.title);
    if (!year) continue;
    const grade = extractGrade(comp.title);
    const key = `${year}-${grade}`;
    if (!completedBuckets[key]) completedBuckets[key] = [];
    if (comp.totalUsd != null && comp.totalUsd > 0) {
      completedBuckets[key].push(comp.totalUsd);
    }
  }

  // ── 2. Bucket active BIN listings by year+grade ──
  const activeBuckets = {};
  for (const comp of activeComps) {
    if (comp.listingType && !/fixed|buyitnow|bin/i.test(comp.listingType)) continue;
    const year = extractYear(comp.title);
    if (!year) continue;
    const grade = extractGrade(comp.title);
    const key = `${year}-${grade}`;
    if (!activeBuckets[key]) activeBuckets[key] = [];
    if (comp.totalUsd != null && comp.totalUsd > 0) {
      activeBuckets[key].push({ price: comp.totalUsd, url: comp.url || null });
    }
  }

  // ── 3. Collect all year-grade keys ──
  const allKeys = new Set([...Object.keys(completedBuckets), ...Object.keys(activeBuckets)]);

  // ── 4. Build cells ──
  const cells = [];
  const yearsSet = new Set();
  const gradesSet = new Set();

  for (const key of allKeys) {
    const dashIdx = key.indexOf('-');
    const yearStr = key.substring(0, dashIdx);
    const grade = key.substring(dashIdx + 1);
    const year = parseInt(yearStr, 10);
    yearsSet.add(year);
    gradesSet.add(grade);

    const completedPrices = completedBuckets[key] || [];
    let medianCompleted = null;
    if (completedPrices.length > 0) {
      const sorted = [...completedPrices].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianCompleted = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    }

    const activeItems = activeBuckets[key] || [];
    let cheapestBin = null;
    let nextCheapestBin = null;
    if (activeItems.length > 0) {
      activeItems.sort((a, b) => a.price - b.price);
      cheapestBin = { value: activeItems[0].price, currency: 'USD', url: activeItems[0].url };
      if (activeItems.length > 1) {
        nextCheapestBin = { value: activeItems[1].price, currency: 'USD' };
      }
    }

    const kdResult = lookupKeyDate(series, year, '');

    cells.push({
      year,
      grade,
      keyDate: kdResult.isKeyDate || false,
      keyDateTier: kdResult.tier || null,
      medianCompleted: medianCompleted != null
        ? { value: Math.round(medianCompleted * 100) / 100, currency: 'USD', sampleSize: completedPrices.length, lookbackDays }
        : null,
      cheapestBin: cheapestBin || null,
      nextCheapestBin: nextCheapestBin || null,
    });
  }

  // ── 5. Sort years ascending; sort grades: RAW first, then by prefix+number ──
  const years = [...yearsSet].sort((a, b) => a - b);

  const GRADE_ORDER = { RAW: 0, MS: 1, PR: 2, PF: 2, SP: 3, AU: 4, XF: 5, EF: 5, VF: 6, F: 7, VG: 8, G: 9, AG: 10, PO: 11 };
  const grades = [...gradesSet].sort((a, b) => {
    if (a === 'RAW') return -1;
    if (b === 'RAW') return 1;
    const prefA = a.replace(/\d+\+?$/, '');
    const prefB = b.replace(/\d+\+?$/, '');
    const numA = parseInt(a.replace(/^[A-Z]+/, ''), 10) || 0;
    const numB = parseInt(b.replace(/^[A-Z]+/, ''), 10) || 0;
    const ordA = GRADE_ORDER[prefA] ?? 99;
    const ordB = GRADE_ORDER[prefB] ?? 99;
    if (ordA !== ordB) return ordA - ordB;
    return numB - numA; // higher numeric grade first within same prefix
  });

  // ── 6. Summary ──
  const totalCells = cells.length;
  const cellsWithPriceData = cells.filter(c => c.medianCompleted || c.cheapestBin).length;
  const summary = {
    totalCells,
    cellsWithPriceData,
    yearMin: years.length ? years[0] : null,
    yearMax: years.length ? years[years.length - 1] : null,
    gradeCount: grades.length,
  };

  return {
    mode: 'grade',
    grades,
    years,
    summary,
    cells,
  };
}

/**
 * Fetch eBay data and build the market matrix for a coin.
 *
 * This is the main entry point. It:
 *  1. Builds eBay keywords from the series + optional year/grade
 *  2. Fetches completed sales (Insights + Finding)
 *  3. Fetches active BIN listings (Browse API)
 *  4. Aggregates into a year × mint matrix
 *
 * @param {object} params
 * @param {string} params.series     — e.g. "Franklin Half Dollar"
 * @param {string} [params.grade]    — e.g. "MS65" or "All"
 * @param {number} [params.timeWindowDays]
 * @param {Function} params.lookupKeyDate
 * @param {object}   params.ebayService — the ebayService module
 * @returns {Promise<object>}
 */
async function fetchMarketMatrix({
  series,
  grade = 'All',
  timeWindowDays = 90,
  weight = null,
  lookupKeyDate,
  ebayService,
}) {
  if (!series) throw new Error('series is required');

  const cacheKey = `market:${series}:${grade || 'All'}:${timeWindowDays}:${weight || ''}`;
  if (_cache.has(cacheKey)) return _cache.get(cacheKey);

  // Build keywords — series name + optional weight for bullion coins
  let keywords = series;
  if (weight && weight !== 1) {
    const WEIGHT_LABELS = { 0.5: '1/2', 0.25: '1/4', 0.1: '1/10', 0.05: '1/20' };
    const wStr = WEIGHT_LABELS[weight] ? WEIGHT_LABELS[weight] + ' oz' : weight + ' oz';
    keywords = series + ' ' + wStr;
  }

  // Fetch completed sales via the existing fetchSoldComps pipeline
  // This returns comps from Insights + Finding APIs
  const soldResult = await ebayService.fetchSoldComps(keywords, {
    timeWindowDays,
    maxPages: 3,
    usMinComps: 0,  // don't trigger Browse fallback
  }, { series });

  const completedComps = [
    ...(soldResult.us?.comps || []),
    ...(soldResult.global?.comps || []),
  ];

  // Fetch active BIN listings via Browse API directly
  // We need access to browseSearch — but it's not exported.
  // Instead, we'll do a second fetchSoldComps with very small window
  // that triggers Browse fallback, OR we export browseSearch.
  // For now, use a pragmatic approach: trigger a Browse-only search
  // by setting usMinComps very high so it always falls through.
  let activeComps = [];
  try {
    const activeResult = await ebayService.fetchSoldComps(keywords, {
      timeWindowDays: 1, // very short window so Finding yields little
      maxPages: 1,
      usMinComps: 999,   // force Browse API fallback
    }, { series });
    // Browse comps have listingType: 'FixedPrice' or _source: 'browse'
    const allActive = [
      ...(activeResult.us?.comps || []),
      ...(activeResult.global?.comps || []),
    ];
    activeComps = allActive.filter(c => c._source === 'browse' || c.listingType === 'FixedPrice');
  } catch (err) {
    console.warn('[marketAggregator] Browse fetch failed:', err.message);
    // Continue with completed data only
  }

  const bullion = isBullionSeries(series);
  const matrix = bullion
    ? buildGradeMatrix({
        completedComps,
        activeComps,
        series,
        lookbackDays: timeWindowDays,
        lookupKeyDate,
      })
    : buildMarketMatrix({
        completedComps,
        activeComps,
        series,
        grade,
        lookbackDays: timeWindowDays,
        lookupKeyDate,
      });

  matrix.series = series;
  matrix.keywords = keywords;

  _cache.set(cacheKey, matrix);
  return matrix;
}

/** Flush the in-memory market aggregator cache. */
function clearCache() { _cache.clear(); }

module.exports = {
  buildMarketMatrix,
  buildGradeMatrix,
  fetchMarketMatrix,
  extractYear,
  extractMint,
  extractGrade,
  matchesGrade,
  isBullionSeries,
  clearCache,
};
