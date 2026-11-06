// src/utils/spotLookup.js -- pure spot lookup over { 'YYYY-MM-DD': price } entries
// CommonJS
'use strict';

const MAX_GAP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function ownPrice(entries, day) {
  if (!Object.prototype.hasOwnProperty.call(entries, day)) return null;
  const v = entries[day];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Spot price on a date: the exact day, else the nearest prior day (or, unless
 * `allowLater` is false, the first later day when the data starts after the date),
 * within `maxGapDays`; otherwise null. Non-numeric or non-positive entries are ignored.
 * @param {Object<string, number>|undefined} entries - one metal's daily prices
 * @param {string} dateStr - ISO date or timestamp
 * @param {{ maxGapDays?: number, allowLater?: boolean, sortedDates?: string[] }} [opts]
 *   `sortedDates` is the pre-sorted key list for callers that look up many dates
 * @returns {number|null}
 */
function lookupSpotInEntries(entries, dateStr, { maxGapDays = MAX_GAP_DAYS, allowLater = true, sortedDates } = {}) {
  if (!entries || typeof entries !== 'object' || typeof dateStr !== 'string' || !dateStr) return null;
  const targetDate = dateStr.substring(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return null;
  const exact = ownPrice(entries, targetDate);
  if (exact != null) return exact;

  const dates = sortedDates || Object.keys(entries).sort();
  let closest = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] <= targetDate && ownPrice(entries, dates[i]) != null) { closest = dates[i]; break; }
  }
  if (!closest && allowLater) {
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] > targetDate && ownPrice(entries, dates[i]) != null) { closest = dates[i]; break; }
    }
  }
  if (!closest) return null;

  const diffDays = Math.abs(new Date(targetDate) - new Date(closest)) / DAY_MS;
  return diffDays > maxGapDays ? null : entries[closest];
}

/** A lookup bound to one metal's entries with the dates sorted once. */
function createSpotIndex(entries, defaults = {}) {
  const sortedDates = entries && typeof entries === 'object' ? Object.keys(entries).sort() : [];
  return (dateStr, opts = {}) => lookupSpotInEntries(entries, dateStr, { ...defaults, ...opts, sortedDates });
}

module.exports = { lookupSpotInEntries, createSpotIndex, MAX_GAP_DAYS };