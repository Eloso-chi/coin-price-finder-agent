// __tests__/adminService.test.js — Unit tests for adminService
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Set TERAPEAK_DATA_DIR before requiring service
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-test-'));
process.env.TERAPEAK_DATA_DIR = tmpDir;

// Mock dependent services
jest.mock('../src/services/authService');
jest.mock('../src/services/coinStorageService');
jest.mock('../src/services/terapeakService');
jest.mock('../src/services/terapeakQuotaService');

const authService = require('../src/services/authService');
const coinStorage = require('../src/services/coinStorageService');
const terapeakService = require('../src/services/terapeakService');
const quotaService = require('../src/services/terapeakQuotaService');

const adminService = require('../src/services/adminService');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── _analyzeCSV ─────────────────────────────────────────────

describe('_analyzeCSV', () => {
  test('parses CSV with valid sold dates', () => {
    const csv = path.join(tmpDir, 'test1.csv');
    fs.writeFileSync(csv,
      'Item Title,Item ID,Sold Date,Sold Price\n' +
      'Coin A,111,"Jan 5, 2026",$100.00\n' +
      'Coin B,222,"Mar 15, 2026",$200.00\n' +
      'Coin C,333,"Feb 10, 2026",$150.00\n'
    );

    const result = adminService._analyzeCSV(csv);
    expect(result.compCount).toBe(3);
    expect(new Date(result.newestSoldDate).getMonth()).toBe(2); // March
    expect(new Date(result.oldestSoldDate).getMonth()).toBe(0); // January
  });

  test('returns null for empty file', () => {
    const csv = path.join(tmpDir, 'empty.csv');
    fs.writeFileSync(csv, '');
    expect(adminService._analyzeCSV(csv)).toBeNull();
  });

  test('returns zero compCount for header-only file', () => {
    const csv = path.join(tmpDir, 'header-only.csv');
    fs.writeFileSync(csv, 'Item Title,Item ID,Sold Date,Sold Price\n');
    const result = adminService._analyzeCSV(csv);
    expect(result.compCount).toBe(0);
    expect(result.newestSoldDate).toBeNull();
  });

  test('handles rows with missing dates', () => {
    const csv = path.join(tmpDir, 'missing-dates.csv');
    fs.writeFileSync(csv,
      'Item Title,Item ID,Sold Date,Sold Price\n' +
      'Coin A,111,,$100.00\n' +
      'Coin B,222,"Apr 1, 2026",$200.00\n'
    );
    const result = adminService._analyzeCSV(csv);
    expect(result.compCount).toBe(2);
    expect(result.newestSoldDate).not.toBeNull();
  });

  test('returns null for nonexistent file', () => {
    expect(adminService._analyzeCSV('/nonexistent/file.csv')).toBeNull();
  });
});

// ── _listCSVFiles ───────────────────────────────────────────

describe('_listCSVFiles', () => {
  test('lists only .csv files', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.csv'), 'h\n');
    fs.writeFileSync(path.join(tmpDir, 'a.meta'), 'term');
    fs.writeFileSync(path.join(tmpDir, 'b.csv'), 'h\n');
    const files = adminService._listCSVFiles();
    const csvFiles = files.filter(f => f.endsWith('.csv'));
    expect(csvFiles.length).toBeGreaterThanOrEqual(2);
    expect(files.every(f => f.endsWith('.csv'))).toBe(true);
  });
});

// ── getStaleDatasets ────────────────────────────────────────

describe('getStaleDatasets', () => {
  beforeEach(() => {
    terapeakService.listDatasets.mockReset();
  });

  test('identifies stale datasets based on days threshold', () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const oldStr = new Date(Date.now() - 60 * 86_400_000).toISOString().split('T')[0];

    terapeakService.listDatasets.mockReturnValue([
      { key: 'fresh', searchTerm: 'fresh coin', compCount: 5, aggregationMeta: { newestSaleDate: todayStr } },
      { key: 'stale', searchTerm: 'stale coin', compCount: 3, aggregationMeta: { newestSaleDate: oldStr } },
    ]);

    const result = adminService.getStaleDatasets({ days: 30 });
    expect(result.summary.totalCSVs).toBe(2);
    expect(result.summary.staleCount).toBe(1);
    expect(result.summary.freshCount).toBe(1);
    expect(result.stale.length).toBe(1);
    expect(result.stale[0].file).toBe('stale');
  });

  test('respects limit parameter', () => {
    const datasets = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(Date.now() - (90 + i) * 86_400_000).toISOString().split('T')[0];
      datasets.push({ key: `old${i}`, searchTerm: `old coin ${i}`, compCount: 1, aggregationMeta: { newestSaleDate: d } });
    }
    terapeakService.listDatasets.mockReturnValue(datasets);

    const result = adminService.getStaleDatasets({ days: 30, limit: 3 });
    expect(result.stale.length).toBe(3);
  });

  test('generates filter regex', () => {
    const oldStr = new Date(Date.now() - 60 * 86_400_000).toISOString().split('T')[0];
    terapeakService.listDatasets.mockReturnValue([
      { key: 'morgan 1921', searchTerm: '1921 Morgan Silver Dollar', compCount: 2, aggregationMeta: { newestSaleDate: oldStr } },
    ]);

    const result = adminService.getStaleDatasets({ days: 30 });
    expect(result.summary.filterRegex).toContain('1921 Morgan Silver Dollar');
  });

  test('empty CSVs have null age (only returned with includeSkipped)', () => {
    terapeakService.listDatasets.mockReturnValue([
      { key: 'stub', searchTerm: 'stub coin', compCount: 0, aggregationMeta: {} },
    ]);

    // Default: excluded as 'empty' by freshnessClassifier (#229)
    const def = adminService.getStaleDatasets({ days: 30 });
    expect(def.stale.find(s => s.file === 'stub')).toBeUndefined();
    expect(def.summary.skippedByReason.empty).toBe(1);

    // includeSkipped=true: returned with skipReason populated
    const all = adminService.getStaleDatasets({ days: 30, includeSkipped: true });
    const stub = all.stale.find(s => s.file === 'stub');
    expect(stub).toBeDefined();
    expect(stub.ageDays).toBeNull();
    expect(stub.skipReason).toBe('empty');
  });
});

// ── getDatasetHealth ────────────────────────────────────────

describe('getDatasetHealth', () => {
  beforeEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
  });

  test('returns correct totals', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.csv'),
      'Item Title,Item ID,Sold Date,Sold Price\nC1,1,"Jan 1, 2026",$10\nC2,2,"Feb 1, 2026",$20\n');
    fs.writeFileSync(path.join(tmpDir, 'b.csv'),
      'Item Title,Item ID,Sold Date,Sold Price\nC3,3,"Mar 1, 2026",$30\n');
    fs.writeFileSync(path.join(tmpDir, 'empty.csv'),
      'Item Title,Item ID,Sold Date,Sold Price\n');

    const h = adminService.getDatasetHealth();
    expect(h.totalCSVs).toBe(3);
    expect(h.totalComps).toBe(3);
    expect(h.emptyCSVs).toBe(1);
    expect(h.avgCompsPerCSV).toBe(1); // 3 comps / 3 files
    expect(h.oldestData).not.toBeNull();
    expect(h.newestData).not.toBeNull();
  });

  test('handles empty directory', () => {
    const h = adminService.getDatasetHealth();
    expect(h.totalCSVs).toBe(0);
    expect(h.totalComps).toBe(0);
  });
});

// ── getDashboardStats ───────────────────────────────────────

describe('getDashboardStats', () => {
  test('aggregates stats from all services', () => {
    authService.listUsers.mockReturnValue([
      { username: 'alice', userId: 'u1', createdAt: '2026-01-01T00:00:00Z' },
      { username: 'bob', userId: 'u2', createdAt: '2026-02-01T00:00:00Z' },
    ]);
    coinStorage.count.mockImplementation(uid => uid === 'u1' ? 10 : 5);
    terapeakService.listDatasets.mockReturnValue([
      { key: 'k1', compCount: 100 },
      { key: 'k2', compCount: 200 },
    ]);
    quotaService.getStatus.mockReturnValue({
      date: '2026-04-20', used: 42, remaining: 208, limit: 250,
    });

    const stats = adminService.getDashboardStats();

    expect(stats.users.totalUsers).toBe(2);
    expect(stats.users.users[0].coinCount).toBe(10);
    expect(stats.users.users[1].coinCount).toBe(5);
    expect(stats.data.totalDatasets).toBe(2);
    expect(stats.data.totalComps).toBe(300);
    expect(stats.quota.used).toBe(42);
    expect(stats.quota.remaining).toBe(208);
    expect(typeof stats.uptime).toBe('number');
  });

  test('handles empty state', () => {
    authService.listUsers.mockReturnValue([]);
    terapeakService.listDatasets.mockReturnValue([]);
    quotaService.getStatus.mockReturnValue({
      date: '2026-04-20', used: 0, remaining: 250, limit: 250,
    });

    const stats = adminService.getDashboardStats();
    expect(stats.users.totalUsers).toBe(0);
    expect(stats.data.totalDatasets).toBe(0);
    expect(stats.data.totalComps).toBe(0);
  });
});
