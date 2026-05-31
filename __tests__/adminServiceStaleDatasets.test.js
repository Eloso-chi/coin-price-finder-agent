// __tests__/adminServiceStaleDatasets.test.js
// Backlog #229: verify getStaleDatasets() applies the same refresh-skip
// exclusions as scripts/generate-freshness-report.js.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-stale-'));
process.env.TERAPEAK_DATA_DIR = tmpDir;

jest.mock('../src/services/terapeakService');
const terapeakService = require('../src/services/terapeakService');
const adminService = require('../src/services/adminService');
const { THRESHOLDS } = require('../src/services/freshnessClassifier');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────
const NOW = Date.now();
function daysAgo(n) {
  return new Date(NOW - n * 86_400_000).toISOString();
}
function dateAgo(n) {
  return daysAgo(n).split('T')[0];
}

/**
 * Build a fake dataset entry shaped like terapeakService.listDatasets() output.
 */
function makeDataset(key, am, compCount) {
  return {
    key,
    searchTerm: key,
    compCount: compCount != null ? compCount : (am.compCount || 0),
    lastImport: am.lastRefreshAt || null,
    importCount: 1,
    aggregationMeta: am,
  };
}

function setDatasets(list) {
  terapeakService.listDatasets.mockReturnValue(list);
}

// ── Tests ───────────────────────────────────────────────────

describe('getStaleDatasets exclusions (#229)', () => {
  test('excludes recently-confirmed-stale by default', () => {
    setDatasets([
      makeDataset('recent-stale', {
        newestSaleDate: dateAgo(40),       // very-stale
        lastRefreshAt: daysAgo(5),         // scraped <14d ago
        refreshCount: 1,
      }, 50), // viable
      makeDataset('actionable-stale', {
        newestSaleDate: dateAgo(40),
        lastRefreshAt: daysAgo(30),        // scraped >14d ago
        refreshCount: 1,
      }, 50),
    ]);

    const { stale, summary } = adminService.getStaleDatasets({ days: 30, limit: 50 });
    const keys = stale.map(s => s.searchTerm);
    expect(keys).toContain('actionable-stale');
    expect(keys).not.toContain('recent-stale');
    expect(summary.skippedByReason['recently-confirmed-stale']).toBe(1);
  });

  test('excludes dormant datasets', () => {
    setDatasets([
      makeDataset('dormant', {
        newestSaleDate: dateAgo(60),
        noDataCount: 3,
        noDataAt: daysAgo(10),             // within DORMANT_WINDOW_DAYS
      }, 50),
      makeDataset('actionable', {
        newestSaleDate: dateAgo(60),
        lastRefreshAt: daysAgo(30),
      }, 50),
    ]);

    const { stale, summary } = adminService.getStaleDatasets({ days: 30, limit: 50 });
    const keys = stale.map(s => s.searchTerm);
    expect(keys).toContain('actionable');
    expect(keys).not.toContain('dormant');
    expect(summary.skippedByReason.dormant).toBe(1);
  });

  test('excludes dry-refresh-backoff tier 1 (>=2 dry within 30d)', () => {
    setDatasets([
      makeDataset('tier1-backoff', {
        newestSaleDate: dateAgo(40),
        lastRefreshAt: daysAgo(20),        // within tier1 30d window
        refreshCount: 5,
        consecutiveDryRefreshes: THRESHOLDS.DRY_REFRESH_TIER1,
      }, 50),
    ]);
    const { stale, summary } = adminService.getStaleDatasets({ days: 30, limit: 50 });
    expect(stale.find(s => s.searchTerm === 'tier1-backoff')).toBeUndefined();
    expect(summary.skippedByReason['dry-refresh-backoff']).toBe(1);
  });

  test('excludes dry-refresh-backoff tier 2 (>=4 dry within 60d)', () => {
    setDatasets([
      makeDataset('tier2-backoff', {
        newestSaleDate: dateAgo(60),
        lastRefreshAt: daysAgo(45),        // outside tier1 (30d) but inside tier2 (60d)
        refreshCount: 6,
        consecutiveDryRefreshes: THRESHOLDS.DRY_REFRESH_TIER2,
      }, 50),
    ]);
    const { stale, summary } = adminService.getStaleDatasets({ days: 30, limit: 50 });
    expect(stale.find(s => s.searchTerm === 'tier2-backoff')).toBeUndefined();
    expect(summary.skippedByReason['dry-refresh-backoff']).toBe(1);
  });

  test('excludes confirmed-thin (compCount<10 + refreshCount>=3 within 90d)', () => {
    setDatasets([
      makeDataset('confirmed-thin', {
        newestSaleDate: dateAgo(40),
        lastRefreshAt: daysAgo(30),        // <90d cadence -> skip
        refreshCount: 5,
      }, 5), // <10 -> thin; refreshCount>=3 -> confirmed-thin
    ]);
    const { stale, summary } = adminService.getStaleDatasets({ days: 30, limit: 50 });
    expect(stale.find(s => s.searchTerm === 'confirmed-thin')).toBeUndefined();
    expect(summary.skippedByReason['confirmed-thin-skip']).toBe(1);
  });

  test('excludes thin-wait (compCount<10 + refreshCount<3 within 60d)', () => {
    setDatasets([
      makeDataset('thin-wait', {
        newestSaleDate: dateAgo(40),
        lastRefreshAt: daysAgo(20),        // <60d cadence -> skip
        refreshCount: 1,
      }, 3), // <10 -> thin (not yet confirmed)
    ]);
    const { stale, summary } = adminService.getStaleDatasets({ days: 30, limit: 50 });
    expect(stale.find(s => s.searchTerm === 'thin-wait')).toBeUndefined();
    expect(summary.skippedByReason['thin-wait']).toBe(1);
  });

  test('includeSkipped=true returns skipped rows with skipReason populated', () => {
    setDatasets([
      makeDataset('recent-stale', {
        newestSaleDate: dateAgo(40),
        lastRefreshAt: daysAgo(5),
        refreshCount: 1,
      }, 50),
      makeDataset('dormant', {
        newestSaleDate: dateAgo(60),
        noDataCount: 3,
        noDataAt: daysAgo(10),
      }, 50),
    ]);

    const { stale, summary } = adminService.getStaleDatasets({
      days: 30,
      limit: 50,
      includeSkipped: true,
    });
    const recent = stale.find(s => s.searchTerm === 'recent-stale');
    const dormant = stale.find(s => s.searchTerm === 'dormant');
    expect(recent?.skipReason).toBe('recently-confirmed-stale');
    expect(dormant?.skipReason).toBe('dormant');
    expect(summary.includeSkipped).toBe(true);
    expect(summary.skippedCount).toBe(2);
  });

  test('filterRegex never includes skipped datasets', () => {
    setDatasets([
      makeDataset('recent-stale', {
        newestSaleDate: dateAgo(40),
        lastRefreshAt: daysAgo(5),
        refreshCount: 1,
      }, 50),
      makeDataset('actionable', {
        newestSaleDate: dateAgo(40),
        lastRefreshAt: daysAgo(30),
        refreshCount: 1,
      }, 50),
    ]);

    // includeSkipped=true so skipped rows are present, but filterRegex must still omit them
    const { summary } = adminService.getStaleDatasets({
      days: 30,
      limit: 50,
      includeSkipped: true,
    });
    expect(summary.filterRegex).toContain('actionable');
    expect(summary.filterRegex).not.toContain('recent-stale');
  });

  test('viable stale with no recent refresh and no dry refreshes is actionable', () => {
    setDatasets([
      makeDataset('clean-stale', {
        newestSaleDate: dateAgo(20),       // stale (>=15d)
        lastRefreshAt: daysAgo(20),        // outside RECENTLY_REFRESHED_DAYS
        refreshCount: 1,
        consecutiveDryRefreshes: 0,
      }, 30),
    ]);
    const { stale, summary } = adminService.getStaleDatasets({ days: 15, limit: 50 });
    expect(stale.find(s => s.searchTerm === 'clean-stale')).toBeDefined();
    expect(summary.skippedCount).toBe(0);
  });
});
