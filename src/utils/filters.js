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
  // Coin accessories / storage — not actual coins
  /\balbum\b/i, /\bfolder\b/i, /\bwhitman\b/i, /\bdansco\b/i,
  /\blittleton\b/i, /\bmap\b/i, /\bpush.?pin\b/i
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

module.exports = { DENY_PATTERNS, ROLL_PATTERN, isDenied, detectDenomination, hasSeriesConflict };

// ── Series conflict detection ───────────────────────────────
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
