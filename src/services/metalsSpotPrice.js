// src/services/metalsSpotPrice.js — Metals spot price with provider rotation,
// in-flight dedupe, TTL cache, disk persistence, stale fallback, and
// hardcoded last-resort.  CommonJS.

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { MetalsSpotPriceError } = require('./MetalsSpotPriceError');

/* ---------- Configuration ---------- */

const CACHE_TTL_MS = parseInt(process.env.METALS_CACHE_TTL_MS, 10) || 45 * 60 * 1000; // 45 min
const DISK_CACHE_PATH = path.join(require('../utils/cachePath').CACHE_DIR, 'metals_spot.json');

const GOLDAPI_KEY   = () => process.env.GOLDAPI_KEY   || '';
const METALS_API_KEY = () => process.env.METALS_API_KEY || '';

const GOLDAPI_BASE   = () => process.env.GOLDAPI_BASE_URL   || 'https://www.goldapi.io/api';
const METALS_API_BASE = () => process.env.METALS_API_BASE_URL || 'https://metals-api.com/api';

/* ---------- Hardcoded last-resort prices ---------- */
// Updated periodically.  These are only used when ALL providers fail AND there
// is no cached / disk-persisted price available.  Better than returning nothing.
const HARDCODED_FALLBACK = {
  XAG: { price: 80.27, currency: 'USD', source: 'hardcoded-fallback', timestamp: '2026-03-03T00:00:00Z' },
  XAU: { price: 5071.50, currency: 'USD', source: 'hardcoded-fallback', timestamp: '2026-03-03T00:00:00Z' },
  XPT: { price: 1050.00, currency: 'USD', source: 'hardcoded-fallback', timestamp: '2026-03-03T00:00:00Z' },
  XPD: { price: 975.00, currency: 'USD', source: 'hardcoded-fallback', timestamp: '2026-03-03T00:00:00Z' },
};

/* ---------- Disk-persist helpers ---------- */

let _diskCache = null; // lazy-loaded

function loadDiskCache() {
  if (_diskCache) return _diskCache;
  try {
    if (fs.existsSync(DISK_CACHE_PATH)) {
      _diskCache = JSON.parse(fs.readFileSync(DISK_CACHE_PATH, 'utf8'));
    } else {
      _diskCache = {};
    }
  } catch {
    _diskCache = {};
  }
  return _diskCache;
}

function saveDiskCache(data) {
  _diskCache = data;
  try {
    const dir = path.dirname(DISK_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DISK_CACHE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    // Non-fatal — disk persistence is best-effort
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[metals] disk cache write failed:', err.message);
    }
  }
}

function getDiskCached(key) {
  const dc = loadDiskCache();
  return dc[key] || null;
}

function setDiskCached(key, data) {
  const dc = loadDiskCache();
  dc[key] = { ...data, savedAt: Date.now() };
  saveDiskCache(dc);
}

/* ---------- Provider definitions ---------- */

/**
 * Each provider: { name, fetch(metal, currency) → { price, timestamp, source } }
 * Providers are tried in round-robin order; on failure the next one is attempted.
 */
const providers = [
  {
    name: 'gold-api-com',
    // Free, no-auth endpoint — api.gold-api.com
    async fetch(metal, currency) {
      const res = await axios.get(`https://api.gold-api.com/price/${metal}`, {
        timeout: 8000,
        headers: { Accept: 'application/json' },
      });
      const d = res.data;
      const price = d.price;
      if (!price) throw new Error(`No ${metal} price in gold-api.com response`);
      return {
        price: parseFloat(price),
        timestamp: d.updatedAt || new Date().toISOString(),
        source: 'gold-api-com',
      };
    },
  },
  {
    name: 'goldprice-org',
    // Free, no-auth endpoint — can be rate-limited
    async fetch(metal, currency) {
      const res = await axios.get('https://data-asg.goldprice.org/dbXRates/' + currency, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CoinPriceAgent/1.0)',
          'Accept': 'application/json',
        },
      });
      const d = res.data;
      // Response contains items[0].xauPrice, items[0].xagPrice, etc.
      const item = (d.items || d.Items || [])[0] || d;
      const key = metal.toLowerCase() + 'Price';     // 'xauPrice', 'xagPrice'
      const price = item[key] ?? item[metal.toLowerCase() + 'Close'];
      if (!price) throw new Error(`No ${metal} price in goldprice.org response`);
      return {
        price: parseFloat(price),
        timestamp: new Date().toISOString(),
        source: 'goldprice-org',
      };
    },
  },
  {
    name: 'goldapi',
    async fetch(metal, currency) {
      if (!GOLDAPI_KEY()) throw new Error('GOLDAPI_KEY not configured');
      const url = `${GOLDAPI_BASE()}/${metal}/${currency}`;
      const res = await axios.get(url, {
        headers: { 'x-access-token': GOLDAPI_KEY() },
        timeout: 8000,
      });
      const d = res.data;
      return {
        price: d.price ?? d.current_price ?? d.price_gram_24k * 31.1035,
        timestamp: d.timestamp
          ? new Date(d.timestamp * 1000).toISOString()
          : new Date().toISOString(),
        source: 'goldapi',
      };
    },
  },
  {
    name: 'metals-api',
    async fetch(metal, currency) {
      if (!METALS_API_KEY()) throw new Error('METALS_API_KEY not configured');
      const url = `${METALS_API_BASE()}/latest`;
      const res = await axios.get(url, {
        params: { access_key: METALS_API_KEY(), base: currency, symbols: metal },
        timeout: 8000,
      });
      const d = res.data;
      if (!d.success && d.error) {
        const err = new Error(d.error.info || d.error.type || 'metals-api error');
        err.status = d.error.code || 502;
        throw err;
      }
      // metals-api returns rates as 1/price (inverse)
      const rate = d.rates && d.rates[metal];
      if (!rate) throw new Error(`No rate returned for ${metal}`);
      return {
        price: 1 / rate,
        timestamp: d.timestamp
          ? new Date(d.timestamp * 1000).toISOString()
          : new Date().toISOString(),
        source: 'metals-api',
      };
    },
  },
];

/* ---------- Internal state ---------- */

const cache      = new Map();  // key → { data, expiresAt }
const staleCache = new Map();  // key → data (never auto-deleted; last-known-good)
const inFlight   = new Map();  // key → Promise
let   rotationIdx = 0;         // round-robin index across cache misses

/* ---------- Helpers ---------- */

function cacheKey(metal, currency) { return `${metal}:${currency}`; }

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}

/**
 * Return the best available stale/fallback value for a key.
 * Priority: stale in-memory → disk cache → hardcoded constant.
 */
function getStaleFallback(key, metal, currency) {
  // 1) Stale in-memory (previous successful fetch this process lifetime)
  const stale = staleCache.get(key);
  if (stale) return { ...stale, cached: true, stale: true, source: stale.source + ' (stale)' };

  // 2) Disk-persisted from a prior process
  const disk = getDiskCached(key);
  if (disk) return { metal, currency, price: disk.price, timestamp: disk.timestamp,
    source: (disk.source || 'disk-cache') + ' (disk)', cached: true, stale: true, unit: 'troy_ounce' };

  // 3) Hardcoded last-resort
  const hc = HARDCODED_FALLBACK[metal];
  if (hc && (hc.currency === currency || currency === 'USD')) {
    return { metal, currency, price: hc.price, timestamp: hc.timestamp,
      source: hc.source, cached: true, stale: true, unit: 'troy_ounce' };
  }

  return null;
}

function setCache(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  staleCache.set(key, data);                        // keep forever in-memory
  setDiskCached(key, data);                          // persist to disk
}

/** Advance round-robin index and return it (wraps around providers.length) */
function nextRotation() {
  const idx = rotationIdx % providers.length;
  rotationIdx++;
  return idx;
}

/* ---------- Core fetch with rotation + fallback ---------- */

/**
 * Try each provider starting from `startIdx`, falling back to the rest.
 * If ALL providers fail, attempts stale/disk/hardcoded fallback before throwing.
 * @returns {{ price, timestamp, source }}
 */
async function fetchFromProviders(metal, currency, startIdx) {
  const tried = [];
  let lastStatus = null;
  let lastErrorMessage = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[(startIdx + i) % providers.length];
    tried.push(provider.name);
    try {
      return await provider.fetch(metal, currency);
    } catch (err) {
      lastStatus = err.response?.status || err.status || null;
      lastErrorMessage = err.message;
    }
  }

  // All live providers failed — try stale/disk/hardcoded fallback
  const key = cacheKey(metal, currency);
  const fallback = getStaleFallback(key, metal, currency);
  if (fallback) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[metals] All providers failed for ${metal}/${currency}, using fallback: ${fallback.source}`);
    }
    return fallback;
  }

  throw new MetalsSpotPriceError(
    `All metals-price providers failed for ${metal}/${currency}`,
    { providersTried: tried, lastStatus, lastErrorMessage, metal, currency },
  );
}

/* ---------- Public API ---------- */

/**
 * Get spot price for a single metal.
 * @param {string} metal   – e.g. 'XAU', 'XAG'
 * @param {string} [currency='USD']
 * @returns {Promise<{ metal, currency, price, timestamp, source, cached, unit }>}
 */
async function getMetalsSpotPrice(metal, currency = 'USD') {
  const key = cacheKey(metal, currency);

  // 1. Cache hit
  const hit = getCached(key);
  if (hit) return { ...hit, cached: true };

  // 2. In-flight dedupe
  if (inFlight.has(key)) return inFlight.get(key).then(d => ({ ...d, cached: true }));

  // 3. Fetch with rotation
  const startIdx = nextRotation();
  const promise = fetchFromProviders(metal, currency, startIdx)
    .then((raw) => {
      // If the result is a stale fallback, pass it through without re-caching
      if (raw.stale) return raw;

      const result = {
        metal,
        currency,
        price: Math.round(raw.price * 100) / 100,
        timestamp: raw.timestamp,
        source: raw.source,
        cached: false,
        unit: 'troy_ounce',
      };
      setCache(key, result);
      return result;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

/**
 * Get spot prices for multiple metals in one call.
 * Picks ONE provider for the whole batch (round-robin), falls back per-item.
 * @param {string[]} [metals=['XAU','XAG']]
 * @param {string}   [currency='USD']
 * @returns {Promise<Object.<string, { metal, currency, price, timestamp, source, cached, unit }>>}
 */
async function getMetalsSpotPrices(metals = ['XAU', 'XAG'], currency = 'USD') {
  // Decide provider rotation once for the batch
  const batchStartIdx = nextRotation();

  const entries = await Promise.all(
    metals.map(async (metal) => {
      const key = cacheKey(metal, currency);

      // Cache hit
      const hit = getCached(key);
      if (hit) return [metal, { ...hit, cached: true }];

      // In-flight dedupe
      if (inFlight.has(key)) {
        const d = await inFlight.get(key);
        return [metal, { ...d, cached: true }];
      }

      // Fetch (use batch index so whole batch starts at same provider)
      const promise = fetchFromProviders(metal, currency, batchStartIdx)
        .then((raw) => {
          if (raw.stale) return raw;

          const result = {
            metal,
            currency,
            price: Math.round(raw.price * 100) / 100,
            timestamp: raw.timestamp,
            source: raw.source,
            cached: false,
            unit: 'troy_ounce',
          };
          setCache(key, result);
          return result;
        })
        .finally(() => inFlight.delete(key));

      inFlight.set(key, promise);
      return [metal, await promise];
    }),
  );

  return Object.fromEntries(entries);
}

/* ---------- Testing helpers (not part of public API) ---------- */

/** Reset internal state — useful in tests */
function _reset() {
  cache.clear();
  staleCache.clear();
  inFlight.clear();
  rotationIdx = 0;
  _diskCache = null;
}

/** Expose rotation index for test assertions */
function _getRotationIdx() { return rotationIdx; }

module.exports = {
  getMetalsSpotPrice,
  getMetalsSpotPrices,
  // internals for tests
  _reset,
  _getRotationIdx,
  _providers: providers,
  _cache: cache,
  _staleCache: staleCache,
  _HARDCODED_FALLBACK: HARDCODED_FALLBACK,
};
