// __tests__/metalsSpotPrice.test.js — Comprehensive tests for metals spot price service
// Jest + axios-mock-adapter

const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');

const {
  getMetalsSpotPrice,
  getMetalsSpotPrices,
  _reset,
  _getRotationIdx,
  _cache,
  _staleCache,
  _HARDCODED_FALLBACK,
} = require('../src/services/metalsSpotPrice');

const { MetalsSpotPriceError } = require('../src/services/MetalsSpotPriceError');

let mock;

beforeEach(() => {
  _reset();
  mock = new MockAdapter(axios);
  // Set both API keys so providers are "available"
  process.env.GOLDAPI_KEY = 'test-goldapi-key';
  process.env.METALS_API_KEY = 'test-metals-api-key';
  process.env.NODE_ENV = 'test';
  // Point at mock-friendly base URLs (axios-mock-adapter intercepts all)
  process.env.GOLDAPI_BASE_URL = 'https://www.goldapi.io/api';
  process.env.METALS_API_BASE_URL = 'https://metals-api.com/api';
});

afterEach(() => {
  mock.restore();
  delete process.env.GOLDAPI_KEY;
  delete process.env.METALS_API_KEY;
  delete process.env.GOLDAPI_BASE_URL;
  delete process.env.METALS_API_BASE_URL;
  delete process.env.NODE_ENV;
});

/* ── Helpers ─────────────────────────────────────────────── */

function mockGoldApiCom(metal, price) {
  mock.onGet(`https://api.gold-api.com/price/${metal}`).reply(200, {
    name: metal === 'XAU' ? 'Gold' : 'Silver',
    price,
    symbol: metal,
    updatedAt: '2026-03-02T00:00:00Z',
  });
}

function mockGoldApi(metal, currency, price) {
  mock.onGet(`https://www.goldapi.io/api/${metal}/${currency}`).reply(200, {
    price,
    timestamp: 1700000000,
  });
}

function mockMetalsApi(metal, currency, price) {
  // metals-api returns 1/price as rate
  mock.onGet('https://metals-api.com/api/latest').reply(200, {
    success: true,
    rates: { [metal]: 1 / price },
    timestamp: 1700000000,
  });
}

function failGoldApiCom(metal) {
  mock.onGet(`https://api.gold-api.com/price/${metal}`).reply(500, { error: 'down' });
}

function failGoldApi(metal, currency, status = 500) {
  mock.onGet(`https://www.goldapi.io/api/${metal}/${currency}`).reply(status, {
    error: 'service down',
  });
}

function failMetalsApi(status = 500) {
  mock.onGet('https://metals-api.com/api/latest').reply(status, {
    success: false,
    error: { code: status, info: 'service down' },
  });
}

function failGoldpriceOrg() {
  mock.onGet(/goldprice\.org/).reply(500, 'error');
}

/** Fail ALL providers for a given metal/currency */
function failAll(metal, currency) {
  failGoldApiCom(metal);
  failGoldpriceOrg();
  failGoldApi(metal, currency);
  failMetalsApi();
}

/* ── Tests ───────────────────────────────────────────────── */

describe('metalsSpotPrice', () => {
  // ── 1. TTL prevents repeated calls ──
  test('TTL cache prevents repeated API calls', async () => {
    mockGoldApiCom('XAU', 2000);

    const first  = await getMetalsSpotPrice('XAU', 'USD');
    expect(first.price).toBe(2000);
    expect(first.cached).toBe(false);
    expect(first.unit).toBe('troy_ounce');

    // Reset mock — no more API calls should happen
    mock.reset();

    const second = await getMetalsSpotPrice('XAU', 'USD');
    expect(second.price).toBe(2000);
    expect(second.cached).toBe(true);
    // If an uncached request was made, axios would throw because mock is empty
  });

  // ── 2. Round-robin rotation ──
  test('round-robin rotates provider across cache misses', async () => {
    // Provider order: [0] gold-api-com, [1] goldprice-org, [2] goldapi, [3] metals-api
    // Call 1 → rotation idx 0 → gold-api-com
    mockGoldApiCom('XAU', 2000);
    const r1 = await getMetalsSpotPrice('XAU', 'USD');
    expect(r1.source).toBe('gold-api-com');

    _cache.clear(); // force miss
    _reset();

    // Call 1 → rotation idx 0 → gold-api-com
    mockGoldApiCom('XAU', 2000);
    await getMetalsSpotPrice('XAU', 'USD');

    // Call 2 → rotation idx 1 → goldprice-org
    mock.onGet(/goldprice\.org/).reply(200, {
      items: [{ xagPrice: 25 }],
    });
    const r2 = await getMetalsSpotPrice('XAG', 'USD');
    expect(r2.source).toBe('goldprice-org');
    expect(r2.price).toBe(25);

    // Confirm rotation advanced
    expect(_getRotationIdx()).toBe(2);
  });

  // ── 3. Fallback when provider A fails ──
  test('falls back to next provider when first fails', async () => {
    failGoldApiCom('XAU');
    failGoldpriceOrg();
    failGoldApi('XAU', 'USD', 503);
    mockMetalsApi('XAU', 'USD', 1950);

    const result = await getMetalsSpotPrice('XAU', 'USD');
    expect(result.price).toBe(1950);
    expect(result.source).toBe('metals-api');
  });

  // ── 4. All providers fail → hardcoded fallback for known metals ──
  test('returns hardcoded fallback when all providers fail for XAU', async () => {
    // Ensure no stale/disk cache exists from prior tests
    _reset();
    failAll('XAU', 'USD');

    const result = await getMetalsSpotPrice('XAU', 'USD');
    expect(result.source).toMatch(/fallback|disk|stale/);
    expect(result.stale).toBe(true);
    expect(typeof result.price).toBe('number');
    expect(result.price).toBeGreaterThan(0);
  });

  // ── 4b. All providers fail for unknown metal → MetalsSpotPriceError ──
  test('throws MetalsSpotPriceError when all providers fail and no fallback exists', async () => {
    // Use a metal that has no hardcoded fallback
    mock.onGet(/gold-api\.com/).reply(500, {});
    failGoldpriceOrg();
    mock.onGet(/goldapi\.io/).reply(500, {});
    failMetalsApi();

    try {
      await getMetalsSpotPrice('XRH', 'USD');  // Rhodium — no hardcoded fallback
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MetalsSpotPriceError);
      expect(err.name).toBe('MetalsSpotPriceError');
      expect(err.providersTried).toHaveLength(4);
      expect(err.metal).toBe('XRH');
      expect(err.currency).toBe('USD');
    }
  });

  // ── 4c. Stale in-memory cache used when all providers fail ──
  test('returns stale cached value when all providers fail after prior success', async () => {
    // First: successful fetch
    mockGoldApiCom('XAG', 30);
    const fresh = await getMetalsSpotPrice('XAG', 'USD');
    expect(fresh.price).toBe(30);
    expect(fresh.stale).toBeUndefined();

    // Expire the TTL cache
    _cache.clear();

    // Now fail all providers
    mock.reset();
    failAll('XAG', 'USD');

    const stale = await getMetalsSpotPrice('XAG', 'USD');
    expect(stale.price).toBe(30);
    expect(stale.stale).toBe(true);
    expect(stale.source).toMatch(/stale/);
  });

  // ── 5. getMetalsSpotPrices returns both metals ──
  test('getMetalsSpotPrices returns both XAU and XAG', async () => {
    mockGoldApiCom('XAU', 2050);
    mockGoldApiCom('XAG', 24.5);

    const result = await getMetalsSpotPrices(['XAU', 'XAG'], 'USD');

    expect(result).toHaveProperty('XAU');
    expect(result).toHaveProperty('XAG');
    expect(result.XAU.metal).toBe('XAU');
    expect(result.XAU.currency).toBe('USD');
    expect(result.XAU.unit).toBe('troy_ounce');
    expect(typeof result.XAU.price).toBe('number');
    expect(result.XAG.metal).toBe('XAG');
    expect(typeof result.XAG.price).toBe('number');
  });

  // ── 6. In-flight deduplication ──
  test('concurrent calls for same key are deduplicated', async () => {
    let callCount = 0;
    mock.onGet(/gold-api\.com/).reply(() => {
      callCount++;
      return [200, { name: 'Gold', price: 2100, symbol: 'XAU', updatedAt: '2026-01-01T00:00:00Z' }];
    });

    // Launch 3 concurrent requests for the same key
    const [r1, r2, r3] = await Promise.all([
      getMetalsSpotPrice('XAU', 'USD'),
      getMetalsSpotPrice('XAU', 'USD'),
      getMetalsSpotPrice('XAU', 'USD'),
    ]);

    // Only one real API call should have been made
    expect(callCount).toBe(1);

    // All should return valid data
    expect(r1.price).toBe(2100);
    expect(r2.price).toBe(2100);
    expect(r3.price).toBe(2100);

    // First gets cached:false, subsequent get cached:true (from in-flight dedupe)
    const cachedCount = [r1, r2, r3].filter(r => r.cached).length;
    expect(cachedCount).toBeGreaterThanOrEqual(2);
  });

  // ── Extra: MetalsSpotPriceError fields ──
  test('MetalsSpotPriceError carries correct fields', () => {
    const err = new MetalsSpotPriceError('test', {
      providersTried: ['goldapi'],
      lastStatus: 503,
      lastErrorMessage: 'timeout',
      metal: 'XAG',
      currency: 'EUR',
    });
    expect(err.name).toBe('MetalsSpotPriceError');
    expect(err.providersTried).toEqual(['goldapi']);
    expect(err.lastStatus).toBe(503);
    expect(err.lastErrorMessage).toBe('timeout');
    expect(err.metal).toBe('XAG');
    expect(err.currency).toBe('EUR');
    expect(err.message).toBe('test');
  });

  // ── Extra: default currency ──
  test('defaults to USD when no currency provided', async () => {
    mockGoldApiCom('XAU', 1999);
    const r = await getMetalsSpotPrice('XAU');
    expect(r.currency).toBe('USD');
    expect(r.price).toBe(1999);
  });
});
