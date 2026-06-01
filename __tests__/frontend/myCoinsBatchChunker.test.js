/**
 * @jest-environment jsdom
 *
 * myCoinsBatchChunker.test.js — BACKLOG #21 / #238
 *
 * Verifies that MyCoins._fetchPricing chunks the coin list into
 * batches of MAX_BATCH (25) when calling POST /api/pricing-batch.
 */

'use strict';

// Stub the index.html-provided globals that my-coins.js references at call time.
global.CoinAuth = { currentUser: () => ({ userId: 'u1', key: 'k1' }) };
global.CoinStorage = {
  getAllDecrypted: jest.fn(),
  removeCoin: jest.fn(),
  updateCount: jest.fn(),
  updateCostPer: jest.fn(),
};
global._esc = (s) => String(s == null ? '' : s);
global._escAttr = (s) => String(s == null ? '' : s);

const MyCoins = require('../../public/js/my-coins');

describe('MyCoins._fetchPricing chunking (#21)', () => {
  let fetchCalls;

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = jest.fn((url, opts) => {
      fetchCalls.push({ url, body: JSON.parse(opts.body) });
      const items = JSON.parse(opts.body).items;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: items.map(() => ({ fmv: 1 })) }),
      });
    });
    MyCoins.__testing._setContainer(document.createElement('div'));
  });

  test('exposes MAX_BATCH = 25 (the documented contract)', () => {
    expect(MyCoins.__testing.MAX_BATCH).toBe(25);
  });

  test('a single coin produces exactly one /api/pricing-batch call of size 1', async () => {
    const coins = [{ coinHash: 'h0', series: 'Morgan', year: 1881 }];
    const results = await MyCoins.__testing._fetchPricing(coins);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('/api/pricing-batch');
    expect(fetchCalls[0].body.items).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].coin.coinHash).toBe('h0');
  });

  test('25 coins (boundary) → 1 batch call of size 25', async () => {
    const coins = Array.from({ length: 25 }, (_, i) => ({ coinHash: `h${i}` }));
    await MyCoins.__testing._fetchPricing(coins);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.items).toHaveLength(25);
  });

  test('26 coins → 2 batch calls of [25, 1]', async () => {
    const coins = Array.from({ length: 26 }, (_, i) => ({ coinHash: `h${i}` }));
    await MyCoins.__testing._fetchPricing(coins);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].body.items).toHaveLength(25);
    expect(fetchCalls[1].body.items).toHaveLength(1);
  });

  test('53 coins → 3 batch calls of [25, 25, 3] in order', async () => {
    const coins = Array.from({ length: 53 }, (_, i) => ({ coinHash: `h${i}` }));
    const results = await MyCoins.__testing._fetchPricing(coins);
    expect(fetchCalls.map((c) => c.body.items.length)).toEqual([25, 25, 3]);
    // Each result row carries the original coin reference in order.
    expect(results.map((r) => r.coin.coinHash)).toEqual(coins.map((c) => c.coinHash));
  });

  test('non-OK responses mark every coin in the chunk as a pricingError', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 503 }));
    const coins = Array.from({ length: 3 }, (_, i) => ({ coinHash: `h${i}` }));
    const results = await MyCoins.__testing._fetchPricing(coins);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.pricingError).toMatch(/503/);
      expect(r.fmv).toBeNull();
    }
  });

  test('network exceptions are surfaced as pricingError per coin (no throw)', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('boom')));
    const coins = [{ coinHash: 'h0' }, { coinHash: 'h1' }];
    const results = await MyCoins.__testing._fetchPricing(coins);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.pricingError === 'boom')).toBe(true);
  });
});
