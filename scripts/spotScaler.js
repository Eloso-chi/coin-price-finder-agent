// scripts/spotScaler.js — Spot-price-aware range scaling for CSV generators.
// Instead of hardcoded price ranges that go stale, we scale every template's
// [lo, hi] by the *delta* between the spot price the ranges were originally
// calibrated against and the current (live or fallback) spot price.
//
// Formula:  newRange = [lo + Δ, hi + Δ]
//   where   Δ = (currentSpot − baseSpot) × pureOzWeight
//
// This preserves each template's collector / grade premium exactly and only
// shifts the melt-value component.
//
// Usage:
//   const { initSpot, scaleRange } = require('./spotScaler');
//   await initSpot();                       // call once at startup
//   const [lo, hi] = scaleRange([32, 42], 'American Silver Eagle 1 oz', templateTitle);

'use strict';

/* ── Base spot prices the hardcoded ranges were calibrated to ────────── */
const BASE_SPOT = {
  XAG:  30.00,   // Silver $/oz  (ranges written when Ag ≈ $30)
  XAU: 2650.00,  // Gold   $/oz  (ranges written when Au ≈ $2,650)
  XPT: 1000.00,  // Platinum $/oz
};

/* ── Fallback "current" prices when live fetch fails ─────────────────── */
const FALLBACK_CURRENT = {
  XAG:   82.00,
  XAU: 2900.00,
  XPT: 1100.00,
};

/* ── Silver content for US numismatic coins (troy oz pure Ag) ────────── */
const SILVER_CONTENT = {
  dollar:  0.77344,  // Morgan, Peace, Trade Dollar, Seated Liberty $1
  half:    0.36169,  // Walking Liberty, Franklin, Kennedy (90 %)
  quarter: 0.18084,  // Standing Liberty, Barber, Washington (90 %)
  dime:    0.07234,  // Mercury, Barber (90 %)
};

/* ── Gold content for pre-1933 US gold coins (troy oz pure Au) ───────── */
const GOLD_CONTENT = {
  doubleEagle:  0.9675,   // $20  Saint-Gaudens / Liberty
  eagle:        0.48375,  // $10  Indian Head, Liberty
  halfEagle:    0.24187,  // $5   Liberty, Indian
  quarterEagle: 0.12094,  // $2.50  Indian
};

/* ── Internal state ──────────────────────────────────────────────────── */
let _current = null;

/**
 * Try to fetch live spot via the app's metalsSpotPrice service.
 * Returns null on failure (API keys missing, network error, etc.).
 */
async function _fetchLive() {
  try {
    const { getMetalsSpotPrices } = require('../src/services/metalsSpotPrice');
    const data = await getMetalsSpotPrices(['XAU', 'XAG', 'XPT'], 'USD');
    const result = {};
    for (const [metal, info] of Object.entries(data)) {
      result[metal] = info.price;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Initialise spot prices.  Tries live fetch first, then falls back.
 * Env-var overrides: SPOT_XAG, SPOT_XAU, SPOT_XPT
 */
async function initSpot() {
  const live = await _fetchLive();
  _current = live || { ...FALLBACK_CURRENT };

  // Environment overrides (handy for CI / reproducible builds)
  if (process.env.SPOT_XAG) _current.XAG = parseFloat(process.env.SPOT_XAG);
  if (process.env.SPOT_XAU) _current.XAU = parseFloat(process.env.SPOT_XAU);
  if (process.env.SPOT_XPT) _current.XPT = parseFloat(process.env.SPOT_XPT);

  const src = live ? 'LIVE' : 'FALLBACK';
  console.log(`  Spot prices (${src}):  Ag $${_current.XAG}/oz   Au $${_current.XAU}/oz   Pt $${_current.XPT}/oz`);
  console.log(`  Base calibration:      Ag $${BASE_SPOT.XAG}/oz   Au $${BASE_SPOT.XAU}/oz   Pt $${BASE_SPOT.XPT}/oz`);
  return _current;
}

/* ── Metal inference ─────────────────────────────────────────────────── */

function inferMetal(searchTerm) {
  const s = searchTerm.toLowerCase();

  // Explicit metal names
  if (s.includes('gold'))     return 'XAU';
  if (s.includes('platinum')) return 'XPT';
  if (s.includes('silver'))   return 'XAG';

  // Pre-1933 US gold without "gold" in the name
  if (s.includes('saint gaudens') || s.includes('double eagle'))  return 'XAU';
  if (s.includes('indian head eagle'))  return 'XAU';
  if (s.includes('indian quarter eagle'))  return 'XAU';
  if (s.includes('indian eagle'))  return 'XAU';
  if (s.includes('liberty half eagle') || s.includes('liberty eagle'))  return 'XAU';

  // Everything else (Morgan, Peace, Walking Liberty, etc.) is silver
  return 'XAG';
}

/* ── Weight inference ────────────────────────────────────────────────── */

/**
 * Infer pure-metal troy-oz weight from template title (preferred) or coin searchTerm.
 * The template title is checked first because some coin entries mix fractional
 * templates into a larger-coin entry (e.g. 1986-AGE 1oz entry includes 1/2, 1/4, 1/10).
 */
function inferOzWeight(searchTerm, title) {
  // ── 1. Explicit weight from title ────────────────────────
  if (title) {
    const t = title.toLowerCase();
    if (t.includes('1/20 oz') || t.includes('twentieth oz')) return 0.05;
    if (t.includes('1/10 oz') || t.includes('tenth oz'))     return 0.1;
    if (t.includes('1/4 oz')  || t.includes('quarter oz'))   return 0.25;
    if (t.includes('1/2 oz')  || t.includes('half oz'))      return 0.5;
    if (t.includes('10 oz'))  return 10.0;
    if (t.includes('5 oz'))   return 5.0;
    if (t.includes('2 oz'))   return 2.0;
    if (t.includes('1 oz'))   return 1.0;
  }

  // ── 2. Explicit weight from searchTerm ───────────────────
  const s = searchTerm.toLowerCase();
  if (s.includes('1/20 oz') || s.includes('twentieth oz')) return 0.05;
  if (s.includes('1/10 oz') || s.includes('tenth oz'))     return 0.1;
  if (s.includes('1/4 oz')  || s.includes('quarter oz'))   return 0.25;
  if (s.includes('1/2 oz')  || s.includes('half oz'))      return 0.5;
  if (s.includes('10 oz'))  return 10.0;
  if (s.includes('5 oz'))   return 5.0;
  if (s.includes('2 oz'))   return 2.0;
  if (s.includes('1 oz'))   return 1.0;

  // ── 3. Pre-1933 US gold coins (pure-gold content) ───────
  if (s.includes('double eagle') || s.includes('saint gaudens'))  return GOLD_CONTENT.doubleEagle;
  if (s.includes('indian quarter eagle'))                          return GOLD_CONTENT.quarterEagle;
  if (s.includes('indian head eagle') || s.includes('indian eagle')) return GOLD_CONTENT.eagle;
  if (s.includes('liberty half eagle'))                            return GOLD_CONTENT.halfEagle;

  // ── 4. US 90 % silver numismatic coins ───────────────────
  if (s.includes('trade dollar'))                                  return 0.7878;
  if (s.includes('morgan') || s.includes('peace') ||
      s.includes('seated liberty dollar'))                         return SILVER_CONTENT.dollar;
  if (s.includes('half dollar') || s.includes('walking liberty') ||
      s.includes('franklin half') || s.includes('kennedy half') ||
      s.includes('barber half'))                                   return SILVER_CONTENT.half;
  if (/\bhalf\b/.test(s) && s.includes('dollar'))                 return SILVER_CONTENT.half;
  if ((s.includes('quarter') && !s.includes('oz')) ||
      s.includes('standing liberty') || s.includes('barber quarter') ||
      s.includes('washington quarter'))                            return SILVER_CONTENT.quarter;
  if (s.includes('dime') || s.includes('mercury'))                return SILVER_CONTENT.dime;

  // ── 5. Default: 1 oz bullion ─────────────────────────────
  return 1.0;
}

/* ── Core scaling function ───────────────────────────────────────────── */

/**
 * Scale a hardcoded [lo, hi] price range for current spot price.
 *
 * @param {number[]} range          – original [lo, hi]
 * @param {string}   searchTerm     – the coin entry's searchTerm
 * @param {string}   [templateTitle] – the individual template's title (has fractional oz info)
 * @returns {number[]}               – scaled [lo, hi]
 */
function scaleRange(range, searchTerm, templateTitle) {
  if (!_current) return range;  // initSpot() not called yet

  const metal = inferMetal(searchTerm);
  const base  = BASE_SPOT[metal];
  const curr  = _current[metal];
  if (!base || !curr) return range;

  const oz    = inferOzWeight(searchTerm, templateTitle);
  const delta = (curr - base) * oz;

  const lo = Math.round((range[0] + delta) * 100) / 100;
  const hi = Math.round((range[1] + delta) * 100) / 100;

  // Safety floor: never drop below 80 % of original (guards against negative deltas)
  return [
    Math.max(lo, range[0] * 0.8),
    Math.max(hi, range[1] * 0.8),
  ];
}

/* ── Exports ─────────────────────────────────────────────────────────── */
module.exports = {
  BASE_SPOT,
  FALLBACK_CURRENT,
  initSpot,
  scaleRange,
  inferMetal,
  inferOzWeight,
};
