'use strict';

/**
 * auctionPriceServiceErrorPaths.test.js -- Edge-case tests for
 * src/services/auctionPriceService.js helpers that were not exercised
 * by the existing test file.
 *
 * Coverage gap pin (test-coverage Tier 2): the existing
 * auctionPriceService.test.js covers computeStats, needsRefresh,
 * getHistory, computeTrend, FRESHNESS_DAYS/DATE_WINDOW_YEARS. This
 * file adds:
 *   - dedupeRecords (exported as _dedupeRecords)
 *   - getManifest (returns the in-memory manifest shape)
 *   - getStaleEntries (filter + sort behavior)
 *   - updateRunStatus (writes lastRun, lastRunStatus, custom details)
 *   - fetchByGrade input guard (no PCGS API key)
 */

const path = require('path');
const os = require('os');

// Force APR_DIR to a per-test tmp directory so we never touch the real
// cache. The service reads APR_DIR from process.env at require time.
const TMP = path.join(os.tmpdir(), `apr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
require('fs').mkdirSync(TMP, { recursive: true });
process.env.APR_DIR = TMP;
// Clear PCGS_API_KEY so fetchByGrade hits the guard path without
// touching the network.
delete process.env.PCGS_API_KEY;

jest.mock('../src/utils/cachePath', () => ({
  CACHE_DIR: process.env.APR_DIR,
}));

const aprService = require('../src/services/auctionPriceService');
const { _dedupeRecords, getManifest, getStaleEntries,
  updateRunStatus, fetchByGrade } = aprService;

// ============================================================
//  _dedupeRecords -- key = LotNo|Auctioneer|Date|Price
// ============================================================

describe('_dedupeRecords', () => {
  test('empty existing + empty incoming -> no records, 0 added', () => {
    const { merged, added } = _dedupeRecords([], []);
    expect(merged).toEqual([]);
    expect(added).toBe(0);
  });

  test('empty existing + incoming -> all incoming added', () => {
    const incoming = [
      { LotNo: 'L1', Auctioneer: 'Heritage', Date: '06-2024', Price: 100 },
      { LotNo: 'L2', Auctioneer: 'Stacks',   Date: '06-2024', Price: 200 },
    ];
    const { merged, added } = _dedupeRecords([], incoming);
    expect(merged).toHaveLength(2);
    expect(added).toBe(2);
  });

  test('exact-duplicate incoming is filtered out', () => {
    const existing = [{ LotNo: 'L1', Auctioneer: 'Heritage', Date: '06-2024', Price: 100 }];
    const incoming = [{ LotNo: 'L1', Auctioneer: 'Heritage', Date: '06-2024', Price: 100 }];
    const { merged, added } = _dedupeRecords(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(added).toBe(0);
  });

  test('partial overlap -- only novel records added', () => {
    const existing = [
      { LotNo: 'L1', Auctioneer: 'Heritage', Date: '06-2024', Price: 100 },
    ];
    const incoming = [
      { LotNo: 'L1', Auctioneer: 'Heritage', Date: '06-2024', Price: 100 }, // dup
      { LotNo: 'L2', Auctioneer: 'Stacks',   Date: '07-2024', Price: 110 }, // novel
    ];
    const { merged, added } = _dedupeRecords(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
    expect(merged.find(r => r.LotNo === 'L2')).toBeDefined();
  });

  test('records differing only in price are NOT duplicates', () => {
    // Same lot, same auctioneer, same date, different price -> distinct sales.
    const existing = [{ LotNo: 'L1', Auctioneer: 'Heritage', Date: '06-2024', Price: 100 }];
    const incoming = [{ LotNo: 'L1', Auctioneer: 'Heritage', Date: '06-2024', Price: 110 }];
    const { merged, added } = _dedupeRecords(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
  });

  test('within-batch duplicates are also filtered', () => {
    const incoming = [
      { LotNo: 'L1', Auctioneer: 'Heritage', Date: '06-2024', Price: 100 },
      { LotNo: 'L1', Auctioneer: 'Heritage', Date: '06-2024', Price: 100 }, // intra-batch dup
      { LotNo: 'L2', Auctioneer: 'Stacks',   Date: '07-2024', Price: 110 },
    ];
    const { merged, added } = _dedupeRecords([], incoming);
    expect(merged).toHaveLength(2);
    expect(added).toBe(2);
  });
});

// ============================================================
//  getManifest -- shape
// ============================================================

describe('getManifest', () => {
  test('returns an object with an entries map', () => {
    const m = getManifest();
    expect(m).toBeDefined();
    expect(typeof m).toBe('object');
    expect(m).toHaveProperty('entries');
    expect(typeof m.entries).toBe('object');
  });

  test('two consecutive calls return the same structural shape', () => {
    const m1 = getManifest();
    const m2 = getManifest();
    expect(Object.keys(m1).sort()).toEqual(Object.keys(m2).sort());
  });
});

// ============================================================
//  updateRunStatus -- writes lastRun, lastRunStatus, details
// ============================================================

describe('updateRunStatus', () => {
  test('writes lastRunStatus and lastRun timestamp', () => {
    updateRunStatus('success');
    const m = getManifest();
    expect(m.lastRunStatus).toBe('success');
    expect(m.lastRun).toBeDefined();
    expect(typeof m.lastRun).toBe('string');
    // ISO timestamp parse check
    expect(Number.isNaN(Date.parse(m.lastRun))).toBe(false);
  });

  test('accepts arbitrary details and merges them', () => {
    updateRunStatus('partial', { errors: 3, completed: 7 });
    const m = getManifest();
    expect(m.lastRunStatus).toBe('partial');
    expect(m.errors).toBe(3);
    expect(m.completed).toBe(7);
  });

  test('subsequent calls overwrite previous lastRunStatus', () => {
    updateRunStatus('failed', { reason: 'breaker' });
    updateRunStatus('success');
    const m = getManifest();
    expect(m.lastRunStatus).toBe('success');
  });
});

// ============================================================
//  getStaleEntries -- filter + sort
// ============================================================

describe('getStaleEntries', () => {
  test('returns an array (possibly empty)', () => {
    const stale = getStaleEntries();
    expect(Array.isArray(stale)).toBe(true);
  });

  test('every returned entry has key and freshUntil <= now', () => {
    const stale = getStaleEntries();
    const now = new Date();
    for (const entry of stale) {
      expect(entry).toHaveProperty('key');
      expect(entry).toHaveProperty('freshUntil');
      expect(new Date(entry.freshUntil) <= now).toBe(true);
    }
  });

  test('returned list is sorted by lastFetched ascending (oldest first)', () => {
    const stale = getStaleEntries();
    if (stale.length < 2) return; // nothing to verify
    for (let i = 1; i < stale.length; i++) {
      const prev = new Date(stale[i - 1].lastFetched);
      const cur  = new Date(stale[i].lastFetched);
      expect(prev <= cur).toBe(true);
    }
  });
});

// ============================================================
//  fetchByGrade -- guard path (no PCGS API key)
// ============================================================

describe('fetchByGrade -- guard path', () => {
  test('throws when PCGS_API_KEY is not configured', async () => {
    // PCGS_API_KEY was deleted at the top of this file. Verify the
    // explicit guard fires before any network attempt.
    await expect(fetchByGrade(7296, 65)).rejects.toThrow(/PCGS API key/);
  });
});
