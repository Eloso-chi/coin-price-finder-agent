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
  'morgan', 'peace dollar', 'peace silver dollar', 'walking liberty', 'seated liberty',
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
  silver:    /\bsilver\b/i,
  gold:      /\bgold\b/i,
  platinum:  /\bplatinum\b/i,
  palladium: /\bpalladium\b/i,
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
    if (METAL_RE.gold.test(q))      return { isMetalBased: true, metal: 'gold' };
    if (METAL_RE.silver.test(q))    return { isMetalBased: true, metal: 'silver' };
    if (METAL_RE.platinum.test(q))  return { isMetalBased: true, metal: 'platinum' };
    if (METAL_RE.palladium.test(q)) return { isMetalBased: true, metal: 'palladium' };
    // Bullion but metal not explicit — infer from series name
    if (/gold eagle|gold buffalo|krugerrand/i.test(q)) return { isMetalBased: true, metal: 'gold' };
    if (/platinum eagle/i.test(q))  return { isMetalBased: true, metal: 'platinum' };
    if (/palladium eagle/i.test(q)) return { isMetalBased: true, metal: 'palladium' };
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
  if (METAL_RE.gold.test(q))      return { isMetalBased: true, metal: 'gold' };
  if (METAL_RE.silver.test(q))    return { isMetalBased: true, metal: 'silver' };
  if (METAL_RE.platinum.test(q))  return { isMetalBased: true, metal: 'platinum' };
  if (METAL_RE.palladium.test(q)) return { isMetalBased: true, metal: 'palladium' };

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
const SET_PATTERNS = ['proof set', 'mint set', 'prestige set', 'us mint uncirculated set'];

/** Junk silver patterns */
const JUNK_SILVER_PATTERNS = ['junk silver'];

/** Junk silver sold by denomination (e.g. "90% silver dimes 1 face value") */
const JUNK_SILVER_DENOM_PATTERNS = ['90 silver dimes', '90 silver quarters', '90 silver half dollars'];

/** Fractional-weight tokens used in normalized dataset keys */
const FRACTIONAL_WEIGHT_RE = /\b(?:half|quarter|tenth|twentieth)\s*oz\b/;

/** Multi-oz bullion (2oz and above) */
const MULTI_OZ_RE = /\b(?:[2-9]|[1-9]\d+)oz\b/;

/** Proof bullion */
const PROOF_RE = /\bproof\b/;

/**
 * Detect metal from a bullion key using explicit keywords or series inference.
 * @param {string} k - lowercased key
 * @returns {'gold'|'silver'|'platinum'|'palladium'|null}
 */
function detectMetalFromKey(k) {
  if (METAL_RE.gold.test(k))      return 'gold';
  if (METAL_RE.silver.test(k))    return 'silver';
  if (METAL_RE.platinum.test(k))  return 'platinum';
  if (METAL_RE.palladium.test(k)) return 'palladium';
  // Infer from series name when metal keyword is absent
  if (/gold eagle|gold buffalo|krugerrand/i.test(k)) return 'gold';
  if (/platinum eagle/i.test(k))  return 'platinum';
  if (/palladium eagle/i.test(k)) return 'palladium';
  // Most remaining bullion (eagles, maples, etc.) default to silver
  return 'silver';
}

/**
 * Classify a dataset key into a composition category.
 * Bullion is subdivided by weight class (fractional, multi-oz, standard)
 * and finish (proof vs BU).
 *
 * @param {string} key - normalized dataset key (lowercase)
 * @returns {'bullion'|'bullion-fractional-gold'|'bullion-fractional-silver'|'bullion-multioz'|'bullion-proof'|'bar'|'silver-numismatic'|'gold-numismatic'|'base-metal'|'set'|'junk-silver'|'junk-silver-denom'|'unknown'}
 */
function classifyComposition(key) {
  if (!key) return 'unknown';
  const k = key.toLowerCase();

  if (JUNK_SILVER_PATTERNS.some(p => k.includes(p))) return 'junk-silver';
  if (JUNK_SILVER_DENOM_PATTERNS.some(p => k.includes(p))) return 'junk-silver-denom';
  if (BAR_ROUND_PATTERNS.some(p => k.includes(p))) return 'bar';
  if (SET_PATTERNS.some(p => k.includes(p))) return 'set';
  if (BULLION_SERIES.some(s => k.includes(s))) {
    if (FRACTIONAL_WEIGHT_RE.test(k)) {
      const metal = detectMetalFromKey(k);
      return metal === 'gold' ? 'bullion-fractional-gold' : 'bullion-fractional-silver';
    }
    if (MULTI_OZ_RE.test(k)) return 'bullion-multioz';
    if (PROOF_RE.test(k)) return 'bullion-proof';
    return 'bullion';
  }
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

// ── Weight detection from listing titles ────────────────────
// Shared utility used by ebayService (comp filtering) and terapeakService
// (import-time reclassification). Handles grams, kilos, oz fractions.

/**
 * Detect weight (in troy oz) from an eBay listing title.
 * Handles grams, kilos, fractional oz, full oz.
 * @param {string} title
 * @returns {number|null} weight in troy oz, or null if undetectable
 */
function detectWeightFromTitle(title) {
  if (!title) return null;
  const t = title.toLowerCase();

  // Gram-based weights (bars)
  const GRAM = '(?:grams?|g)\\b';
  const gm = t.match(new RegExp('\\b(\\d+(?:\\.\\d+)?)\\s*' + GRAM, 'i'));
  if (gm) return parseFloat(gm[1]) / 31.1035;
  const gm2 = t.match(new RegExp('(?:^|\\s)\\.(\\d+)\\s*' + GRAM, 'i'));
  if (gm2) return parseFloat('0.' + gm2[1]) / 31.1035;
  if (/\bhalf\s+gram\b/i.test(t)) return 0.5 / 31.1035;
  if (/\b(?:1\s*)?kilo(?:gram)?\b/i.test(t)) return 32.1507;

  // Oz-based weights
  const OZ = '(?:troy\\s+)?(?:ounces?(?:\\s+oz)?|ozt?|oz)\\b';
  const fracRe = new RegExp('\\b(1\\/20|1\\/10|1\\/4|1\\/2)\\s*' + OZ, 'i');
  const fracMatch = t.match(fracRe);
  if (fracMatch) {
    const frac = { '1/20': 0.05, '1/10': 0.1, '1/4': 0.25, '1/2': 0.5 };
    return frac[fracMatch[1]] || null;
  }
  if (/\bquarter\s*(?:troy\s+)?(?:ounce|ozt?|oz)\b/i.test(t))  return 0.25;
  if (/\bhalf\s*(?:troy\s+)?(?:ounce|ozt?|oz)\b/i.test(t))     return 0.5;
  const m = t.match(new RegExp('\\b(\\d+(?:\\.\\d+)?)\\s*' + OZ, 'i'));
  if (m) return parseFloat(m[1]);
  return null;
}

/**
 * Map a numeric weight (troy oz) to the word-form token used in dataset keys.
 * @param {number} weight
 * @returns {string|null} e.g. "half oz", "quarter oz", "1oz", or null
 */
function weightToKeyToken(weight) {
  if (weight == null) return null;
  const WEIGHT_TOKENS = [
    [0.05,   'twentieth oz'],
    [0.1,    'tenth oz'],
    [0.25,   'quarter oz'],
    [0.5,    'half oz'],
  ];
  for (const [w, token] of WEIGHT_TOKENS) {
    if (Math.abs(weight - w) < 0.01) return token;
  }
  // Integer or decimal oz (e.g. 1, 2, 5, 10, 100)
  if (weight >= 1 && Math.abs(weight - Math.round(weight)) < 0.01) {
    return Math.round(weight) + 'oz';
  }
  return null;
}

module.exports = {
  getCoinMetalProfile,
  classifyComposition,
  classifyGradeCategory,
  detectWeightFromTitle,
  weightToKeyToken,
  BULLION_SERIES,
  SILVER_US_COIN_SERIES,
  GOLD_US_COIN_SERIES,
  BAR_ROUND_PATTERNS,
  BASE_METAL_SERIES,
  SET_PATTERNS,
};
