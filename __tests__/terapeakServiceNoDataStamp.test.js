// __tests__/terapeakServiceNoDataStamp.test.js
// Fix B of BACKLOG #245: importComps() must stamp noDataCount + noDataAt when
// a page-1 refresh returns 0 comps, so the freshness classifier's dormancy
// guard (noDataCount>=2) can fire and stop re-queueing empty datasets.
'use strict';

const terapeakService = require('../src/services/terapeakService');

describe('terapeakService.importComps -- dormancy stamping (Fix B of #245)', () => {
  const baseTerm = '__test_dormancy_stamp_' + Date.now();
  const baseKey = terapeakService.normalizeSearchKey(baseTerm);

  afterEach(() => {
    try { terapeakService.deleteDataset(baseKey); } catch (_) {}
  });

  function getMeta() {
    const all = terapeakService.listDatasets();
    return all.find(d => d.key === baseKey)?.aggregationMeta || null;
  }

  test('page-1 refresh with 0 comps stamps noDataCount=1 + noDataAt', () => {
    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { page1At: '2026-06-01T00:00:00.000Z', lastRefreshAt: '2026-06-01T00:00:00.000Z' },
    });
    const am = getMeta();
    expect(am).not.toBeNull();
    expect(am.noDataCount).toBe(1);
    expect(am.noDataAt).toBe('2026-06-01T00:00:00.000Z');
  });

  test('successive empty page-1 refreshes increment noDataCount monotonically', () => {
    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { page1At: '2026-06-01T00:00:00.000Z', lastRefreshAt: '2026-06-01T00:00:00.000Z' },
    });
    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { lastRefreshAt: '2026-06-15T00:00:00.000Z' },
    });
    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { lastRefreshAt: '2026-07-01T00:00:00.000Z' },
    });
    const am = getMeta();
    expect(am.noDataCount).toBe(3);
    expect(am.noDataAt).toBe('2026-07-01T00:00:00.000Z');
  });

  test('noDataCount is capped at 5 (NO_DATA_CAP)', () => {
    for (let i = 0; i < 10; i++) {
      terapeakService.importComps(baseTerm, [], {
        aggregationMeta: { lastRefreshAt: `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` },
      });
    }
    const am = getMeta();
    expect(am.noDataCount).toBe(5);
  });

  test('successful import with comps resets noDataCount to 0 (self-healing)', () => {
    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { page1At: '2026-06-01T00:00:00.000Z', lastRefreshAt: '2026-06-01T00:00:00.000Z' },
    });
    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { lastRefreshAt: '2026-06-15T00:00:00.000Z' },
    });
    let am = getMeta();
    expect(am.noDataCount).toBe(2);

    terapeakService.importComps(baseTerm, [
      { price: 100, soldDate: '2026-07-01', title: 'recovered comp', _source: 'terapeak' },
    ], { aggregationMeta: { lastRefreshAt: '2026-07-01T00:00:00.000Z' } });

    am = getMeta();
    expect(am.noDataCount).toBe(0);
    expect(am.noDataAt).toBeNull();
  });

  test('deep-pagination import (no page1At/lastRefreshAt) does not stamp noDataCount', () => {
    // Simulate a deep-pagination import that returned 0 NEW comps (e.g. all duplicates).
    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { deepAt: '2026-06-01T00:00:00.000Z' },
    });
    const am = getMeta();
    // deep imports don't fire the page-1 stamp path
    expect(am?.noDataCount || 0).toBe(0);
    expect(am?.noDataAt || null).toBeNull();
  });

  test('empty refresh against dataset with existing comps does NOT stamp dormancy', () => {
    // Seed with comps
    terapeakService.importComps(baseTerm, [
      { price: 100, soldDate: '2026-05-01', title: 'existing', _source: 'terapeak' },
    ], { aggregationMeta: { page1At: '2026-05-01T00:00:00.000Z', lastRefreshAt: '2026-05-01T00:00:00.000Z' } });
    // Then an empty refresh
    terapeakService.importComps(baseTerm, [], {
      aggregationMeta: { lastRefreshAt: '2026-06-01T00:00:00.000Z' },
    });
    const am = getMeta();
    expect(am.noDataCount || 0).toBe(0);
    expect(am.noDataAt || null).toBeNull();
  });
});
