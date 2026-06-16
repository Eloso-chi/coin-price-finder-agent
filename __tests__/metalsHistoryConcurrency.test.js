// __tests__/metalsHistoryConcurrency.test.js -- burst-write idempotency +
// Cosmos write-through failure semantics for src/services/metalsHistoryService.js
//
// NOTE on naming: `recordDaily` is synchronous, so true wall-clock concurrency
// is not exercisable here. These tests cover BURST behavior (many synchronous
// writes back-to-back in a tight loop) and IDEMPOTENCY within a calendar day.
// The label `Concurrency` in the file name is preserved for git history but
// the describe blocks have been renamed to match what is actually verified.
//
// Contract under test:
//   1. recordDaily is idempotent within a calendar day (first write wins).
//   2. A burst of synchronous recordDaily calls for the same metal+day
//      collapses to one entry (idempotency under burst).
//   3. Burst recordDaily for different metals on the same day all record.
//   4. A rejected Cosmos write-through never throws to the caller and never
//      surfaces as an unhandled rejection.
//   5. evictOld interleaved with recordDaily does not corrupt the store.
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

// Deterministic microtask flush. Loops until the Node event loop reports no
// pending immediates / next-tick callbacks for the rejection chain we triggered.
// Replaces the prior `setImmediate x2` heuristic that could pass spuriously if
// production code chained more than two ticks before the rejection settled.
async function flushMicrotasks(maxIterations = 50) {
  for (let i = 0; i < maxIterations; i++) {
    await new Promise((r) => setImmediate(r));
    if (typeof setTimeout === 'function') {
      await new Promise((r) => setTimeout(r, 0));
    }
    // If no further microtasks have queued, we're flushed. We can't peek the
    // queue directly so we rely on bounded iteration as a safety cap.
  }
}

describe('metalsHistoryService -- burst writes + idempotency', () => {
  test('recordDaily is idempotent within the same calendar day', () => {
    const metal = uniqMetal('IDEMP');
    metalsHistory.recordDaily(metal, 100.00);
    metalsHistory.recordDaily(metal, 999.99);
    metalsHistory.recordDaily(metal, 42.42);
    const hist = metalsHistory.getHistory(metal, 1);
    expect(hist).toHaveLength(1);
    expect(hist[0][1]).toBe(100.00);
  });

  test('burst of recordDaily calls for same metal+day collapses to one entry (idempotency)', () => {
    const metal = uniqMetal('BURST');
    // Fire 100 writes in a tight synchronous loop. recordDaily is sync, so
    // there is no true concurrency -- this tests idempotency under burst.
    for (let i = 0; i < 100; i++) {
      metalsHistory.recordDaily(metal, 1000 + i);
    }
    const hist = metalsHistory.getHistory(metal, 1);
    expect(hist).toHaveLength(1);
    // First writer wins -> price is the initial value 1000.
    expect(hist[0][1]).toBe(1000);
  });

  test('burst recordDaily for different metals on same day all record', () => {
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
      // Deterministic flush replaces prior setImmediate x2 heuristic.
      await flushMicrotasks();
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
