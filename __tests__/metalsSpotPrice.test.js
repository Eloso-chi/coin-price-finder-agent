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
} = require('../src/services/metalsSpotPrice');

const { MetalsSpotPriceError } = require('../src/services/MetalsSpotPriceError');

let mock;

beforeEach(() => {
  _reset();
  mock = new MockAdapter(axios);
  // Set both API keys so providers are "available"
  process.env.GOLDAPI_KEY = 'test-goldapi-key';
  process.env.METALS_API_KEY = 'test-metals-api-key';
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
});

/* ── Helpers ─────────────────────────────────────────────── */

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

/* ── Tests ───────────────────────────────────────────────── */

describe('metalsSpotPrice', () => {
  // ── 1. TTL prevents repeated calls ──
  test('TTL cache prevents repeated API calls', async () => {
    mockGoldApi('XAU', 'USD', 2000);

    const first  = await getMetalsSpotPrice('XAU', 'USD');
    expect(first.price).toBe(2000);
    expect(first.cached).toBe(false);
    expect(first.source).toBe('goldapi');
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
    // First call: starts at goldapi (idx 0)
    mockGoldApi('XAU', 'USD', 2000);
    const r1 = await getMetalsSpotPrice('XAU', 'USD');
    expect(r1.source).toBe('goldapi');

    // Second call for different key: should start at metals-api (idx 1)
    _cache.clear(); // force miss
    _reset();       // reset rotation so we can control it

    // Call 1 → rotation idx 0 → goldapi
    mockGoldApi('XAU', 'USD', 2000);
    await getMetalsSpotPrice('XAU', 'USD');

    // Call 2 → rotation idx 1 → metals-api
    mockMetalsApi('XAG', 'USD', 25);
    const r2 = await getMetalsSpotPrice('XAG', 'USD');
    expect(r2.source).toBe('metals-api');
    expect(r2.price).toBe(25);

    // Confirm rotation advanced
    expect(_getRotationIdx()).toBe(2);
  });

  // ── 3. Fallback when provider A fails ──
  test('falls back to next provider when first fails', async () => {
    failGoldApi('XAU', 'USD', 503);
    mockMetalsApi('XAU', 'USD', 1950);

    const result = await getMetalsSpotPrice('XAU', 'USD');
    expect(result.price).toBe(1950);
    expect(result.source).toBe('metals-api');
  });

  // ── 4. All providers fail → MetalsSpotPriceError ──
  test('throws MetalsSpotPriceError when all providers fail', async () => {
    failGoldApi('XAU', 'USD', 503);
    failMetalsApi(502);
    failGoldpriceOrg();

    try {
      await getMetalsSpotPrice('XAU', 'USD');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MetalsSpotPriceError);
      expect(err.name).toBe('MetalsSpotPriceError');
      expect(err.providersTried).toEqual(expect.arrayContaining(['goldapi', 'metals-api', 'goldprice-org']));
      expect(err.providersTried).toHaveLength(3);
      expect(err.metal).toBe('XAU');
      expect(err.currency).toBe('USD');
      expect(err.lastStatus).toBeDefined();
    }
  });

  // ── 5. getMetalsSpotPrices returns both metals ──
  test('getMetalsSpotPrices returns both XAU and XAG', async () => {
    mockGoldApi('XAU', 'USD', 2050);
    mockGoldApi('XAG', 'USD', 24.5);
    // metals-api also set up as fallback
    mockMetalsApi('XAU', 'USD', 2045);

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
    mock.onGet(/goldapi/).reply(() => {
      callCount++;
      return [200, { price: 2100, timestamp: 1700000000 }];
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
    mockGoldApi('XAU', 'USD', 1999);
    const r = await getMetalsSpotPrice('XAU');
    expect(r.currency).toBe('USD');
    expect(r.price).toBe(1999);
  });
});
