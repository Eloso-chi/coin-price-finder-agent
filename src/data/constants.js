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

module.exports = { ZODIAC, zodiacForYear, perthLunarSeries };
