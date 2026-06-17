'use strict';

/**
 * metalsHistoryWindowEdges.test.js -- Edge-case tests for
 * src/services/metalsHistoryService.js#getSpotOnDate.
 *
 * Coverage gap pin (test-coverage Tier 2): the existing
 * metalsHistoryService.test.js does not exercise getSpotOnDate at
 * all. This function implements a non-trivial 7-day window lookup
 * (exact-match -> prior-date scan -> next-date fallback -> 7-day
 * tolerance gate -> null) that is consumed by both metalsRoute and
 * valuationService. Each branch is pinned here.
 */

jest.mock('../src/utils/cachePath', () => ({
  CACHE_DIR: require('os').tmpdir()
}));
jest.mock('../src/utils/cosmosClient', () => ({
  isEnabled: () => false,
  container: () => ({ items: { upsert: jest.fn() } }),
}));

const {
  recordDaily,
  getSpotOnDate,
} = require('../src/services/metalsHistoryService');

// Use unique metal name per test to avoid cross-test state bleed
// through the shared in-memory + tmp-file store.
function uniqueMetal(label) {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
//  getSpotOnDate -- input guards
// ============================================================

describe('getSpotOnDate -- input guards', () => {
  test('null metal returns null', () => {
    expect(getSpotOnDate(null, '2024-06-01')).toBeNull();
  });

  test('null dateStr returns null', () => {
    expect(getSpotOnDate('silver-test', null)).toBeNull();
  });

  test('empty metal returns null', () => {
    expect(getSpotOnDate('', '2024-06-01')).toBeNull();
  });

  test('empty dateStr returns null', () => {
    expect(getSpotOnDate('silver-test', '')).toBeNull();
  });

  test('unknown metal returns null', () => {
    expect(getSpotOnDate('never-seen-metal-zzzz', '2024-06-01')).toBeNull();
  });
});

// ============================================================
//  getSpotOnDate -- exact-match path
// ============================================================

describe('getSpotOnDate -- exact match', () => {
  test('returns the stored price when target date exactly matches', () => {
    const metal = uniqueMetal('silver-exact');
    recordDaily(metal, 30.50, '2024-06-15T12:00:00Z');
    expect(getSpotOnDate(metal, '2024-06-15')).toBe(30.50);
  });

  test('accepts full ISO timestamp and normalizes to YYYY-MM-DD', () => {
    const metal = uniqueMetal('silver-iso');
    recordDaily(metal, 31.25, '2024-06-20T00:00:00Z');
    expect(getSpotOnDate(metal, '2024-06-20T14:30:00Z')).toBe(31.25);
  });
});

// ============================================================
//  getSpotOnDate -- prior-date fallback
// ============================================================

describe('getSpotOnDate -- prior-date fallback', () => {
  test('returns most recent prior date within 7 days', () => {
    const metal = uniqueMetal('silver-prior');
    recordDaily(metal, 30.00, '2024-06-10T00:00:00Z');
    recordDaily(metal, 31.00, '2024-06-12T00:00:00Z');
    // Query 06-14: should pick 06-12 (closest prior, within 7 days)
    expect(getSpotOnDate(metal, '2024-06-14')).toBe(31.00);
  });

  test('returns null when only prior date is more than 7 days stale', () => {
    const metal = uniqueMetal('silver-stale-prior');
    recordDaily(metal, 30.00, '2024-06-01T00:00:00Z');
    // Query 06-15: prior is 06-01 (14 days back) -> outside 7-day window -> null
    expect(getSpotOnDate(metal, '2024-06-15')).toBeNull();
  });

  test('exactly 7-day-prior is within tolerance', () => {
    const metal = uniqueMetal('silver-7day-prior');
    recordDaily(metal, 29.50, '2024-06-08T00:00:00Z');
    expect(getSpotOnDate(metal, '2024-06-15')).toBe(29.50);
  });
});

// ============================================================
//  getSpotOnDate -- next-date fallback (target before any data)
// ============================================================

describe('getSpotOnDate -- next-date fallback', () => {
  test('returns next date when target is before any stored data', () => {
    const metal = uniqueMetal('gold-next');
    recordDaily(metal, 2400.00, '2024-06-10T00:00:00Z');
    // Query 06-05: no prior data -> falls through to next-date scan -> 06-10 within 7 days
    expect(getSpotOnDate(metal, '2024-06-05')).toBe(2400.00);
  });

  test('returns null when next date is more than 7 days ahead', () => {
    const metal = uniqueMetal('gold-far-next');
    recordDaily(metal, 2400.00, '2024-06-20T00:00:00Z');
    // Query 06-01: next is 06-20 (19 days ahead) -> outside window -> null
    expect(getSpotOnDate(metal, '2024-06-01')).toBeNull();
  });
});

// ============================================================
//  getSpotOnDate -- determinism
// ============================================================

describe('getSpotOnDate -- determinism', () => {
  test('repeated calls return the same value', () => {
    const metal = uniqueMetal('platinum-det');
    recordDaily(metal, 950.00, '2024-06-15T00:00:00Z');
    expect(getSpotOnDate(metal, '2024-06-15'))
      .toBe(getSpotOnDate(metal, '2024-06-15'));
    expect(getSpotOnDate(metal, '2024-06-15'))
      .toBe(getSpotOnDate(metal, '2024-06-15'));
  });

  test('prior-date fallback is stable across calls', () => {
    const metal = uniqueMetal('platinum-prior-det');
    recordDaily(metal, 950.00, '2024-06-10T00:00:00Z');
    recordDaily(metal, 960.00, '2024-06-12T00:00:00Z');
    const a = getSpotOnDate(metal, '2024-06-14');
    const b = getSpotOnDate(metal, '2024-06-14');
    const c = getSpotOnDate(metal, '2024-06-14');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
