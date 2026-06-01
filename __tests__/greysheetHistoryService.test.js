/**
 * greysheetHistoryService.test.js — Unit tests for daily Greysheet price snapshots
 *
 * Covers: makeKey, recordSnapshot (first-write-per-day semantics),
 * getHistory (range filtering, sort), getLatest, evictOld, coinCount,
 * getLastRefreshDate/setLastRefreshDate.
 *
 * Strategy: We isolate by using unique keys per test (no shared state conflicts).
 * The internal _store is populated via the service's own exported functions.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// We must use require('os').tmpdir() inside the factory (no out-of-scope refs)
jest.mock('../src/utils/cachePath', () => ({
  CACHE_DIR: require('os').tmpdir()
}));
jest.mock('../src/utils/cosmosClient', () => ({
  isEnabled: () => false,
  container: () => ({ items: { upsert: jest.fn() } }),
}));

const {
  makeKey,
  recordSnapshot,
  getHistory,
  getLatest,
  evictOld,
  getLastRefreshDate,
  setLastRefreshDate,
  coinCount,
  _loadStore,
} = require('../src/services/greysheetHistoryService');

// ═══════════════════════════════════════════════════════════════
//  makeKey
// ═══════════════════════════════════════════════════════════════

describe('makeKey', () => {
  test('formats id:grade', () => {
    expect(makeKey(7130, 63)).toBe('7130:63');
    expect(makeKey('72469', 65)).toBe('72469:65');
  });

  test('null grade becomes "all"', () => {
    expect(makeKey(7130, null)).toBe('7130:all');
    expect(makeKey(7130, 0)).toBe('7130:all');
  });
});

// ═══════════════════════════════════════════════════════════════
//  recordSnapshot
// ═══════════════════════════════════════════════════════════════

describe('recordSnapshot', () => {
  test('records a snapshot on first call', () => {
    const key = makeKey(`first-${Date.now()}`, 63);
    const result = recordSnapshot(key, 150.50, 180.25);
    expect(result).toBe(true);
  });

  test('second call same day returns false (no overwrite)', () => {
    const key = makeKey(`dup-${Date.now()}`, 65);
    recordSnapshot(key, 100, 120);
    const result = recordSnapshot(key, 200, 250);
    expect(result).toBe(false);
  });

  test('skips if no key', () => {
    expect(recordSnapshot(null, 100, 120)).toBeUndefined();
    expect(recordSnapshot('', 100, 120)).toBeUndefined();
  });

  test('skips if both values null', () => {
    expect(recordSnapshot(`skip-${Date.now()}:63`, null, null)).toBeUndefined();
  });

  test('records with only wholesale (cpg null)', () => {
    const key = makeKey(`ws-only-${Date.now()}`, 64);
    const result = recordSnapshot(key, 99.99, null);
    expect(result).toBe(true);
    const latest = getLatest(key);
    expect(latest.wholesale).toBe(99.99);
    expect(latest.retail).toBeNull();
  });

  test('rounds values to 2 decimal places', () => {
    const key = makeKey(`round-${Date.now()}`, 70);
    recordSnapshot(key, 123.456789, 200.999);
    const latest = getLatest(key);
    expect(latest.wholesale).toBe(123.46);
    expect(latest.retail).toBe(201);
  });
});

// ═══════════════════════════════════════════════════════════════
//  getHistory
// ═══════════════════════════════════════════════════════════════

describe('getHistory', () => {
  test('returns empty for unknown key', () => {
    const result = getHistory('nonexistent:63', 90);
    expect(result).toEqual({ wholesale: [], retail: [] });
  });

  test('returns sorted entries within range', () => {
    // Pin "now" so the 30-day window is deterministic regardless of when
    // CI runs. Real timers are restored at the end so other tests that rely
    // on Date.now() for unique keys continue to work.
    jest.useFakeTimers({ now: new Date('2026-05-05T00:00:00Z') });
    try {
      // Seed the store directly via _loadStore
      const store = _loadStore();
      const key = 'hist-test:63';
      store[key] = {
        '2026-05-01': { w: 100, r: 120 },
        '2026-05-03': { w: 105, r: 125 },
        '2026-05-02': { w: 102, r: 122 },
        '2025-01-01': { w: 50, r: 60 }, // old — should be excluded for short range
      };

      const result = getHistory(key, 30);
      // Only recent entries (within 30 days of pinned now = May 5 2026)
      expect(result.wholesale.length).toBeGreaterThanOrEqual(3);
      // Verify sorted
      for (let i = 1; i < result.wholesale.length; i++) {
        expect(result.wholesale[i][0] >= result.wholesale[i - 1][0]).toBe(true);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test('filters entries older than rangeDays', () => {
    const store = _loadStore();
    const key = 'old-test:64';
    store[key] = {
      '2020-01-01': { w: 10, r: 15 },
      '2020-06-01': { w: 20, r: 25 },
    };
    const result = getHistory(key, 90);
    expect(result.wholesale).toHaveLength(0);
    expect(result.retail).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  getLatest
// ═══════════════════════════════════════════════════════════════

describe('getLatest', () => {
  test('returns null for unknown key', () => {
    expect(getLatest('nope:all')).toBeNull();
  });

  test('returns most recent entry', () => {
    const store = _loadStore();
    const key = 'latest-test:65';
    store[key] = {
      '2026-04-01': { w: 80, r: 95 },
      '2026-05-01': { w: 90, r: 110 },
      '2026-03-15': { w: 75, r: 88 },
    };
    const result = getLatest(key);
    expect(result.date).toBe('2026-05-01');
    expect(result.wholesale).toBe(90);
    expect(result.retail).toBe(110);
  });

  test('handles missing w or r fields', () => {
    const store = _loadStore();
    const key = 'partial-test:66';
    store[key] = {
      '2026-05-01': { w: 50 }, // no retail
    };
    const result = getLatest(key);
    expect(result.wholesale).toBe(50);
    expect(result.retail).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  evictOld
// ═══════════════════════════════════════════════════════════════

describe('evictOld', () => {
  test('removes entries older than maxDays', () => {
    // Pin "now" so the 30-day cutoff is deterministic; 2026-05-01 must stay recent.
    jest.useFakeTimers({ now: new Date('2026-05-05T00:00:00Z') });
    try {
      const store = _loadStore();
      store['evict-test:63'] = {
        '2020-01-01': { w: 10, r: 12 },
        '2020-06-01': { w: 20, r: 22 },
        '2026-05-01': { w: 100, r: 120 },
      };
      const evicted = evictOld(30);
      expect(evicted).toBeGreaterThanOrEqual(2);
      // Recent entry should survive
      expect(store['evict-test:63']['2026-05-01']).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('returns 0 when nothing to evict', () => {
    jest.useFakeTimers({ now: new Date('2026-05-05T00:00:00Z') });
    try {
      const store = _loadStore();
      store['fresh:63'] = {
        '2026-05-04': { w: 100, r: 120 },
      };
      expect(evictOld(30)).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('removes empty coin keys after eviction', () => {
    const store = _loadStore();
    store['all-old:70'] = {
      '2020-01-01': { w: 5, r: 6 },
    };
    evictOld(30);
    expect(store['all-old:70']).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
//  coinCount
// ═══════════════════════════════════════════════════════════════

describe('coinCount', () => {
  test('counts keys excluding _lastRefresh', () => {
    const store = _loadStore();
    // Count before adding
    const before = coinCount();
    // Add two unique keys
    store[`count-a-${Date.now()}:63`] = { '2026-05-01': { w: 1 } };
    store[`count-b-${Date.now()}:64`] = { '2026-05-01': { w: 2 } };
    store._lastRefresh = '2026-05-01';
    expect(coinCount()).toBe(before + 2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  getLastRefreshDate / setLastRefreshDate
// ═══════════════════════════════════════════════════════════════

describe('refresh date tracking', () => {
  test('returns null when no refresh recorded', () => {
    const store = _loadStore();
    delete store._lastRefresh;
    expect(getLastRefreshDate()).toBeNull();
  });

  test('setLastRefreshDate stores and retrieves', () => {
    setLastRefreshDate('2026-04-20');
    expect(getLastRefreshDate()).toBe('2026-04-20');
  });

  test('defaults to today when no date arg', () => {
    setLastRefreshDate();
    const today = new Date().toISOString().substring(0, 10);
    expect(getLastRefreshDate()).toBe(today);
  });
});
