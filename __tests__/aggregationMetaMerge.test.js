// __tests__/aggregationMetaMerge.test.js
// #246 PR B -- unit tests for the _mergeAggregationMeta helper used by
// loadMetaSidecar() and hydrateMetaFromCosmos(). Replaces the previous
// first-wins merge that silently dropped newer markers in favor of older
// existing values.
'use strict';

const { _mergeAggregationMeta } = require('../src/services/terapeakService');

describe('_mergeAggregationMeta (#246 PR B)', () => {
  test('returns an object with all expected fields when both inputs are empty', () => {
    const out = _mergeAggregationMeta({}, {});
    expect(out).toEqual({
      page1At: null,
      deepAt: null,
      lastRefreshAt: null,
      newestSaleDate: null,
      oldestSaleDate: null,
      noDataAt: null,
      maxPageReached: null,
      compCount: null,
      refreshCount: 0,
      noDataCount: 0,
      consecutiveDryRefreshes: 0,
      lastRefreshNewComps: null,
    });
  });

  test('tolerates null / undefined inputs', () => {
    const out1 = _mergeAggregationMeta(null, { page1At: '2026-05-01T00:00:00Z' });
    expect(out1.page1At).toBe('2026-05-01T00:00:00Z');
    const out2 = _mergeAggregationMeta({ deepAt: '2026-05-01T00:00:00Z' }, undefined);
    expect(out2.deepAt).toBe('2026-05-01T00:00:00Z');
  });

  // ── Timestamp fields: take the LATEST ─────────────────────────────
  describe('timestamp fields take the latest value', () => {
    const cases = [
      ['page1At',         '2025-06-01T00:00:00Z', '2026-06-01T00:00:00Z'],
      ['deepAt',          '2025-06-01T00:00:00Z', '2026-06-01T00:00:00Z'],
      ['lastRefreshAt',   '2025-06-01T00:00:00Z', '2026-06-01T00:00:00Z'],
      ['newestSaleDate',  '2025-12-31', '2026-05-30'],
      ['noDataAt',        '2025-06-01T00:00:00Z', '2026-06-01T00:00:00Z'],
    ];
    test.each(cases)('%s: existing-newer wins over incoming-older', (field, oldVal, newVal) => {
      const out = _mergeAggregationMeta({ [field]: newVal }, { [field]: oldVal });
      expect(out[field]).toBe(newVal);
    });
    test.each(cases)('%s: incoming-newer wins over existing-older', (field, oldVal, newVal) => {
      const out = _mergeAggregationMeta({ [field]: oldVal }, { [field]: newVal });
      expect(out[field]).toBe(newVal);
    });
  });

  test('first-wins bug regression: newer Cosmos lastRefreshAt overrides older existing', () => {
    // The bug PR B fixes: previously `existing.lastRefreshAt || meta.lastRefreshAt`
    // returned the older `existing` value, silently dropping the newer Cosmos marker
    // and confusing the freshness classifier.
    const existing = { lastRefreshAt: '2025-01-01T00:00:00Z' };
    const incoming = { lastRefreshAt: '2026-06-01T00:00:00Z' };
    const out = _mergeAggregationMeta(existing, incoming);
    expect(out.lastRefreshAt).toBe('2026-06-01T00:00:00Z');
  });

  test('oldestSaleDate takes the EARLIEST value', () => {
    const out = _mergeAggregationMeta(
      { oldestSaleDate: '2024-03-15' },
      { oldestSaleDate: '2023-01-10' }
    );
    expect(out.oldestSaleDate).toBe('2023-01-10');
  });

  // ── Counter fields: take the MAX ──────────────────────────────────
  describe('counter fields take the max value', () => {
    const cases = [
      ['maxPageReached',           5,  12],
      ['compCount',                10, 250],
      ['refreshCount',             3,  7],
      ['noDataCount',              1,  4],
      ['consecutiveDryRefreshes',  0,  3],
    ];
    test.each(cases)('%s: max(existing, incoming)', (field, a, b) => {
      const out = _mergeAggregationMeta({ [field]: a }, { [field]: b });
      expect(out[field]).toBe(b);
      const out2 = _mergeAggregationMeta({ [field]: b }, { [field]: a });
      expect(out2[field]).toBe(b);
    });
  });

  test('compCount returns null when both sides are 0/missing (not 0)', () => {
    // Preserves the existing "null marker" convention used by freshness code:
    // a null compCount means "never tracked" vs 0 which means "zero comps".
    const out = _mergeAggregationMeta({}, {});
    expect(out.compCount).toBeNull();
    expect(out.maxPageReached).toBeNull();
  });

  test('counter fields with one side missing still return the present value', () => {
    const out = _mergeAggregationMeta({ refreshCount: 5 }, {});
    expect(out.refreshCount).toBe(5);
    const out2 = _mergeAggregationMeta({}, { compCount: 42 });
    expect(out2.compCount).toBe(42);
  });

  // ── lastRefreshNewComps: per-refresh value, not cumulative ────────
  test('lastRefreshNewComps prefers existing (already-tracked) value', () => {
    const out = _mergeAggregationMeta({ lastRefreshNewComps: 12 }, { lastRefreshNewComps: 3 });
    expect(out.lastRefreshNewComps).toBe(12);
  });

  test('lastRefreshNewComps falls back to incoming when existing is missing', () => {
    const out = _mergeAggregationMeta({}, { lastRefreshNewComps: 7 });
    expect(out.lastRefreshNewComps).toBe(7);
  });

  test('lastRefreshNewComps preserves 0 (zero is a valid signal, not "missing")', () => {
    const out = _mergeAggregationMeta({ lastRefreshNewComps: 0 }, { lastRefreshNewComps: 5 });
    expect(out.lastRefreshNewComps).toBe(0);
  });

  // ── Realistic mixed scenarios ─────────────────────────────────────
  test('realistic Cosmos hydration: in-memory has stale markers, Cosmos has fresh', () => {
    const inMemory = {
      page1At: '2025-01-01T00:00:00Z',
      deepAt: '2024-06-01T00:00:00Z',
      maxPageReached: 5,
      lastRefreshAt: '2025-01-01T00:00:00Z',
      compCount: 50,
      refreshCount: 2,
    };
    const cosmos = {
      page1At: '2026-06-01T00:00:00Z',
      deepAt: '2026-05-15T00:00:00Z',
      maxPageReached: 8,
      lastRefreshAt: '2026-06-01T00:00:00Z',
      compCount: 230,
      refreshCount: 10,
    };
    const out = _mergeAggregationMeta(inMemory, cosmos);
    expect(out.page1At).toBe('2026-06-01T00:00:00Z');
    expect(out.deepAt).toBe('2026-05-15T00:00:00Z');
    expect(out.maxPageReached).toBe(8);
    expect(out.lastRefreshAt).toBe('2026-06-01T00:00:00Z');
    expect(out.compCount).toBe(230);
    expect(out.refreshCount).toBe(10);
  });

  test('realistic sidecar load: sidecar has identifiers + markers, in-memory has fresher refresh', () => {
    // Common boot path: sidecar pre-seeds historical markers; in-memory store
    // (built from CSV import that ran before hydration) already has newer
    // refresh activity for the same key.
    const inMemory = {
      lastRefreshAt: '2026-06-02T12:00:00Z',
      refreshCount: 15,
      newestSaleDate: '2026-05-30',
    };
    const sidecar = {
      deepAt: '2025-08-15T00:00:00Z',
      lastRefreshAt: '2025-08-15T00:00:00Z',
      refreshCount: 1,
      newestSaleDate: '2025-08-10',
      oldestSaleDate: '2020-01-15',
    };
    const out = _mergeAggregationMeta(inMemory, sidecar);
    expect(out.deepAt).toBe('2025-08-15T00:00:00Z'); // pre-seeded from sidecar
    expect(out.lastRefreshAt).toBe('2026-06-02T12:00:00Z'); // in-memory newer
    expect(out.refreshCount).toBe(15); // in-memory higher
    expect(out.newestSaleDate).toBe('2026-05-30');
    expect(out.oldestSaleDate).toBe('2020-01-15'); // sidecar earliest
  });
});
