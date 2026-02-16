// src/utils/cache.js — TTL Map with optional JSON-file persistence
// CommonJS

const fs = require('fs');
const path = require('path');

class TTLCache {
  /**
   * @param {object} opts
   * @param {number} opts.defaultTTL  – ms (default 15 min)
   * @param {string} [opts.filePath]  – if set, persist cache to this JSON file
   */
  constructor({ defaultTTL = 900_000, filePath } = {}) {
    this._store = new Map();
    this._defaultTTL = defaultTTL;
    this._filePath = filePath;
    if (filePath) this._loadFromFile();
  }

  /** Get a value (returns undefined when missing or expired). */
  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.exp) {
      this._store.delete(key);
      return undefined;
    }
    return entry.val;
  }

  /** Set a value with an optional per-key TTL. */
  set(key, val, ttl) {
    const exp = Date.now() + (ttl || this._defaultTTL);
    this._store.set(key, { val, exp });
    if (this._filePath) this._saveToFile();
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    this._store.delete(key);
    if (this._filePath) this._saveToFile();
  }

  clear() {
    this._store.clear();
    if (this._filePath) this._saveToFile();
  }

  /** Evict all expired entries. */
  prune() {
    const now = Date.now();
    for (const [k, v] of this._store) {
      if (now > v.exp) this._store.delete(k);
    }
  }

  get size() {
    this.prune();
    return this._store.size;
  }

  // ── File persistence ──────────────────────────────────────
  _saveToFile() {
    // Debounce: coalesce rapid writes into a single async flush
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const obj = {};
        for (const [k, v] of this._store) obj[k] = v;
        fs.writeFile(this._filePath, JSON.stringify(obj, null, 2), () => {});
      } catch (_) { /* best-effort */ }
    }, 500);
  }

  _loadFromFile() {
    try {
      if (!fs.existsSync(this._filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
      const now = Date.now();
      for (const [k, v] of Object.entries(raw)) {
        if (v.exp > now) this._store.set(k, v);
      }
    } catch (_) { /* ignore corrupt file */ }
  }
}

module.exports = { TTLCache };
