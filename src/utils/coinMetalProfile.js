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

module.exports = { getCoinMetalProfile, BULLION_SERIES, SILVER_US_COIN_SERIES, GOLD_US_COIN_SERIES };
