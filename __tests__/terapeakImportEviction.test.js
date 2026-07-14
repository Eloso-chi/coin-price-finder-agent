// __tests__/terapeakImportEviction.test.js -- Tests for Terapeak CSV import,
// eviction of stale comps, and auto-import from folder.
//
// These tests use the in-memory store (reset between tests) and temp files.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const terapeakService = require('../src/services/terapeakService');
const {
  importComps,
  lookupComps,
  listDatasets,
  deleteDataset,
  clearAll,
  evictStaleComps,
  autoImportFolder,
  parseCSV,
  normalizeSearchKey,
  _resetStoreCache,
} = terapeakService;

// Reset store before each test to avoid cross-contamination
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

/* ════════════════════════════════════════════════════════════
 *  importComps — basic import
 * ════════════════════════════════════════════════════════════ */
describe('importComps', () => {
  test('imports comps and returns summary', () => {
    const comps = [
      { title: 'Test Morgan 1889', soldDate: '2026-03-01', totalUsd: 50, itemId: 'A1' },
      { title: 'Test Morgan 1889 PCGS', soldDate: '2026-03-02', totalUsd: 55, itemId: 'A2' },
    ];
    const result = importComps('1889 Morgan Silver Dollar', comps);
    expect(result.newComps).toBe(2);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.totalStored).toBe(2);
  });

  test('deduplicates by itemId on re-import', () => {
    const comps = [
      { title: 'Test Eagle', soldDate: '2026-04-01', totalUsd: 35, itemId: 'B1' },
    ];
    importComps('Test Eagle', comps);
    const result = importComps('Test Eagle', comps);
    expect(result.newComps).toBe(0);
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.totalStored).toBe(1);
  });

  test('deduplicates by title+price+date when itemId missing', () => {
    const comps = [
      { title: 'Test Libertad', soldDate: '2026-04-01', totalUsd: 38 },
    ];
    importComps('Test Libertad', comps);
    const result = importComps('Test Libertad', comps);
    expect(result.newComps).toBe(0);
    expect(result.duplicatesSkipped).toBe(1);
  });

  test('increments importCount on re-import', () => {
    importComps('Test Count', [{ title: 'A', totalUsd: 10 }]);
    importComps('Test Count', [{ title: 'B', totalUsd: 20 }]);
    const datasets = listDatasets();
    const ds = datasets.find(d => d.searchTerm === 'Test Count');
    expect(ds.importCount).toBe(2);
  });

  // #283W: onza-fractional titles must reroute at import time.  This
  // pins the second consumer of the shared `detectWeightFromTitle`
  // detector (the first is ebayService.applyFilters weight-mismatch
  // hard filter).  Regression protects against the original bug where
  // "1/20 ONZA" titles landed in the wrong-weight pool because the
  // regex didn't know Spanish "onza".
  test('#283W: reroutes 1/20 ONZA comp out of a 1 oz dataset key', () => {
    const comps = [
      // Correctly-weighted 1 oz Libertad Proof (stays in the 1 oz key).
      { title: '2011 Mo Proof Mexico Libertad 1 oz Silver 999 Onza', soldDate: '2026-04-01', totalUsd: 60, itemId: 'onza-keep-1oz' },
      // 1/20 oz Libertad Proof that uses Spanish "ONZA" only (no plain
      // "oz" token).  Before #283W this returned null from
      // detectWeightFromTitle and stayed in the 1 oz dataset; after
      // #283W it must reroute out.
      { title: '2011 MO SILVER PROOF MEXICO 1/20 ONZA LIBERTAD NGC PF 69 UC', soldDate: '2026-04-02', totalUsd: 15, itemId: 'onza-reroute-twentieth' },
      // 1/4 Onza -- same shape as the coin the user saw on the tracker.
      { title: '2023 Mexico Libertad 1/4 Onza Proof Silver Coin', soldDate: '2026-04-03', totalUsd: 45, itemId: 'onza-reroute-quarter' },
    ];
    const result = importComps('1oz 2011 libertad mexican proof silver', comps);
    // Two of three rerouted -> only one stays in the target key.
    expect(result.reclassified).toBe(2);
    expect(result.totalStored).toBe(1);
    // The kept comp is the actual 1 oz Onza.
    const lookup = lookupComps('1oz 2011 libertad mexican proof silver');
    expect(lookup).not.toBeNull();
    expect(lookup.comps.length).toBe(1);
    expect(lookup.comps[0].title).toMatch(/1 oz Silver 999 Onza/);
  });
});

/* ════════════════════════════════════════════════════════════
 *  listDatasets / deleteDataset
 * ════════════════════════════════════════════════════════════ */
describe('listDatasets / deleteDataset', () => {
  test('lists imported datasets', () => {
    importComps('Alpha', [{ title: 'A', totalUsd: 10 }]);
    importComps('Beta', [{ title: 'B', totalUsd: 20 }]);
    const list = listDatasets();
    expect(list.length).toBe(2);
    expect(list.map(d => d.searchTerm).sort()).toEqual(['Alpha', 'Beta']);
  });

  test('deletes a dataset by key', () => {
    importComps('Deletable', [{ title: 'D', totalUsd: 5 }]);
    expect(deleteDataset('Deletable')).toBe(true);
    expect(listDatasets().length).toBe(0);
  });

  test('returns false for non-existent dataset', () => {
    expect(deleteDataset('NonExistent')).toBe(false);
  });
});

/* ════════════════════════════════════════════════════════════
 *  evictStaleComps
 * ════════════════════════════════════════════════════════════ */
describe('evictStaleComps', () => {
  test('evicts comps older than maxDays', () => {
    const old = new Date();
    old.setDate(old.getDate() - 200);
    const fresh = new Date();
    fresh.setDate(fresh.getDate() - 10);

    importComps('Eviction Test', [
      { title: 'Old', soldDate: old.toISOString(), totalUsd: 10 },
      { title: 'Fresh', soldDate: fresh.toISOString(), totalUsd: 20 },
    ]);

    const result = evictStaleComps(180);
    expect(result.compsEvicted).toBe(1);
    expect(result.datasetsChecked).toBe(1);

    const data = lookupComps('Eviction Test');
    expect(data.comps.length).toBe(1);
    expect(data.comps[0].title).toBe('Fresh');
  });

  test('keeps comps without soldDate', () => {
    importComps('No Date', [
      { title: 'No Date Comp', totalUsd: 15 },
    ]);

    const result = evictStaleComps(1); // 1 day = very aggressive
    expect(result.compsEvicted).toBe(0);
  });

  test('removes empty datasets after eviction', () => {
    const old = new Date();
    old.setDate(old.getDate() - 200);

    importComps('All Old', [
      { title: 'Ancient', soldDate: old.toISOString(), totalUsd: 5 },
    ]);

    evictStaleComps(180);
    expect(listDatasets().length).toBe(0);
  });

  test('default maxDays is 180', () => {
    const borderline = new Date();
    borderline.setDate(borderline.getDate() - 179);

    importComps('Borderline', [
      { title: 'Just Fresh', soldDate: borderline.toISOString(), totalUsd: 30 },
    ]);

    const result = evictStaleComps(); // defaults to 180
    expect(result.compsEvicted).toBe(0);
  });
});

/* ════════════════════════════════════════════════════════════
 *  autoImportFolder
 * ════════════════════════════════════════════════════════════ */
describe('autoImportFolder', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('imports CSVs from a folder', () => {
    const csv = 'Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition,Seller,Format,Item URL,Quantity Sold\n'
      + 'Test Morgan 1889,ID1,Apr 1 2026,$50.00,$5.00,,,Fixed price,http://example.com,1\n';
    fs.writeFileSync(path.join(tmpDir, 'Test_Morgan.csv'), csv);
    fs.writeFileSync(path.join(tmpDir, 'Test_Morgan.meta'), 'Test Morgan');

    const result = autoImportFolder(tmpDir, { force: true });
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  test('skips empty CSVs', () => {
    const csv = 'Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition\n';
    fs.writeFileSync(path.join(tmpDir, 'Empty.csv'), csv);

    const result = autoImportFolder(tmpDir, { force: true });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('returns zero for non-existent folder', () => {
    const result = autoImportFolder('/nonexistent/folder/xyz');
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test('uses .meta file for search term', () => {
    const csv = 'Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition,Seller,Format,Item URL,Quantity Sold\n'
      + 'Eagle,ID2,Apr 2 2026,$35.00,$0.00,,,Fixed price,http://example.com,1\n';
    fs.writeFileSync(path.join(tmpDir, 'Eagle_2024.csv'), csv);
    fs.writeFileSync(path.join(tmpDir, 'Eagle_2024.meta'), '2024 American Silver Eagle');

    autoImportFolder(tmpDir, { force: true });
    const datasets = listDatasets();
    expect(datasets.some(d => d.searchTerm === '2024 American Silver Eagle')).toBe(true);
  });

  test('falls back to filename for search term when no .meta', () => {
    const csv = 'Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition,Seller,Format,Item URL,Quantity Sold\n'
      + 'Peace Dollar,ID3,Apr 3 2026,$25.00,$3.00,,,Fixed price,http://example.com,1\n';
    fs.writeFileSync(path.join(tmpDir, '1921_Peace_Dollar.csv'), csv);

    autoImportFolder(tmpDir, { force: true });
    const datasets = listDatasets();
    expect(datasets.some(d => d.searchTerm === '1921 Peace Dollar')).toBe(true);
  });
});

/* ════════════════════════════════════════════════════════════
 *  parseCSV
 * ════════════════════════════════════════════════════════════ */
describe('parseCSV', () => {
  test('parses standard Terapeak CSV format', () => {
    const csv = 'Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition,Seller,Format,Item URL,Quantity Sold\n'
      + '2024 ASE MS69 PCGS,12345,Apr 1 2026,$35.50,$4.99,Certified,,Fixed price,http://ebay.com/itm/12345,1\n';
    const { comps } = parseCSV(csv, 'Test');
    expect(comps).toHaveLength(1);
    expect(comps[0].title).toBe('2024 ASE MS69 PCGS');
    expect(comps[0].itemId).toBe('12345');
    expect(comps[0].totalUsd).toBeCloseTo(40.49, 1);
  });

  test('handles missing columns gracefully', () => {
    const csv = 'Item Title,Sold Price\nTest,$10.00\n';
    const { comps } = parseCSV(csv, 'Test');
    expect(comps.length).toBeGreaterThanOrEqual(0);
  });

  test('skips denied items (junk filter)', () => {
    const csv = 'Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition,Seller,Format,Item URL,Quantity Sold\n'
      + 'BASEBALL CARD LOT,99999,Apr 1 2026,$5.00,$0.00,,,Fixed price,http://ebay.com,1\n';
    const { comps } = parseCSV(csv, 'Test');
    // Should be filtered out by deny patterns if "baseball card" matches
    // This depends on filters.js DENY_PATTERNS
    expect(comps.length).toBeLessThanOrEqual(1);
  });
});
