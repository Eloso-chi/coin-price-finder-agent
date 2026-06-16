// __tests__/coinStorageDualModeFailure.test.js -- dual-mode (Cosmos + file)
// persistence failure semantics for src/services/coinStorageService.js
//
// Contract under test:
//   1. addCoin() returns a hash even when the Cosmos write-through rejects.
//   2. addCoin() updates the in-memory store synchronously regardless of
//      Cosmos availability (file is the source of truth for sync reads).
//   3. Cosmos rejections never bubble up to the caller (fire-and-forget).
//   4. removeCoin / updateCount / updateCostPer / bulkDelete tolerate Cosmos
//      rejection without raising.
//   5. importCoins de-duplicates by hash and assigns "lot N" notes for
//      collisions, never throwing on a Cosmos write failure.
//
// Strategy: mock cosmosClient as enabled but with rejecting promises; assert
// the file/in-memory contract holds and no unhandled rejections occur.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Per-suite cache dir so the test does not collide with the dev cache.
const TMP_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'coinstore-dual-'));

jest.mock('../src/utils/cachePath', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const os2 = require('os');
  // Reuse one dir per process so the module-level singleton is stable.
  if (!global.__COIN_STORE_DUAL_DIR) {
    global.__COIN_STORE_DUAL_DIR = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'coinstore-dual-cache-'));
  }
  return { CACHE_DIR: global.__COIN_STORE_DUAL_DIR };
});

// Build a configurable cosmos mock we can re-arm per test.
const cosmosState = {
  enabled: true,
  upsertImpl: () => Promise.reject(new Error('Cosmos 429 Throttled')),
  deleteImpl: () => Promise.reject(new Error('Cosmos 503 Unavailable')),
  readImpl: () => Promise.reject(Object.assign(new Error('not found'), { code: 404 })),
  queryImpl: () => Promise.resolve({ resources: [] }),
};

jest.mock('../src/utils/cosmosClient', () => {
  return {
    isEnabled: () => cosmosState.enabled,
    container: jest.fn(() => ({
      items: {
        upsert: (...args) => cosmosState.upsertImpl(...args),
        query: () => ({ fetchAll: () => cosmosState.queryImpl() }),
      },
      item: () => ({
        delete: () => cosmosState.deleteImpl(),
        read: () => cosmosState.readImpl(),
        replace: () => Promise.resolve(),
      }),
    })),
  };
});

const coinStorage = require('../src/services/coinStorageService');

beforeEach(() => {
  cosmosState.enabled = true;
  cosmosState.upsertImpl = () => Promise.reject(new Error('Cosmos 429 Throttled'));
  cosmosState.deleteImpl = () => Promise.reject(new Error('Cosmos 503 Unavailable'));
  cosmosState.readImpl = () => Promise.reject(Object.assign(new Error('not found'), { code: 404 }));
  coinStorage._resetStore();
});

afterAll(() => {
  try { fs.rmSync(TMP_CACHE, { recursive: true, force: true }); } catch { /* ignore */ }
  if (global.__COIN_STORE_DUAL_DIR) {
    try { fs.rmSync(global.__COIN_STORE_DUAL_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('coinStorageService -- Cosmos failure tolerance', () => {
  test('addCoin returns a hash when Cosmos upsert rejects', () => {
    const hash = coinStorage.addCoin('user-A', {
      series: 'Morgan Dollar', year: 1881, mint: 'S', grade: 'MS63',
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(coinStorage.getAllCoins('user-A')).toHaveLength(1);
  });

  test('addCoin updates in-memory store synchronously even when Cosmos rejects', () => {
    coinStorage.addCoin('user-B', {
      series: 'Peace Dollar', year: 1923, mint: 'P', grade: 'AU58',
    });
    // Immediate read must reflect the write -- proves the file path runs
    // synchronously and is independent of the fire-and-forget Cosmos write.
    expect(coinStorage.count('user-B')).toBe(1);
  });

  test('removeCoin succeeds against the file store even when Cosmos delete rejects', () => {
    const hash = coinStorage.addCoin('user-C', {
      series: 'Walking Liberty', year: 1944, mint: 'D', grade: 'MS65',
    });
    const removed = coinStorage.removeCoin('user-C', hash);
    expect(removed).toBe(true);
    expect(coinStorage.count('user-C')).toBe(0);
  });

  test('updateCount mutates the file store regardless of Cosmos read failure', () => {
    const hash = coinStorage.addCoin('user-D', {
      series: 'Buffalo Nickel', year: 1937, mint: 'D', grade: 'AU55',
    });
    const ok = coinStorage.updateCount('user-D', hash, 5);
    expect(ok).toBe(true);
    expect(coinStorage.getAllCoins('user-D')[0].count).toBe(5);
  });

  test('updateCostPer mutates the file store regardless of Cosmos read failure', () => {
    const hash = coinStorage.addCoin('user-E', {
      series: 'Standing Liberty Quarter', year: 1925, mint: 'P', grade: 'VF30',
    });
    const ok = coinStorage.updateCostPer('user-E', hash, 87.50);
    expect(ok).toBe(true);
    expect(coinStorage.getAllCoins('user-E')[0].costPer).toBe(87.50);
  });

  test('bulkDelete succeeds against the file store when every Cosmos delete rejects', () => {
    const h1 = coinStorage.addCoin('user-F', { series: 'A', year: 1900, mint: 'P', grade: 'F' });
    const h2 = coinStorage.addCoin('user-F', { series: 'B', year: 1901, mint: 'P', grade: 'F' });
    const h3 = coinStorage.addCoin('user-F', { series: 'C', year: 1902, mint: 'P', grade: 'F' });
    const deleted = coinStorage.bulkDelete('user-F', [h1, h2, h3]);
    expect(deleted).toBe(3);
    expect(coinStorage.count('user-F')).toBe(0);
  });

  test('addCoin does not propagate Cosmos rejection as an unhandled promise', async () => {
    let unhandled = null;
    const handler = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', handler);
    try {
      coinStorage.addCoin('user-G', { series: 'X', year: 1909, mint: 'S VDB', grade: 'G' });
      // Flush microtasks so the rejected upsert promise has a chance to settle.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  test('addCoin still writes when Cosmos is disabled (degraded mode)', () => {
    cosmosState.enabled = false;
    coinStorage.addCoin('user-H', { series: 'Mercury Dime', year: 1942, mint: 'D', grade: 'AU' });
    expect(coinStorage.count('user-H')).toBe(1);
  });

  test('importCoins de-duplicates by hash with lot suffix even under Cosmos failure', () => {
    const base = { series: 'Liberty Head Nickel', year: 1900, mint: 'P', grade: 'F' };
    const result = coinStorage.importCoins('user-I', [base, { ...base }, { ...base }]);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    const coins = coinStorage.getAllCoins('user-I');
    expect(coins).toHaveLength(3);
    // The 2nd and 3rd should have differentiated notes containing "lot"
    const lotted = coins.filter(c => c.notes && /lot \d+/.test(c.notes));
    expect(lotted).toHaveLength(2);
  });

  test('concurrent addCoin calls all land in the in-memory store', () => {
    const hashes = [];
    for (let i = 0; i < 25; i++) {
      hashes.push(coinStorage.addCoin('user-J', {
        series: 'Concurrent', year: 1900 + i, mint: 'P', grade: 'MS65',
      }));
    }
    expect(new Set(hashes).size).toBe(25);
    expect(coinStorage.count('user-J')).toBe(25);
  });

  test('exportCoins returns a stable backup envelope even when Cosmos failed during writes', () => {
    coinStorage.addCoin('user-K', { series: 'A', year: 1900, mint: 'P', grade: 'F' });
    coinStorage.addCoin('user-K', { series: 'B', year: 1901, mint: 'P', grade: 'F' });
    const bak = coinStorage.exportCoins('user-K');
    expect(bak).toEqual(expect.objectContaining({
      format: 'coin-price-agent-backup-v1',
      count: 2,
      coins: expect.any(Array),
    }));
    expect(bak.coins).toHaveLength(2);
  });
});
