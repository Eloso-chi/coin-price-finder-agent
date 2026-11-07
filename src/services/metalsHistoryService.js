// src/services/metalsHistoryService.js — Daily metals spot price history
// Stores one price per metal per day in a JSON cache file.
// CommonJS

'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR  = require('../utils/cachePath').CACHE_DIR;
const cosmos     = require('../utils/cosmosClient');
const { lookupSpotInEntries, isCalendarDay } = require('../utils/spotLookup');
const STORE_PATH = path.join(CACHE_DIR, 'metals_history.json');

// Terapeak sold comps reach back about two years, and premium-over-spot needs spot on each sale date.
const RETENTION_DAYS = 800;
const METAL_CODES = ['XAU', 'XAG', 'XPT', 'XPD'];
const MAX_IMPORT_DAYS_PER_METAL = 1500;

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
 * @param {number} [maxDays=RETENTION_DAYS]
 */
function evictOld(maxDays = RETENTION_DAYS) {
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
  return lookupSpotInEntries(loadStore()[metal], dateStr);
}

/** Map common metal names to ISO 4217 symbols */
const METAL_SYMBOLS = { silver: 'XAG', gold: 'XAU', platinum: 'XPT', palladium: 'XPD' };

/** A price read from a live provider just now: not a stale copy and not the hardcoded last resort. */
function isLiveReading(data) {
  return !!data && !!data.price && !data.stale && data.source !== 'hardcoded-fallback';
}

/**
 * Record one daily snapshot per metal from a getMetalsSpotPrices() result, skipping anything that is not a live reading.
 * @returns {{ offered: number, skipped: number }}
 */
function recordSpotReadings(result) {
  let offered = 0;
  let skipped = 0;
  for (const [metal, data] of Object.entries(result || {})) {
    if (!isLiveReading(data)) { skipped++; continue; }
    recordDaily(metal, data.price, data.timestamp);
    offered++;
  }
  return { offered, skipped };
}

function importError(message) {
  const err = new Error(message);
  err.name = 'ImportError';
  return err;
}

/**
 * Merge daily prices from an operator-supplied backfill. Everything is validated before anything is written.
 * Existing days are kept unless listed in `replaceDays`; days older than the retention window are skipped.
 *
 * @param {Object<string, Object<string, number>>} history - { XAU: { 'YYYY-MM-DD': price } }
 * @param {{ replaceDays?: string[] }} [opts]
 * @returns {Object<string, { added: number, replaced: number, kept: number, skippedOld: number }>}
 */
function importHistory(history, { replaceDays = [] } = {}) {
  if (!history || typeof history !== 'object' || Array.isArray(history)) throw importError('history must be an object keyed by metal');
  if (!Array.isArray(replaceDays) || replaceDays.length > 400 || !replaceDays.every(isCalendarDay)) {
    throw importError('replaceDays must be a list of YYYY-MM-DD dates');
  }
  const replace = new Set(replaceDays);
  const today = new Date().toISOString().substring(0, 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().substring(0, 10);

  const incoming = [];
  for (const [metal, days] of Object.entries(history)) {
    if (!METAL_CODES.includes(metal)) throw importError('unknown metal in history');
    if (!days || typeof days !== 'object' || Array.isArray(days)) throw importError(`${metal} must be an object keyed by day`);
    const entries = Object.entries(days);
    if (entries.length > MAX_IMPORT_DAYS_PER_METAL) throw importError(`${metal} has more than ${MAX_IMPORT_DAYS_PER_METAL} days`);
    for (const [day, price] of entries) {
      const ok = isCalendarDay(day) && day <= today && typeof price === 'number' && Number.isFinite(price) && price > 0 && price < 1e7;
      if (!ok) throw importError(`invalid entry in ${metal}`);
    }
    incoming.push([metal, entries]);
  }

  const store = loadStore();
  const summary = {};
  const changed = [];
  for (const [metal, entries] of incoming) {
    if (!store[metal]) store[metal] = {};
    const current = store[metal];
    const s = { added: 0, replaced: 0, kept: 0, skippedOld: 0 };
    for (const [day, raw] of entries) {
      const price = Math.round(raw * 100) / 100;
      if (day < cutoffStr) { s.skippedOld++; continue; }
      if (!Object.prototype.hasOwnProperty.call(current, day)) { current[day] = price; s.added++; }
      else if (replace.has(day) && current[day] !== price) { current[day] = price; s.replaced++; }
      else s.kept++;
    }
    summary[metal] = s;
    if (s.added || s.replaced) changed.push(metal);
  }

  if (changed.length) {
    _store = store;
    saveStore();
    if (cosmos.isEnabled()) {
      for (const metal of changed) {
        cosmos.container('metals-history').items.upsert({ id: metal, metal, prices: store[metal] }).catch(err => {
          if (process.env.NODE_ENV !== 'test') console.error('[metalsHistory] Cosmos write-through failed:', err.message);
        });
      }
    }
  }
  return summary;
}

module.exports = { recordDaily, getHistory, getSpotOnDate, evictOld, recordSpotReadings, importHistory, METAL_SYMBOLS, RETENTION_DAYS };
