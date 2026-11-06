// src/utils/barIdentity.js -- one bar identity for every pricing route (#333H)
// CommonJS
'use strict';

const { canonicalizeBarBrand, detectBarSeries } = require('../data/barSeries');

const GRAMS_PER_OZT = 31.1035;
const OZT_PER_KILO = 32.1507;
const MAX_BAR_OZT = 1000;
const MIN_BAR_OZT = 0.01 / GRAMS_PER_OZT;
const MAX_BAR_TEXT = 60;

/**
 * Brand classes, from narrowest to broadest:
 *   series  -- recognized maker and recognized series/line
 *   brand   -- maker only (recognized, or a user-typed maker we cannot classify)
 *   generic -- no maker; every recognized maker is excluded from the comp pool
 */
const BAR_BRAND_CLASSES = Object.freeze(['series', 'brand', 'generic']);

/**
 * Premium ceiling over spot for bars, by metal. Safety net only: it replaces
 * the old test on the bar's total spot value (`spotPrice > 500`), which gave a
 * 10 oz silver bar the gold cap and a 1 oz silver bar the silver cap. Phase 2
 * of #333H replaces this with spot-normalized segment premiums.
 */
const BAR_MAX_PREMIUM = Object.freeze({
  silver: 1.00,
  gold: 0.40,
  platinum: 0.40,
  palladium: 0.40,
});

function barMaxPremium(metal) {
  const key = typeof metal === 'string' ? metal.toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(BAR_MAX_PREMIUM, key) ? BAR_MAX_PREMIUM[key] : 0.40;
}

/** ".5 gram" -> "0.5 gram", "  1  OZ " -> "1 oz". */
function normalizeBarSize(raw) {
  if (typeof raw !== 'string') return raw;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^\.(\d)/, '0.$1');
  s = s.replace(/\s+/g, ' ');
  return s;
}

function _number(text) {
  const frac = String(text).match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const denom = parseInt(frac[2], 10);
    return denom > 0 ? parseInt(frac[1], 10) / denom : NaN;
  }
  return parseFloat(text);
}

/**
 * Parse a bar size into troy ounces. Returns null for anything that is not a
 * recognized weight (never a silent 1 oz default).
 * Accepts grams (g, gm, gram, grams), troy ounces (oz, ozt, ounce, troy oz,
 * fractions such as 1/10 oz), and kilos (kilo, kg, "2 kilo").
 * @param {string} size
 * @returns {{ weightOzt: number, size: string }|null}
 */
function parseBarSize(size) {
  if (typeof size !== 'string') return null;
  const s = normalizeBarSize(size);
  if (!s || s.length > 40) return null;

  const num = '(\\d+(?:\\.\\d+)?(?:\\s*/\\s*\\d+)?)';
  let m = s.match(new RegExp(`^${num}\\s*(?:grams?|gms?|g)$`));
  let weightOzt = null;
  if (m) {
    weightOzt = _number(m[1]) / GRAMS_PER_OZT;
  } else if ((m = s.match(new RegExp(`^${num}\\s*(?:troy\\s*)?(?:ozt?|ounces?)$`)))) {
    weightOzt = _number(m[1]);
  } else if ((m = s.match(new RegExp(`^(?:${num}\\s*)?(?:kilos?|kilograms?|kgs?)$`)))) {
    weightOzt = (m[1] ? _number(m[1]) : 1) * OZT_PER_KILO;
  }
  if (!Number.isFinite(weightOzt) || weightOzt < MIN_BAR_OZT || weightOzt > MAX_BAR_OZT) return null;
  return { weightOzt, size: s };
}

/**
 * Resolve a bar request to its brand class. Pure and shared by
 * /api/bar-price, /api/price and /api/pricing-batch so the same bar gets the
 * same segment everywhere.
 *
 * @param {object} args
 * @param {string} [args.brand]   user-typed maker (canonicalized when recognized)
 * @param {string} [args.series]  user-typed series hint
 * @param {boolean} [args.isLunar] Lunar bars are matched by animal, not by catalog series
 * @returns {{ class: 'series'|'brand'|'generic', barBrand: string|null,
 *   barSeries: string|null, barSeriesRe: RegExp|null, barSeriesKeywords: string|null,
 *   requestedBrand: string|null, unrecognizedSeries: string|null, label: string }}
 */
function resolveBarSegment({ brand, series, isLunar = false } = {}) {
  const clip = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_BAR_TEXT) : '');
  const typedBrand = clip(brand) || null;
  const typedSeriesText = clip(series);
  const barBrand = canonicalizeBarBrand(typedBrand);
  const seriesEntry = (barBrand && !isLunar && typedSeriesText)
    ? detectBarSeries(barBrand, typedSeriesText)
    : null;
  const barSeries = seriesEntry ? seriesEntry.series : null;
  const typedSeries = (!isLunar && typedSeriesText) ? typedSeriesText : null;

  let cls;
  let label;
  if (barBrand && barSeries) {
    cls = 'series';
    label = `${barBrand} / ${barSeries}`;
  } else if (barBrand || typedBrand) {
    cls = 'brand';
    label = `${barBrand || typedBrand} (any series)`;
  } else {
    cls = 'generic';
    label = 'Generic (no recognized maker)';
  }
  return {
    class: cls,
    barBrand,
    barSeries,
    barSeriesRe: seriesEntry ? seriesEntry.re : null,
    barSeriesKeywords: seriesEntry ? seriesEntry.keywords : null,
    requestedBrand: !barBrand ? typedBrand : null,
    unrecognizedSeries: (typedSeries && !barSeries) ? typedSeries : null,
    label,
  };
}

/**
 * Segment for the comp filters and valuation. Reads `expected.barSegment`
 * when a route built one; otherwise derives it from `barBrand` / `barSeries`
 * so callers that set only those fields keep the #285W behavior.
 * @returns {{ class: string, barBrand: string|null, barSeries: string|null }|null}
 */
function getBarSegment(expected) {
  if (!expected) return null;
  if (expected.barSegment && BAR_BRAND_CLASSES.includes(expected.barSegment.class)) {
    return expected.barSegment;
  }
  if (expected.barBrand && expected.barSeries) {
    return { class: 'series', barBrand: expected.barBrand, barSeries: expected.barSeries };
  }
  if (expected.barBrand) {
    return { class: 'brand', barBrand: expected.barBrand, barSeries: null };
  }
  return null;
}

/** Compact, response-safe description of a segment. */
function describeBarSegment(segment) {
  if (!segment) return null;
  return {
    class: segment.class,
    brand: segment.barBrand || segment.requestedBrand || null,
    series: segment.barSeries || null,
    unrecognizedSeries: segment.unrecognizedSeries || null,
    label: segment.label || null,
  };
}

/**
 * Put a segment onto an `expected` object the same way for every route, so the
 * scoring, relevance gate and maker filters see identical inputs.
 * `brand` is the canonical maker when recognized, else the user-typed maker.
 */
function applyBarSegment(expected, segment) {
  // Coin-only identity fields would filter bar comps by year, mint, grade or series.
  if (expected.barYear == null && expected.year) expected.barYear = expected.year;
  expected.year = null;
  expected.mint = null;
  expected.series = null;
  expected.grade = null;
  expected.designation = null;
  expected.type = 'bar';
  expected.brand = segment.barBrand || segment.requestedBrand || null;
  expected.barBrand = segment.barBrand;
  expected.barSeries = segment.barSeries;
  expected.barSeriesRe = segment.barSeriesRe;
  expected.barSegment = segment;
  return expected;
}

module.exports = {
  BAR_BRAND_CLASSES,
  BAR_MAX_PREMIUM,
  barMaxPremium,
  normalizeBarSize,
  parseBarSize,
  resolveBarSegment,
  getBarSegment,
  describeBarSegment,
  applyBarSegment,
  MAX_BAR_TEXT,
  MIN_BAR_OZT,
  GRAMS_PER_OZT,
  OZT_PER_KILO,
};
