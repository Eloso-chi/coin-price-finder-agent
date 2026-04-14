// src/services/greysheetHistoryService.js -- Daily Greysheet price history
// Stores one snapshot per coin per day in a JSON cache file.
// Mirrors the metalsHistoryService pattern.
// CommonJS

'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR  = path.resolve(__dirname, '..', '..', 'cache');
const STORE_PATH = path.join(CACHE_DIR, 'greysheet_history.json');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let _store = null;

function loadStore() {
  if (_store) return _store;
  try {
    if (fs.existsSync(STORE_PATH)) {
      _store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } else {
      _store = {};
    }
  } catch {
    _store = {};
  }
  return _store;
}

function saveStore() {
  if (saveStore._pending) clearTimeout(saveStore._pending);
  saveStore._pending = setTimeout(() => {
    saveStore._pending = null;
    const data = JSON.stringify(_store, null, 2);
    fs.writeFile(STORE_PATH, data, (err) => {
      if (err && process.env.NODE_ENV !== 'test') {
        console.error('[greysheetHistory] Failed to save store:', err.message);
      }
    });
  }, 500);
}

/**
 * Build a canonical lookup key for a coin.
 *
 * @param {string|number} id -- PCGS number or GSID
 * @param {number|null}   grade -- numeric grade (e.g. 63), or null for "all"
 * @returns {string} e.g. "7130:63" or "72469:all"
 */
function makeKey(id, grade) {
  return `${id}:${grade || 'all'}`;
}

/**
 * Record a daily Greysheet price snapshot.
 * Only writes one entry per coin per calendar day (UTC).
 *
 * @param {string} lookupKey -- from makeKey()
 * @param {number|null} greyVal -- Greysheet wholesale (dealer bid)
 * @param {number|null} cpgVal  -- CPG retail
 */
function recordSnapshot(lookupKey, greyVal, cpgVal) {
  if (!lookupKey || (greyVal == null && cpgVal == null)) return;
  const store = loadStore();
  const dateKey = new Date().toISOString().substring(0, 10);

  if (!store[lookupKey]) store[lookupKey] = {};
  // Only record once per day (first snapshot wins)
  if (!store[lookupKey][dateKey]) {
    store[lookupKey][dateKey] = {};
    if (greyVal != null) store[lookupKey][dateKey].w = Math.round(greyVal * 100) / 100;
    if (cpgVal  != null) store[lookupKey][dateKey].r = Math.round(cpgVal  * 100) / 100;
    _store = store;
    saveStore();
    return true;
  }
  return false;
}

/**
 * Get historical daily prices for a coin within the last N days.
 *
 * @param {string} lookupKey -- from makeKey()
 * @param {number} rangeDays -- how many days back
 * @returns {{ wholesale: Array<[string, number]>, retail: Array<[string, number]> }}
 */
function getHistory(lookupKey, rangeDays) {
  const store = loadStore();
  const entries = store[lookupKey];
  if (!entries) return { wholesale: [], retail: [] };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rangeDays);
  const cutoffStr = cutoff.toISOString().substring(0, 10);

  const wholesale = [];
  const retail = [];
  for (const [date, snap] of Object.entries(entries)) {
    if (date >= cutoffStr) {
      if (snap.w != null) wholesale.push([date, snap.w]);
      if (snap.r != null) retail.push([date, snap.r]);
    }
  }
  wholesale.sort((a, b) => a[0].localeCompare(b[0]));
  retail.sort((a, b) => a[0].localeCompare(b[0]));
  return { wholesale, retail };
}

/**
 * Get the most recent snapshot for a coin (any date).
 *
 * @param {string} lookupKey
 * @returns {{ date: string, wholesale: number|null, retail: number|null }|null}
 */
function getLatest(lookupKey) {
  const store = loadStore();
  const entries = store[lookupKey];
  if (!entries) return null;

  const dates = Object.keys(entries).sort();
  if (dates.length === 0) return null;

  const latest = dates[dates.length - 1];
  const snap = entries[latest];
  return {
    date: latest,
    wholesale: snap.w ?? null,
    retail: snap.r ?? null
  };
}

/**
 * Evict entries older than maxDays.
 * @param {number} [maxDays=200]
 * @returns {number} entries evicted
 */
function evictOld(maxDays = 200) {
  const store = loadStore();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  const cutoffStr = cutoff.toISOString().substring(0, 10);
  let evicted = 0;

  for (const key of Object.keys(store)) {
    for (const date of Object.keys(store[key])) {
      if (date < cutoffStr) {
        delete store[key][date];
        evicted++;
      }
    }
    // Remove empty keys
    if (Object.keys(store[key]).length === 0) {
      delete store[key];
    }
  }

  if (evicted > 0) {
    _store = store;
    saveStore();
  }
  return evicted;
}

/**
 * Get the date of the last full refresh (written by greysheet-refresh.js).
 * @returns {string|null} ISO date string e.g. "2026-04-14", or null
 */
function getLastRefreshDate() {
  const store = loadStore();
  return store._lastRefresh || null;
}

/**
 * Record the date of a completed full refresh.
 * @param {string} [date] -- defaults to today
 */
function setLastRefreshDate(date) {
  const store = loadStore();
  store._lastRefresh = date || new Date().toISOString().substring(0, 10);
  _store = store;
  saveStore();
}

/**
 * Number of unique coins tracked.
 */
function coinCount() {
  const store = loadStore();
  return Object.keys(store).filter(k => k !== '_lastRefresh').length;
}

module.exports = {
  makeKey,
  recordSnapshot,
  getHistory,
  getLatest,
  evictOld,
  getLastRefreshDate,
  setLastRefreshDate,
  coinCount,
  // Exposed for testing
  _loadStore: loadStore
};
