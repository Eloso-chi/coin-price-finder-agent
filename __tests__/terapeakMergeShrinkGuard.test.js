// __tests__/terapeakMergeShrinkGuard.test.js -- Regression tests to ensure
// CSV imports NEVER reduce the comp count for a dataset.
//
// These tests validate the server-side invariant that a re-import (refresh)
// can only ADD or maintain data, never shrink it. This monitors for the class
// of bugs fixed in fix/csv-merge-on-refresh (May 2026).

'use strict';

const terapeakService = require('../src/services/terapeakService');
const {
  importComps,
  lookupComps,
  listDatasets,
  clearAll,
  _resetStoreCache,
} = terapeakService;

beforeEach(() => {
  clearAll();
  _resetStoreCache();
});
// Cancel any pending debounced writes after all tests complete
afterAll(() => {
  terapeakService._cancelPendingSaves();
  clearAll();
  _resetStoreCache();
});

describe('import never shrinks dataset', () => {
  test('re-importing subset of comps does not reduce totalStored', () => {
    // Simulate a deep-paginated dataset (100 comps)
    const deepComps = Array.from({ length: 100 }, (_, i) => ({
      title: `Morgan Dollar Lot ${i}`,
      soldDate: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
      totalUsd: 50 + i,
      itemId: `DEEP${i.toString().padStart(4, '0')}`,
    }));

    const initial = importComps('1889 Morgan Silver Dollar', deepComps);
    expect(initial.totalStored).toBe(100);

    // Simulate a page-1 refresh with only 20 comps (all duplicates)
    const page1Refresh = deepComps.slice(0, 20);
    const refresh = importComps('1889 Morgan Silver Dollar', page1Refresh);

    // CRITICAL: totalStored must never decrease
    expect(refresh.totalStored).toBeGreaterThanOrEqual(100);
    expect(refresh.duplicatesSkipped).toBe(20);
    expect(refresh.newComps).toBe(0);
  });

  test('re-importing with new + duplicate comps grows the dataset', () => {
    const existing = Array.from({ length: 50 }, (_, i) => ({
      title: `Silver Eagle ${i}`,
      soldDate: '2026-04-10',
      totalUsd: 35 + i * 0.5,
      itemId: `ASE${i}`,
    }));

    importComps('2024 Silver Eagle', existing);

    // Page-1 refresh: 10 dupes + 5 new
    const refresh = [
      ...existing.slice(0, 10),
      ...Array.from({ length: 5 }, (_, i) => ({
        title: `Silver Eagle New ${i}`,
        soldDate: '2026-05-12',
        totalUsd: 36 + i,
        itemId: `ASENEW${i}`,
      })),
    ];

    const result = importComps('2024 Silver Eagle', refresh);

    expect(result.totalStored).toBe(55); // 50 + 5 new
    expect(result.newComps).toBe(5);
    expect(result.duplicatesSkipped).toBe(10);
  });

  test('empty re-import does not clear dataset', () => {
    importComps('Test Coin', [
      { title: 'Comp A', totalUsd: 25, itemId: 'X1' },
      { title: 'Comp B', totalUsd: 30, itemId: 'X2' },
    ]);

    const result = importComps('Test Coin', []);

    expect(result.totalStored).toBe(2);
    expect(result.newComps).toBe(0);
  });

  test('sequential page-1 refreshes never lose deep data', () => {
    // Simulate initial deep pagination (pages 1-4 = 200 comps)
    const allComps = Array.from({ length: 200 }, (_, i) => ({
      title: `Krugerrand ${2020 + (i % 5)} 1oz`,
      soldDate: `2026-${String(3 + Math.floor(i / 60)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      totalUsd: 2100 + i * 2,
      itemId: `KR${i.toString().padStart(4, '0')}`,
    }));

    importComps('Krugerrand 1oz Gold', allComps);

    // Simulate 3 consecutive page-1 refreshes (each with 50 rows)
    for (let batch = 0; batch < 3; batch++) {
      const page1 = allComps.slice(batch * 10, batch * 10 + 50);
      const result = importComps('Krugerrand 1oz Gold', page1);
      expect(result.totalStored).toBeGreaterThanOrEqual(200);
    }
  });

  test('autoImportFolder re-importing smaller CSV preserves stored comps', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const { autoImportFolder } = terapeakService;

    // Set up temp directory with a CSV
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-guard-'));
    const csvPath = path.join(tmpDir, '2024_Silver_Eagle.csv');

    // First import: 80 rows
    const header = 'Title,Item ID,Sold Date,Total Price\n';
    const rows80 = Array.from({ length: 80 }, (_, i) =>
      `"Silver Eagle ${i}","ASE${i}","May ${(i % 28) + 1}, 2026","$${35 + i}.00"`
    ).join('\n');
    fs.writeFileSync(csvPath, header + rows80);

    autoImportFolder(tmpDir);
    const ds1 = listDatasets().find(d => d.searchTerm.includes('Silver Eagle'));
    expect(ds1.compCount).toBe(80);

    // Overwrite CSV with only 30 rows (simulates the old bug)
    const rows30 = Array.from({ length: 30 }, (_, i) =>
      `"Silver Eagle ${i}","ASE${i}","May ${(i % 28) + 1}, 2026","$${35 + i}.00"`
    ).join('\n');
    fs.writeFileSync(csvPath, header + rows30);

    autoImportFolder(tmpDir);
    const ds2 = listDatasets().find(d => d.searchTerm.includes('Silver Eagle'));

    // CRITICAL: comp count must not shrink
    expect(ds2.compCount).toBeGreaterThanOrEqual(80);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
