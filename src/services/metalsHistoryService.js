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
const BACKUP_PATH = `${STORE_PATH}.bak`;
const TMP_PATH = `${STORE_PATH}.tmp`;

// Terapeak sold comps reach back about two years, and premium-over-spot needs spot on each sale date.
const RETENTION_DAYS = 800;
const METAL_CODES = ['XAU', 'XAG', 'XPT', 'XPD'];
const MAX_IMPORT_DAYS_PER_METAL = 1500;
const MAX_REPLACE_DAYS = 60;
// Per-metal USD/oz bounds an imported price must sit inside, and how far from the median of the days within a week it may be.
const PLAUSIBLE_PRICE = { XAU: [100, 20000], XAG: [1, 1000], XPT: [100, 10000], XPD: [100, 10000] };
const NEIGHBOUR_WINDOW_DAYS = 7;
const MAX_NEIGHBOUR_JUMP = 0.4;

// (CACHE_DIR mkdir handled by cachePath.js)

let _store = null;
let _writeChain = Promise.resolve();
const _sortedDates = new Map(); // metal -> sorted day keys, rebuilt after any change to that metal

function readStoreFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  return parsed;
}

function loadStore() {
  if (_store) return _store;
  _store = {};
  _sortedDates.clear();
  for (const file of [STORE_PATH, BACKUP_PATH]) {
    if (!fs.existsSync(file)) continue;
    try {
      _store = readStoreFile(file);
      break;
    } catch {
      if (process.env.NODE_ENV !== 'test') console.error(`[metalsHistory] ${path.basename(file)} is unreadable`);
    }
  }
  return _store;
}

// Temp file then rename, keeping the last good file as .bak, so a crash mid-write cannot truncate the history.
async function writeStoreAtomic() {
  await fs.promises.writeFile(TMP_PATH, JSON.stringify(_store, null, 2));
  try {
    readStoreFile(STORE_PATH);
    await fs.promises.copyFile(STORE_PATH, BACKUP_PATH);
  } catch { /* no readable current file to keep */ }
  await fs.promises.rename(TMP_PATH, STORE_PATH);
}

/** Write the store now (cancelling any pending debounced write); rejects if the write fails. */
function flushStore() {
  if (saveStore._pending) {
    clearTimeout(saveStore._pending);
    saveStore._pending = null;
  }
  const run = _writeChain.then(writeStoreAtomic);
  _writeChain = run.catch(() => {});
  return run;
}

function saveStore() {
  // Debounced async write -- coalesces rapid successive calls into one I/O.
  if (saveStore._pending) clearTimeout(saveStore._pending);
  saveStore._pending = setTimeout(() => {
    saveStore._pending = null;
    flushStore().catch((err) => {
      if (process.env.NODE_ENV !== 'test') {
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
    _sortedDates.delete(metal);
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
    _sortedDates.clear();
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
  const entries = loadStore()[metal];
  if (!entries || typeof entries !== 'object') return null;
  let sorted = _sortedDates.get(metal);
  if (!sorted) {
    sorted = Object.keys(entries).sort();
    _sortedDates.set(metal, sorted);
  }
  return lookupSpotInEntries(entries, dateStr, { sortedDates: sorted });
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

const shiftDay = (day, delta) => new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86400000).toISOString().substring(0, 10);

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Merge daily prices from an operator-supplied backfill. Everything is validated before anything is changed:
 * known metals, real past days (never today, which the live poll records), a plausible price for the metal, and a price
 * within 40% of the median of the days around it. Existing days are kept unless listed in `replaceDays`; days older
 * than the retention window are skipped. Replaced days are reported with their previous price.
 *
 * @param {Object<string, Object<string, number>>} history - { XAU: { 'YYYY-MM-DD': price } }
 * @param {{ replaceDays?: string[] }} [opts]
 * @returns {Promise<{ summary: Object<string, { added: number, replaced: number, kept: number, skippedOld: number, previous: Object<string, number> }>,
 *   persisted: { file: 'ok'|'failed'|'unchanged', cosmos: 'ok'|'failed'|'disabled'|'unchanged' } }>}
 */
async function importHistory(history, { replaceDays = [] } = {}) {
  if (!history || typeof history !== 'object' || Array.isArray(history)) throw importError('history must be an object keyed by metal');
  if (!Array.isArray(replaceDays) || replaceDays.length > MAX_REPLACE_DAYS || !replaceDays.every(isCalendarDay)) {
    throw importError(`replaceDays must be a list of at most ${MAX_REPLACE_DAYS} YYYY-MM-DD dates`);
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
    const [lo, hi] = PLAUSIBLE_PRICE[metal];
    const rounded = [];
    for (const [day, price] of entries) {
      if (!isCalendarDay(day) || typeof price !== 'number' || !Number.isFinite(price)) throw importError(`invalid entry in ${metal}`);
      if (day >= today) throw importError(`${metal} has a day that is today or later; the live poll records today`);
      const cents = Math.round(price * 100) / 100;
      if (cents < lo || cents > hi) throw importError(`implausible ${metal} price on ${day}`);
      rounded.push([day, cents]);
    }
    incoming.push([metal, rounded]);
  }

  // Plan every change against the current store without touching it.
  const store = loadStore();
  const plans = [];
  for (const [metal, entries] of incoming) {
    const current = store[metal] || {};
    const plan = { metal, adds: [], replaces: [], kept: 0, skippedOld: 0, previous: {} };
    for (const [day, price] of entries) {
      if (day < cutoffStr) { plan.skippedOld++; continue; }
      if (!Object.prototype.hasOwnProperty.call(current, day)) plan.adds.push([day, price]);
      else if (replace.has(day) && current[day] !== price) { plan.replaces.push([day, price]); plan.previous[day] = current[day]; }
      else plan.kept++;
    }
    plans.push(plan);
  }

  // A changed day must sit near the days around it, judged on the store as it would be after the import.
  for (const plan of plans) {
    const after = Object.assign(Object.create(null), store[plan.metal] || {});
    const changedDays = [...plan.adds, ...plan.replaces];
    for (const [day, price] of changedDays) after[day] = price;
    for (const [day, price] of changedDays) {
      const near = [];
      for (let d = -NEIGHBOUR_WINDOW_DAYS; d <= NEIGHBOUR_WINDOW_DAYS; d++) {
        const v = d === 0 ? undefined : after[shiftDay(day, d)];
        if (typeof v === 'number' && v > 0) near.push(v);
      }
      if (near.length && Math.abs(price / median(near) - 1) > MAX_NEIGHBOUR_JUMP) {
        throw importError(`${plan.metal} price on ${day} is more than ${MAX_NEIGHBOUR_JUMP * 100}% from the days around it`);
      }
    }
  }

  const summary = {};
  const changed = [];
  for (const plan of plans) {
    if (!store[plan.metal]) store[plan.metal] = {};
    for (const [day, price] of [...plan.adds, ...plan.replaces]) store[plan.metal][day] = price;
    summary[plan.metal] = { added: plan.adds.length, replaced: plan.replaces.length, kept: plan.kept, skippedOld: plan.skippedOld, previous: plan.previous };
    if (plan.adds.length || plan.replaces.length) changed.push(plan.metal);
  }

  const persisted = { file: 'unchanged', cosmos: 'unchanged' };
  if (changed.length) {
    _sortedDates.clear();
    _store = store;
    try {
      await flushStore();
      persisted.file = 'ok';
    } catch (err) {
      persisted.file = 'failed';
      saveStore(); // one retry after the debounce, so the data is not left only in memory
      if (process.env.NODE_ENV !== 'test') console.error('[metalsHistory] Import write failed:', err.message);
    }
    if (cosmos.isEnabled()) {
      const results = await Promise.allSettled(changed.map(async (metal) => cosmos.container('metals-history').items.upsert({ id: metal, metal, prices: store[metal] })));
      persisted.cosmos = results.every((r) => r.status === 'fulfilled') ? 'ok' : 'failed';
      if (persisted.cosmos === 'failed' && process.env.NODE_ENV !== 'test') console.error('[metalsHistory] Cosmos write-through failed for the import');
    } else {
      persisted.cosmos = 'disabled';
    }
  }
  return { summary, persisted };
}

module.exports = { recordDaily, getHistory, getSpotOnDate, evictOld, recordSpotReadings, importHistory, flushStore, METAL_SYMBOLS, RETENTION_DAYS };
