// src/utils/spotLookup.js -- pure spot lookup over { 'YYYY-MM-DD': price } entries
// CommonJS
'use strict';

const MAX_GAP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A real calendar day written YYYY-MM-DD (rejects 2024-99-99 and non-date keys such as __proto__). */
function isCalendarDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

function ownPrice(entries, day) {
  if (!isCalendarDay(day) || !Object.prototype.hasOwnProperty.call(entries, day)) return null;
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
  if (!isCalendarDay(targetDate)) return null;
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
  return Number.isFinite(diffDays) && diffDays <= maxGapDays ? entries[closest] : null;
}

/** A lookup bound to one metal's entries with the dates sorted once. */
function createSpotIndex(entries, defaults = {}) {
  const sortedDates = entries && typeof entries === 'object' ? Object.keys(entries).sort() : [];
  return (dateStr, opts = {}) => lookupSpotInEntries(entries, dateStr, { ...defaults, ...opts, sortedDates });
}

module.exports = { lookupSpotInEntries, createSpotIndex, MAX_GAP_DAYS };