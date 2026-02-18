/**
 * Shared constants and helper functions for coin-search relevance tests.
 *
 * Token lists live here so every test file uses the same source of truth.
 * Helpers normalise text, check token presence, and decode eBay query params.
 */

'use strict';

/* ══════════════════════════════════════════════════════════════
 *  Denomination token sets
 *
 *  positive  – at least ONE must appear for a correct match
 *  negative  – NONE may appear (would signal wrong denomination)
 * ══════════════════════════════════════════════════════════════ */

const DENOMINATION_TOKENS = {
  'Half Dollar': {
    positive: ['half dollar', '50c', 'fifty cent', 'kennedy half', 'franklin half',
               'walking liberty half', 'barber half', 'seated liberty half',
               'capped bust half', 'draped bust half', 'flowing hair half'],
    negative: ['dime', 'penny', 'cent', 'quarter', 'nickel'],
  },
  'Quarter': {
    positive: ['quarter', '25c', 'twenty-five cent', 'washington quarter',
               'standing liberty quarter', 'barber quarter', 'seated liberty quarter'],
    negative: ['half dollar', 'dime', 'penny', 'cent', 'nickel'],
  },
  'Dime': {
    positive: ['dime', '10c', 'ten cent', 'roosevelt dime', 'mercury dime',
               'barber dime', 'seated liberty dime'],
    negative: ['half dollar', 'quarter', 'penny', 'cent', 'nickel'],
  },
  'Penny': {
    positive: ['penny', 'cent', '1c', 'lincoln', 'indian head cent', 'wheat'],
    negative: ['half dollar', 'quarter', 'dime', 'nickel'],
  },
  'Nickel': {
    positive: ['nickel', '5c', 'five cent', 'jefferson', 'buffalo nickel',
               'liberty nickel', 'shield nickel'],
    negative: ['half dollar', 'quarter', 'dime', 'penny', 'cent'],
  },
  'Dollar': {
    positive: ['dollar', 'morgan', 'peace', 'eisenhower', 'sacagawea',
               'presidential dollar', 'silver eagle'],
    negative: ['penny', 'cent', 'dime', 'nickel'],
  },
};

/* ══════════════════════════════════════════════════════════════
 *  Denomination → expected design series by year
 * ══════════════════════════════════════════════════════════════ */

const EXPECTED_SERIES = {
  'Half Dollar': {
    1795: 'Flowing Hair',
    1810: 'Capped Bust',
    1850: 'Seated Liberty',
    1900: 'Barber',
    1940: 'Walking Liberty',
    1950: 'Franklin',
    1964: 'Kennedy',
    1971: 'Kennedy',
    2025: 'Kennedy',
    2026: 'Kennedy',
  },
};

/* ══════════════════════════════════════════════════════════════
 *  Test matrix — denomination × year combos to verify
 * ══════════════════════════════════════════════════════════════ */

const DENOMINATION_TEST_MATRIX = [
  // Half Dollar — bare denomination parses to "Half Dollar"
  { denomination: 'Half Dollar', year: 1964, expectedSeries: /half dollar/i },
  { denomination: 'Half Dollar', year: 1971, expectedSeries: /half dollar/i },
  { denomination: 'Half Dollar', year: 2025, expectedSeries: /half dollar/i },
  { denomination: 'Half Dollar', year: 2026, expectedSeries: /half dollar/i },
  { denomination: 'Half Dollar', year: 1956, expectedSeries: /half dollar/i },
  { denomination: 'Half Dollar', year: 1945, expectedSeries: /half dollar/i },
  // Quarter
  { denomination: 'Quarter', year: 1999, expectedSeries: /quarter/i },
  { denomination: 'Quarter', year: 2020, expectedSeries: /quarter/i },
  // Dime
  { denomination: 'Dime', year: 1964, expectedSeries: /dime/i },
  { denomination: 'Dime', year: 2010, expectedSeries: /dime/i },
  // Penny / Cent
  { denomination: 'Penny', year: 1959, expectedSeries: /penny/i },
  { denomination: 'Penny', year: 2019, expectedSeries: /penny/i },
  // Nickel
  { denomination: 'Nickel', year: 2005, expectedSeries: /nickel/i },
];

/**
 * Extended matrix with specific series names (e.g. "Kennedy", "Franklin").
 * These require the series name in the raw query for parseDescription to detect them.
 */
const NAMED_SERIES_TEST_MATRIX = [
  { query: '1964 Kennedy half dollar',       expectedSeries: /kennedy/i },
  { query: '1956 Franklin half dollar',       expectedSeries: /franklin/i },
  { query: '1945 Walking Liberty half',       expectedSeries: /walking liberty/i },
  { query: '2020 Washington quarter',         expectedSeries: /washington/i },
  { query: '1964 Roosevelt dime',             expectedSeries: /roosevelt/i },
  { query: '1944 Mercury dime',               expectedSeries: /mercury/i },
  { query: '1959 Lincoln penny',              expectedSeries: /lincoln/i },
  { query: '2005 Jefferson nickel',           expectedSeries: /jefferson/i },
  { query: '1921 Morgan dollar',              expectedSeries: /morgan/i },
  { query: '1937 Buffalo nickel',             expectedSeries: /buffalo nickel/i },
];

/* ══════════════════════════════════════════════════════════════
 *  Helper utilities
 * ══════════════════════════════════════════════════════════════ */

/**
 * Lowercase + strip punctuation (keeps alphanumeric, spaces, hyphens).
 */
function normalize(text) {
  if (!text) return '';
  return String(text).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Returns true if `text` contains at least one of `tokens` (case-insensitive).
 */
function containsAny(text, tokens) {
  const n = normalize(text);
  return tokens.some(t => n.includes(normalize(t)));
}

/**
 * Returns true if `text` contains NONE of the forbidden tokens.
 * Exception: allows "cent" inside "semiquincentennial" or "bicentennial".
 */
function containsNone(text, forbiddenTokens) {
  const n = normalize(text);
  return forbiddenTokens.every(t => {
    const tn = normalize(t);
    if (tn === 'cent') {
      // Remove compound words that contain "cent" as a substring
      const sanitised = n.replace(/semiquincentennial|bicentennial|centennial|percent/g, '');
      return !sanitised.includes(tn);
    }
    return !n.includes(tn);
  });
}

/**
 * Extract the search-query value from an eBay URL.
 * Supports ?q=, ?_nkw=, and /sch/ path tokens.
 */
function decodeEbayQueryFromUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return decodeURIComponent(u.searchParams.get('q') || u.searchParams.get('_nkw') || '');
  } catch {
    return '';
  }
}

/**
 * Lookup the token config for a denomination.
 * Falls back to the exact key or a case-insensitive search.
 */
function tokensFor(denomination) {
  const exact = DENOMINATION_TOKENS[denomination];
  if (exact) return exact;
  const key = Object.keys(DENOMINATION_TOKENS).find(
    k => k.toLowerCase() === denomination.toLowerCase()
  );
  return key ? DENOMINATION_TOKENS[key] : null;
}

module.exports = {
  DENOMINATION_TOKENS,
  DENOMINATION_TEST_MATRIX,
  NAMED_SERIES_TEST_MATRIX,
  EXPECTED_SERIES,
  normalize,
  containsAny,
  containsNone,
  decodeEbayQueryFromUrl,
  tokensFor,
};
