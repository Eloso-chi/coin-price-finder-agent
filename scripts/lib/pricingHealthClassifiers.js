'use strict';

/**
 * #262W -- Pure classifier helpers for scripts/pricing-health-full.js.
 *
 * Extracted into a separate module so each rule can be unit-tested
 * directly (the parent script makes HTTP calls and is harder to fault-inject).
 *
 * Inputs are shaped exactly as the `result` object built by
 * scripts/pricing-health-full.js#testCoin:
 *   { coin, teakRows, discovery: { fmv, confidence, method, compCount,
 *     usComps, spotPrice, ... }, batch: { ... } }
 *
 * Each classifier returns either an issue object (to be pushed onto
 * result.issues) or null when the rule does not fire. None of these
 * helpers throw -- a malformed input always yields null so the script
 * keeps grading the remaining coins.
 */

const {
  getCoinMetalProfile,
  detectWeightFromTitle,
} = require('../../src/utils/coinMetalProfile');
const {
  lookupPremiumRange,
  classifyPremium,
  computePremium,
} = require('../../src/data/dealerPremiums');

// -- Series detection (minimal, conservative) -----------------------------
// Maps query patterns to canonical series strings recognized by
// dealerPremiums.PREMIUM_RANGES `match` predicates. Order matters --
// first hit wins. Unknown queries return null and dependent checks
// fail-quiet (no false RED). Adding a row here is safe; removing one
// risks losing a band check.
const SERIES_PATTERNS = [
  [/\bgold krugerrand\b/i,                                  () => 'Gold Krugerrand'],
  [/\bsilver krugerrand\b/i,                                () => 'Silver Krugerrand'],
  [/\bkrugerrand\b/i,                                       (q) => /silver/i.test(q) ? 'Silver Krugerrand' : 'Gold Krugerrand'],
  [/\bamerican gold eagle\b|\bgold eagle\b/i,               () => 'American Gold Eagle'],
  [/\bamerican silver eagle\b|\bsilver eagle\b/i,           () => 'American Silver Eagle'],
  [/\bamerican (gold )?buffalo\b|\bgold buffalo\b/i,        () => 'American Gold Buffalo'],
  [/\bcanad(?:a|ian) gold maple\b|\bgold maple leaf\b/i,    () => 'Canadian Gold Maple Leaf'],
  [/\bcanad(?:a|ian) silver maple\b|\bsilver maple leaf\b/i,() => 'Canadian Silver Maple Leaf'],
  [/\bchinese gold panda\b|\bgold panda\b/i,                () => 'Chinese Gold Panda'],
  [/\bchinese (silver )?panda\b|\bsilver panda\b/i,         () => 'Chinese Silver Panda'],
  [/\bmexican gold libertad\b|\bgold libertad\b/i,          () => 'Mexican Gold Libertad'],
  [/\bmexican silver libertad\b|\bsilver libertad\b/i,      () => 'Mexican Silver Libertad'],
  [/\bbritish silver britannia\b|\bsilver britannia\b/i,    () => 'British Silver Britannia'],
  [/\baustrian silver philharmonic\b|\bsilver philharmonic\b/i, () => 'Austrian Silver Philharmonic'],
  [/\baustralian silver kookaburra\b|\bsilver kookaburra\b/i,   () => 'Australian Silver Kookaburra'],
  [/\b(?:perth )?lunar\b/i,                                 (q) => /gold/i.test(q) ? 'Gold Lunar' : 'Silver Lunar'],
  [/\bamerican platinum eagle\b|\bplatinum eagle\b/i,       () => 'American Platinum Eagle'],
];

function detectSeriesFromQuery(query) {
  if (!query || typeof query !== 'string') return null;
  for (const [re, fn] of SERIES_PATTERNS) {
    if (re.test(query)) return fn(query);
  }
  return null;
}

function detectFormFromQuery(query) {
  if (!query || typeof query !== 'string') return 'coin';
  if (/\bbar\b/i.test(query)) return 'bar';
  if (/\bround\b/i.test(query)) return 'round';
  return 'coin';
}

// -- Item 2: RP / proof melt-floor sanity ---------------------------------
// Detects the #260W class of bug: a "Reverse Proof Morgan" query has
// dozens of RP-tagged comps in the Terapeak store, but the valuator
// fell back to bullion-spot-premium (silver melt + 5%) and silently
// returned ~$35 instead of the ~$130 the comp blend would have given.
//
// Trigger:
//   - query intent is proof or reverse proof
//   - >= 10 surviving comps reached the valuation (so the spot fallback
//     is NOT due to "no comp data")
//   - valuation method is bullion-spot-premium
const PROOF_INTENT_RE = /\b(?:reverse\s+proof|enhanced\s+reverse\s+proof|proof)\b/i;

function classifyRpMeltFloor({ query, discovery } = {}) {
  if (!query || !discovery) return null;
  if (!PROOF_INTENT_RE.test(query)) return null;
  const usComps = discovery.usComps || 0;
  if (usComps < 10) return null;
  if (discovery.method !== 'bullion-spot-premium') return null;
  return {
    type: 'rp-melt-floor',
    severity: 'RED',
    method: discovery.method,
    usComps,
    fmv: discovery.fmv,
    note: 'proof/RP intent: spot-premium fallback won despite >=10 surviving comps',
  };
}

// -- Item 3: Dealer-premium band check ------------------------------------
// Calls dealerPremiums.lookupPremiumRange for the parsed
// (series, metal, weight, form) tuple. If a band is defined and the
// realized premium falls outside it, flag RED.
//
// Inputs:
//   - query (string) -- used to derive metal/weight/series/form
//   - discovery.fmv -- realized FMV in USD
//   - discovery.spotPrice -- coin-level melt value (meltPerOz * weight),
//     already exposed by /api/price as valuation.spotPrice
//
// Fail-quiet: returns null for unknown series, missing weight, missing
// spotPrice, or any "normal"/"unknown" classification. This avoids
// false RED on coins outside the dealerPremiums coverage table.
function classifyDealerPremium({ query, discovery } = {}) {
  if (!query || !discovery) return null;
  const fmv = discovery.fmv;
  const meltValue = discovery.spotPrice;
  if (!Number.isFinite(fmv) || !Number.isFinite(meltValue) || meltValue <= 0) return null;

  const profile = getCoinMetalProfile(query);
  if (!profile || !profile.isMetalBased) return null;
  const weightOz = detectWeightFromTitle(query);
  const series = detectSeriesFromQuery(query);
  const form = detectFormFromQuery(query);

  const parsed = { metal: profile.metal, weightOz, series, form };
  const range = lookupPremiumRange(parsed);
  if (!range) return null;

  const premium = computePremium(fmv, meltValue);
  if (premium === null) return null;
  const cls = classifyPremium(premium, range);
  if (cls === 'normal' || cls === 'unknown') return null;
  return {
    type: 'dealer-premium',
    severity: 'RED',
    classification: cls, // 'low' or 'high'
    premiumPct: +(premium * 100).toFixed(1),
    bandPct: { min: +(range.min * 100).toFixed(1), max: +(range.max * 100).toFixed(1) },
    bandKey: range.key,
    fmv,
    meltValue,
  };
}

// -- Item 1: Fractional-collision check -----------------------------------
// Groups results by (metal, series) and within each group flags pairs
// of fractional-weight datasets {weight A, weight A/2 (or 2A)} whose
// FMVs collide within 1%. This is the #261W class of bug: 1/10 oz and
// 1/20 oz Gold Maple Leaf both returning $4986 because the fractional
// melt ceiling was scaled to a full-ounce comp.
//
// Returns Map<coin -> issue>. Caller pushes the issue onto the matching
// result.issues array.
function findFractionalCollisions(results) {
  const issues = new Map();
  if (!Array.isArray(results) || results.length === 0) return issues;

  const groups = new Map();
  for (const r of results) {
    const q = r && r.coin;
    if (!q) continue;
    const fmv = r.discovery && r.discovery.fmv;
    if (!Number.isFinite(fmv) || fmv <= 0) continue;
    const profile = getCoinMetalProfile(q);
    if (!profile || !profile.isMetalBased) continue;
    const series = detectSeriesFromQuery(q);
    if (!series) continue;
    const weight = detectWeightFromTitle(q);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const key = `${profile.metal}|${series}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ coin: q, weight, fmv });
  }

  const COLLISION_PCT = 0.01; // within 1%
  const RATIO_TOL = 0.05;     // ratio within 5% of exact 2.0

  for (const [groupKey, entries] of groups) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const minW = Math.min(a.weight, b.weight);
        if (minW <= 0) continue;
        const ratio = Math.max(a.weight, b.weight) / minW;
        if (Math.abs(ratio - 2) > RATIO_TOL) continue;
        const maxFmv = Math.max(a.fmv, b.fmv);
        const fmvDelta = Math.abs(a.fmv - b.fmv) / maxFmv;
        if (fmvDelta > COLLISION_PCT) continue;

        const base = {
          type: 'fractional-collision',
          severity: 'RED',
          groupKey,
          fmvDeltaPct: +(fmvDelta * 100).toFixed(2),
          note: 'same-series fractional pair within 1% FMV despite 2x weight gap',
        };
        issues.set(a.coin, {
          ...base,
          weight: a.weight, fmv: a.fmv,
          peer: b.coin, peerWeight: b.weight, peerFmv: b.fmv,
        });
        issues.set(b.coin, {
          ...base,
          weight: b.weight, fmv: b.fmv,
          peer: a.coin, peerWeight: a.weight, peerFmv: a.fmv,
        });
      }
    }
  }
  return issues;
}

module.exports = {
  classifyRpMeltFloor,
  classifyDealerPremium,
  findFractionalCollisions,
  // Exposed for tests + reuse:
  detectSeriesFromQuery,
  detectFormFromQuery,
  PROOF_INTENT_RE,
};
