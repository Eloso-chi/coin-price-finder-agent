// storage.js — Server-backed coin inventory store
// Calls /api/coins/* endpoints. Auth token comes from CoinAuth.currentUser().
// Signature-compatible with the old client-side IndexedDB version:
//   methods accept (userId, key, ...) but ignore those params.

'use strict';

const CoinStorage = (() => {
  function _authHeaders() {
    const user = CoinAuth.currentUser();
    const h = { 'Content-Type': 'application/json' };
    if (user && user.token) h['Authorization'] = 'Bearer ' + user.token;
    return h;
  }

  /**
   * Add or update a coin.
   * @param {string} _userId - ignored (server derives from token)
   * @param {*} _key - ignored (no client-side encryption)
   * @param {object} coin
   * @returns {Promise<string>} coinHash
   */
  async function addCoin(_userId, _key, coin) {
    const resp = await fetch('/api/coins', {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify(coin),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to add coin');
    return data.coinHash;
  }

  /**
   * Check if a coin exists.
   * @param {string} _userId - ignored
   * @param {object} coin
   * @returns {Promise<boolean>}
   */
  async function hasCoin(_userId, coin) {
    const resp = await fetch('/api/coins/get', {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify(coin),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!data.coin;
  }

  /**
   * Get a single coin by identifying fields.
   * @param {string} _userId - ignored
   * @param {*} _key - ignored
   * @param {object} coin
   * @returns {Promise<object|null>}
   */
  async function getCoin(_userId, _key, coin) {
    const resp = await fetch('/api/coins/get', {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify(coin),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.coin || null;
  }

  /**
   * Update coin quantity.
   * @param {string} _userId - ignored
   * @param {*} _key - ignored
   * @param {string} coinHash
   * @param {number} newCount
   */
  async function updateCount(_userId, _key, coinHash, newCount) {
    const resp = await fetch('/api/coins/' + encodeURIComponent(coinHash), {
      method: 'PUT',
      headers: _authHeaders(),
      body: JSON.stringify({ count: newCount }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to update count');
    }
  }

  /**
   * Update cost per coin.
   * @param {string} _userId - ignored
   * @param {*} _key - ignored
   * @param {string} coinHash
   * @param {number|null} costPer
   */
  async function updateCostPer(_userId, _key, coinHash, costPer) {
    const resp = await fetch('/api/coins/' + encodeURIComponent(coinHash), {
      method: 'PUT',
      headers: _authHeaders(),
      body: JSON.stringify({ costPer }),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to update cost');
    }
  }

  /**
   * Remove a coin by hash.
   * @param {string} _userId - ignored
   * @param {string} coinHash
   */
  async function removeCoin(_userId, coinHash) {
    const resp = await fetch('/api/coins/' + encodeURIComponent(coinHash), {
      method: 'DELETE',
      headers: _authHeaders(),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to remove coin');
    }
  }

  /**
   * Get all coins (plaintext) for authenticated user.
   * @param {string} _userId - ignored
   * @param {*} _key - ignored
   * @returns {Promise<object[]>}
   */
  async function getAllDecrypted(_userId, _key) {
    const resp = await fetch('/api/coins', { headers: _authHeaders() });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.coins || [];
  }

  /** Alias for getAllDecrypted (no encryption in server mode). */
  async function getAllEncrypted(_userId) {
    return getAllDecrypted(_userId);
  }

  /**
   * Count of coins.
   * @param {string} _userId - ignored
   * @returns {Promise<number>}
   */
  async function count(_userId) {
    const resp = await fetch('/api/coins/count', { headers: _authHeaders() });
    if (!resp.ok) return 0;
    const data = await resp.json();
    return data.count || 0;
  }

  /**
   * Clear all coins for the user.
   * @param {string} _userId - ignored
   */
  async function clearAll(_userId) {
    const coins = await getAllDecrypted(_userId);
    for (const coin of coins) {
      await removeCoin(_userId, coin.coinHash);
    }
  }

  /**
   * Export all coins as a backup JSON string.
   * @param {string} _userId - ignored
   * @param {*} _key - ignored
   * @returns {Promise<string>} JSON string
   */
  async function exportJSON(_userId, _key) {
    const resp = await fetch('/api/coins/export', { headers: _authHeaders() });
    if (!resp.ok) throw new Error('Export failed');
    const data = await resp.json();
    return JSON.stringify(data, null, 2);
  }

  /**
   * Import coins from a backup JSON string.
   * @param {string} _userId - ignored
   * @param {*} _key - ignored
   * @param {string} jsonStr
   * @returns {Promise<{imported, skipped, errors, warnings}>}
   */
  async function importJSON(_userId, _key, jsonStr) {
    const data = JSON.parse(jsonStr);
    if (!data || data.format !== 'coin-price-agent-backup-v1' || !Array.isArray(data.coins)) {
      throw new Error('Invalid backup file format');
    }
    const resp = await fetch('/api/coins/import', {
      method: 'POST',
      headers: _authHeaders(),
      body: jsonStr,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Import failed');
    }
    const result = await resp.json();
    return { imported: result.imported || 0, skipped: result.skipped || 0, errors: 0, warnings: [] };
  }

  /** No-op -- no client-side DB to open. */
  function openDB() { return Promise.resolve(null); }

  /** No-op -- no client-side encryption to redo. */
  async function reEncryptAll() { return 0; }

  /**
   * Client-side coinHash -- matches server coinStorageService.coinHash().
   * Used by inline "I Have This Coin" qty +/- buttons.
   * @param {object} coin
   * @returns {Promise<string>} hex digest (64 chars)
   */
  async function coinHash(coin) {
    const input = [
      (coin.series || '').trim().toLowerCase(),
      String(coin.year || ''),
      (coin.mint || '').trim().toUpperCase(),
      (coin.grade || '').trim().toUpperCase(),
      (coin.notes || '').trim().toLowerCase(),
      (coin.label || '').trim().toLowerCase(),
    ].join('|');
    const buf = new TextEncoder().encode(input);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  return {
    openDB,
    addCoin,
    hasCoin,
    getCoin,
    updateCount,
    updateCostPer,
    removeCoin,
    getAllEncrypted,
    getAllDecrypted,
    count,
    clearAll,
    exportJSON,
    importJSON,
    reEncryptAll,
    coinHash,
  };
})();

// BackupReminder — coins are now server-side so backup is less critical.
// Keep the interface but make it a lightweight no-op.
const BackupReminder = (() => {
  function recordAdd() {}
  function recordBackup() {}
  function dismiss() {}
  function check() { return { needed: false, reason: null }; }
  return { recordAdd, recordBackup, dismiss, check };
})();
