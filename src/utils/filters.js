// src/utils/filters.js — Shared deny-list filtering
// CommonJS
//
// Single source of truth for listing title deny-patterns used by both
// ebayService and terapeakService.  Consolidating here prevents the
// two lists from drifting out of sync.

const ROLL_PATTERN = /\broll\b/i;

const DENY_PATTERNS = [
  /\blots?\b/i, /\bcollection\b/i, ROLL_PATTERN, /\bestate\b/i,
  /\breplica\b/i, /\bcopy\b/i, /\bcleaned\b/i, /\bpolished\b/i,
  /\bfake\b/i, /\btoken\b/i, /\bplated\b/i,
  // Coin accessories / storage -- not actual coins
  /\balbum\b/i, /\bfolder\b/i, /\bwhitman\b/i, /\bdansco\b/i,
  /\blittleton\b/i, /\bmap\b/i, /\bpush.?pin\b/i,
  // Jewelry / wearables -- coin-derived but not actual coins
  /\bring[s]?\b/i, /\bnecklace\b/i, /\bpendant\b/i,
  /\bbracelet\b/i, /\bcufflink/i, /\bbuckle\b/i,
  /\bkeychain\b/i, /\bearring/i,
  // Non-coin merchandise
  /\bmagnet\b/i, /\bposter\b/i, /\bornament\b/i,
  /\bbutton\b/i, /\bshirt\b/i, /\bpatch\b/i,
  // Books / media
  /\bbook\b/i, /\bencyclopedia\b/i, /\bcatalog(?:ue)?\b/i,
  // Stamps (careful: exclude die-striking terms via negative lookahead)
  /\bstamps?\b(?!\s*(?:die|error|double|over|variet))/i,
  // Misc non-coin items
  /\bcoin\s*roll\s*hunt/i, /\bmedal\b/i
];

/**
 * Returns true when a listing title contains any of the deny-list
 * keywords (lots, replica, fake, etc.)
 * @param {string} title
 * @returns {boolean}
 */
/**
 * Returns true when a listing title contains any of the deny-list
 * keywords.  When opts.allowRoll is true the /\broll\b/ pattern is
 * skipped — this lets roll-specific searches keep roll listings.
 * @param {string} title
 * @param {{ allowRoll?: boolean }} [opts]
 * @returns {boolean}
 */
function isDenied(title, opts = {}) {
  return DENY_PATTERNS.some(p => {
    if (opts.allowRoll && p === ROLL_PATTERN) return false;
    return p.test(title);
  });
}

// ── Denomination detection ──────────────────────────────────
// Ordered longest-first so "half dollar" and "quarter dollar" are checked
// before the bare "dollar" pattern.
const DENOM_RULES = [
  { canonical: 'half dollar', re: /\bhalf\s*dollar/i },
  { canonical: 'quarter',     re: /\bquarter/i },       // catches "quarter" and "quarter dollar"
  { canonical: 'dime',        re: /\bdime/i },
  { canonical: 'nickel',      re: /\bnickel/i },
  { canonical: 'cent',        re: /\b(?:cent|penny|pennies)\b/i },
  { canonical: 'dollar',      re: /\bdollar/i },         // bare "dollar" — checked AFTER half/quarter dollar
];

/**
 * Extract the canonical denomination from a text string.
 * Returns null when no denomination is recognized.
 * @param {string} text
 * @returns {string|null}
 */
function detectDenomination(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const { canonical, re } of DENOM_RULES) {
    if (re.test(t)) return canonical;
  }
  return null;
}

// ── Non-bullion denomination filter for bullion searches ────────────
// Circulating coins (centavos, pesos) share keywords like "libertad"
// but are not bullion.  Used by both ebayService and marketAggregator.
const BULLION_DENY_DENOM_RE = /\b(centavo|centavos|peso[s]?|\d+\s*cent(?:avo)?)\b/i;
const BULLION_OK_RE = /\b(?:oz|ounce|onza|troy|bullion)\b/i;

module.exports = { DENY_PATTERNS, ROLL_PATTERN, isDenied, detectDenomination, hasSeriesConflict, isCompositionMismatch, BULLION_DENY_DENOM_RE, BULLION_OK_RE };

// ── Silver / Clad era composition detection ─────────────────────────
// US circulating coins transitioned from 90% silver to clad at known dates.
// Mixing silver-era and clad-era comps produces wildly wrong FMV.
// This table maps denominations to their silver→clad transition year.
// `lastSilverYear` is the final year 90% silver coins were struck for circulation.
// Some series have both (e.g. Kennedy 1964 silver, 1965-70 40% silver, 1971+ clad).
const SILVER_TRANSITION = {
  'quarter':     { lastSilverYear: 1964, silverTokens: ['silver', '90%', '.900'] },
  'dime':        { lastSilverYear: 1964, silverTokens: ['silver', '90%', '.900'] },
  'half dollar': { lastSilverYear: 1970, silverTokens: ['silver', '90%', '40%', '.900', '.400'] },
  // Note: Kennedy 1965-1970 are 40% silver; 1971+ are clad
  // Morgan/Peace dollars are ALWAYS silver — no transition needed
  // Nickels: only war nickels 1942-1945 are 35% silver; all others are copper-nickel
  'nickel':      { lastSilverYear: 1945, silverTokens: ['silver', '35%', 'war'] },
};

/**
 * Detect if a comp has a silver/clad composition mismatch with the expected coin.
 * Returns true (=mismatch) when:
 *   - User searches a CLAD-era coin but comp title says "silver"/"90%"/etc.
 *   - User searches a SILVER-era coin but comp title explicitly says "clad"
 *
 * @param {string} compTitle — the eBay listing title
 * @param {{ year?: number, series?: string, _rawQuery?: string }} expected
 * @returns {boolean} true if composition mismatch detected
 */
function isCompositionMismatch(compTitle, expected) {
  if (!compTitle || !expected) return false;
  const year = expected.year;
  if (!year) return false;

  const denom = detectDenomination(expected.series || expected._rawQuery || '');
  if (!denom) return false;

  const transition = SILVER_TRANSITION[denom];
  if (!transition) return false;

  const tLow = compTitle.toLowerCase();
  const { lastSilverYear, silverTokens } = transition;

  // Special handling for war nickels: only 1942P/D/S through 1945 are silver
  if (denom === 'nickel') {
    const isWarNickelEra = year >= 1942 && year <= 1945;
    if (isWarNickelEra) {
      // User wants a war nickel — don't filter silver comps
      // but DO filter comps that explicitly say "clad" or "copper"
      return false;
    }
    // Non-war nickel — reject silver comps
    return silverTokens.some(t => tLow.includes(t));
  }

  if (year > lastSilverYear) {
    // CLAD era coin — reject comps with silver indicators
    // Exception: user explicitly asked for silver (e.g. "1976 S silver quarter proof")
    const queryLow = (expected._rawQuery || '').toLowerCase();
    if (silverTokens.some(t => queryLow.includes(t))) return false;
    return silverTokens.some(t => tLow.includes(t));
  }

  if (year <= lastSilverYear) {
    // SILVER era coin — reject comps that explicitly say "clad" or "copper-nickel"
    if (/\bclad\b/i.test(tLow) || /\bcopper[\s-]*nickel\b/i.test(tLow)) {
      // But only if the query doesn't explicitly say "clad"
      const queryLow = (expected._rawQuery || '').toLowerCase();
      if (/\bclad\b/i.test(queryLow)) return false;
      return true;
    }
  }

  return false;
}
// Same-denomination coin series that are MUTUALLY EXCLUSIVE.
// If the user searches for one, comps containing the other are wrong.
const SERIES_CONFLICTS = [
  // Nickels
  [/\bjefferson\b/i, /\bbuffalo\b/i],
  [/\bjefferson\b/i, /\bliberty\s+nickel\b/i],
  [/\bjefferson\b/i, /\bshield\s+nickel\b/i],
  [/\bbuffalo\b/i,   /\bliberty\s+nickel\b/i],
  // Half dollars
  [/\bkennedy\b/i,          /\bfranklin\b/i],
  [/\bkennedy\b/i,          /\bwalking\s*liberty\b/i],
  [/\bkennedy\b/i,          /\bbarber\b/i],
  [/\bkennedy\b/i,          /\bseated\s*liberty\b/i],
  [/\bfranklin\b/i,         /\bwalking\s*liberty\b/i],
  [/\bfranklin\b/i,         /\bbarber\b/i],
  [/\bwalking\s*liberty\b/i,/\bbarber\b/i],
  // Quarters
  [/\bwashington\b/i,       /\bstanding\s*liberty\b/i],
  [/\bwashington\b/i,       /\bbarber\b/i],
  [/\bwashington\b/i,       /\bseated\s*liberty\b/i],
  [/\bstanding\s*liberty\b/i,/\bbarber\b/i],
  // Dimes
  [/\broosevelt\b/i,        /\bmercury\b/i],
  [/\broosevelt\b/i,        /\bbarber\b/i],
  [/\bmercury\b/i,          /\bbarber\b/i],
  // Dollars
  [/\bmorgan\b/i,           /\bpeace\b/i],
  [/\bmorgan\b/i,           /\beisenhower\b/i],
  [/\bmorgan\b/i,           /\bsacagawea\b/i],
  [/\bpeace\b/i,            /\beisenhower\b/i],
  // Cents
  [/\blincoln\b/i,          /\bindian\s*head\b/i],
  [/\bwheat\b/i,            /\bindian\s*head\b/i],
];

/**
 * Returns true when `wantSeries` and `compTitle` belong to
 * mutually-exclusive coin series (e.g. Jefferson vs Buffalo).
 * @param {string} wantSeries – the series the user is looking for
 * @param {string} compTitle  – the eBay listing title
 * @returns {boolean}
 */
function hasSeriesConflict(wantSeries, compTitle) {
  if (!wantSeries || !compTitle) return false;
  for (const [reA, reB] of SERIES_CONFLICTS) {
    const wantA = reA.test(wantSeries);
    const wantB = reB.test(wantSeries);
    const compA = reA.test(compTitle);
    const compB = reB.test(compTitle);
    // User wants A but comp is B  (or vice versa)
    if ((wantA && compB && !compA) || (wantB && compA && !compB)) return true;
  }
  return false;
}
