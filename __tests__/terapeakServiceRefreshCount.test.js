// __tests__/terapeakServiceRefreshCount.test.js
// Fix D of BACKLOG #245: refreshCount must increment on any page-1 attempt
// (page1At OR lastRefreshAt), not just when page1At is supplied. Previously
// the Python scraper's lastRefreshAt-only empty-scrape path left refreshCount
// stuck at 0, keeping marketDepth='untested' and re-queuing as initial-fetch.
'use strict';

const terapeakService = require('../src/services/terapeakService');

describe('terapeakService.importComps -- refreshCount semantics (Fix D of #245)', () => {
  const baseTerm = '__test_refresh_count_' + Date.now();
  const baseKey = terapeakService.normalizeSearchKey(baseTerm);

  afterEach(() => {
    try { terapeakService.deleteDataset(baseKey); } catch (_) {}
  });

  function getMeta() {
    return terapeakService.listDatasets().find(d => d.key === baseKey)?.aggregationMeta || null;
  }

  test('page1At-only import increments refreshCount (regression guard)', () => {
    terapeakService.importComps(baseTerm, [
      { price: 50, soldDate: '2026-06-01', title: 't', _source: 'terapeak' },
    ], { aggregationMeta: { page1At: '2026-06-01T00:00:00.000Z' } });
    expect(getMeta().refreshCount).toBe(1);
  });

  test('lastRefreshAt-only import (Python scraper empty path) increments refreshCount', () => {
    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { lastRefreshAt: '2026-06-01T00:00:00.000Z' },
    });
    expect(getMeta().refreshCount).toBe(1);
  });

  test('three empty lastRefreshAt-only imports yield refreshCount=3 (confirmed-thin would converge)', () => {
    for (let i = 0; i < 3; i++) {
      terapeakService.importComps(baseTerm, [], {
        aggregationMeta: { lastRefreshAt: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` },
      });
    }
    expect(getMeta().refreshCount).toBe(3);
  });

  test('deep-pagination import (no page1At/lastRefreshAt) does NOT increment refreshCount', () => {
    terapeakService.importComps(baseTerm, [
      { price: 50, soldDate: '2026-06-01', title: 't', _source: 'terapeak' },
    ], { aggregationMeta: { deepAt: '2026-06-01T00:00:00.000Z' } });
    expect(getMeta().refreshCount).toBe(0);
  });

  test('mixed sequence: deep then page-1-empty then page-1-success', () => {
    terapeakService.importComps(baseTerm, [
      { price: 50, soldDate: '2026-06-01', title: 'a', _source: 'terapeak' },
    ], { aggregationMeta: { deepAt: '2026-06-01T00:00:00.000Z' } });
    expect(getMeta().refreshCount).toBe(0); // deep doesn't count

    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { lastRefreshAt: '2026-06-15T00:00:00.000Z' },
    });
    expect(getMeta().refreshCount).toBe(1); // empty page-1 counts

    terapeakService.importComps(baseTerm, [
      { price: 60, soldDate: '2026-07-01', title: 'b', _source: 'terapeak' },
    ], { aggregationMeta: { page1At: '2026-07-01T00:00:00.000Z' } });
    expect(getMeta().refreshCount).toBe(2);
  });
});
