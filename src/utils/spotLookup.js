// src/utils/spotLookup.js -- pure spot lookup over { 'YYYY-MM-DD': price } entries
// CommonJS
'use strict';

const MAX_GAP_DAYS = 7;

/**
 * Spot price on a date: the exact day, else the nearest prior day (or the first
 * later day when the data starts after the date), within 7 days; otherwise null.
 * @param {Object<string, number>|undefined} entries - one metal's daily prices
 * @param {string} dateStr - ISO date or timestamp
 * @returns {number|null}
 */
function lookupSpotInEntries(entries, dateStr) {
  if (!entries || typeof dateStr !== 'string' || !dateStr) return null;
  const dates = Object.keys(entries).sort();
  if (dates.length === 0) return null;

  const targetDate = dateStr.substring(0, 10);
  if (entries[targetDate] != null) return entries[targetDate];

  let closest = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] <= targetDate) { closest = dates[i]; break; }
  }
  if (!closest) {
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] > targetDate) { closest = dates[i]; break; }
    }
  }
  if (!closest) return null;

  const diffDays = Math.abs(new Date(targetDate) - new Date(closest)) / (1000 * 60 * 60 * 24);
  return diffDays > MAX_GAP_DAYS ? null : entries[closest];
}

module.exports = { lookupSpotInEntries, MAX_GAP_DAYS };
