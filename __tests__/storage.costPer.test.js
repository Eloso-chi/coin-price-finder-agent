/**
 * storage.costPer.test.js -- Tests for coinStorageService costPer handling
 *
 * Covers: addCoin costPer validation, updateCostPer, exportCoins/importCoins
 * round-trip with cost, and costPer edge cases (negative, NaN, string).
 *
 * Tests the server-side coinStorageService directly (no network).
 */

'use strict';

const coinStorage = require('../src/services/coinStorageService');

const USER = 'test-user-cost';

function baseCoin(overrides = {}) {
  return {
    series: 'Morgan Dollar',
    year: '1921',
    mint: 'S',
    grade: 'MS-65',
    weight: null,
    query: 'Morgan Dollar 1921',
    count: 1,
    ...overrides,
  };
}

function getCoin(userId, coin) {
  const hash = coinStorage.coinHash(coin);
  return coinStorage.getAllCoins(userId).find(c => c.coinHash === hash) || null;
}

beforeEach(() => {
  coinStorage._resetStore();
});

// ═══════════════════════════════════════════════════════════════
//  addCoin -- costPer field
// ═══════════════════════════════════════════════════════════════

describe('addCoin -- costPer validation', () => {
  test('stores valid costPer as a number', () => {
    coinStorage.addCoin(USER, baseCoin({ costPer: 42.50 }));
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBe(42.50);
  });

  test('stores costPer = 0 (free coin)', () => {
    coinStorage.addCoin(USER, baseCoin({ costPer: 0 }));
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBe(0);
  });

  test('stores costPer from string "12.99"', () => {
    coinStorage.addCoin(USER, baseCoin({ costPer: '12.99' }));
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBe(12.99);
  });

  test('null costPer when omitted', () => {
    coinStorage.addCoin(USER, baseCoin());
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('null costPer for undefined', () => {
    coinStorage.addCoin(USER, baseCoin({ costPer: undefined }));
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('null costPer for negative value', () => {
    coinStorage.addCoin(USER, baseCoin({ costPer: -5 }));
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('null costPer for NaN string', () => {
    coinStorage.addCoin(USER, baseCoin({ costPer: 'abc' }));
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  updateCostPer
// ═══════════════════════════════════════════════════════════════

describe('updateCostPer', () => {
  test('sets cost on a coin that had no cost', () => {
    const hash = coinStorage.addCoin(USER, baseCoin());
    coinStorage.updateCostPer(USER, hash, 25.00);
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBe(25.00);
  });

  test('updates existing cost to new value', () => {
    const hash = coinStorage.addCoin(USER, baseCoin({ costPer: 10 }));
    coinStorage.updateCostPer(USER, hash, 30);
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBe(30);
  });

  test('clears cost when set to null', () => {
    const hash = coinStorage.addCoin(USER, baseCoin({ costPer: 15 }));
    coinStorage.updateCostPer(USER, hash, null);
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('rejects negative cost (stores null)', () => {
    const hash = coinStorage.addCoin(USER, baseCoin({ costPer: 10 }));
    coinStorage.updateCostPer(USER, hash, -5);
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('rejects NaN string (stores null)', () => {
    const hash = coinStorage.addCoin(USER, baseCoin({ costPer: 10 }));
    coinStorage.updateCostPer(USER, hash, 'xyz');
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('accepts string number "99.50"', () => {
    const hash = coinStorage.addCoin(USER, baseCoin());
    coinStorage.updateCostPer(USER, hash, '99.50');
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBe(99.5);
  });

  test('returns false for non-existent coinHash', () => {
    expect(coinStorage.updateCostPer(USER, 'nonexistent', 10)).toBe(false);
  });

  test('preserves other coin fields after cost update', () => {
    const hash = coinStorage.addCoin(USER, baseCoin({ count: 3 }));
    coinStorage.updateCostPer(USER, hash, 50);
    const coin = getCoin(USER, baseCoin());
    expect(coin.count).toBe(3);
    expect(coin.series).toBe('Morgan Dollar');
    expect(coin.costPer).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════
//  exportCoins / importCoins -- costPer round-trip
// ═══════════════════════════════════════════════════════════════

describe('exportJSON / importJSON -- costPer', () => {
  test('export includes costPer field', () => {
    coinStorage.addCoin(USER, baseCoin({ costPer: 100 }));
    const data = coinStorage.exportCoins(USER);
    expect(data.coins[0].costPer).toBe(100);
  });

  test('export has null costPer when not set', () => {
    coinStorage.addCoin(USER, baseCoin());
    const data = coinStorage.exportCoins(USER);
    expect(data.coins[0].costPer).toBeNull();
  });

  test('import preserves costPer value', () => {
    coinStorage.addCoin(USER, baseCoin({ costPer: 75.25 }));
    const exported = coinStorage.exportCoins(USER);
    coinStorage._resetStore();
    const result = coinStorage.importCoins(USER, exported.coins);
    expect(result.imported).toBe(1);
    const coin = getCoin(USER, baseCoin());
    expect(coin.costPer).toBe(75.25);
  });

  test('import sanitizes negative costPer to null', () => {
    const coins = [{ series: 'Peace Dollar', year: '1923', mint: '', grade: 'VF-30', query: 'Peace Dollar 1923', count: 1, costPer: -10 }];
    const result = coinStorage.importCoins(USER, coins);
    expect(result.imported).toBe(1);
    const all = coinStorage.getAllCoins(USER);
    expect(all[0].costPer).toBeNull();
  });

  test('import sanitizes non-numeric costPer to null', () => {
    const coins = [{ series: 'Peace Dollar', year: '1923', mint: '', grade: '', query: 'Peace Dollar 1923', count: 1, costPer: 'bad' }];
    coinStorage.importCoins(USER, coins);
    const all = coinStorage.getAllCoins(USER);
    expect(all[0].costPer).toBeNull();
  });
});
