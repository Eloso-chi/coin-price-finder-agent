// __tests__/metalsHistoryConcurrency.test.js -- concurrency + Cosmos
// write-through failure semantics for src/services/metalsHistoryService.js
//
// Contract under test:
//   1. recordDaily is idempotent within a calendar day (first write wins).
//   2. Concurrent recordDaily calls for the same metal+day collapse to one entry.
//   3. Concurrent recordDaily for different metals on the same day all record.
//   4. A rejected Cosmos write-through never throws to the caller and never
//      surfaces as an unhandled rejection.
//   5. evictOld + concurrent recordDaily do not race the in-memory store
//      into an inconsistent shape.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

jest.mock('../src/utils/cachePath', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const os2 = require('os');
  if (!global.__METALS_HIST_DIR) {
    global.__METALS_HIST_DIR = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'metals-conc-'));
  }
  return { CACHE_DIR: global.__METALS_HIST_DIR };
});

const cosmosState = {
  enabled: true,
  upsertImpl: () => Promise.reject(new Error('Cosmos 429')),
};

jest.mock('../src/utils/cosmosClient', () => ({
  isEnabled: () => cosmosState.enabled,
  container: jest.fn(() => ({
    items: { upsert: (...args) => cosmosState.upsertImpl(...args) },
  })),
}));

const metalsHistory = require('../src/services/metalsHistoryService');

beforeEach(() => {
  cosmosState.enabled = true;
  cosmosState.upsertImpl = () => Promise.reject(new Error('Cosmos 429'));
});

afterAll(() => {
  if (global.__METALS_HIST_DIR) {
    try { fs.rmSync(global.__METALS_HIST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function uniqMetal(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe('metalsHistoryService -- concurrency + idempotency', () => {
  test('recordDaily is idempotent within the same calendar day', () => {
    const metal = uniqMetal('IDEMP');
    metalsHistory.recordDaily(metal, 100.00);
    metalsHistory.recordDaily(metal, 999.99);
    metalsHistory.recordDaily(metal, 42.42);
    const hist = metalsHistory.getHistory(metal, 1);
    expect(hist).toHaveLength(1);
    expect(hist[0][1]).toBe(100.00);
  });

  test('many concurrent recordDaily calls for same metal+day collapse to one entry', () => {
    const metal = uniqMetal('BURST');
    // Fire 100 writes in a tight loop (synchronous-style concurrency).
    for (let i = 0; i < 100; i++) {
      metalsHistory.recordDaily(metal, 1000 + i);
    }
    const hist = metalsHistory.getHistory(metal, 1);
    expect(hist).toHaveLength(1);
    // First writer wins -> price is the initial value 1000.
    expect(hist[0][1]).toBe(1000);
  });

  test('concurrent recordDaily for different metals on same day all record', () => {
    const metals = [
      uniqMetal('M1'), uniqMetal('M2'), uniqMetal('M3'),
      uniqMetal('M4'), uniqMetal('M5'),
    ];
    metals.forEach((m, i) => metalsHistory.recordDaily(m, 200 + i));
    metals.forEach((m, i) => {
      const hist = metalsHistory.getHistory(m, 1);
      expect(hist).toHaveLength(1);
      expect(hist[0][1]).toBe(200 + i);
    });
  });

  test('Cosmos write-through rejection does not throw to caller', () => {
    const metal = uniqMetal('COSMOS_FAIL');
    expect(() => metalsHistory.recordDaily(metal, 1500)).not.toThrow();
    const hist = metalsHistory.getHistory(metal, 1);
    expect(hist[0][1]).toBe(1500);
  });

  test('Cosmos write-through rejection does not surface as unhandled rejection', async () => {
    let unhandled = null;
    const handler = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', handler);
    try {
      for (let i = 0; i < 10; i++) {
        metalsHistory.recordDaily(uniqMetal('UNHANDLED'), 800 + i);
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toBeNull();
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  test('recordDaily continues to work after Cosmos is toggled disabled', () => {
    const metal = uniqMetal('TOGGLE_OFF');
    cosmosState.enabled = false;
    metalsHistory.recordDaily(metal, 555);
    const hist = metalsHistory.getHistory(metal, 1);
    expect(hist).toHaveLength(1);
    expect(hist[0][1]).toBe(555);
  });

  test('evictOld interleaved with recordDaily keeps the store consistent', () => {
    const metal = uniqMetal('EVICT_RACE');
    // Seed an old entry that should be evicted
    metalsHistory.recordDaily(metal, 1, '2020-01-01T00:00:00Z');
    // Today writes
    metalsHistory.recordDaily(metal, 99);
    // Evict ancient data
    const evicted = metalsHistory.evictOld(30);
    expect(evicted).toBeGreaterThanOrEqual(1);
    // After eviction, today entry must still be readable
    const hist = metalsHistory.getHistory(metal, 1);
    expect(hist).toHaveLength(1);
    expect(hist[0][1]).toBe(99);
  });

  test('recordDaily across many distinct days for one metal all retain', () => {
    const metal = uniqMetal('MULTI_DAY');
    // Use offsets in days
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const d = new Date(Date.now() - dayOffset * 24 * 60 * 60 * 1000);
      metalsHistory.recordDaily(metal, 100 + dayOffset, d.toISOString());
    }
    const hist = metalsHistory.getHistory(metal, 8);
    expect(hist).toHaveLength(7);
    // Sorted ascending by date
    const sorted = [...hist].sort((a, b) => a[0].localeCompare(b[0]));
    expect(hist).toEqual(sorted);
  });

  test('recordDaily ignores invalid prices but still allows valid follow-ups', () => {
    const metal = uniqMetal('INVALID_FIRST');
    metalsHistory.recordDaily(metal, NaN);
    metalsHistory.recordDaily(metal, null);
    metalsHistory.recordDaily(metal, undefined);
    expect(metalsHistory.getHistory(metal, 1)).toHaveLength(0);
    // Valid call after invalid ones still records (since first valid one wins for that day)
    metalsHistory.recordDaily(metal, 777);
    expect(metalsHistory.getHistory(metal, 1)[0][1]).toBe(777);
  });
});
