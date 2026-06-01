/**
 * @jest-environment jsdom
 *
 * myCoinsSpotCache.test.js — BACKLOG #23 / #238
 *
 * Verifies that MyCoins._fetchSpotPrices respects the SPOT_CACHE_TTL
 * (5 minutes) — back-to-back calls do not hit /api/metals twice.
 */

'use strict';

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

describe('MyCoins._fetchSpotPrices cache (#23)', () => {
  beforeEach(() => {
    MyCoins.__testing._resetSpotCache();
  });

  test('SPOT_CACHE_TTL is 5 minutes (the documented contract)', () => {
    expect(MyCoins.__testing.SPOT_CACHE_TTL).toBe(5 * 60 * 1000);
  });

  test('first call hits both /api/metals/XAG and /api/metals/XAU', async () => {
    const calls = [];
    global.fetch = jest.fn((url) => {
      calls.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: url.endsWith('XAG') ? 30 : 2000 }) });
    });

    const prices = await MyCoins.__testing._fetchSpotPrices();
    expect(calls).toEqual(expect.arrayContaining(['/api/metals/XAG', '/api/metals/XAU']));
    expect(calls).toHaveLength(2);
    expect(prices).toEqual({ silver: 30, gold: 2000 });
  });

  test('second call within TTL reuses cache (no additional fetch)', async () => {
    let callCount = 0;
    global.fetch = jest.fn((url) => {
      callCount++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ price: url.endsWith('XAG') ? 30 : 2000 }) });
    });

    await MyCoins.__testing._fetchSpotPrices();
    expect(callCount).toBe(2);

    const prices2 = await MyCoins.__testing._fetchSpotPrices();
    expect(callCount).toBe(2); // unchanged — second call cached
    expect(prices2).toEqual({ silver: 30, gold: 2000 });
  });

  test('non-numeric price from server stores null (not NaN)', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ price: 'oops' }) })
    );
    const prices = await MyCoins.__testing._fetchSpotPrices();
    expect(prices.silver).toBeNull();
    expect(prices.gold).toBeNull();
  });

  test('fetch rejection falls back gracefully (no throw, returns shape)', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('offline')));
    const prices = await MyCoins.__testing._fetchSpotPrices();
    expect(prices).toEqual({ silver: null, gold: null });
  });
});
