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
  };
})();
