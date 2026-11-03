// storage.js -- Server-backed coin inventory store
// Calls /api/coins/* endpoints. Auth token comes from CoinAuth.currentUser().

'use strict';

const CoinStorage = (() => {
  function _authHeaders() {
    const user = CoinAuth.currentUser();
    const h = { 'Content-Type': 'application/json' };
    if (user && user.token) h['Authorization'] = 'Bearer ' + user.token;
    return h;
  }

  const REQUEST_TIMEOUT_MS = 20000;

  /**
   * Failure from a collection request. `code` is one of: auth-expired, forbidden,
   * rate-limited, not-found, server, timeout, network, malformed. The UI picks its state from it.
   */
  class CollectionError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = 'CollectionError';
      this.code = code;
      this.status = status || null;
    }
  }

  function _codeForStatus(status) {
    if (status === 401) return 'auth-expired';
    if (status === 403) return 'forbidden';
    if (status === 429) return 'rate-limited';
    if (status === 404) return 'not-found';
    return 'server';
  }

  function _transportError(err) {
    if (err && err.name === 'AbortError') return new CollectionError('timeout', 'The request timed out.');
    return new CollectionError('network', 'Could not reach the server.');
  }

  /**
   * fetch + JSON parse under one timeout. Parse failures are reported via
   * `parseFailed` so each caller decides whether they matter.
   */
  async function _exchange(url, options) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      let resp;
      try {
        resp = await fetch(url, controller ? { ...options, signal: controller.signal } : options);
      } catch (err) {
        throw _transportError(err);
      }
      let data = null;
      let parseFailed = false;
      try {
        data = await resp.json();
      } catch (err) {
        if (err && err.name === 'AbortError') throw _transportError(err);
        parseFailed = true;
      }
      return { resp, data, parseFailed };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function _responseError(resp, data, fallback) {
    const serverMessage = data && typeof data.error === 'string' ? data.error : null;
    return new CollectionError(_codeForStatus(resp.status), serverMessage || fallback, resp.status);
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
    const { resp, data } = await _exchange('/api/coins/' + encodeURIComponent(coinHash), {
      method: 'PUT',
      headers: _authHeaders(),
      body: JSON.stringify({ count: newCount }),
    });
    if (!resp.ok) throw _responseError(resp, data, 'Failed to update count');
  }

  /**
   * Update cost per coin.
   * @param {string} _userId - ignored
   * @param {*} _key - ignored
   * @param {string} coinHash
   * @param {number|null} costPer
   */
  async function updateCostPer(_userId, _key, coinHash, costPer) {
    const { resp, data } = await _exchange('/api/coins/' + encodeURIComponent(coinHash), {
      method: 'PUT',
      headers: _authHeaders(),
      body: JSON.stringify({ costPer }),
    });
    if (!resp.ok) throw _responseError(resp, data, 'Failed to update cost');
  }

  /**
   * Remove a coin by hash.
   * @param {string} _userId - ignored
   * @param {string} coinHash
   */
  async function removeCoin(_userId, coinHash) {
    const { resp, data } = await _exchange('/api/coins/' + encodeURIComponent(coinHash), {
      method: 'DELETE',
      headers: _authHeaders(),
    });
    if (resp.status === 404) return; // already gone (retry after a timeout, or removed in another tab)
    if (!resp.ok) throw _responseError(resp, data, 'Failed to remove coin');
  }

  /**
   * Get all coins (plaintext) for authenticated user.
   * Throws CollectionError on any HTTP, transport, timeout or parse failure so a
   * failed load is never mistaken for an empty collection.
   * @param {string} _userId - ignored
   * @param {*} _key - ignored
   * @returns {Promise<object[]>}
   */
  async function getAllDecrypted(_userId, _key) {
    const { resp, data, parseFailed } = await _exchange('/api/coins', { headers: _authHeaders() });
    if (!resp.ok) {
      const failure = _responseError(resp, data, 'Could not load your collection.');
      if (failure.code === 'not-found') failure.code = 'server'; // a missing route is a service failure, not a missing coin
      throw failure;
    }
    if (parseFailed || !data || !Array.isArray(data.coins)) {
      throw new CollectionError('malformed', 'The server sent an unreadable response.', resp.status);
    }
    return data.coins;
  }

  /** Alias kept for backwards compatibility. */
  const getAllEncrypted = getAllDecrypted;

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

  /** No-op -- retained for interface compatibility. */
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
    CollectionError,
    REQUEST_TIMEOUT_MS,
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

// CommonJS shim for jest. No-op in the browser (no `module` global there).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CoinStorage;
}
