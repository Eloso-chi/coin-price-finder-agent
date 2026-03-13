/**
 * storage.costPer.test.js — Tests for CoinStorage costPer field handling
 *
 * Covers: addCoin costPer validation, updateCostPer, exportJSON/importJSON
 * round-trip with cost, and costPer edge cases (negative, NaN, string).
 *
 * Uses fake-indexeddb to provide IDB in Node + a passthrough CoinCrypto stub
 * (no real encryption — tests focus on data logic, not crypto).
 */

'use strict';

require('fake-indexeddb/auto');
const { TextEncoder, TextDecoder } = require('util');

// ── Stub CoinCrypto (passthrough, no real encryption) ───────
const CoinCrypto = {
  async coinHash(coin) {
    const key = [coin.series, coin.year, coin.mint, coin.grade].join('|');
    // Simple hash: use a hex-encoded string
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return 'h' + Math.abs(h).toString(16);
  },
  async encrypt(_key, plaintext) {
    // Store plaintext as-is (base64-encoded to mimic ciphertext)
    const encoded = Buffer.from(plaintext).toString('base64');
    return { iv: 'fake-iv', ciphertext: encoded };
  },
  async decrypt(_key, _iv, ciphertext) {
    return Buffer.from(ciphertext, 'base64').toString('utf8');
  },
};

// ── Load CoinStorage by evaluating the IIFE with globals ────
const fs = require('fs');
const path = require('path');

let CoinStorage;

beforeEach(() => {
  // Reset IDB between tests by clearing the cached _db handle
  // We re-evaluate the module each time for a clean slate
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'storage.js'),
    'utf8'
  );

  // Provide globals that storage.js depends on
  const fn = new Function('indexedDB', 'CoinCrypto', `
    ${src}
    return CoinStorage;
  `);

  CoinStorage = fn(indexedDB, CoinCrypto);
});

const USER = 'test-user';
const KEY = 'fake-key';

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

// ═══════════════════════════════════════════════════════════════
//  addCoin — costPer field
// ═══════════════════════════════════════════════════════════════

describe('addCoin — costPer validation', () => {
  test('stores valid costPer as a number', async () => {
    await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: 42.50 }));
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBe(42.50);
  });

  test('stores costPer = 0 (free coin)', async () => {
    await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: 0 }));
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBe(0);
  });

  test('stores costPer from string "12.99"', async () => {
    await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: '12.99' }));
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBe(12.99);
  });

  test('null costPer when omitted', async () => {
    await CoinStorage.addCoin(USER, KEY, baseCoin());
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('null costPer for undefined', async () => {
    await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: undefined }));
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('null costPer for negative value', async () => {
    await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: -5 }));
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('null costPer for NaN string', async () => {
    await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: 'abc' }));
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  updateCostPer
// ═══════════════════════════════════════════════════════════════

describe('updateCostPer', () => {
  test('sets cost on a coin that had no cost', async () => {
    const hash = await CoinStorage.addCoin(USER, KEY, baseCoin());
    await CoinStorage.updateCostPer(USER, KEY, hash, 25.00);
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBe(25.00);
  });

  test('updates existing cost to new value', async () => {
    const hash = await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: 10 }));
    await CoinStorage.updateCostPer(USER, KEY, hash, 30);
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBe(30);
  });

  test('clears cost when set to null', async () => {
    const hash = await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: 15 }));
    await CoinStorage.updateCostPer(USER, KEY, hash, null);
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('rejects negative cost (stores null)', async () => {
    const hash = await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: 10 }));
    await CoinStorage.updateCostPer(USER, KEY, hash, -5);
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('rejects NaN string (stores null)', async () => {
    const hash = await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: 10 }));
    await CoinStorage.updateCostPer(USER, KEY, hash, 'xyz');
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBeNull();
  });

  test('accepts string number "99.50"', async () => {
    const hash = await CoinStorage.addCoin(USER, KEY, baseCoin());
    await CoinStorage.updateCostPer(USER, KEY, hash, '99.50');
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBe(99.5);
  });

  test('rejects non-existent coinHash', async () => {
    await expect(
      CoinStorage.updateCostPer(USER, KEY, 'nonexistent', 10)
    ).rejects.toThrow('Coin not found');
  });

  test('preserves other coin fields after cost update', async () => {
    const hash = await CoinStorage.addCoin(USER, KEY, baseCoin({ count: 3 }));
    await CoinStorage.updateCostPer(USER, KEY, hash, 50);
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.count).toBe(3);
    expect(coin.series).toBe('Morgan Dollar');
    expect(coin.costPer).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════
//  exportJSON / importJSON — costPer round-trip
// ═══════════════════════════════════════════════════════════════

describe('exportJSON / importJSON — costPer', () => {
  test('export includes costPer field', async () => {
    await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: 100 }));
    const json = await CoinStorage.exportJSON(USER, KEY);
    const data = JSON.parse(json);
    expect(data.coins[0].costPer).toBe(100);
  });

  test('export has null costPer when not set', async () => {
    await CoinStorage.addCoin(USER, KEY, baseCoin());
    const json = await CoinStorage.exportJSON(USER, KEY);
    const data = JSON.parse(json);
    expect(data.coins[0].costPer).toBeNull();
  });

  test('import preserves costPer value', async () => {
    // Add a coin, export, clear, import, verify costPer survives
    await CoinStorage.addCoin(USER, KEY, baseCoin({ costPer: 75.25 }));
    const json = await CoinStorage.exportJSON(USER, KEY);
    await CoinStorage.clearAll(USER);
    const result = await CoinStorage.importJSON(USER, KEY, json);
    expect(result.imported).toBe(1);
    const coin = await CoinStorage.getCoin(USER, KEY, baseCoin());
    expect(coin.costPer).toBe(75.25);
  });

  test('import sanitizes negative costPer to null', async () => {
    const backup = JSON.stringify({
      format: 'coin-price-agent-backup-v1',
      exportedAt: new Date().toISOString(),
      count: 1,
      coins: [{ series: 'Peace Dollar', year: '1923', mint: '', grade: 'VF-30', query: 'Peace Dollar 1923', count: 1, costPer: -10 }],
    });
    const result = await CoinStorage.importJSON(USER, KEY, backup);
    expect(result.imported).toBe(1);
    const coins = await CoinStorage.getAllDecrypted(USER, KEY);
    expect(coins[0].costPer).toBeNull();
  });

  test('import sanitizes non-numeric costPer to null', async () => {
    const backup = JSON.stringify({
      format: 'coin-price-agent-backup-v1',
      exportedAt: new Date().toISOString(),
      count: 1,
      coins: [{ series: 'Peace Dollar', year: '1923', mint: '', grade: '', query: 'Peace Dollar 1923', count: 1, costPer: 'bad' }],
    });
    await CoinStorage.importJSON(USER, KEY, backup);
    const coins = await CoinStorage.getAllDecrypted(USER, KEY);
    expect(coins[0].costPer).toBeNull();
  });
});
