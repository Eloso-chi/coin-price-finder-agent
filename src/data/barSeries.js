// src/data/barSeries.js — Bar series/product-line data for brand-specific matching
// CommonJS
'use strict';

/**
 * Known bar series by brand.
 * Each entry has:
 *   - series:    canonical name for display
 *   - re:        regex to detect the series in an eBay listing title
 *   - keywords:  extra keywords to add to the eBay search when this series is specified
 *   - aliases:   alternate names users might type
 */
const BAR_SERIES = {
  // ── Geiger Edelmetalle ────────────────────────────────────
  geiger: [
    { series: 'Square',            re: /\bsquare\b/i,                      keywords: 'square',               aliases: ['square bar'] },
    { series: 'Original',          re: /\boriginal\b/i,                    keywords: 'original',             aliases: ['original bar'] },
    { series: 'Schloss Guldengossa', re: /\bschloss\b|\bguldengossa\b/i,   keywords: 'schloss guldengossa',  aliases: ['schloss', 'guldengossa', 'castle'] },
    { series: 'Security Line',     re: /\bsecurity\s*line\b/i,             keywords: 'security line',        aliases: ['security'] },
    { series: 'Fireworks',         re: /\bfirework/i,                       keywords: 'fireworks',            aliases: ['firework'] },
    { series: 'Tree of Life',      re: /\btree\s+of\s+life\b/i,           keywords: 'tree of life',         aliases: ['tree of life', 'tara'] },
    { series: 'Love',              re: /\blove\b|\bheart/i,                keywords: 'love',                 aliases: ['hearts', 'valentines', 'valentine'] },
    { series: 'Christmas',         re: /\bchristmas\b|\bxmas\b/i,         keywords: 'christmas',            aliases: ['merry christmas', 'xmas', 'holiday'] },
    { series: 'USA Edition',       re: /\busa\s*edition\b|\bold\s*glory\b/i, keywords: 'usa edition',       aliases: ['old glory', 'usa'] },
    { series: 'Shamrock',          re: /\bshamrock\b/i,                    keywords: 'shamrock',             aliases: ['irish', 'clover'] },
    { series: 'Edelmetalle',       re: /\bedelmetalle\b/i,                 keywords: 'edelmetalle',          aliases: ['edelmetalle'] },
  ],

  // ── PAMP Suisse ───────────────────────────────────────────
  pamp: [
    { series: 'Fortuna',           re: /\bfortuna\b/i,                     keywords: 'fortuna',              aliases: ['lady fortuna'] },
    { series: 'Rosa',              re: /\brosa\b/i,                        keywords: 'rosa',                 aliases: ['rose'] },
    { series: 'Lady of Liberty',   re: /\blady\s+of\s+liberty\b|\bliberty\b/i, keywords: 'lady of liberty',  aliases: ['liberty'] },
    { series: 'Veriscan',          re: /\bveriscan\b/i,                    keywords: 'veriscan',             aliases: [] },
    { series: 'Love',              re: /\blove\b/i,                        keywords: 'love',                 aliases: ['heart'] },
    { series: 'Romanesque Cross',  re: /\bromanesque\b/i,                  keywords: 'romanesque cross',     aliases: ['cross'] },
    { series: 'America the Free',  re: /\bamerica\s+the\s+free\b/i,       keywords: 'america the free',     aliases: ['bald eagle'] },
    { series: 'Multigram',         re: /\bmultigram\b/i,                   keywords: 'multigram',            aliases: ['divisible', 'breakable'] },
    { series: 'Coca-Cola',         re: /\bcoca[- ]?cola\b|\bcoke\b/i,     keywords: 'coca-cola',            aliases: ['coke', 'coca cola'] },
    { series: 'Zodiac - Aries',    re: /\baries\b/i,                       keywords: 'aries',                aliases: ['ram'] },
    { series: 'Zodiac - Taurus',   re: /\btaurus\b/i,                      keywords: 'taurus',               aliases: ['bull'] },
    { series: 'Zodiac - Gemini',   re: /\bgemini\b/i,                      keywords: 'gemini',               aliases: ['twins'] },
    { series: 'Zodiac - Cancer',   re: /\bcancer\b/i,                      keywords: 'cancer',               aliases: ['crab'] },
    { series: 'Zodiac - Leo',      re: /\bleo\b/i,                         keywords: 'leo',                  aliases: ['lion'] },
    { series: 'Zodiac - Virgo',    re: /\bvirgo\b/i,                       keywords: 'virgo',                aliases: ['maiden'] },
    { series: 'Zodiac - Libra',    re: /\blibra\b/i,                       keywords: 'libra',                aliases: ['scales'] },
    { series: 'Zodiac - Scorpio',  re: /\bscorpio\b/i,                     keywords: 'scorpio',              aliases: ['scorpion'] },
    { series: 'Zodiac - Sagittarius', re: /\bsagittarius\b/i,              keywords: 'sagittarius',          aliases: ['archer'] },
    { series: 'Zodiac - Capricorn', re: /\bcapricorn\b/i,                  keywords: 'capricorn',            aliases: ['goat'] },
    { series: 'Zodiac - Aquarius', re: /\baquarius\b/i,                    keywords: 'aquarius',             aliases: ['water bearer'] },
    { series: 'Zodiac - Pisces',   re: /\bpisces\b/i,                      keywords: 'pisces',               aliases: ['fish'] },
    { series: 'Lunar',             re: /\blunar\b/i,                       keywords: 'lunar',                aliases: ['zodiac'] },
  ],

  // ── Perth Mint ────────────────────────────────────────────
  'perth mint': [
    { series: 'Cast',              re: /\bcast\b/i,                        keywords: 'cast',                 aliases: ['poured'] },
    { series: 'Minted',            re: /\bminted\b/i,                      keywords: 'minted',               aliases: [] },
    { series: 'Kangaroo',          re: /\bkangaroo\b/i,                    keywords: 'kangaroo',             aliases: [] },
    { series: 'Lakshmi',           re: /\blakshmi\b/i,                     keywords: 'lakshmi',              aliases: [] },
    { series: 'Dragon',            re: /\bdragon\b(?!\s*ball)/i,           keywords: 'dragon',               aliases: ['dragon bar'] },
  ],

  // ── Scottsdale ────────────────────────────────────────────
  scottsdale: [
    { series: 'Stacker',           re: /\bstacker\b/i,                     keywords: 'stacker',              aliases: ['stackable'] },
    { series: 'Cast',              re: /\bcast\b/i,                        keywords: 'cast',                 aliases: ['poured', 'chunky'] },
    { series: 'Tombstone',         re: /\btombstone\b/i,                   keywords: 'tombstone',            aliases: ['nugget'] },
  ],

  // ── Valcambi ──────────────────────────────────────────────
  valcambi: [
    { series: 'CombiBar',          re: /\bcombi\s*bar\b/i,                 keywords: 'combibar',             aliases: ['combi', 'divisible'] },
  ],

  // ── Heraeus ───────────────────────────────────────────────
  heraeus: [
    { series: 'Kinebar',           re: /\bkinebar\b/i,                     keywords: 'kinebar',              aliases: ['hologram'] },
  ],

  // ── Credit Suisse ─────────────────────────────────────────
  'credit suisse': [
    { series: 'Classic',           re: /\bclassic\b/i,                     keywords: 'classic',              aliases: [] },
    { series: 'Statue of Liberty', re: /\bstatue\s+of\s+liberty\b|\bliberty\b/i, keywords: 'statue of liberty', aliases: ['liberty'] },
  ],
};

const BAR_BRANDS = [
  { brand: 'PAMP', re: /\bpamp(?:\s+suisse)?\b/i },
  { brand: 'Geiger', re: /\bgeiger(?:\s+edelmetalle)?\b/i },
  { brand: 'Perth Mint', re: /\bperth\s+mint\b/i },
  { brand: 'Scottsdale', re: /\bscottsdale\b/i },
  { brand: 'Valcambi', re: /\bvalcambi\b/i },
  { brand: 'Heraeus', re: /\bheraeus\b/i },
  { brand: 'Credit Suisse', re: /\bcredit\s+suisse\b/i },
];

function detectBarBrand(text) {
  return detectBarBrands(text)[0] || null;
}

function detectBarBrands(text) {
  if (typeof text !== 'string' || !text) return [];
  return BAR_BRANDS.filter(({ re }) => re.test(text)).map(({ brand }) => brand);
}

function canonicalizeBarBrand(brand) {
  if (typeof brand !== 'string') return null;
  const normalized = brand.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'pamp suisse') return 'PAMP';
  return BAR_BRANDS.find(entry => entry.brand.toLowerCase() === normalized)?.brand || null;
}

/**
 * Look up series entries for a given brand.
 * @param {string} brand — e.g. "Geiger", "PAMP", "Perth Mint"
 * @returns {Array} series entries or empty array
 */
function getSeriesForBrand(brand) {
  const canonicalBrand = canonicalizeBarBrand(brand);
  if (!canonicalBrand) return [];
  const key = canonicalBrand.toLowerCase();
  return Object.prototype.hasOwnProperty.call(BAR_SERIES, key) ? BAR_SERIES[key] : [];
}

/**
 * Detect series from a brand + user-supplied series hint.
 * Returns { series, keywords } or null.
 * @param {string} brand
 * @param {string} seriesHint — user input like "fortuna", "edelmetalle", "square"
 */
function detectBarSeries(brand, seriesHint) {
  if (typeof seriesHint !== 'string' || !seriesHint) return null;
  const entries = getSeriesForBrand(brand);
  if (!entries.length) return null;

  const hint = seriesHint.toLowerCase().trim();

  // Direct series name match
  for (const entry of entries) {
    if (entry.series.toLowerCase() === hint) return entry;
    if (entry.aliases.some(a => a.toLowerCase() === hint)) return entry;
    if (entry.re.test(hint)) return entry;
  }
  return null;
}

/**
 * Detect series from an eBay listing title for scoring.
 * Returns the first matching series entry or null.
 * @param {string} brand
 * @param {string} title — eBay listing title
 */
function detectSeriesFromTitle(brand, title) {
  if (typeof title !== 'string' || !title) return null;
  const entries = getSeriesForBrand(brand);
  for (const entry of entries) {
    if (entry.re.test(title)) return entry;
  }
  return null;
}

function detectSeriesFromQuery(brand, query) {
  if (typeof query !== 'string' || !query) return null;
  const entries = getSeriesForBrand(brand);
  for (const entry of entries) {
    if (entry.re.test(query)) return entry;
    for (const alias of entry.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(query)) return entry;
    }
  }
  return null;
}

function canonicalizeBarIntent(brand, series) {
  const barBrand = canonicalizeBarBrand(brand);
  if (!barBrand) return { barBrand: null, barSeries: null };
  const matchedSeries = detectBarSeries(barBrand, series);
  return {
    barBrand,
    barSeries: matchedSeries?.series || null,
  };
}

module.exports = {
  BAR_SERIES,
  getSeriesForBrand,
  detectBarBrand,
  detectBarBrands,
  canonicalizeBarBrand,
  detectBarSeries,
  detectSeriesFromTitle,
  detectSeriesFromQuery,
  canonicalizeBarIntent,
};
