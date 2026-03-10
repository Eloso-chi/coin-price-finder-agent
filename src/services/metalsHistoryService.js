// src/services/metalsHistoryService.js — Daily metals spot price history
// Stores one price per metal per day in a JSON cache file.
// CommonJS

'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR  = path.resolve(__dirname, '..', '..', 'cache');
const STORE_PATH = path.join(CACHE_DIR, 'metals_history.json');

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
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(_store, null, 2));
  } catch { /* best-effort */ }
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

/** Map common metal names to ISO 4217 symbols */
const METAL_SYMBOLS = { silver: 'XAG', gold: 'XAU', platinum: 'XPT', palladium: 'XPD' };

module.exports = { recordDaily, getHistory, evictOld, METAL_SYMBOLS };
