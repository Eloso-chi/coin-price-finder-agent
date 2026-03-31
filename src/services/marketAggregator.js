// src/services/marketAggregator.js — eBay market matrix aggregator
// Produces a year × mint grid of median-completed + cheapest-BIN data
// for a given coin series.  Reuses existing eBay API tier functions.
// CommonJS

'use strict';

const { TTLCache } = require('../utils/cache');
const stats = require('../utils/stats');
const { zodiacForYear, perthLunarSeries } = require('../data/constants');
const { getMetalsSpotPrice } = require('./metalsSpotPrice');

// ── In-memory cache (5-minute TTL, not persisted to disk) ────
const _cache = new TTLCache({ defaultTTL: 5 * 60 * 1000 });

// Grade token regex — matches "MS65", "PR-69", "AU 58+", etc.
const GRADE_RE = /\b(MS|PR|PF|SP|AU|XF|EF|VF|F|VG|G|AG|PO)\s*[-]?\s*(\d{1,2})(\+)?\b/i;

// Bullion series that should use grade-based matrix instead of year×mint
const BULLION_SERIES_RE = /\b(silver\s*eagle|gold\s*eagle|platinum\s*eagle|libertad|maple\s*leaf|philharmonic|britannia|krugerrand|panda|kookaburra|koala|kangaroo|gold\s+buffalo|buffalo\s+gold|silver\s+buffalo|buffalo\s+silver|american\s+(gold|silver|platinum)|perth\s*mint|lunar|year\s+of\s+the|polar\s*bear|gold\s+bar|silver\s+bar|platinum\s+bar|bullion\s+bar)\b/i;

// Bar query detection — bars don't have mint marks or years like coins
const BAR_RE = /\b(gold|silver|platinum|palladium)\s+bar\b/i;

// Earliest production year for bullion series (1 oz coins).
// Comps with years before these are NOT the same coin — e.g. pre-1982 Mexican
// coins that happen to have "libertad" in their name are circulating currency,
// not bullion Libertads.
const BULLION_FIRST_YEAR = {
  'libertad':       1982,  // silver Libertad BU; 1981 for gold
  'silver eagle':   1986,
  'gold eagle':     1986,
  'platinum eagle': 1997,
  'maple leaf':     1979,  // gold; silver 1988
  'philharmonic':   1989,  // gold; silver 2008
  'britannia':      1987,  // gold; silver 1997
  'krugerrand':     1967,
  'panda':          1982,  // gold; silver 1989
  'kookaburra':     1990,
  'koala':          2007,  // platinum 1988
  'kangaroo':       1986,
  'gold buffalo':   2006,
  'polar bear':     2018,
};

// Non-bullion coin terms that contaminate bullion searches.
// Old Mexican coins, commemoratives, etc. share keywords like "libertad"
// but are circulating denomination coins, not bullion.
const BULLION_DENY_DENOM_RE = /\b(centavo|centavos|peso[s]?|\d+\s*cent(?:avo)?)\b/i;
const BULLION_OK_RE = /\b(?:oz|ounce|onza|troy|bullion)\b/i;

/**
 * Detect if a series name looks like bullion (grade matrix mode).
 * @param {string} series
 * @returns {boolean}
 */
function isBullionSeries(series) {
  return BULLION_SERIES_RE.test(series || '');
}

/**
 * Detect if a series name is a bullion bar query.
 * @param {string} series
 * @returns {boolean}
 */
function isBarSeries(series) {
  return BAR_RE.test(series || '');
}

/**
 * Detect precious metal from a series / query string.
 * Returns 'gold', 'silver', 'platinum', 'palladium', or null.
 */
function _detectMetal(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\bgold\b/.test(t))      return 'gold';
  if (/\bsilver\b/.test(t))    return 'silver';
  if (/\bplatinum\b/.test(t))  return 'platinum';
  if (/\bpalladium\b/.test(t)) return 'palladium';
  return null;
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

/* ── Known brand tokens for bar listing classification ── */
const BAR_BRAND_TOKENS = [
  { re: /\bpamp\b/i,              brand: 'PAMP' },
  { re: /\bvalcambi\b/i,          brand: 'Valcambi' },
  { re: /\bcredit\s*suisse\b/i,   brand: 'Credit Suisse' },
  { re: /\bperth\s*mint\b/i,      brand: 'Perth Mint' },
  { re: /\broyal\s*canadian\b/i,  brand: 'RCM' },
  { re: /\bjohnson\s*matthey\b|\bjm\b/i, brand: 'JM' },
  { re: /\bengelhard\b/i,         brand: 'Engelhard' },
  { re: /\bsunshine\b/i,          brand: 'Sunshine' },
  { re: /\basahi\b/i,             brand: 'Asahi' },
  { re: /\bscottsdale\b/i,        brand: 'Scottsdale' },
  { re: /\bgeiger\b/i,            brand: 'Geiger' },
  { re: /\bargor[\s-]*heraeus\b/i,brand: 'Argor-Heraeus' },
  { re: /\bmetalor\b/i,           brand: 'Metalor' },
  { re: /\bheraeus\b/i,           brand: 'Heraeus' },
  { re: /\bsilvertowne\b/i,       brand: 'SilverTowne' },
  { re: /\bapmex\b/i,             brand: 'Apmex' },
  { re: /\ba[\s-]*mark\b/i,       brand: 'A-Mark' },
  { re: /\bmmtc\b/i,              brand: 'MMTC-PAMP' },
  { re: /\broyal\s*mint\b/i,      brand: 'Royal Mint' },
  { re: /\bumicore\b/i,           brand: 'Umicore' },
];

/**
 * Extract brand from a bar listing title.
 * Returns the first matched known brand, or 'Generic'.
 */
function extractBrand(title) {
  if (!title) return 'Generic';
  for (const { re, brand } of BAR_BRAND_TOKENS) {
    if (re.test(title)) return brand;
  }
  return 'Generic';
}

/**
 * Build a brand-based market matrix for bullion bars.
 * Rows = brands, single column showing price stats.
 * This is more useful for bars which don't have year×mint variance.
 *
 * @param {object} params
 * @returns {object}
 */
function buildBarMatrix({
  completedComps = [],
  activeComps = [],
  series = '',
  lookbackDays = 90,
}) {
  // ── 1. Bucket completed sales by brand ──
  const completedBuckets = {};
  for (const comp of completedComps) {
    const brand = extractBrand(comp.title);
    if (!completedBuckets[brand]) completedBuckets[brand] = [];
    if (comp.totalUsd != null && comp.totalUsd > 0) {
      completedBuckets[brand].push(comp.totalUsd);
    }
  }

  // ── 2. Bucket active BIN listings by brand ──
  const activeBuckets = {};
  for (const comp of activeComps) {
    if (comp.listingType && !/fixed|buyitnow|bin/i.test(comp.listingType)) continue;
    const brand = extractBrand(comp.title);
    if (!activeBuckets[brand]) activeBuckets[brand] = [];
    if (comp.totalUsd != null && comp.totalUsd > 0) {
      activeBuckets[brand].push({ price: comp.totalUsd, url: comp.url || null });
    }
  }

  // ── 3. Collect all brands ──
  const allBrands = new Set([...Object.keys(completedBuckets), ...Object.keys(activeBuckets)]);

  // ── 4. Build cells ──
  const cells = [];
  for (const brand of allBrands) {
    const completedPrices = completedBuckets[brand] || [];
    let medianCompleted = null;
    if (completedPrices.length > 0) {
      const sorted = [...completedPrices].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianCompleted = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    }

    const activeItems = activeBuckets[brand] || [];
    let cheapestBin = null;
    let nextCheapestBin = null;
    if (activeItems.length > 0) {
      activeItems.sort((a, b) => a.price - b.price);
      cheapestBin = { value: activeItems[0].price, currency: 'USD', url: activeItems[0].url };
      if (activeItems.length > 1) {
        nextCheapestBin = { value: activeItems[1].price, currency: 'USD' };
      }
    }

    cells.push({
      brand,
      medianCompleted: medianCompleted != null
        ? { value: Math.round(medianCompleted * 100) / 100, currency: 'USD', sampleSize: completedPrices.length, lookbackDays }
        : null,
      cheapestBin: cheapestBin || null,
      nextCheapestBin: nextCheapestBin || null,
      activeListing: activeItems.length,
      soldCount: completedPrices.length,
    });
  }

  // Sort by sold count descending
  cells.sort((a, b) => b.soldCount - a.soldCount);

  const brands = cells.map(c => c.brand);

  return {
    mode: 'bar',
    brands,
    summary: {
      totalCells: cells.length,
      cellsWithPriceData: cells.filter(c => c.medianCompleted || c.cheapestBin).length,
      brandCount: brands.length,
      totalSold: cells.reduce((s, c) => s + c.soldCount, 0),
      totalActive: cells.reduce((s, c) => s + c.activeListing, 0),
    },
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

  // ── Lunar series detection ──
  // For Perth Lunar coins, the series name might be "Perth Year Of The Rooster"
  // which only matches one animal. Transform to broader series-level keywords
  // and constrain results to the correct year range.
  const ZODIAC_ANIMAL_RE = /\b(rat|ox|tiger|rabbit|dragon|snake|horse|goat|monkey|rooster|dog|pig)\b/i;
  const seriesLower = series.toLowerCase();
  const isLunar = /\blunar\b/.test(seriesLower) || /\byear\s+of\s+the\s+/.test(seriesLower) || ZODIAC_ANIMAL_RE.test(seriesLower);
  const isPerthLunar = isLunar && (/\bperth\b/.test(seriesLower) || /\baustralian?\b/.test(seriesLower));
  let lunarYearRange = null;  // { min, max } for filtering comps
  let brandFilter = null;

  // Build keywords — series name + optional weight for bullion coins
  let keywords = series;

  if (isPerthLunar) {
    // Extract the animal and find which series this falls into.
    // Reverse-lookup a plausible year from the animal to get the series range.
    const animalMatch = seriesLower.match(ZODIAC_ANIMAL_RE);
    const animal = animalMatch ? animalMatch[1] : null;
    // Try to extract a series number from the series name (e.g. "Series II")
    const snMatch = seriesLower.match(/series\s*(i{1,3}|[123])/i);
    let seriesNum = null;
    if (snMatch) {
      const sn = snMatch[1].toUpperCase();
      seriesNum = sn === '1' ? 'I' : sn === '2' ? 'II' : sn === '3' ? 'III' : sn;
    }
    // Determine year range from series number
    if (seriesNum === 'I')   lunarYearRange = { min: 1996, max: 2007 };
    else if (seriesNum === 'II')  lunarYearRange = { min: 2008, max: 2019 };
    else if (seriesNum === 'III') lunarYearRange = { min: 2020, max: 2031 };
    else if (animal) {
      // No explicit series number — infer from keywords. Check if any year
      // hint exists, otherwise default to most recent completed series.
      // We can't know for sure, so pick the most popular (Series II: 2008-2019).
      lunarYearRange = { min: 2008, max: 2019 };
    }

    // Build broader keywords: "Perth Lunar Series II Silver 1 oz"
    // Remove the specific animal from keywords so all years are matched.
    const metalToken = _detectMetal(series) || 'silver';
    let lunarKeywords = 'Perth Lunar';
    if (seriesNum) lunarKeywords += ' Series ' + seriesNum;
    lunarKeywords += ' ' + metalToken;
    keywords = lunarKeywords;
    brandFilter = 'Perth Mint';
    console.log(`[marketAggregator] Lunar series detected: keywords="${keywords}", yearRange=${lunarYearRange?.min}-${lunarYearRange?.max}`);
  }

  // Append weight to keywords so eBay returns size-appropriate listings.
  // For 1 oz bullion, "1 oz" is critical to exclude fractional and non-bullion coins.
  const bullion = !isBarSeries(series) && isBullionSeries(series);
  const effectiveWeight = weight || (bullion ? 1 : null);
  if (effectiveWeight && effectiveWeight !== 1) {
    const WEIGHT_LABELS = { 0.5: '1/2', 0.25: '1/4', 0.1: '1/10', 0.05: '1/20' };
    const wStr = WEIGHT_LABELS[effectiveWeight] ? WEIGHT_LABELS[effectiveWeight] + ' oz' : effectiveWeight + ' oz';
    keywords = keywords + ' ' + wStr;
  } else if (effectiveWeight === 1 || isPerthLunar) {
    keywords += ' 1 oz';
  }

  // Detect if the user is searching for rolls (e.g. "Franklin Half Dollar Roll")
  const isRoll = /\brolls?\b/i.test(series);

  // Fetch completed sales via the existing fetchSoldComps pipeline
  // This returns comps from Insights + Finding APIs
  const detectedMetal = _detectMetal(series);
  const expectedOpts = { series, _rawQuery: keywords, metal: detectedMetal, isRoll };
  if (effectiveWeight) expectedOpts.weight = effectiveWeight;
  if (brandFilter) expectedOpts._brandFilter = brandFilter;

  // Fetch spot price so weight/melt sanity filters can fire (non-fatal).
  if (detectedMetal && effectiveWeight) {
    const METAL_SYM = { silver: 'XAG', gold: 'XAU', platinum: 'XPT', palladium: 'XPD' };
    const sym = METAL_SYM[detectedMetal];
    if (sym) {
      try {
        const spot = await getMetalsSpotPrice(sym, 'USD');
        expectedOpts.meltPerOz = spot.price;
      } catch { /* non-fatal */ }
    }
  }

  // Determine earliest production year for this bullion series.
  // Comps with years before this are non-bullion coins that share keywords.
  let firstYear = null;
  if (bullion) {
    const sLow = series.toLowerCase();
    for (const [token, yr] of Object.entries(BULLION_FIRST_YEAR)) {
      if (sLow.includes(token)) { firstYear = yr; break; }
    }
  }

  const soldResult = await ebayService.fetchSoldComps(keywords, {
    timeWindowDays,
    maxPages: 3,
    usMinComps: 0,  // don't trigger Browse fallback
  }, expectedOpts);

  let completedComps = [
    ...(soldResult.us?.comps || []),
    ...(soldResult.global?.comps || []),
  ];

  // Fetch active BIN listings via Browse API directly (not through fetchSoldComps)
  let activeComps = [];
  try {
    const browseRaw = await ebayService.browseSearch(keywords, 200, brandFilter);
    // Score and keep only relevant comps
    const scored = browseRaw.map(c => ebayService.scoreMatch(c, expectedOpts));
    const { kept } = ebayService.applyFilters(scored, { usMinComps: 0, maxPages: 3 }, expectedOpts);
    activeComps = kept;
    console.log(`[marketAggregator] Browse API active listings: ${activeComps.length} kept (${browseRaw.length} raw)`);
  } catch (err) {
    console.warn('[marketAggregator] Browse fetch failed:', err.message);
  }

  // ── Filter Lunar comps to the correct series year range ──
  if (lunarYearRange) {
    const filterByYearRange = (comps) => comps.filter(c => {
      const year = extractYear(c.title);
      if (!year) return false; // drop comps with no year for Lunar (year matters)
      return year >= lunarYearRange.min && year <= lunarYearRange.max;
    });
    const preBefore = completedComps.length;
    completedComps = filterByYearRange(completedComps);
    const activeBefore = activeComps.length;
    activeComps = filterByYearRange(activeComps);
    console.log(`[marketAggregator] Lunar year filter: completed ${preBefore}→${completedComps.length}, active ${activeBefore}→${activeComps.length}`);
  }

  // ── Filter bullion comps before earliest production year ──
  // Prevents non-bullion coins (e.g. 1962 Mexico "libertad" peso) from appearing.
  if (firstYear) {
    const filterByFirstYear = (comps) => comps.filter(c => {
      const year = extractYear(c.title);
      if (!year) return true; // no year stated — keep (benefit of doubt)
      return year >= firstYear;
    });
    const cBefore = completedComps.length;
    completedComps = filterByFirstYear(completedComps);
    const aBefore = activeComps.length;
    activeComps = filterByFirstYear(activeComps);
    if (cBefore !== completedComps.length || aBefore !== activeComps.length) {
      console.log(`[marketAggregator] Pre-${firstYear} filter: completed ${cBefore}→${completedComps.length}, active ${aBefore}→${activeComps.length}`);
    }
  }

  // ── Filter non-bullion denomination coins from bullion searches ──
  // Old circulating coins (centavos, pesos) share keywords like "libertad"
  // but are not bullion. Only filter when we're in bullion mode.
  if (bullion) {
    const filterNonBullion = (comps) => comps.filter(c => {
      const t = c.title || '';
      return !(BULLION_DENY_DENOM_RE.test(t) && !BULLION_OK_RE.test(t));
    });
    const cBefore = completedComps.length;
    completedComps = filterNonBullion(completedComps);
    const aBefore = activeComps.length;
    activeComps = filterNonBullion(activeComps);
    if (cBefore !== completedComps.length || aBefore !== activeComps.length) {
      console.log(`[marketAggregator] Non-bullion denom filter: completed ${cBefore}→${completedComps.length}, active ${aBefore}→${activeComps.length}`);
    }
  }

  const bar = isBarSeries(series);
  const matrix = bar
    ? buildBarMatrix({
        completedComps,
        activeComps,
        series,
        lookbackDays: timeWindowDays,
      })
    : bullion
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
  buildBarMatrix,
  fetchMarketMatrix,
  extractYear,
  extractMint,
  extractGrade,
  extractBrand,
  matchesGrade,
  isBullionSeries,
  isBarSeries,
  clearCache,
};
