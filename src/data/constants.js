// src/data/constants.js — Shared constants used across routes/services
// CommonJS

/** Chinese zodiac cycle starting from 2020 = Rat */
const ZODIAC = ['Rat','Ox','Tiger','Rabbit','Dragon','Snake','Horse','Goat','Monkey','Rooster','Dog','Pig'];

/**
 * Given a year (>= 1996), return the zodiac animal for the Chinese Lunar cycle.
 * @param {number} year
 * @returns {string|null}
 */
function zodiacForYear(year) {
  if (!year || year < 1996) return null;
  return ZODIAC[((year - 2020) % 12 + 12) % 12];
}

/**
 * Determine Perth Mint Lunar series label from year.
 * @param {number} year
 * @returns {{ label: string|null, num: string|null }}
 */
function perthLunarSeries(year) {
  if (!year) return { label: null, num: null };
  if (year >= 1996 && year <= 2007) return { label: 'Series I', num: 'I' };
  if (year >= 2008 && year <= 2019) return { label: 'Series II', num: 'II' };
  if (year >= 2020 && year <= 2031) return { label: 'Series III', num: 'III' };
  return { label: null, num: null };
}

// ── Roll / tube quantity lookup ──────────────────────────────
// Standard roll/tube sizes by series keyword.  Bullion tubes vary by mint;
// circulating rolls follow US banking standards.
const ROLL_QTY_BY_SERIES = [
  // Bullion tubes
  { re: /silver\s*eagle/i,           qty: 20 },
  { re: /gold\s*eagle/i,             qty: 20 },
  { re: /gold\s*buffalo/i,           qty: 20 },
  { re: /maple\s*leaf/i,             qty: 25 },
  { re: /britannia/i,                qty: 25 },
  { re: /libertad/i,                 qty: 25 },
  { re: /philharmonic/i,             qty: 20 },
  { re: /krugerrand/i,               qty: 25 },
  { re: /kangaroo/i,                 qty: 25 },
  { re: /kookaburra/i,               qty: 20 },
  { re: /panda/i,                    qty: 30 },
  { re: /lunar/i,                    qty: 20 },
  { re: /polar\s*bear/i,             qty: 25 },
  // US circulating rolls (denomination-based)
  { re: /half\s*dollar|kennedy|franklin|walking\s*liberty|barber\s*half|seated.*half/i, qty: 20 },
  { re: /quarter|standing\s*liberty/i, qty: 40 },
  { re: /dime|mercury|roosevelt|barber\s*dime|seated.*dime/i, qty: 50 },
  { re: /nickel|jefferson|buffalo\s*nickel|liberty.*nickel/i, qty: 40 },
  { re: /cent|penny|lincoln|indian\s*head|wheat/i, qty: 50 },
  { re: /dollar|morgan|peace|eisenhower|susan.*anthony|sacagawea/i, qty: 20 },
];

/**
 * Determine standard roll/tube quantity from a series or query string.
 * @param {string} text - series name, query, or coin description
 * @returns {number|null} - coins per roll/tube, or null if unknown
 */
function getRollQuantity(text) {
  if (!text) return null;
  for (const { re, qty } of ROLL_QTY_BY_SERIES) {
    if (re.test(text)) return qty;
  }
  return null;
}

// ── Bullion series that default to 1 oz when no weight is specified ──
const BULLION_1OZ_DEFAULT = [
  'libertad', 'silver eagle', 'gold eagle', 'maple leaf', 'britannia',
  'philharmonic', 'krugerrand', 'kangaroo', 'kookaburra', 'panda',
  'gold buffalo', 'platinum eagle', 'palladium eagle', 'lunar',
  'polar bear'
];

// ── Allowed graded-slab label values (must match frontend <select> options) ──
const ALLOWED_LABELS = new Set([
  'First Strike', 'Early Releases', 'First Releases', 'First Day of Issue',
  'Burnished', 'Reverse Proof', 'Enhanced Reverse Proof',
  'Satin Finish', 'Antiqued', 'High Relief', 'Prooflike',
  'Colorized', 'Privy', 'Type 1', 'Type 2',
  'Gilded', 'Ruthenium', 'Hologram', 'Gold Plated',
  'Flag Label', 'Brown Label', 'Blue Label', 'Black Label',
  'Mercanti Signed', 'Moy Signed', 'Reagan Signed',
]);

module.exports = { ZODIAC, zodiacForYear, perthLunarSeries, getRollQuantity, BULLION_1OZ_DEFAULT, ALLOWED_LABELS };
