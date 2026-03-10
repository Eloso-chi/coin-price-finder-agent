// storage.js — Encrypted IndexedDB inventory store (client-side only)
// Depends on: CoinCrypto (crypto.js)
// Never sends data to the server.

'use strict';

const CoinStorage = (() => {
  const DB_NAME = 'CoinVault';
  const DB_VERSION = 1;
  const STORE_NAME = 'inventory';

  let _db = null;

  /**
   * Open (or create) the IndexedDB database.
   * @returns {Promise<IDBDatabase>}
   */
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: ['userId', 'coinHash'] });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Add or update a coin in the encrypted inventory.
   * @param {string} userId
   * @param {CryptoKey} key - AES-GCM key
   * @param {object} coin - { series, year, mint, grade, weight, query }
   * @returns {Promise<string>} coinHash
   */
  async function addCoin(userId, key, coin) {
    const db = await openDB();
    const hash = await CoinCrypto.coinHash(coin);
    const plaintext = JSON.stringify({
      series: coin.series || '',
      year: coin.year || '',
      mint: coin.mint || '',
      grade: coin.grade || '',
      weight: coin.weight || null,
      query: coin.query || '',
      dateAdded: new Date().toISOString(),
    });
    const { iv, ciphertext } = await CoinCrypto.encrypt(key, plaintext);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ userId, coinHash: hash, iv, ciphertext });
      tx.oncomplete = () => resolve(hash);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Check if a coin already exists in inventory.
   * @param {string} userId
   * @param {object} coin - { series, year, mint, grade }
   * @returns {Promise<boolean>}
   */
  async function hasCoin(userId, coin) {
    const db = await openDB();
    const hash = await CoinCrypto.coinHash(coin);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get([userId, hash]);
      req.onsuccess = () => resolve(!!req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Remove a coin from inventory.
   * @param {string} userId
   * @param {string} coinHash
   * @returns {Promise<void>}
   */
  async function removeCoin(userId, coinHash) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete([userId, coinHash]);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Get all encrypted inventory records for a user.
   * @param {string} userId
   * @returns {Promise<Array<{userId, coinHash, iv, ciphertext}>>}
   */
  async function getAllEncrypted(userId) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const results = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(results);
        if (cursor.value.userId === userId) results.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Decrypt all inventory records for a user.
   * @param {string} userId
   * @param {CryptoKey} key
   * @returns {Promise<Array<{coinHash, ...coinData}>>}
   */
  async function getAllDecrypted(userId, key) {
    const records = await getAllEncrypted(userId);
    const decrypted = [];
    for (const rec of records) {
      try {
        const json = await CoinCrypto.decrypt(key, rec.iv, rec.ciphertext);
        const coin = JSON.parse(json);
        coin.coinHash = rec.coinHash;
        decrypted.push(coin);
      } catch {
        // Skip records that fail to decrypt (shouldn't happen with correct key)
      }
    }
    return decrypted;
  }

  /**
   * Count coins in inventory for a user.
   * @param {string} userId
   * @returns {Promise<number>}
   */
  async function count(userId) {
    const records = await getAllEncrypted(userId);
    return records.length;
  }

  /**
   * Clear all inventory for a user.
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async function clearAll(userId) {
    const records = await getAllEncrypted(userId);
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const rec of records) {
        store.delete([rec.userId, rec.coinHash]);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    openDB,
    addCoin,
    hasCoin,
    removeCoin,
    getAllEncrypted,
    getAllDecrypted,
    count,
    clearAll,

    /**
     * Export all coins for a user as a plain JSON array (decrypted).
     * The user must be logged in (key required).
     * @param {string} userId
     * @param {CryptoKey} key
     * @returns {Promise<string>} JSON string ready for download
     */
    async exportJSON(userId, key) {
      const coins = await getAllDecrypted(userId, key);
      // Strip internal fields, keep only user-facing data
      const clean = coins.map(c => ({
        series: c.series || '',
        year: c.year || '',
        mint: c.mint || '',
        grade: c.grade || '',
        weight: c.weight || null,
        query: c.query || '',
        dateAdded: c.dateAdded || null,
      }));
      return JSON.stringify({
        format: 'coin-price-agent-backup-v1',
        exportedAt: new Date().toISOString(),
        count: clean.length,
        coins: clean,
      }, null, 2);
    },

    /**
     * Import coins from a backup JSON string, encrypting each with the user's key.
     * Skips duplicates (same coinHash already in inventory).
     * @param {string} userId
     * @param {CryptoKey} key
     * @param {string} jsonStr — the raw JSON text from a backup file
     * @returns {Promise<{imported: number, skipped: number, errors: number}>}
     */
    async importJSON(userId, key, jsonStr) {
      const data = JSON.parse(jsonStr);
      if (!data || data.format !== 'coin-price-agent-backup-v1' || !Array.isArray(data.coins)) {
        throw new Error('Invalid backup file format');
      }
      let imported = 0, skipped = 0, errors = 0;
      const warnings = [];
      for (let i = 0; i < data.coins.length; i++) {
        const coin = data.coins[i];
        try {
          // Validate: must be an object with at least one identifying field
          if (!coin || typeof coin !== 'object' || Array.isArray(coin)) {
            warnings.push('Row ' + (i + 1) + ': not a valid coin object — skipped');
            errors++;
            continue;
          }
          const hasSeries = typeof coin.series === 'string' && coin.series.trim();
          const hasQuery  = typeof coin.query === 'string' && coin.query.trim();
          const hasYear   = coin.year != null && String(coin.year).trim();
          if (!hasSeries && !hasQuery && !hasYear) {
            warnings.push('Row ' + (i + 1) + ': no series, query, or year — skipped');
            errors++;
            continue;
          }
          // Sanitize: coerce fields to expected types, strip unknown keys
          const clean = {
            series: String(coin.series || '').trim().slice(0, 200),
            year:   String(coin.year || '').trim().slice(0, 10),
            mint:   String(coin.mint || '').trim().toUpperCase().slice(0, 10),
            grade:  String(coin.grade || '').trim().slice(0, 30),
            weight: coin.weight ? String(coin.weight).trim().slice(0, 20) : null,
            query:  String(coin.query || '').trim().slice(0, 300),
            dateAdded: coin.dateAdded || null,
          };
          const already = await hasCoin(userId, clean);
          if (already) { skipped++; continue; }
          await addCoin(userId, key, clean);
          imported++;
        } catch {
          warnings.push('Row ' + (i + 1) + ': encryption error — skipped');
          errors++;
        }
      }
      return { imported, skipped, errors, warnings };
    },

    /**
     * Re-encrypt all coins for a user with a new key.
     * Used during password change.
     * @param {string} userId
     * @param {CryptoKey} oldKey
     * @param {CryptoKey} newKey
     * @returns {Promise<number>} count of re-encrypted coins
     */
    async reEncryptAll(userId, oldKey, newKey) {
      const coins = await getAllDecrypted(userId, oldKey);
      const db = await openDB();
      // Clear old records
      await clearAll(userId);
      // Re-encrypt with new key
      for (const coin of coins) {
        await addCoin(userId, newKey, coin);
      }
      return coins.length;
    },
  };
})();

// ── BackupReminder — tracks when users should back up their collection ──
const BackupReminder = (() => {
  const STORAGE_KEY = 'cpf_backup_state';
  const ADDS_THRESHOLD = 10;      // prompt after this many adds without backup
  const DAYS_THRESHOLD = 30;      // prompt after this many days without backup

  function _load(userId) {
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
      return all[userId] || { addsSinceBackup: 0, lastBackupDate: null, dismissed: null };
    } catch { return { addsSinceBackup: 0, lastBackupDate: null, dismissed: null }; }
  }

  function _save(userId, state) {
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
      all[userId] = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch { /* localStorage full or unavailable */ }
  }

  /** Call after a coin is added. */
  function recordAdd(userId) {
    const s = _load(userId);
    s.addsSinceBackup++;
    s.dismissed = null;  // new add clears any previous dismissal
    _save(userId, s);
  }

  /** Call after a successful backup export. */
  function recordBackup(userId) {
    const s = _load(userId);
    s.addsSinceBackup = 0;
    s.lastBackupDate = new Date().toISOString();
    s.dismissed = null;
    _save(userId, s);
  }

  /** Call when user clicks "Remind Me Later". */
  function dismiss(userId) {
    const s = _load(userId);
    s.dismissed = new Date().toISOString();
    _save(userId, s);
  }

  /**
   * Check if a backup prompt should be shown.
   * @param {string} userId
   * @returns {{ needed: boolean, reason: string|null }}
   */
  function check(userId) {
    const s = _load(userId);

    // Don't re-show if dismissed within the last 7 days
    if (s.dismissed) {
      const dismissedAgo = Date.now() - new Date(s.dismissed).getTime();
      if (dismissedAgo < 7 * 24 * 60 * 60 * 1000) return { needed: false, reason: null };
    }

    // First coin ever added and never backed up
    if (s.addsSinceBackup >= 1 && !s.lastBackupDate) {
      return { needed: true, reason: 'first' };
    }

    // Threshold of adds reached
    if (s.addsSinceBackup >= ADDS_THRESHOLD) {
      return { needed: true, reason: 'adds' };
    }

    // Too many days since last backup
    if (s.lastBackupDate) {
      const daysSince = (Date.now() - new Date(s.lastBackupDate).getTime()) / (24 * 60 * 60 * 1000);
      if (daysSince >= DAYS_THRESHOLD) {
        return { needed: true, reason: 'time' };
      }
    }

    return { needed: false, reason: null };
  }

  return { recordAdd, recordBackup, dismiss, check };
})();
