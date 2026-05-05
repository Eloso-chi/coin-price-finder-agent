// src/services/bulkEvaluateService.js -- Bulk Collection Evaluator
// Prices 50-500 coins with lot-level analysis.
// CommonJS
'use strict';

const crypto = require('crypto');
const pcgsService      = require('./pcgsService');
const ebayService      = require('./ebayService');
const greysheetService = require('./greysheetService');
const { computeValuation } = require('./valuationService');
const { getMetalsSpotPrice } = require('./metalsSpotPrice');
const { getCoinMetalProfile } = require('../utils/coinMetalProfile');
const { zodiacForYear, perthLunarSeries, getRollQuantity } = require('../data/constants');

const BULLION_SERIES = [
  'libertad', 'silver eagle', 'gold eagle', 'maple leaf', 'britannia',
  'philharmonic', 'krugerrand', 'kangaroo', 'kookaburra', 'panda',
  'gold buffalo', 'platinum eagle', 'palladium eagle', 'lunar', 'polar bear',
];

// ── Concurrency control ──────────────────────────────────────
const MAX_COINS = 500;
const COIN_CONCURRENCY = 10;          // per-job parallelism
const MAX_ACTIVE_JOBS  = 3;           // server-wide cap
let _activeJobs = 0;

// ── Result cache (1 hr TTL, keyed by input hash) ─────────────
const _cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function _hashInput(coins) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(coins));
  return h.digest('hex').slice(0, 16);
}

function _pruneCache() {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (now - v.ts > CACHE_TTL) _cache.delete(k);
  }
}

// ── Lot pricing formula ──────────────────────────────────────

/** Size discount: larger lots get a bigger discount. */
function sizeDiscount(count) {
  if (count <= 10)  return 0;
  if (count <= 50)  return 0.05;
  if (count <= 100) return 0.10;
  if (count <= 250) return 0.15;
  return 0.20;
}

/** Confidence penalty: low average confidence = additional lot discount. */
function confidencePenalty(avgConfidence) {
  return avgConfidence < 60 ? 0.05 : 0;
}

/** Concentration risk: single coin > 25% of lot is a flag, > 50% adds penalty. */
function concentrationPenalty(results) {
  const total = results.reduce((s, r) => s + (r.totalFmv || 0), 0);
  if (total <= 0) return { penalty: 0, flags: [] };
  const flags = [];
  let penalty = 0;
  for (const r of results) {
    const pct = (r.totalFmv || 0) / total;
    if (pct > 0.50) {
      penalty = 0.03;
      flags.push({ query: r.query, pctOfLot: +(pct * 100).toFixed(1), risk: 'high' });
    } else if (pct > 0.25) {
      flags.push({ query: r.query, pctOfLot: +(pct * 100).toFixed(1), risk: 'moderate' });
    }
  }
  return { penalty, flags };
}

/** Compute lot-level summary from per-coin results. */
function computeLotSummary(results) {
  const priced = results.filter(r => r.fmv != null && r.fmv > 0);
  const failed = results.filter(r => r.error);
  const noPriced = results.filter(r => !r.error && (r.fmv == null || r.fmv === 0));

  const totalFmv     = priced.reduce((s, r) => s + (r.totalFmv || 0), 0);
  const totalMelt    = priced.reduce((s, r) => s + (r.meltValue || 0), 0);
  const avgConf      = priced.length ? priced.reduce((s, r) => s + (r.confidence || 0), 0) / priced.length : 0;
  const bullionCount = priced.filter(r => r.isBullion).length;
  const bullionValue = priced.filter(r => r.isBullion).reduce((s, r) => s + (r.totalFmv || 0), 0);
  const bullionPct   = totalFmv > 0 ? bullionValue / totalFmv : 0;

  const coinCount = priced.length;
  const szDisc    = sizeDiscount(coinCount);
  const confPen   = confidencePenalty(avgConf);
  const { penalty: concPen, flags: concFlags } = concentrationPenalty(priced);

  const totalDiscount = szDisc + confPen + concPen;

  // Three buy tiers applied to the lot
  const cherryPick = +(totalFmv * Math.max(0.40, 0.60 - totalDiscount)).toFixed(2);
  const fairLot    = +(totalFmv * Math.max(0.50, 0.75 - totalDiscount)).toFixed(2);
  const fullRetail = +(totalFmv * Math.max(0.60, 0.87 - totalDiscount)).toFixed(2); // 87% = retail minus ~13% eBay fees

  return {
    coinCount: results.length,
    pricedCount: priced.length,
    failedCount: failed.length,
    noPriceCount: noPriced.length,
    totalFmv:        +totalFmv.toFixed(2),
    totalMelt:       +totalMelt.toFixed(2),
    avgConfidence:   +avgConf.toFixed(0),
    bullionCount,
    bullionPct:      +(bullionPct * 100).toFixed(1),
    discounts: {
      size:          +(szDisc * 100).toFixed(1),
      confidence:    +(confPen * 100).toFixed(1),
      concentration: +(concPen * 100).toFixed(1),
      total:         +(totalDiscount * 100).toFixed(1),
    },
    concentrationFlags: concFlags,
    buyTiers: {
      cherryPick,
      fairLot,
      fullRetail,
    },
  };
}

// ── Per-coin evaluation (medium-weight) ──────────────────────

async function evaluateOneCoin(coin) {
  const query = String(coin.query || coin.name || '').trim();
  if (!query) return { query: '', error: 'missing query' };

  try {
    const qty = Math.max(1, Math.min(9999, parseInt(coin.qty) || 1));

    // Identify
    const parsed = pcgsService.parseDescription(query);
    const series = coin.series || coin.name || parsed.series || '';
    const year   = coin.year || parsed.year;
    const mint   = coin.mintMark || parsed.mint || '';
    const grade  = coin.grade || parsed.grade || '';
    const gradeNum = parsed.gradeNum || parseInt((grade.match(/\d+/) || [])[0]) || null;

    // Weight
    let weight = coin.weight ? parseFloat(coin.weight) : (parsed.weight || null);
    if (!weight && series) {
      const sl = series.toLowerCase();
      if (BULLION_SERIES.some(b => sl.includes(b))) weight = 1;
    }

    // Detect proof / roll
    const isProof = parsed.finish === 'Proof' || /^(PF|PR)[-\s]?\d/i.test(grade) || /\bproof\b/i.test(query);
    const isRoll  = !!(parsed.isRoll || /\brolls?\b|\btubes?\b/i.test(query));

    // Metal / bullion
    const { isMetalBased, metal: detectedMetal } = getCoinMetalProfile(query);
    const isBullion = BULLION_SERIES.some(b => (series || query).toLowerCase().includes(b));

    // #162: World bullion BU fix — "BU" for bullion means raw mint-sealed,
    // not a PCGS-graded slab. Null out BU-expanded grade so valuation uses
    // raw pool and gradeNumMismatch filter doesn't kill valid comps.
    let effectiveGradeNum = gradeNum;
    let effectiveGrade = grade;
    if (isBullion && parsed._gradeSource === 'bu-term') {
      effectiveGradeNum = null;
      effectiveGrade = '';
    }

    // Expected context for eBay filtering
    const expected = {
      year, mint, series, grade: effectiveGrade || null, weight,
      finish: parsed.finish || null,
      isProof, isRoll, isSet: false,
      _exclusions: parsed._exclusions || null,
      _rawQuery: query,
    };
    if (year && /lunar/i.test(series)) {
      expected.zodiacAnimal = zodiacForYear(Number(year));
      expected.isLunarCoin = true;
    }

    // Spot price for bullion
    const METAL_SYM = { silver: 'XAG', gold: 'XAU', platinum: 'XPT', palladium: 'XPD' };
    const metalKey = detectedMetal || parsed.metal || null;
    let meltPerOz = null;
    if (metalKey && weight) {
      const sym = METAL_SYM[metalKey];
      if (sym) {
        try {
          const spot = await getMetalsSpotPrice(sym, 'USD');
          meltPerOz = spot.price;
          expected.meltPerOz = meltPerOz;
        } catch { /* non-fatal */ }
      }
    }

    // eBay comps (1 page, 90-day window -- medium weight)
    let keywords = ebayService.buildKeywords
      ? ebayService.buildKeywords({ series }, query, weight)
      : query;

    // Roll/tube keyword override
    if (isRoll) {
      const yr = year || '';
      keywords = `${yr}${mint ? '-' + mint : ''} ${series} (roll,tube)`.trim();
    }

    const ebay = await ebayService.fetchSoldComps(keywords, {
      timeWindowDays: 90,
      maxPages: 1,
      usMinComps: 3,
    }, expected);

    // PCGS
    let pcgs = { verified: false };
    try { pcgs = await pcgsService.resolveFromDescription(query); } catch { /* */ }

    // Greysheet
    const pcgsNo = pcgs?.pcgsCoinNumber || pcgs?.pcgsNo || null;
    let greysheet = pcgsNo ? await greysheetService.fetchPriceByPcgsNumber(pcgsNo, gradeNum) : null;
    if (!greysheet) {
      greysheet = await greysheetService.fetchTypePrice(query, gradeNum, {
        series, metal: metalKey, weight,
        finish: isProof ? 'Proof' : (parsed.finish || null),
      });
    }

    // Valuation
    const spotPrice = (isBullion && meltPerOz && weight) ? meltPerOz * weight : null;
    const result = computeValuation(pcgs, ebay, null, effectiveGradeNum, {
      isBullion,
      greysheet,
      spotPrice,
    });
    const val = result.valuation || {};
    const fmv = val.fmvCore || null;

    return {
      query,
      qty,
      year:   year || null,
      mint:   mint || null,
      series: series || null,
      grade:  grade || null,
      weight: weight || null,
      isBullion,
      isRoll,
      fmv,
      totalFmv:   fmv ? +(fmv * qty).toFixed(2) : null,
      rollQty:    isRoll ? (getRollQuantity(series || query) || null) : undefined,
      perCoinFmv: isRoll && fmv ? (() => { const rq = getRollQuantity(series || query); return rq ? +(fmv / rq).toFixed(2) : null; })() : undefined,
      rangeLow:   val.rangeLow || null,
      rangeHigh:  val.rangeHigh || null,
      confidence: val.confidence || null,
      method:     val.method || null,
      meltValue:  (meltPerOz && weight) ? +(meltPerOz * weight * qty).toFixed(2) : null,
      avgEbay:    ebay?.us?.stats?.median || ebay?.us?.stats?.mean || null,
      compCount:  ebay?.us?.stats?.count || 0,
      greysheet:  greysheet ? (greysheet.greyVal || greysheet.cpgVal || null) : null,
    };
  } catch (err) {
    return { query, error: err.message };
  }
}

// ── Job runner with controlled concurrency ───────────────────

/**
 * Run a bulk evaluation job.
 *
 * @param {Array<object>} coins -- array of { query, qty?, year?, mintMark?, grade?, weight?, series? }
 * @param {function} onProgress -- called with (result, index, total) for each coin completed
 * @returns {Promise<{ results: Array, lotSummary: object }>}
 */
async function runBulkEvaluation(coins, onProgress) {
  if (!Array.isArray(coins) || coins.length === 0) {
    throw new Error('coins array is required');
  }
  if (coins.length > MAX_COINS) {
    throw new Error(`Maximum ${MAX_COINS} coins per evaluation`);
  }
  if (_activeJobs >= MAX_ACTIVE_JOBS) {
    throw Object.assign(new Error('Server busy -- max concurrent bulk evaluations reached. Try again shortly.'), { status: 429 });
  }

  // Check cache
  const cacheKey = _hashInput(coins);
  _pruneCache();
  const cached = _cache.get(cacheKey);
  if (cached) {
    // Replay cached results through onProgress
    for (let i = 0; i < cached.data.results.length; i++) {
      onProgress?.(cached.data.results[i], i, cached.data.results.length);
    }
    return cached.data;
  }

  _activeJobs++;
  try {
    const results = new Array(coins.length);
    const total = coins.length;

    // Process in batches of COIN_CONCURRENCY
    for (let i = 0; i < total; i += COIN_CONCURRENCY) {
      const batch = coins.slice(i, i + COIN_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map((coin, j) => evaluateOneCoin(coin).then(result => {
          const idx = i + j;
          results[idx] = result;
          onProgress?.(result, idx, total);
          return result;
        }))
      );
    }

    const lotSummary = computeLotSummary(results);
    const data = { results, lotSummary };

    _cache.set(cacheKey, { ts: Date.now(), data });
    return data;
  } finally {
    _activeJobs--;
  }
}

module.exports = {
  runBulkEvaluation,
  evaluateOneCoin,
  computeLotSummary,
  // Exposed for testing
  sizeDiscount,
  confidencePenalty,
  concentrationPenalty,
  _cache,
  MAX_COINS,
  MAX_ACTIVE_JOBS,
};
