// src/services/metalsSpotPrice.js — Metals spot price with provider rotation,
// in-flight dedupe, TTL cache, and fallback.  CommonJS.

const axios = require('axios');
const { MetalsSpotPriceError } = require('./MetalsSpotPriceError');

/* ---------- Configuration ---------- */

const CACHE_TTL_MS = parseInt(process.env.METALS_CACHE_TTL_MS, 10) || 45 * 60 * 1000; // 45 min

const GOLDAPI_KEY   = () => process.env.GOLDAPI_KEY   || '';
const METALS_API_KEY = () => process.env.METALS_API_KEY || '';

const GOLDAPI_BASE   = () => process.env.GOLDAPI_BASE_URL   || 'https://www.goldapi.io/api';
const METALS_API_BASE = () => process.env.METALS_API_BASE_URL || 'https://metals-api.com/api';

/* ---------- Provider definitions ---------- */

/**
 * Each provider: { name, fetch(metal, currency) → { price, timestamp, source } }
 * Providers are tried in round-robin order; on failure the next one is attempted.
 */
const providers = [
  {
    name: 'goldprice-org',
    // Free, no-auth endpoint — always available as a baseline fallback
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

function setCache(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
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
    .then(({ price, timestamp, source }) => {
      const result = {
        metal,
        currency,
        price: Math.round(price * 100) / 100,
        timestamp,
        source,
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
        .then(({ price, timestamp, source }) => {
          const result = {
            metal,
            currency,
            price: Math.round(price * 100) / 100,
            timestamp,
            source,
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
  inFlight.clear();
  rotationIdx = 0;
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
};
