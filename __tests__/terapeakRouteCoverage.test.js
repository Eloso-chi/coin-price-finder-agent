'use strict';

/**
 * terapeakRouteCoverage.test.js -- Extra route coverage for
 * src/routes/terapeakRoute.js.
 *
 * Coverage gap pin (test-coverage Tier 2): the existing
 * terapeakRoute.test.js covers admin auth, datasets, lookup, quota
 * status, import-text validation, dataset management. It does NOT
 * cover the quota mutation endpoints, purge-stale-csvs, reimport,
 * aggregation-status filters, scrape-status redirect, or
 * report-no-data. This file plugs those gaps.
 *
 * Route line coverage before this file: 38.53 percent.
 */

const TEST_ADMIN_KEY = 'test-admin-api-key-32chars!!!!!';
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

// ── Service mocks ──────────────────────────────────────────
const mockListDatasets = jest.fn(() => []);
const mockUpdateDatasetMeta = jest.fn();
const mockImportComps = jest.fn(() => ({ stored: 0, duplicates: 0 }));
const mockAutoImportFromBlob = jest.fn(async () => ({ imported: 0 }));
const mockAutoImportFolder = jest.fn(() => ({ imported: 0 }));
const mockPurgeStaleCSVs = jest.fn(() => ({ deleted: 0, kept: 0 }));
const mockNormalizeSearchKey = jest.fn(s => String(s).toLowerCase().replace(/\s+/g, '-'));

jest.mock('../src/services/terapeakService', () => ({
  parseCSV: jest.fn(),
  importComps: (...args) => mockImportComps(...args),
  listDatasets: (...args) => mockListDatasets(...args),
  lookupComps: jest.fn(),
  detectMetal: jest.fn(() => 'silver'),
  deleteDataset: jest.fn(() => true),
  deleteAllDatasets: jest.fn(() => 0),
  purgeStaleCSVs: (...args) => mockPurgeStaleCSVs(...args),
  autoImportFromBlob: (...args) => mockAutoImportFromBlob(...args),
  autoImportFolder: (...args) => mockAutoImportFolder(...args),
  updateDatasetMeta: (...args) => mockUpdateDatasetMeta(...args),
  normalizeSearchKey: (...args) => mockNormalizeSearchKey(...args),
}));

jest.mock('../src/services/terapeakQuotaService', () => ({
  getStatus: jest.fn(() => ({ used: 5, remaining: 95, limit: 100, ok: true })),
  recordQueries: jest.fn(() => ({ ok: true, used: 6, remaining: 94, limit: 100, warning: null })),
  setUsed: jest.fn((u) => ({ used: u, remaining: 100 - u, limit: 100 })),
  resetToday: jest.fn(() => ({ used: 0, remaining: 100, limit: 100 })),
  setLimit: jest.fn((l) => ({ used: 0, remaining: l, limit: l })),
}));

jest.mock('../src/utils/blobClient', () => ({
  isEnabled: jest.fn(() => false),
}));

jest.mock('../src/services/ebayService', () => ({
  clearCache: jest.fn(),
}));

const http = require('http');
const express = require('express');
const terapeakRoute = require('../src/routes/terapeakRoute');
const quotaService = require('../src/services/terapeakQuotaService');
const blobClient = require('../src/utils/blobClient');

let app, server, baseUrl;

beforeAll((done) => {
  app = express();
  app.use('/api/terapeak', terapeakRoute);
  server = app.listen(0, () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  mockListDatasets.mockReturnValue([]);
});

// ── HTTP helper ────────────────────────────────────────────
function request(method, p, body, apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + p);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (apiKey) opts.headers['x-api-key'] = apiKey;
    let data = null;
    if (body != null) {
      data = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: buf, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (data != null) req.write(data);
    req.end();
  });
}

// ============================================================
//  POST /quota/record
// ============================================================

describe('POST /quota/record', () => {
  test('requires admin (401 anonymous)', async () => {
    const { status } = await request('POST', '/api/terapeak/quota/record', { count: 3 });
    expect(status).toBe(401);
  });

  test('records arbitrary count with note', async () => {
    const { status, body } = await request('POST', '/api/terapeak/quota/record',
      { count: 5, note: 'manual sync' }, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(quotaService.recordQueries).toHaveBeenCalledWith(5, 'manual sync');
  });

  test('defaults to 1 when count is missing or invalid', async () => {
    await request('POST', '/api/terapeak/quota/record', {}, TEST_ADMIN_KEY);
    expect(quotaService.recordQueries).toHaveBeenCalledWith(1, '');
  });

  test('clamps count to minimum 1 (negative count is treated as 1)', async () => {
    await request('POST', '/api/terapeak/quota/record',
      { count: -10 }, TEST_ADMIN_KEY);
    // Math.max(1, parseInt(-10) || 1) = Math.max(1, -10) = 1
    expect(quotaService.recordQueries).toHaveBeenCalledWith(1, '');
  });
});

// ============================================================
//  POST /quota/set-used
// ============================================================

describe('POST /quota/set-used', () => {
  test('requires admin', async () => {
    const { status } = await request('POST', '/api/terapeak/quota/set-used', { used: 50 });
    expect(status).toBe(401);
  });

  test('rejects missing/invalid used (400)', async () => {
    const { status, body } = await request('POST', '/api/terapeak/quota/set-used',
      {}, TEST_ADMIN_KEY);
    expect(status).toBe(400);
    expect(body.error).toMatch(/used/i);
  });

  test('rejects negative used (400)', async () => {
    const { status } = await request('POST', '/api/terapeak/quota/set-used',
      { used: -5 }, TEST_ADMIN_KEY);
    expect(status).toBe(400);
  });

  test('accepts valid used (200)', async () => {
    const { status, body } = await request('POST', '/api/terapeak/quota/set-used',
      { used: 42 }, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body.used).toBe(42);
    expect(quotaService.setUsed).toHaveBeenCalledWith(42);
  });

  test('accepts used = 0 (boundary)', async () => {
    const { status } = await request('POST', '/api/terapeak/quota/set-used',
      { used: 0 }, TEST_ADMIN_KEY);
    expect(status).toBe(200);
  });
});

// ============================================================
//  POST /quota/reset
// ============================================================

describe('POST /quota/reset', () => {
  test('requires admin', async () => {
    const { status } = await request('POST', '/api/terapeak/quota/reset');
    expect(status).toBe(401);
  });

  test('resets quota when admin key provided', async () => {
    const { status, body } = await request('POST', '/api/terapeak/quota/reset', null, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body.used).toBe(0);
    expect(quotaService.resetToday).toHaveBeenCalled();
  });
});

// ============================================================
//  POST /quota/set-limit
// ============================================================

describe('POST /quota/set-limit', () => {
  test('requires admin', async () => {
    const { status } = await request('POST', '/api/terapeak/quota/set-limit', { limit: 500 });
    expect(status).toBe(401);
  });

  test('rejects missing limit (400)', async () => {
    const { status } = await request('POST', '/api/terapeak/quota/set-limit',
      {}, TEST_ADMIN_KEY);
    expect(status).toBe(400);
  });

  test('rejects zero or negative limit (400)', async () => {
    const r1 = await request('POST', '/api/terapeak/quota/set-limit', { limit: 0 }, TEST_ADMIN_KEY);
    const r2 = await request('POST', '/api/terapeak/quota/set-limit', { limit: -5 }, TEST_ADMIN_KEY);
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });

  test('accepts a positive limit', async () => {
    const { status, body } = await request('POST', '/api/terapeak/quota/set-limit',
      { limit: 250 }, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body.limit).toBe(250);
    expect(quotaService.setLimit).toHaveBeenCalledWith(250);
  });
});

// ============================================================
//  POST /purge-stale-csvs
// ============================================================

describe('POST /purge-stale-csvs', () => {
  test('requires admin', async () => {
    const { status } = await request('POST', '/api/terapeak/purge-stale-csvs', {});
    expect(status).toBe(401);
  });

  test('uses default maxDays=180 when body is empty', async () => {
    const { status } = await request('POST', '/api/terapeak/purge-stale-csvs', {}, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(mockPurgeStaleCSVs).toHaveBeenCalledWith(expect.any(String), 180);
  });

  test('respects custom maxDays from body', async () => {
    const { status, body } = await request('POST', '/api/terapeak/purge-stale-csvs',
      { maxDays: 90 }, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(mockPurgeStaleCSVs).toHaveBeenCalledWith(expect.any(String), 90);
  });
});

// ============================================================
//  POST /reimport
// ============================================================

describe('POST /reimport', () => {
  test('requires admin', async () => {
    const { status } = await request('POST', '/api/terapeak/reimport', {});
    expect(status).toBe(401);
  });

  test('skips blob import when not configured', async () => {
    blobClient.isEnabled.mockReturnValue(false);
    const { status, body } = await request('POST', '/api/terapeak/reimport',
      {}, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.blob).toEqual({ skipped: true, reason: 'Blob storage not configured' });
    expect(mockAutoImportFromBlob).not.toHaveBeenCalled();
  });

  test('runs blob import when blob is enabled', async () => {
    blobClient.isEnabled.mockReturnValue(true);
    mockAutoImportFromBlob.mockResolvedValueOnce({ imported: 3 });
    mockAutoImportFolder.mockReturnValueOnce({ imported: 2 });
    const { status, body } = await request('POST', '/api/terapeak/reimport',
      { force: true }, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body.totalImported).toBe(5);
    expect(body.force).toBe(true);
    expect(mockAutoImportFromBlob).toHaveBeenCalledWith({ force: true });
  });

  test('returns 500 on service exception', async () => {
    blobClient.isEnabled.mockReturnValue(true);
    mockAutoImportFromBlob.mockRejectedValueOnce(new Error('blob fetch failed'));
    const { status, body } = await request('POST', '/api/terapeak/reimport',
      {}, TEST_ADMIN_KEY);
    expect(status).toBe(500);
    expect(body.error).toMatch(/blob fetch failed/);
  });
});

// ============================================================
//  GET /aggregation-status -- filters
// ============================================================

describe('GET /aggregation-status', () => {
  const DATASETS = [
    { key: 'k1', searchTerm: 'morgan dollar 1881', compCount: 100,
      aggregationMeta: { page1At: '2024-01-01', deepAt: '2024-01-02', newestSaleDate: '2024-05-01' },
      identifiers: { is_low_volume_candidate: false } },
    { key: 'k2', searchTerm: 'barber quarter 1900', compCount: 20,
      aggregationMeta: { page1At: '2024-01-01' },
      identifiers: { is_low_volume_candidate: true } },
    { key: 'k3', searchTerm: 'walking liberty half 1942', compCount: 60,
      aggregationMeta: {} },
    { key: 'k4', searchTerm: 'silver eagle 2024', compCount: 80,
      aggregationMeta: { noDataAt: '2024-06-01' } },
  ];

  beforeEach(() => mockListDatasets.mockReturnValue(DATASETS));

  test('requires admin', async () => {
    const { status } = await request('GET', '/api/terapeak/aggregation-status');
    expect(status).toBe(401);
  });

  test('returns summary + dataset list', async () => {
    const { status, body } = await request('GET', '/api/terapeak/aggregation-status',
      null, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body).toHaveProperty('summary');
    expect(body.summary.total).toBe(4);
    expect(body.summary.withPage1).toBe(2);
    expect(body.summary.withDeep).toBe(1);
    expect(body.summary.needsDeep).toBe(3);
    expect(Array.isArray(body.datasets)).toBe(true);
  });

  test('needs=deep filter returns only datasets without deepAt', async () => {
    const { body } = await request('GET', '/api/terapeak/aggregation-status?needs=deep',
      null, TEST_ADMIN_KEY);
    const keys = body.datasets.map(d => d.key);
    expect(keys).not.toContain('k1');
    expect(keys).toEqual(expect.arrayContaining(['k2', 'k3', 'k4']));
  });

  test('needs=page1 filter returns only datasets without page1At', async () => {
    const { body } = await request('GET', '/api/terapeak/aggregation-status?needs=page1',
      null, TEST_ADMIN_KEY);
    const keys = body.datasets.map(d => d.key);
    expect(keys).toEqual(expect.arrayContaining(['k3', 'k4']));
    expect(keys).not.toContain('k1');
    expect(keys).not.toContain('k2');
  });

  test('minComps filter excludes small datasets', async () => {
    const { body } = await request('GET', '/api/terapeak/aggregation-status?minComps=50',
      null, TEST_ADMIN_KEY);
    const keys = body.datasets.map(d => d.key);
    expect(keys).not.toContain('k2'); // compCount 20
    expect(keys).toEqual(expect.arrayContaining(['k1', 'k3', 'k4']));
  });

  test('excludeLowVolume=1 drops low-volume candidates', async () => {
    const { body } = await request('GET',
      '/api/terapeak/aggregation-status?excludeLowVolume=1',
      null, TEST_ADMIN_KEY);
    const keys = body.datasets.map(d => d.key);
    expect(keys).not.toContain('k2');
    expect(body.summary.excluded.lowVolume).toBe(1);
  });

  test('excludeBarberNonHalf=1 drops Barber quarter/dime/dollar', async () => {
    const { body } = await request('GET',
      '/api/terapeak/aggregation-status?excludeBarberNonHalf=1',
      null, TEST_ADMIN_KEY);
    const keys = body.datasets.map(d => d.key);
    expect(keys).not.toContain('k2'); // "barber quarter"
    expect(body.summary.excluded.barberNonHalf).toBe(1);
  });

  test('excludeNoData=1 drops datasets with noDataAt', async () => {
    const { body } = await request('GET',
      '/api/terapeak/aggregation-status?excludeNoData=1',
      null, TEST_ADMIN_KEY);
    const keys = body.datasets.map(d => d.key);
    expect(keys).not.toContain('k4');
    expect(body.summary.excluded.noData).toBe(1);
  });
});

// ============================================================
//  GET /scrape-status -- backward-compat redirect
// ============================================================

describe('GET /scrape-status', () => {
  test('requires admin', async () => {
    const { status } = await request('GET', '/api/terapeak/scrape-status');
    expect(status).toBe(401);
  });

  test('redirects 307 to /aggregation-status preserving query string', async () => {
    const { status, headers } = await request('GET',
      '/api/terapeak/scrape-status?needs=deep&minComps=50', null, TEST_ADMIN_KEY);
    expect(status).toBe(307);
    expect(headers.location).toContain('/api/terapeak/aggregation-status');
    expect(headers.location).toContain('needs=deep');
    expect(headers.location).toContain('minComps=50');
  });
});

// ============================================================
//  POST /report-no-data
// ============================================================

describe('POST /report-no-data', () => {
  test('requires admin', async () => {
    const { status } = await request('POST', '/api/terapeak/report-no-data',
      { searchTerm: 'morgan' });
    expect(status).toBe(401);
  });

  test('rejects missing searchTerm (400)', async () => {
    const { status, body } = await request('POST', '/api/terapeak/report-no-data',
      {}, TEST_ADMIN_KEY);
    expect(status).toBe(400);
    expect(body.error).toMatch(/searchTerm/i);
  });

  test('rejects non-string searchTerm (400)', async () => {
    const { status } = await request('POST', '/api/terapeak/report-no-data',
      { searchTerm: 123 }, TEST_ADMIN_KEY);
    expect(status).toBe(400);
  });

  test('increments noDataCount on first call (starts at 1)', async () => {
    mockListDatasets.mockReturnValue([]); // no existing entry
    mockUpdateDatasetMeta.mockReturnValue({
      key: 'morgan-dollar-1881',
      aggregationMeta: { noDataCount: 1, noDataAt: '2024-06-01T00:00:00Z' },
    });
    const { status, body } = await request('POST', '/api/terapeak/report-no-data',
      { searchTerm: 'morgan dollar 1881' }, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body.noDataCount).toBe(1);
    expect(mockUpdateDatasetMeta).toHaveBeenCalledWith('morgan dollar 1881',
      expect.objectContaining({ noDataCount: 1 }));
  });

  test('increments noDataCount when prior count exists', async () => {
    mockListDatasets.mockReturnValue([{
      key: 'morgan-dollar-1881',
      aggregationMeta: { noDataCount: 3, noDataAt: '2024-05-01T00:00:00Z' },
    }]);
    mockNormalizeSearchKey.mockReturnValue('morgan-dollar-1881');
    mockUpdateDatasetMeta.mockReturnValue({
      key: 'morgan-dollar-1881',
      aggregationMeta: { noDataCount: 4, noDataAt: '2024-06-01T00:00:00Z' },
    });
    const { status, body } = await request('POST', '/api/terapeak/report-no-data',
      { searchTerm: 'morgan dollar 1881' }, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body.noDataCount).toBe(4);
    expect(mockUpdateDatasetMeta).toHaveBeenCalledWith('morgan dollar 1881',
      expect.objectContaining({ noDataCount: 4 }));
  });
});
