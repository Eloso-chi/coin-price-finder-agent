// src/services/coinStorageService.js -- Server-side coin inventory storage
// Plaintext JSON store keyed by userId.
// File: cache/user_coins.json
// CommonJS

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.resolve(__dirname, '..', '..', 'cache');
const STORE_PATH = path.join(CACHE_DIR, 'user_coins.json');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

let _store = null;
let _savePending = null;

function loadStore() {
  if (_store) return _store;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    _store = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    _store = {};
  }
  return _store;
}

function saveStore() {
  if (_savePending) clearTimeout(_savePending);
  _savePending = setTimeout(() => {
    _savePending = null;
    fs.writeFile(STORE_PATH, JSON.stringify(_store, null, 2), (err) => {
      if (err && process.env.NODE_ENV !== 'test') {
        console.error('[coinStorage] Failed to save store:', err.message);
      }
    });
  }, 300);
}

function saveStoreSync() {
  fs.writeFileSync(STORE_PATH, JSON.stringify(_store, null, 2), 'utf8');
}

// ── coinHash — deterministic hash from identifying fields ───
// Must match CoinCrypto.coinHash() on the client (public/js/crypto.js)
function coinHash(coin) {
  const input = [
    (coin.series || '').trim().toLowerCase(),
    String(coin.year || ''),
    (coin.mint || '').trim().toUpperCase(),
    (coin.grade || '').trim().toUpperCase(),
    (coin.notes || '').trim().toLowerCase(),
    (coin.label || '').trim().toLowerCase(),
  ].join('|');
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ── CRUD ────────────────────────────────────────────────────

/**
 * Add a coin to a user's collection.
 * @param {string} userId
 * @param {object} coin
 * @returns {string} coinHash
 */
function addCoin(userId, coin) {
  const store = loadStore();
  if (!store[userId]) store[userId] = [];

  const hash = coinHash(coin);
  const costRaw = coin.costPer != null ? parseFloat(coin.costPer) : null;

  const entry = {
    coinHash: hash,
    series: (coin.series || '').trim().slice(0, 200),
    year: (coin.year || '').toString().trim().slice(0, 10),
    mint: (coin.mint || '').trim().toUpperCase().slice(0, 10),
    grade: (coin.grade || '').trim().slice(0, 30),
    weight: coin.weight || null,
    query: (coin.query || '').trim().slice(0, 300),
    count: Math.max(1, parseInt(coin.count, 10) || 1),
    costPer: (costRaw != null && !isNaN(costRaw) && costRaw >= 0) ? costRaw : null,
    notes: coin.notes ? String(coin.notes).trim().slice(0, 500) : null,
    label: coin.label ? String(coin.label).trim().slice(0, 50) : null,
    baseMetal: coin.baseMetal ? String(coin.baseMetal).trim().slice(0, 20) : null,
    fineness: coin.fineness != null ? parseFloat(coin.fineness) || null : null,
    dateAdded: coin.dateAdded || new Date().toISOString(),
  };

  // Check for duplicate
  const existing = store[userId].findIndex(c => c.coinHash === hash);
  if (existing >= 0) {
    // Update existing entry
    store[userId][existing] = entry;
  } else {
    store[userId].push(entry);
  }

  _store = store;
  saveStore();
  return hash;
}

/**
 * Check if a coin exists in a user's collection.
 * @param {string} userId
 * @param {object} coin
 * @returns {boolean}
 */
function hasCoin(userId, coin) {
  const store = loadStore();
  const hash = coinHash(coin);
  return (store[userId] || []).some(c => c.coinHash === hash);
}

/**
 * Remove a coin by its hash.
 * @param {string} userId
 * @param {string} hash
 * @returns {boolean}
 */
function removeCoin(userId, hash) {
  const store = loadStore();
  if (!store[userId]) return false;
  const before = store[userId].length;
  store[userId] = store[userId].filter(c => c.coinHash !== hash);
  if (store[userId].length === before) return false;
  _store = store;
  saveStore();
  return true;
}

/**
 * Get all coins for a user (decrypted/plaintext).
 * @param {string} userId
 * @returns {object[]}
 */
function getAllCoins(userId) {
  const store = loadStore();
  return store[userId] || [];
}

/**
 * Update the count of a coin.
 * @param {string} userId
 * @param {string} hash
 * @param {number} newCount
 * @returns {boolean}
 */
function updateCount(userId, hash, newCount) {
  const store = loadStore();
  const coin = (store[userId] || []).find(c => c.coinHash === hash);
  if (!coin) return false;
  coin.count = Math.max(1, parseInt(newCount, 10) || 1);
  _store = store;
  saveStore();
  return true;
}

/**
 * Update the cost per coin.
 * @param {string} userId
 * @param {string} hash
 * @param {number|null} costPer
 * @returns {boolean}
 */
function updateCostPer(userId, hash, costPer) {
  const store = loadStore();
  const coin = (store[userId] || []).find(c => c.coinHash === hash);
  if (!coin) return false;
  const parsed = costPer != null ? parseFloat(costPer) : null;
  coin.costPer = (parsed != null && !isNaN(parsed) && parsed >= 0) ? parsed : null;
  _store = store;
  saveStore();
  return true;
}

/**
 * Get the count of coins for a user.
 * @param {string} userId
 * @returns {number}
 */
function count(userId) {
  const store = loadStore();
  return (store[userId] || []).length;
}

/**
 * Bulk delete coins by hash.
 * @param {string} userId
 * @param {string[]} hashes
 * @returns {number} count deleted
 */
function bulkDelete(userId, hashes) {
  const store = loadStore();
  if (!store[userId]) return 0;
  const hashSet = new Set(hashes);
  const before = store[userId].length;
  store[userId] = store[userId].filter(c => !hashSet.has(c.coinHash));
  const deleted = before - store[userId].length;
  if (deleted > 0) { _store = store; saveStore(); }
  return deleted;
}

/**
 * Import coins from a backup, skipping duplicates.
 * @param {string} userId
 * @param {object[]} coins
 * @returns {{ imported: number, skipped: number }}
 */
function importCoins(userId, coins) {
  const store = loadStore();
  if (!store[userId]) store[userId] = [];
  const existingHashes = new Set(store[userId].map(c => c.coinHash));

  let imported = 0, skipped = 0;
  for (const coin of coins) {
    let hash = coinHash(coin);
    if (existingHashes.has(hash)) {
      // Auto-differentiate with lot number
      let lotNum = 2;
      const origNotes = coin.notes || '';
      let diffCoin = { ...coin };
      while (existingHashes.has(hash) && lotNum <= 50) {
        diffCoin.notes = (origNotes ? origNotes + ' | ' : '') + 'lot ' + lotNum;
        hash = coinHash(diffCoin);
        lotNum++;
      }
      if (lotNum > 50) { skipped++; continue; }
      coin.notes = diffCoin.notes;
    }
    addCoin(userId, coin);
    existingHashes.add(hash);
    imported++;
  }
  return { imported, skipped };
}

/**
 * Export all coins as a backup-format object.
 * @param {string} userId
 * @returns {object}
 */
function exportCoins(userId) {
  const coins = getAllCoins(userId).map(c => ({
    series: c.series || '',
    year: c.year || '',
    mint: c.mint || '',
    grade: c.grade || '',
    weight: c.weight || null,
    query: c.query || '',
    count: c.count || 1,
    costPer: c.costPer != null ? c.costPer : null,
    notes: c.notes || null,
    label: c.label || null,
    baseMetal: c.baseMetal || null,
    fineness: c.fineness != null ? c.fineness : null,
    dateAdded: c.dateAdded || null,
  }));
  return {
    format: 'coin-price-agent-backup-v1',
    exportedAt: new Date().toISOString(),
    count: coins.length,
    coins,
  };
}

// ── Test helpers ────────────────────────────────────────────

function _resetStore() {
  _store = {};
  saveStoreSync();
}

module.exports = {
  coinHash,
  addCoin,
  hasCoin,
  removeCoin,
  getAllCoins,
  updateCount,
  updateCostPer,
  count,
  bulkDelete,
  importCoins,
  exportCoins,
  _resetStore,
};
