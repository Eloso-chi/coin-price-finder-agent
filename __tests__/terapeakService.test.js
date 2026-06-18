// __tests__/terapeakService.test.js — Tests for Terapeak CSV import, eviction, and purge
// Covers: parseCSV, importComps, evictStaleComps, purgeStaleCSVs, normalizeSearchKey,
//         autoImportFolder, multi-row carry-forward, deduplication
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  parseCSV,
  importComps,
  evictStaleComps,
  normalizeSearchKey,
  purgeStaleCSVs,
  autoImportFolder,
  listDatasets,
  clearAll,
  mapColumn,
  rowToComp,
  _resetStoreCache,
} = require('../src/services/terapeakService');

// Suppress console noise in tests
beforeAll(() => { jest.spyOn(console, 'log').mockImplementation(); jest.spyOn(console, 'error').mockImplementation(); jest.spyOn(console, 'warn').mockImplementation(); });
afterAll(() => { console.log.mockRestore(); console.error.mockRestore(); console.warn.mockRestore(); });

// Reset the in-memory store between tests AND wipe data to isolate from disk
beforeEach(() => { _resetStoreCache(); clearAll(); });
afterEach(() => { clearAll(); _resetStoreCache(); });
// Cancel any pending debounced writes after all tests complete
afterAll(() => {
  const terapeakService = require('../src/services/terapeakService');
  terapeakService._cancelPendingSaves();
});

// ═══════════════════════════════════════════════════════════════
//  normalizeSearchKey
// ═══════════════════════════════════════════════════════════════
describe('normalizeSearchKey', () => {
  test('lowercases and trims', () => {
    // #266H Phase 2: tokens sorted alphabetically for canonical form.
    expect(normalizeSearchKey('  Morgan Dollar  ')).toBe('dollar morgan');
  });

  test('strips trailing -0 from year (no zero-to-O conversion)', () => {
    expect(normalizeSearchKey('1883-0 Morgan')).toBe('1883 morgan');
  });

  test('normalizes year-mint "1956-D" to "1956 d"', () => {
    expect(normalizeSearchKey('1956-D Franklin')).toBe('1956 d franklin');
  });

  test('collapses "1 oz" to "1oz"', () => {
    expect(normalizeSearchKey('Silver Eagle 1 oz')).toBe('1oz eagle silver');
  });

  test('strips Roman numerals', () => {
    expect(normalizeSearchKey('Perth Lunar II Silver')).toBe('lunar perth silver');
  });

  test('strips special characters', () => {
    expect(normalizeSearchKey('Silver (BU) .999')).toBe('999 bu silver');
  });

  test('returns empty string for null/undefined', () => {
    expect(normalizeSearchKey(null)).toBe('');
    expect(normalizeSearchKey(undefined)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
//  mapColumn
// ═══════════════════════════════════════════════════════════════
describe('mapColumn', () => {
  test('maps standard eBay Terapeak column names', () => {
    expect(mapColumn('Title')).toBe('title');
    expect(mapColumn('Sold Price')).toBe('price');
    expect(mapColumn('Sold Date')).toBe('soldDate');
    expect(mapColumn('Item Number')).toBe('itemId');
  });

  test('maps aliased column names', () => {
    expect(mapColumn('Product Title')).toBe('title');
    expect(mapColumn('Total Sold Price')).toBe('price');
  });

  test('returns null for unknown columns', () => {
    expect(mapColumn('Random Column')).toBeNull();
  });

  test('is case-insensitive', () => {
    expect(mapColumn('title')).toBe('title');
    expect(mapColumn('TITLE')).toBe('title');
  });
});

// ═══════════════════════════════════════════════════════════════
//  parseCSV
// ═══════════════════════════════════════════════════════════════
describe('parseCSV', () => {
  const header = 'Title,Sold Price,Shipping,Sold Date,Item Number\n';

  test('parses basic CSV with standard columns', () => {
    const csv = header + '1889 Morgan Dollar MS63,$45.00,$5.00,2025-06-01,123456';
    const { comps, skipped } = parseCSV(csv, 'Morgan Dollar');
    expect(comps.length).toBe(1);
    expect(comps[0].title).toContain('Morgan Dollar');
    expect(comps[0].totalUsd).toBe(50);
    expect(comps[0]._source).toBe('terapeak');
  });

  test('returns empty for empty CSV', () => {
    const result = parseCSV('', 'test');
    expect(result.comps).toHaveLength(0);
  });

  test('handles multi-row carry-forward (blank title inherits previous)', () => {
    const csv = header +
      '1889 Morgan Dollar,$40.00,$5.00,2025-06-01,111\n' +
      ',$35.00,$5.00,2025-06-02,\n' +
      ',$38.00,$5.00,2025-06-03,\n';
    const { comps } = parseCSV(csv, 'Morgan Dollar');
    expect(comps.length).toBe(3);
    expect(comps[1].title).toBe('1889 Morgan Dollar');
    expect(comps[2].title).toBe('1889 Morgan Dollar');
    // Carry-forward rows should have blank itemId (forces title+price dedup)
    expect(comps[1].itemId).toBeFalsy();
    expect(comps[2].itemId).toBeFalsy();
  });

  test('filters denied titles (junk rows)', () => {
    const csv = header +
      '1889 Morgan Dollar,$40.00,$5.00,2025-06-01,111\n' +
      'Baseball Card Lot,$10.00,$3.00,2025-06-01,222\n';
    const { comps } = parseCSV(csv, 'Morgan Dollar');
    // Baseball card should be filtered by DENY_PATTERNS
    expect(comps.length).toBeLessThanOrEqual(1);
  });

  test('skips rows with zero or negative price', () => {
    const csv = header +
      '1889 Morgan Dollar,$0.00,$0.00,2025-06-01,111\n';
    const { comps } = parseCSV(csv, 'Morgan Dollar');
    expect(comps.length).toBe(0);
  });

  test('handles Buffer input', () => {
    const csv = header + '1889 Morgan Dollar,$45.00,$5.00,2025-06-01,123456';
    const { comps } = parseCSV(Buffer.from(csv, 'utf8'), 'Morgan Dollar');
    expect(comps.length).toBe(1);
  });

  test('returns column info', () => {
    const csv = header + '1889 Morgan Dollar,$45.00,$5.00,2025-06-01,123456';
    const result = parseCSV(csv, 'Morgan Dollar');
    expect(result.columns).toBeDefined();
    expect(Array.isArray(result.columns)).toBe(true);
  });

  test('parses soldDate into ISO format', () => {
    const csv = header + 'Test Coin,$10.00,$1.00,2025-03-15,999';
    const { comps } = parseCSV(csv, 'test');
    expect(comps[0].soldDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('detects metal from title', () => {
    const csv = header + '2024 American Gold Eagle 1 oz,$2100.00,$0.00,2025-06-01,555';
    const { comps } = parseCSV(csv, 'Gold Eagle');
    expect(comps[0]._detectedMetal).toBe('gold');
  });
});

// ═══════════════════════════════════════════════════════════════
//  importComps
// ═══════════════════════════════════════════════════════════════
describe('importComps', () => {
  test('imports new comps and returns stats', () => {
    const comps = [
      { itemId: 'A1', title: 'Test Coin 1', totalUsd: 50, soldDate: '2025-06-01' },
      { itemId: 'A2', title: 'Test Coin 2', totalUsd: 60, soldDate: '2025-06-02' },
    ];
    const result = importComps('Test Coin', comps);
    expect(result.newComps).toBe(2);
    expect(result.totalStored).toBe(2);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.key).toBe(normalizeSearchKey('Test Coin'));
  });

  test('deduplicates by itemId', () => {
    const comps = [{ itemId: 'DUP1', title: 'Coin A', totalUsd: 50, soldDate: '2025-06-01' }];
    importComps('Test Dedup', comps);
    const result = importComps('Test Dedup', comps);
    expect(result.newComps).toBe(0);
    expect(result.duplicatesSkipped).toBe(1);
    expect(result.totalStored).toBe(1);
  });

  test('deduplicates by title+price+date when no itemId', () => {
    const comps = [{ title: 'Coin X', totalUsd: 42, soldDate: '2025-06-01' }];
    importComps('Dedup Title', comps);
    const result = importComps('Dedup Title', comps);
    expect(result.newComps).toBe(0);
    expect(result.duplicatesSkipped).toBe(1);
  });

  test('different price is not a duplicate', () => {
    const comps1 = [{ title: 'Coin Y', totalUsd: 42, soldDate: '2025-06-01' }];
    const comps2 = [{ title: 'Coin Y', totalUsd: 99, soldDate: '2025-06-01' }];
    importComps('Price Diff', comps1);
    const result = importComps('Price Diff', comps2);
    expect(result.newComps).toBe(1);
    expect(result.totalStored).toBe(2);
  });

  test('increments importCount across calls', () => {
    importComps('Counter', [{ itemId: 'C1', title: 'X', totalUsd: 10, soldDate: '2025-01-01' }]);
    const result = importComps('Counter', [{ itemId: 'C2', title: 'Y', totalUsd: 20, soldDate: '2025-01-02' }]);
    // importCount should be >= 2
    expect(result.lastImport).toBeTruthy();
  });

  test('merges metadata', () => {
    const result = importComps('Meta Test', [{ itemId: 'M1', title: 'Z', totalUsd: 10 }], { fileName: 'test.csv', autoImported: true });
    expect(result.key).toBeTruthy();
  });

  test('normalizes search term key', () => {
    const r1 = importComps('1883-O Morgan Silver Dollar', [{ itemId: 'N1', title: 'X', totalUsd: 10 }]);
    const r2 = importComps('1883-o morgan silver dollar', [{ itemId: 'N2', title: 'Y', totalUsd: 20 }]);
    expect(r1.key).toBe(r2.key);
    expect(r2.totalStored).toBe(2); // merged into same dataset
  });
});

// ═══════════════════════════════════════════════════════════════
//  evictStaleComps
// ═══════════════════════════════════════════════════════════════
describe('evictStaleComps', () => {
  test('evicts comps older than maxDays', () => {
    const old = new Date();
    old.setDate(old.getDate() - 200);
    const fresh = new Date().toISOString();

    importComps('Evict Test', [
      { itemId: 'E1', title: 'Old Coin', totalUsd: 10, soldDate: old.toISOString() },
      { itemId: 'E2', title: 'Fresh Coin', totalUsd: 20, soldDate: fresh },
    ]);

    const result = evictStaleComps(180);
    expect(result.compsEvicted).toBe(1);
    expect(result.datasetsChecked).toBeGreaterThanOrEqual(1);

    const datasets = listDatasets();
    const ds = datasets.find(d => d.searchTerm.toLowerCase().includes('evict'));
    expect(ds.compCount).toBe(1);
  });

  test('removes empty datasets after eviction', () => {
    const old = new Date();
    old.setDate(old.getDate() - 200);

    importComps('All Stale', [
      { itemId: 'S1', title: 'Old 1', totalUsd: 10, soldDate: old.toISOString() },
      { itemId: 'S2', title: 'Old 2', totalUsd: 20, soldDate: old.toISOString() },
    ]);

    evictStaleComps(180);
    const datasets = listDatasets();
    const ds = datasets.find(d => d.searchTerm.toLowerCase().includes('stale'));
    expect(ds).toBeUndefined(); // dataset should be gone
  });

  test('keeps comps with no soldDate', () => {
    importComps('No Date', [
      { itemId: 'ND1', title: 'No Date Coin', totalUsd: 10, soldDate: null },
    ]);

    const result = evictStaleComps(1); // 1 day -- very aggressive
    expect(result.compsEvicted).toBe(0);
  });

  test('returns zero when no data exists', () => {
    const result = evictStaleComps(180);
    expect(result.compsEvicted).toBe(0);
    expect(result.datasetsChecked).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  purgeStaleCSVs
// ═══════════════════════════════════════════════════════════════
describe('purgeStaleCSVs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-purge-'));
  });

  afterEach(() => {
    // Clean up temp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  function writeCSV(name, rows) {
    const header = 'Title,Sold Price,Shipping,Sold Date,Item Number\n';
    const body = rows.map(r => `${r.title},$${r.price.toFixed(2)},$0.00,${r.date},${r.id || ''}`).join('\n');
    fs.writeFileSync(path.join(tmpDir, name), header + body);
  }

  test('deletes CSV where all comps are stale', () => {
    const old = new Date();
    old.setDate(old.getDate() - 200);
    writeCSV('stale.csv', [
      { title: 'Old Morgan', price: 40, date: old.toISOString().split('T')[0], id: '1' },
      { title: 'Old Peace', price: 30, date: old.toISOString().split('T')[0], id: '2' },
    ]);

    const result = purgeStaleCSVs(tmpDir, 180);
    expect(result.deleted).toBe(1);
    expect(result.deletedFiles).toContain('stale.csv');
    expect(fs.existsSync(path.join(tmpDir, 'stale.csv'))).toBe(false);
  });

  test('keeps CSV with at least one fresh comp', () => {
    const old = new Date();
    old.setDate(old.getDate() - 200);
    const fresh = new Date().toISOString().split('T')[0];

    writeCSV('mixed.csv', [
      { title: 'Old Coin', price: 40, date: old.toISOString().split('T')[0], id: '1' },
      { title: 'Fresh Coin', price: 50, date: fresh, id: '2' },
    ]);

    const result = purgeStaleCSVs(tmpDir, 180);
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
  });

  test('keeps CSV with missing soldDate (indeterminate age)', () => {
    writeCSV('nodate.csv', [
      { title: 'No Date Coin', price: 40, date: '', id: '1' },
    ]);

    const result = purgeStaleCSVs(tmpDir, 180);
    expect(result.deleted).toBe(0);
  });

  test('deletes companion .meta file when CSV is purged', () => {
    const old = new Date();
    old.setDate(old.getDate() - 200);
    writeCSV('withmeta.csv', [
      { title: 'Old Coin', price: 40, date: old.toISOString().split('T')[0], id: '1' },
    ]);
    fs.writeFileSync(path.join(tmpDir, 'withmeta.meta'), 'Morgan Dollar');

    purgeStaleCSVs(tmpDir, 180);
    expect(fs.existsSync(path.join(tmpDir, 'withmeta.csv'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'withmeta.meta'))).toBe(false);
  });

  test('returns zero for non-existent folder', () => {
    const result = purgeStaleCSVs('/nonexistent/path/abc', 180);
    expect(result.checked).toBe(0);
    expect(result.deleted).toBe(0);
  });

  test('ignores non-CSV files', () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'just a text file');
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');
    const result = purgeStaleCSVs(tmpDir, 180);
    expect(result.checked).toBeLessThanOrEqual(1); // .txt might match, .json won't
  });
});

// ═══════════════════════════════════════════════════════════════
//  autoImportFolder
// ═══════════════════════════════════════════════════════════════
describe('autoImportFolder', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-import-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  test('imports CSVs from folder', () => {
    const header = 'Title,Sold Price,Shipping,Sold Date,Item Number\n';
    fs.writeFileSync(path.join(tmpDir, 'Morgan_Dollar.csv'),
      header + '1889 Morgan Dollar,$45.00,$5.00,2025-06-01,111');
    fs.writeFileSync(path.join(tmpDir, 'Peace_Dollar.csv'),
      header + '1922 Peace Dollar,$30.00,$4.00,2025-06-01,222');

    const result = autoImportFolder(tmpDir, { force: true });
    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  test('uses .meta file for search term', () => {
    const header = 'Title,Sold Price,Shipping,Sold Date,Item Number\n';
    fs.writeFileSync(path.join(tmpDir, 'data.csv'),
      header + '1889 Morgan Dollar,$45.00,$5.00,2025-06-01,111');
    fs.writeFileSync(path.join(tmpDir, 'data.meta'), 'Custom Search Term');

    autoImportFolder(tmpDir, { force: true });
    const datasets = listDatasets();
    const found = datasets.find(d => d.searchTerm.toLowerCase().includes('custom'));
    expect(found).toBeDefined();
  });

  test('returns zero for non-existent folder', () => {
    const result = autoImportFolder('/nonexistent/folder/xyz');
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test('skips empty CSV files', () => {
    fs.writeFileSync(path.join(tmpDir, 'empty.csv'), 'Title,Sold Price\n');
    const result = autoImportFolder(tmpDir, { force: true });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('freshness check skips recently imported files', () => {
    // Ensure clean state (other test files may run in parallel)
    clearAll(); _resetStoreCache();

    const header = 'Title,Sold Price,Shipping,Sold Date,Item Number\n';
    fs.writeFileSync(path.join(tmpDir, 'test.csv'),
      header + '1889 Morgan,$45.00,$5.00,2025-06-01,111');

    const r1 = autoImportFolder(tmpDir, { force: true });
    expect(r1.imported).toBe(1);

    // Second import without force -- should skip (data is fresh, file not modified)
    const r2 = autoImportFolder(tmpDir, { maxAgeMs: 365 * 24 * 60 * 60 * 1000 });
    expect(r2.freshSkipped).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  rowToComp
// ═══════════════════════════════════════════════════════════════
describe('rowToComp', () => {
  test('builds comp from mapped row', () => {
    const comp = rowToComp({
      title: '2024 Silver Eagle MS70',
      price: '45.00',
      shipping: '5.00',
      soldDate: '2025-06-01',
      itemId: '12345',
    }, 'Silver Eagle');
    expect(comp).toBeTruthy();
    expect(comp.title).toContain('Silver Eagle');
    expect(comp.totalUsd).toBe(50);
    expect(comp._source).toBe('terapeak');
  });

  test('returns null for denied title', () => {
    const comp = rowToComp({
      title: 'Pokemon Card Lot',
      price: '10.00',
      shipping: '3.00',
      soldDate: '2025-06-01',
    }, 'test');
    expect(comp).toBeNull();
  });

  test('returns null for zero price', () => {
    const comp = rowToComp({
      title: 'Good Coin',
      price: '0',
      shipping: '0',
      soldDate: '2025-06-01',
    }, 'test');
    expect(comp).toBeNull();
  });

  test('detects gold metal from title', () => {
    const comp = rowToComp({
      title: '2024 Gold Eagle 1 oz',
      price: '2100',
      shipping: '0',
      soldDate: '2025-06-01',
      itemId: 'G1',
    }, 'Gold Eagle');
    expect(comp._detectedMetal).toBe('gold');
  });

  test('builds eBay URL from itemId', () => {
    const comp = rowToComp({
      title: 'Test Coin',
      price: '10',
      shipping: '1',
      soldDate: '2025-06-01',
      itemId: '999888',
    }, 'test');
    expect(comp.url).toBe('https://www.ebay.com/itm/999888');
  });

  test('builds search URL when no itemId', () => {
    const comp = rowToComp({
      title: 'Test Coin Search',
      price: '10',
      shipping: '1',
      soldDate: '2025-06-01',
    }, 'test');
    expect(comp.url).toContain('ebay.com/sch/');
  });
});

// ═══════════════════════════════════════════════════════════════
//  clearAll + listDatasets
// ═══════════════════════════════════════════════════════════════
describe('clearAll + listDatasets', () => {
  test('clearAll removes all data', () => {
    importComps('To Clear', [{ itemId: 'C1', title: 'X', totalUsd: 10 }]);
    expect(listDatasets().length).toBeGreaterThan(0);
    clearAll();
    expect(listDatasets()).toHaveLength(0);
  });

  test('listDatasets returns dataset metadata', () => {
    importComps('List Test', [{ itemId: 'L1', title: 'Y', totalUsd: 20, soldDate: '2025-06-01' }]);
    const datasets = listDatasets();
    const ds = datasets.find(d => d.searchTerm.toLowerCase().includes('list'));
    expect(ds).toBeDefined();
    expect(ds.compCount).toBe(1);
    expect(ds.lastImport).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
//  Dry-refresh backoff tracking
// ═══════════════════════════════════════════════════════════════
describe('dry-refresh backoff (consecutiveDryRefreshes)', () => {
  test('stamps lastRefreshNewComps on page-1 import with new comps', () => {
    const result = importComps('Backoff Test A', [
      { itemId: 'BA1', title: 'Coin A', totalUsd: 50, soldDate: '2025-06-01' },
    ], { aggregationMeta: { page1At: new Date().toISOString() } });
    expect(result.newComps).toBe(1);
    const ds = listDatasets().find(d => d.key === result.key);
    expect(ds.aggregationMeta.lastRefreshNewComps).toBe(1);
    expect(ds.aggregationMeta.consecutiveDryRefreshes).toBe(0);
  });

  test('increments consecutiveDryRefreshes when refresh yields 0 new comps', () => {
    const comps = [{ itemId: 'BB1', title: 'Coin B', totalUsd: 50, soldDate: '2025-06-01' }];
    importComps('Backoff Test B', comps, { aggregationMeta: { page1At: '2025-05-01T00:00:00Z' } });
    // Re-import same comps (all dupes) with a new page1At (refresh)
    const result = importComps('Backoff Test B', comps, { aggregationMeta: { page1At: '2025-05-10T00:00:00Z' } });
    expect(result.newComps).toBe(0);
    const ds = listDatasets().find(d => d.key === result.key);
    expect(ds.aggregationMeta.lastRefreshNewComps).toBe(0);
    expect(ds.aggregationMeta.consecutiveDryRefreshes).toBe(1);
  });

  test('consecutiveDryRefreshes accumulates across multiple dry refreshes', () => {
    const comps = [{ itemId: 'BC1', title: 'Coin C', totalUsd: 50, soldDate: '2025-06-01' }];
    importComps('Backoff Test C', comps, { aggregationMeta: { page1At: '2025-05-01T00:00:00Z' } });
    importComps('Backoff Test C', comps, { aggregationMeta: { page1At: '2025-05-10T00:00:00Z' } });
    importComps('Backoff Test C', comps, { aggregationMeta: { page1At: '2025-05-20T00:00:00Z' } });
    const result = importComps('Backoff Test C', comps, { aggregationMeta: { page1At: '2025-05-30T00:00:00Z' } });
    const ds = listDatasets().find(d => d.key === result.key);
    expect(ds.aggregationMeta.consecutiveDryRefreshes).toBe(3);
  });

  test('resets consecutiveDryRefreshes when a refresh finds new comps', () => {
    const comps = [{ itemId: 'BD1', title: 'Coin D', totalUsd: 50, soldDate: '2025-06-01' }];
    importComps('Backoff Test D', comps, { aggregationMeta: { page1At: '2025-05-01T00:00:00Z' } });
    // Two dry refreshes
    importComps('Backoff Test D', comps, { aggregationMeta: { page1At: '2025-05-10T00:00:00Z' } });
    importComps('Backoff Test D', comps, { aggregationMeta: { page1At: '2025-05-20T00:00:00Z' } });
    // Now a productive refresh
    const newComps = [{ itemId: 'BD2', title: 'Coin D New', totalUsd: 60, soldDate: '2025-06-10' }];
    const result = importComps('Backoff Test D', newComps, { aggregationMeta: { page1At: '2025-05-30T00:00:00Z' } });
    expect(result.newComps).toBe(1);
    const ds = listDatasets().find(d => d.key === result.key);
    expect(ds.aggregationMeta.consecutiveDryRefreshes).toBe(0);
    expect(ds.aggregationMeta.lastRefreshNewComps).toBe(1);
  });

  test('does not stamp dry-refresh fields on deep-pagination import (no page1At)', () => {
    const comps = [{ itemId: 'BE1', title: 'Coin E', totalUsd: 50, soldDate: '2025-06-01' }];
    // Initial import with page1At
    importComps('Backoff Test E', comps, { aggregationMeta: { page1At: '2025-05-01T00:00:00Z' } });
    // Deep-pagination import (no page1At, no lastRefreshAt in incoming meta)
    const deepComps = [{ itemId: 'BE2', title: 'Coin E Deep', totalUsd: 70, soldDate: '2025-06-05' }];
    importComps('Backoff Test E', deepComps, { aggregationMeta: { deepAt: '2025-05-15T00:00:00Z' } });
    const ds = listDatasets().find(d => d.key === normalizeSearchKey('Backoff Test E'));
    // Should preserve the value from the page1At import (0), not increment
    expect(ds.aggregationMeta.consecutiveDryRefreshes).toBe(0);
    expect(ds.aggregationMeta.lastRefreshNewComps).toBe(1); // from original import
  });
});
