// src/utils/coinMetalProfile.js — Determine if a coin/bullion query is metal-based
// CommonJS

'use strict';

/**
 * Bullion series names (lowercased substrings).
 * Mirrors BULLION_1OZ_DEFAULT in priceRoute but lives here for reuse.
 */
const BULLION_SERIES = [
  'libertad', 'silver eagle', 'gold eagle', 'maple leaf', 'britannia',
  'philharmonic', 'krugerrand', 'kangaroo', 'kookaburra', 'panda',
  'gold buffalo', 'platinum eagle', 'palladium eagle', 'lunar',
  'polar bear',
];

/**
 * US coin types that contain significant silver content.
 * Matches broadly — the caller can refine with year if needed.
 */
const SILVER_US_COIN_SERIES = [
  'morgan', 'peace dollar', 'walking liberty', 'seated liberty',
  'barber half', 'barber quarter', 'barber dime',
  'franklin half', 'mercury dime', 'roosevelt dime',
  'washington quarter', 'standing liberty quarter',
  'kennedy half', 'trade dollar', 'bust half', 'bust dollar',
  'draped bust', 'flowing hair', 'capped bust',
];

/** US coin types with significant gold content. */
const GOLD_US_COIN_SERIES = [
  'liberty gold', 'liberty eagle', 'liberty half eagle', 'liberty quarter eagle',
  'indian head gold', 'indian gold', 'saint-gaudens', 'saint gaudens',
  'double eagle', 'gold dollar',
];

const METAL_RE = {
  silver: /\bsilver\b/i,
  gold:   /\bgold\b/i,
};

/**
 * Determine whether a query string represents a metal-based coin or bullion,
 * and which precious metal (silver or gold) is primary.
 *
 * @param {string} query — free-text search query
 * @returns {{ isMetalBased: boolean, metal: 'silver'|'gold'|null }}
 */
function getCoinMetalProfile(query) {
  if (!query) return { isMetalBased: false, metal: null };
  // Strip eBay exclusion operators (e.g. "-gold", "-silver") before metal detection.
  // These are search syntax, not descriptors of the coin itself.
  const q = query.replace(/(?:^|\s)-[a-zA-Z]+/g, ' ').toLowerCase().trim();

  // 1. Check explicit bullion series
  const isBullion = BULLION_SERIES.some(s => q.includes(s));
  if (isBullion) {
    // Determine metal from the query text
    if (METAL_RE.gold.test(q))   return { isMetalBased: true, metal: 'gold' };
    if (METAL_RE.silver.test(q)) return { isMetalBased: true, metal: 'silver' };
    // Bullion but metal not explicit — infer from series name
    if (/gold eagle|gold buffalo|krugerrand/i.test(q)) return { isMetalBased: true, metal: 'gold' };
    // Default bullion to silver (most common)
    return { isMetalBased: true, metal: 'silver' };
  }

  // 2. Check US gold coin series
  if (GOLD_US_COIN_SERIES.some(s => q.includes(s))) {
    return { isMetalBased: true, metal: 'gold' };
  }

  // 3. Check US silver coin series
  if (SILVER_US_COIN_SERIES.some(s => q.includes(s))) {
    return { isMetalBased: true, metal: 'silver' };
  }

  // 4. Explicit metal keyword in query (e.g. "1 oz silver round")
  if (METAL_RE.gold.test(q))   return { isMetalBased: true, metal: 'gold' };
  if (METAL_RE.silver.test(q)) return { isMetalBased: true, metal: 'silver' };

  return { isMetalBased: false, metal: null };
}

// ── Composition Classification ──────────────────────────────

/** Bars and rounds patterns */
const BAR_ROUND_PATTERNS = ['silver bar', 'gold bar', 'platinum bar', 'silver round', 'gold round'];

/** Base-metal US coins (copper, nickel, zinc, clad) */
const BASE_METAL_SERIES = [
  'indian head cent', 'lincoln', 'shield nickel', 'jefferson nickel',
  'liberty nickel', 'liberty v nickel', 'buffalo nickel', 'wheat cent',
  'flying eagle', 'large cent', 'half cent', 'two cent', 'three cent',
  'eisenhower', 'susan b anthony', 'sacagawea', 'jefferson war nickel',
];

/** Proof/mint set patterns */
const SET_PATTERNS = ['proof set', 'mint set', 'prestige set'];

/** Junk silver patterns */
const JUNK_SILVER_PATTERNS = ['junk silver'];

/**
 * Classify a dataset key into a composition category.
 *
 * @param {string} key - normalized dataset key (lowercase)
 * @returns {'bullion'|'bar'|'silver-numismatic'|'gold-numismatic'|'base-metal'|'set'|'junk-silver'|'unknown'}
 */
function classifyComposition(key) {
  if (!key) return 'unknown';
  const k = key.toLowerCase();

  if (JUNK_SILVER_PATTERNS.some(p => k.includes(p))) return 'junk-silver';
  if (BAR_ROUND_PATTERNS.some(p => k.includes(p))) return 'bar';
  if (SET_PATTERNS.some(p => k.includes(p))) return 'set';
  if (BULLION_SERIES.some(s => k.includes(s))) return 'bullion';
  if (GOLD_US_COIN_SERIES.some(s => k.includes(s))) return 'gold-numismatic';
  // "indian head eagle" and "indian quarter eagle" are gold but won't match
  // GOLD_US_COIN_SERIES which has "indian head gold" -- catch them explicitly
  if (/indian.*eagle/.test(k) && !k.includes('cent')) return 'gold-numismatic';
  if (SILVER_US_COIN_SERIES.some(s => k.includes(s))) return 'silver-numismatic';
  // War nickels (1942-1945) are 35% silver
  if (/war nickel/.test(k)) return 'silver-numismatic';
  if (BASE_METAL_SERIES.some(s => k.includes(s))) return 'base-metal';
  return 'unknown';
}

/** Grade category from key suffix */
const GRADE_RE_SUFFIX = /\b(ms|pr|pf|au|vf|xf|ef)\s*\d{1,2}\b/i;

/**
 * Determine if a dataset key represents graded or raw/ungraded coins.
 * @param {string} key
 * @returns {'graded'|'raw'}
 */
function classifyGradeCategory(key) {
  return GRADE_RE_SUFFIX.test(key || '') ? 'graded' : 'raw';
}

module.exports = {
  getCoinMetalProfile,
  classifyComposition,
  classifyGradeCategory,
  BULLION_SERIES,
  SILVER_US_COIN_SERIES,
  GOLD_US_COIN_SERIES,
  BAR_ROUND_PATTERNS,
  BASE_METAL_SERIES,
  SET_PATTERNS,
};
