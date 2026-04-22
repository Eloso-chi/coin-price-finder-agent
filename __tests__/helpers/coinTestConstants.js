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

/* ══════════════════════════════════════════════════════════════
 *  Shared synthetic comp builder
 *
 *  Canonical version — replaces per-file duplicates.
 * ══════════════════════════════════════════════════════════════ */

/**
 * Build a synthetic eBay comp object with sensible defaults.
 * Pass overrides to customise any field.
 */
function makeComp(overrides = {}) {
  return {
    itemId: overrides.itemId || 'test-' + Math.random().toString(36).slice(2),
    title: overrides.title || '1964 Kennedy Half Dollar',
    totalUsd: overrides.totalUsd ?? 12.50,
    matchScore: overrides.matchScore ?? 70,
    matchNotes: overrides.matchNotes || [],
    matchQuality: overrides.matchQuality || 'close',
    gradeType: overrides.gradeType || 'raw',
    _detectedMetal: overrides._detectedMetal || null,
    _source: overrides._source || 'finding',
    soldDate: overrides.soldDate || new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Build N comps. Accepts a count + shared overrides,
 * or an array of per-comp overrides.
 */
function makeComps(countOrArray, overrides = {}) {
  if (Array.isArray(countOrArray)) {
    return countOrArray.map(o => makeComp({ ...overrides, ...o }));
  }
  return Array.from({ length: countOrArray }, () => makeComp(overrides));
}

/* ══════════════════════════════════════════════════════════════
 *  Seeded PRNG — reproducible random test selection
 *
 *  Uses a simple mulberry32 generator seeded from COIN_TEST_SEED
 *  env var (or Date.now()). Logs the active seed so failures
 *  can be reproduced by setting the env var.
 * ══════════════════════════════════════════════════════════════ */

function _mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create a seeded random() function.
 * Reads COIN_TEST_SEED from env; falls back to Date.now().
 * Prints the active seed to console for reproducibility.
 */
function seedRandom(label) {
  const envSeed = process.env.COIN_TEST_SEED;
  const seed = envSeed ? parseInt(envSeed, 10) : Date.now();
  if (!envSeed) {
    console.log(`[${label || 'test'}] COIN_TEST_SEED not set — using ${seed}. Re-run with COIN_TEST_SEED=${seed} to reproduce.`);
  }
  return _mulberry32(seed);
}

/**
 * Pick `n` random items from `array` using the given rng function.
 */
function pickRandom(array, n, rng) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

/* ══════════════════════════════════════════════════════════════
 *  Coin catalog — query strings with expected parse results
 *
 *  Used for randomized and cross-category test generation.
 * ══════════════════════════════════════════════════════════════ */

const US_COINS = [
  { q: '1964 Kennedy Half Dollar',          series: /kennedy/i,          year: 1964, metal: null },
  { q: '1921 Morgan Silver Dollar MS63',    series: /morgan/i,           year: 1921, metal: 'silver' },
  { q: '1923 Peace Dollar',                 series: /peace/i,            year: 1923, metal: null },
  { q: '1955 Franklin Half Dollar',         series: /franklin/i,         year: 1955, metal: null },
  { q: '1943 Walking Liberty Half Dollar',  series: /walking liberty/i,  year: 1943, metal: null },
  { q: '1916 D Mercury Dime',              series: /mercury/i,          year: 1916, metal: null },
  { q: '1932 S Washington Quarter',         series: /washington/i,       year: 1932, metal: null },
  { q: '1909 S VDB Lincoln Cent',          series: /lincoln/i,          year: 1909, metal: null },
  { q: '1937 Buffalo Nickel',              series: /buffalo/i,          year: 1937, metal: null },
  { q: '1893 S Morgan Silver Dollar',      series: /morgan/i,           year: 1893, metal: 'silver' },
  { q: '1876 CC Trade Dollar',             series: /trade/i,            year: 1876, metal: null },
  { q: '2000 Sacagawea Dollar',            series: /dollar/i,           year: 2000, metal: null },
];

const US_BULLION = [
  { q: '2024 American Silver Eagle',          series: /silver eagle/i,    year: 2024, metal: 'silver', weight: null },
  { q: '2023 American Gold Eagle 1 oz',       series: /gold eagle/i,     year: 2023, metal: 'gold',   weight: 1 },
  { q: '2024 American Gold Eagle 1/10 oz',    series: /gold eagle/i,     year: 2024, metal: 'gold',   weight: 0.1 },
  { q: '2024 American Gold Buffalo',          series: /gold buffalo/i,   year: 2024, metal: 'gold',   weight: null },
  { q: '2024 American Platinum Eagle 1 oz',   series: /platinum eagle/i, year: 2024, metal: 'platinum', weight: 1 },
  { q: '1986 American Silver Eagle',          series: /silver eagle/i,   year: 1986, metal: 'silver', weight: null },
  { q: '2021 American Silver Eagle Type 2',   series: /silver eagle/i,   year: 2021, metal: 'silver', weight: null },
];

const WORLD_BULLION = [
  { q: '2024 Canadian Silver Maple Leaf 1 oz',    series: /maple/i,         year: 2024, metal: 'silver', weight: 1 },
  { q: '2023 Mexican Silver Libertad 1 oz',        series: /libertad/i,      year: 2023, metal: 'silver', weight: 1 },
  { q: '2024 British Silver Britannia 1 oz',       series: /britannia/i,     year: 2024, metal: 'silver', weight: 1 },
  { q: '2024 Austrian Silver Philharmonic 1 oz',   series: /philharmonic/i,  year: 2024, metal: 'silver', weight: 1 },
  { q: '2023 Chinese Silver Panda 30g',            series: /panda/i,         year: 2023, metal: 'silver', weight: null },
  { q: '2024 South African Krugerrand 1 oz',       series: /krugerrand/i,    year: 2024, metal: null,     weight: 1 },
  { q: '2024 Australian Gold Kangaroo 1 oz',       series: /kangaroo/i,      year: 2024, metal: 'gold',   weight: 1 },
  { q: '2024 Canadian Gold Maple Leaf 1 oz',       series: /maple/i,         year: 2024, metal: 'gold',   weight: 1 },
  { q: '2023 Mexican Gold Libertad 1 oz',          series: /libertad/i,      year: 2023, metal: 'gold',   weight: 1 },
  { q: '2024 Perth Lunar Dragon 1 oz silver',      series: /lunar|dragon/i,  year: 2024, metal: 'silver', weight: 1 },
];

const ALL_COINS = [...US_COINS, ...US_BULLION, ...WORLD_BULLION];

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
  makeComp,
  makeComps,
  seedRandom,
  pickRandom,
  US_COINS,
  US_BULLION,
  WORLD_BULLION,
  ALL_COINS,
};
