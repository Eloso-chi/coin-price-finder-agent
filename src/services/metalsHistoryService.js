// src/services/metalsHistoryService.js — Daily metals spot price history
// Stores one price per metal per day in a JSON cache file.
// CommonJS

'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR  = require('../utils/cachePath').CACHE_DIR;
const cosmos     = require('../utils/cosmosClient');
const STORE_PATH = path.join(CACHE_DIR, 'metals_history.json');

// (CACHE_DIR mkdir handled by cachePath.js)

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
  // Debounced async write -- coalesces rapid successive calls into one I/O.
  if (saveStore._pending) clearTimeout(saveStore._pending);
  saveStore._pending = setTimeout(() => {
    saveStore._pending = null;
    const data = JSON.stringify(_store, null, 2);
    fs.writeFile(STORE_PATH, data, (err) => {
      if (err && process.env.NODE_ENV !== 'test') {
        console.error('[metalsHistory] Failed to save store:', err.message);
      }
    });
  }, 500);
}

/**
 * Record a daily spot price snapshot.
 * Only writes one entry per metal per calendar day (UTC).
 *
 * @param {string} metal — e.g. 'XAU', 'XAG'
 * @param {number} price — spot price in USD
 * @param {string} [timestamp] — ISO timestamp; defaults to now
 */
function recordDaily(metal, price, timestamp) {
  if (!metal || price == null || isNaN(price)) return;
  const store = loadStore();
  const dateKey = (timestamp ? new Date(timestamp) : new Date())
    .toISOString().substring(0, 10); // "2025-06-15"

  if (!store[metal]) store[metal] = {};
  // Only record once per day (first snapshot wins — avoids churn)
  if (!store[metal][dateKey]) {
    store[metal][dateKey] = Math.round(price * 100) / 100;
    _store = store;
    saveStore();

    // Write-through to Cosmos DB (#98)
    if (cosmos.isEnabled()) {
      cosmos.container('metals-history').items.upsert({
        id: metal,
        metal,
        prices: store[metal],
      }).catch(err => {
        if (process.env.NODE_ENV !== 'test') console.error('[metalsHistory] Cosmos write-through failed:', err.message);
      });
    }
  }
}

/**
 * Get historical daily prices for a metal within the last N days.
 *
 * @param {string} metal — e.g. 'XAU', 'XAG'
 * @param {number} rangeDays — how many days back
 * @returns {Array<[string, number]>} sorted [date, price] pairs
 */
function getHistory(metal, rangeDays) {
  const store = loadStore();
  const entries = store[metal];
  if (!entries) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rangeDays);
  const cutoffStr = cutoff.toISOString().substring(0, 10);

  const prices = [];
  for (const [date, price] of Object.entries(entries)) {
    if (date >= cutoffStr) {
      prices.push([date, price]);
    }
  }
  prices.sort((a, b) => a[0].localeCompare(b[0]));
  return prices;
}

/**
 * Evict entries older than maxDays to keep the file from growing forever.
 * @param {number} [maxDays=400]
 */
function evictOld(maxDays = 400) {
  const store = loadStore();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxDays);
  const cutoffStr = cutoff.toISOString().substring(0, 10);
  let evicted = 0;

  for (const metal of Object.keys(store)) {
    for (const date of Object.keys(store[metal])) {
      if (date < cutoffStr) {
        delete store[metal][date];
        evicted++;
      }
    }
  }

  if (evicted > 0) {
    _store = store;
    saveStore();
  }
  return evicted;
}

/**
 * Get the spot price for a metal on a specific date (or nearest prior date).
 * Returns the price as a number, or null if no historical data is available.
 *
 * @param {string} metal — e.g. 'XAU', 'XAG'
 * @param {string} dateStr — ISO date string (e.g. '2025-11-15') or full ISO timestamp
 * @returns {number|null}
 */
function getSpotOnDate(metal, dateStr) {
  if (!metal || !dateStr) return null;
  const store = loadStore();
  const entries = store[metal];
  if (!entries || Object.keys(entries).length === 0) return null;

  const targetDate = dateStr.substring(0, 10); // normalize to "YYYY-MM-DD"

  // Exact match
  if (entries[targetDate] != null) return entries[targetDate];

  // Find the closest prior date (within 7 days tolerance)
  const dates = Object.keys(entries).sort();
  let closest = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] <= targetDate) { closest = dates[i]; break; }
  }
  if (!closest) {
    // No prior date — try the first date after target (edge case: data starts after target)
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] > targetDate) { closest = dates[i]; break; }
    }
  }
  if (!closest) return null;

  // Only return if within 7 days of target (avoid stale data from gaps)
  const diffMs = Math.abs(new Date(targetDate) - new Date(closest));
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  if (diffDays > 7) return null;

  return entries[closest];
}

/** Map common metal names to ISO 4217 symbols */
const METAL_SYMBOLS = { silver: 'XAG', gold: 'XAU', platinum: 'XPT', palladium: 'XPD' };

module.exports = { recordDaily, getHistory, getSpotOnDate, evictOld, METAL_SYMBOLS };
