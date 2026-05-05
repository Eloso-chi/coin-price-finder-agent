/**
 * metalsHistoryService.test.js — Unit tests for daily metals spot price history
 *
 * Covers: recordDaily (first-write-per-day), getHistory (range + sort),
 * evictOld, METAL_SYMBOLS constant.
 *
 * Strategy: Unique metal names per test to avoid shared in-memory state issues.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

jest.mock('../src/utils/cachePath', () => ({
  CACHE_DIR: require('os').tmpdir()
}));
jest.mock('../src/utils/cosmosClient', () => ({
  isEnabled: () => false,
  container: () => ({ items: { upsert: jest.fn() } }),
}));

const { recordDaily, getHistory, evictOld, METAL_SYMBOLS } = require('../src/services/metalsHistoryService');

// ═══════════════════════════════════════════════════════════════
//  METAL_SYMBOLS
// ═══════════════════════════════════════════════════════════════

describe('METAL_SYMBOLS', () => {
  test('maps common names to ISO codes', () => {
    expect(METAL_SYMBOLS.gold).toBe('XAU');
    expect(METAL_SYMBOLS.silver).toBe('XAG');
    expect(METAL_SYMBOLS.platinum).toBe('XPT');
    expect(METAL_SYMBOLS.palladium).toBe('XPD');
  });
});

// ═══════════════════════════════════════════════════════════════
//  recordDaily
// ═══════════════════════════════════════════════════════════════

describe('recordDaily', () => {
  test('records a price for a metal', () => {
    const metal = `TEST_REC_${Date.now()}`;
    recordDaily(metal, 2350.50);
    const history = getHistory(metal, 1);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0][1]).toBe(2350.5);
  });

  test('second call same day does not overwrite', () => {
    const metal = `TEST_NODUP_${Date.now()}`;
    recordDaily(metal, 30.00);
    recordDaily(metal, 35.00); // should be ignored
    const history = getHistory(metal, 1);
    expect(history[0][1]).toBe(30.00);
  });

  test('rounds to 2 decimal places', () => {
    const metal = `TEST_ROUND_${Date.now()}`;
    recordDaily(metal, 999.999);
    const history = getHistory(metal, 1);
    expect(history[0][1]).toBe(1000.00);
  });

  test('skips if metal is empty', () => {
    recordDaily('', 100);
    recordDaily(null, 100);
    // Should not throw
  });

  test('skips if price is null or NaN', () => {
    const metal = `TEST_SKIP_${Date.now()}`;
    recordDaily(metal, null);
    recordDaily(metal, NaN);
    const history = getHistory(metal, 1);
    expect(history).toHaveLength(0);
  });

  test('accepts custom timestamp', () => {
    const metal = `TEST_TS_${Date.now()}`;
    recordDaily(metal, 1200.50, '2026-04-15T12:00:00Z');
    const history = getHistory(metal, 30);
    const dates = history.map(h => h[0]);
    expect(dates).toContain('2026-04-15');
  });
});

// ═══════════════════════════════════════════════════════════════
//  getHistory
// ═══════════════════════════════════════════════════════════════

describe('getHistory', () => {
  test('returns empty for unknown metal', () => {
    expect(getHistory('NOPE_NEVER', 90)).toEqual([]);
  });

  test('filters out entries older than rangeDays', () => {
    const metal = `OLD_HIST_${Date.now()}`;
    recordDaily(metal, 500, '2020-01-01T00:00:00Z');
    const result = getHistory(metal, 30);
    expect(result).toHaveLength(0);
  });

  test('includes entries within range', () => {
    const metal = `RANGE_HIST_${Date.now()}`;
    const today = new Date().toISOString();
    recordDaily(metal, 42.5, today);
    const result = getHistory(metal, 1);
    expect(result.length).toBe(1);
    expect(result[0][1]).toBe(42.5);
  });
});

// ═══════════════════════════════════════════════════════════════
//  evictOld
// ═══════════════════════════════════════════════════════════════

describe('evictOld', () => {
  test('removes entries older than maxDays', () => {
    const metal = `EVICT_${Date.now()}`;
    recordDaily(metal, 100, '2020-01-01T00:00:00Z');
    const evicted = evictOld(30);
    expect(evicted).toBeGreaterThanOrEqual(1);
  });

  test('returns 0 when nothing to evict', () => {
    const metal = `FRESH_${Date.now()}`;
    recordDaily(metal, 50);
    // Evict with a generous window that keeps today's data
    const evicted = evictOld(9999);
    expect(evicted).toBe(0);
  });
});
