// src/data/dealerPremiums.js
// Reference table of typical retail dealer premiums (% over spot melt) for
// common bullion coins / bars. Used by anomaly-detection diagnostics
// (e.g. scripts/fmv-drift-monitor.js, scripts/bar-pricing-health.js) to flag
// FMV outputs whose premium is outside the normal market range.
//
// Premium = (FMV - meltValue) / meltValue  (as a decimal, e.g. 0.20 = 20%)
//
// Ranges are deliberately wide to accommodate market swings, low-mintage
// year premiums, and dealer-mix variation. Tighten only after gathering
// real-world data.
//
// Backlog: #196 (Dealer Premium Benchmark Table for Bullion Anomaly Detection)
'use strict';

const fs = require('fs');
const path = require('path');
const { bucketForWeight } = require('../utils/barPremiumStats');

const BAR_PREMIUMS_PATH = path.join(__dirname, '..', '..', 'data', 'bar-premiums.json');
const _barPremiumCache = new Map();

function loadBarPremiums(file = BAR_PREMIUMS_PATH) {
  if (_barPremiumCache.has(file)) return _barPremiumCache.get(file);
  let data = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.segments)) data = parsed;
  } catch (_) { /* missing or unreadable: fall back to the static table */ }
  _barPremiumCache.set(file, data);
  return data;
}

// ── Bullion premium ranges by metal + form ─────────────────────────────────
// Keys are matched in order; the first matching `match(parsed)` predicate wins.
// `match` receives a normalized `parsed` shape: { metal, weightOz, series, form }
// where `form` ∈ {'coin','bar','round'} (optional).
const PREMIUM_RANGES = [
  // ── Gold coins ────────────────────────────────────────────
  { key: 'gold-eagle-1oz',          metal: 'gold',     min: 0.04, max: 0.12, match: p => p.series === 'American Gold Eagle' && p.weightOz === 1 },
  { key: 'gold-eagle-frac',         metal: 'gold',     min: 0.08, max: 0.25, match: p => p.series === 'American Gold Eagle' && p.weightOz < 1 },
  { key: 'gold-buffalo-1oz',        metal: 'gold',     min: 0.04, max: 0.12, match: p => p.series === 'American Gold Buffalo' && p.weightOz === 1 },
  { key: 'gold-maple-1oz',          metal: 'gold',     min: 0.03, max: 0.10, match: p => p.series === 'Canadian Gold Maple Leaf' && p.weightOz === 1 },
  { key: 'gold-krugerrand-1oz',     metal: 'gold',     min: 0.03, max: 0.10, match: p => p.series === 'Gold Krugerrand' && p.weightOz === 1 },
  { key: 'gold-panda-1oz',          metal: 'gold',     min: 0.05, max: 0.20, match: p => p.series === 'Chinese Gold Panda' && p.weightOz >= 0.9 },
  { key: 'gold-libertad-1oz',       metal: 'gold',     min: 0.08, max: 0.40, match: p => p.series === 'Mexican Gold Libertad' && p.weightOz === 1 },
  { key: 'gold-coin-frac-other',    metal: 'gold',     min: 0.08, max: 0.30, match: p => p.metal === 'gold' && p.form !== 'bar' && p.weightOz && p.weightOz < 1 },
  { key: 'gold-coin-1oz-other',     metal: 'gold',     min: 0.03, max: 0.15, match: p => p.metal === 'gold' && p.form !== 'bar' && p.weightOz === 1 },

  // ── Gold bars ─────────────────────────────────────────────
  { key: 'gold-bar-1g',             metal: 'gold',     min: 0.12, max: 0.40, match: p => p.metal === 'gold' && p.form === 'bar' && p.weightOz <= 0.04 },
  { key: 'gold-bar-small',          metal: 'gold',     min: 0.05, max: 0.20, match: p => p.metal === 'gold' && p.form === 'bar' && p.weightOz < 0.5 },
  { key: 'gold-bar-1oz',            metal: 'gold',     min: 0.02, max: 0.08, match: p => p.metal === 'gold' && p.form === 'bar' && p.weightOz >= 0.5 },

  // ── Silver coins ──────────────────────────────────────────
  { key: 'silver-eagle-1oz',        metal: 'silver',   min: 0.25, max: 0.80, match: p => p.series === 'American Silver Eagle' && p.weightOz === 1 },
  { key: 'silver-maple-1oz',        metal: 'silver',   min: 0.15, max: 0.50, match: p => p.series === 'Canadian Silver Maple Leaf' && p.weightOz === 1 },
  { key: 'silver-krugerrand-1oz',   metal: 'silver',   min: 0.15, max: 0.50, match: p => p.series === 'Silver Krugerrand' && p.weightOz === 1 },
  { key: 'silver-britannia-1oz',    metal: 'silver',   min: 0.15, max: 0.50, match: p => p.series === 'British Silver Britannia' && p.weightOz === 1 },
  { key: 'silver-philharmonic-1oz', metal: 'silver',   min: 0.15, max: 0.50, match: p => p.series === 'Austrian Silver Philharmonic' && p.weightOz === 1 },
  { key: 'silver-panda-30g',        metal: 'silver',   min: 0.20, max: 0.80, match: p => p.series === 'Chinese Silver Panda' },
  { key: 'silver-libertad-1oz',     metal: 'silver',   min: 0.30, max: 1.50, match: p => p.series === 'Mexican Silver Libertad' && p.weightOz === 1 },
  { key: 'silver-kookaburra-1oz',   metal: 'silver',   min: 0.20, max: 0.80, match: p => p.series === 'Australian Silver Kookaburra' && p.weightOz === 1 },
  { key: 'silver-lunar-1oz',        metal: 'silver',   min: 0.20, max: 1.00, match: p => /Lunar/i.test(p.series || '') && p.metal === 'silver' && p.weightOz === 1 },
  { key: 'silver-coin-1oz-other',   metal: 'silver',   min: 0.10, max: 0.60, match: p => p.metal === 'silver' && p.form !== 'bar' && p.weightOz === 1 },

  // ── Silver bars / rounds ──────────────────────────────────
  { key: 'silver-round-1oz',        metal: 'silver',   min: 0.08, max: 0.30, match: p => p.metal === 'silver' && p.form === 'round' && p.weightOz === 1 },
  { key: 'silver-bar-1oz',          metal: 'silver',   min: 0.08, max: 0.30, match: p => p.metal === 'silver' && p.form === 'bar' && p.weightOz === 1 },
  { key: 'silver-bar-10oz',         metal: 'silver',   min: 0.05, max: 0.20, match: p => p.metal === 'silver' && p.form === 'bar' && p.weightOz >= 5 && p.weightOz <= 15 },
  { key: 'silver-bar-100oz',        metal: 'silver',   min: 0.03, max: 0.12, match: p => p.metal === 'silver' && p.form === 'bar' && p.weightOz >= 90 },

  // ── Platinum / palladium ──────────────────────────────────
  { key: 'platinum-eagle-1oz',      metal: 'platinum', min: 0.05, max: 0.20, match: p => p.series === 'American Platinum Eagle' && p.weightOz === 1 },
  { key: 'platinum-coin-1oz-other', metal: 'platinum', min: 0.04, max: 0.20, match: p => p.metal === 'platinum' && p.weightOz === 1 },
  { key: 'palladium-1oz',           metal: 'palladium', min: 0.04, max: 0.20, match: p => p.metal === 'palladium' && p.weightOz === 1 },
];

/**
 * Segment-specific bar range from data/bar-premiums.json (scripts/bar-premiums.js).
 * Tries the series segment, then the maker, then generic, and uses the first that
 * is reliable (enough sold comps with a spot price). The range is the quartiles
 * widened by 1.5 IQR on each side, matching the table's deliberately wide ranges.
 * Returns null when the data file has no reliable segment (the caller falls back
 * to the static table).
 * @param {{ metal:string, weightOz:number, barSegment:{class:string, brand?:string|null, series?:string|null} }} parsed
 * @param {{ file?: string }} [opts]
 * @returns {{ key:string, min:number, max:number, source:'bar-premiums', segment:string, n:number }|null}
 */
function lookupBarSegmentRange(parsed, { file } = {}) {
  const seg = parsed && parsed.barSegment;
  if (!seg || !parsed.metal) return null;
  const bucket = bucketForWeight(parsed.weightOz);
  const data = loadBarPremiums(file);
  if (!bucket || !data) return null;
  const metal = String(parsed.metal).toLowerCase();
  const find = (cls, brand, series) => data.segments.find(s => s.metal === metal && s.weightBucket === bucket.label
    && s.class === cls && (s.brand || null) === (brand || null) && (s.series || null) === (series || null));
  const ladder = [];
  if (seg.class === 'series' && seg.brand && seg.series) ladder.push(find('series', seg.brand, seg.series));
  if (seg.brand) ladder.push(find('brand', seg.brand, null));
  if (!seg.brand) ladder.push(find('generic', null, null));
  const hit = ladder.find(s => s && s.reliable && s.premium);
  if (!hit) return null;
  const iqr = hit.premium.p75 - hit.premium.p25;
  return {
    key: `bar-segment:${hit.key}`,
    min: +(hit.premium.p25 - 1.5 * iqr).toFixed(4),
    max: +(hit.premium.p75 + 1.5 * iqr).toFixed(4),
    source: 'bar-premiums',
    segment: hit.class,
    n: hit.nWithSpot,
  };
}

/**
 * Look up the expected premium range for a coin/bar.
 * A bar with `parsed.barSegment` uses the data-driven segment range when one is
 * reliable; everything else, and any bar without reliable data, uses the static table.
 * @param {object} parsed - { metal, weightOz, series, form, barSegment? }
 * @param {{ barPremiumsFile?: string }} [opts]
 * @returns {{ key:string, min:number, max:number }|null}
 */
function lookupPremiumRange(parsed, opts = {}) {
  if (!parsed || !parsed.metal) return null;
  if (parsed.form === 'bar' && parsed.barSegment) {
    const dataRange = lookupBarSegmentRange(parsed, { file: opts.barPremiumsFile });
    if (dataRange) return dataRange;
  }
  const p = {
    metal: String(parsed.metal).toLowerCase(),
    weightOz: typeof parsed.weightOz === 'number' ? parsed.weightOz : null,
    series: parsed.series || null,
    form: parsed.form || null,
  };
  for (const row of PREMIUM_RANGES) {
    try {
      if (row.match(p)) return { key: row.key, min: row.min, max: row.max };
    } catch (_) { /* predicate guard */ }
  }
  return null;
}

/**
 * Classify a premium against the benchmark range.
 * @param {number} premium - decimal (e.g. 0.20 = 20%)
 * @param {{min:number,max:number}} range
 * @returns {'low'|'normal'|'high'|'unknown'}
 */
function classifyPremium(premium, range) {
  if (!range || !Number.isFinite(premium)) return 'unknown';
  if (premium < range.min) return 'low';
  if (premium > range.max) return 'high';
  return 'normal';
}

/**
 * Compute premium from FMV and melt value.
 * @returns {number|null} decimal premium, or null if inputs invalid
 */
function computePremium(fmv, meltValue) {
  if (!Number.isFinite(fmv) || !Number.isFinite(meltValue) || meltValue <= 0) return null;
  return (fmv - meltValue) / meltValue;
}

module.exports = {
  PREMIUM_RANGES,
  lookupPremiumRange,
  lookupBarSegmentRange,
  classifyPremium,
  computePremium,
};
