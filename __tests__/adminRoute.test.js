// __tests__/adminRoute.test.js — Integration tests for /api/admin/* endpoints
'use strict';

jest.mock('../src/services/adminService');
const adminService = require('../src/services/adminService');

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const adminRoute = require('../src/routes/adminRoute');

const TEST_KEY = 'test-admin-key-12345';

let server, baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());

  // Replicate requireAdmin middleware inline for testing
  app.use('/api/admin', (req, res, next) => {
    const provided = req.headers['x-api-key'] || '';
    if (provided.length !== TEST_KEY.length ||
        !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TEST_KEY))) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
  }, adminRoute);

  const s = http.createServer(app);
  s.listen(0, () => {
    server = s;
    const { port } = s.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Helper ──────────────────────────────────────────────────
function req(method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'x-api-key': TEST_KEY, ...headers },
    };
    const r = http.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

// ── Auth ────────────────────────────────────────────────────

describe('auth', () => {
  test('401 without API key', async () => {
    const res = await req('GET', '/api/admin/dashboard', { 'x-api-key': '' });
    expect(res.status).toBe(401);
  });

  test('401 with wrong API key', async () => {
    const res = await req('GET', '/api/admin/dashboard', { 'x-api-key': 'wrong-key-xxxxxxxxxx' });
    expect(res.status).toBe(401);
  });
});

// ── GET /api/admin/dashboard ────────────────────────────────

describe('GET /api/admin/dashboard', () => {
  test('returns dashboard stats', async () => {
    adminService.getDashboardStats.mockReturnValue({
      users: { totalUsers: 2, users: [] },
      data: { totalDatasets: 100, totalComps: 5000 },
      quota: { date: '2026-04-20', used: 10, remaining: 240, limit: 250 },
      uptime: 3600,
    });

    const res = await req('GET', '/api/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.users.totalUsers).toBe(2);
    expect(res.body.data.totalComps).toBe(5000);
    expect(res.body.quota.used).toBe(10);
  });

  test('500 on service error', async () => {
    adminService.getDashboardStats.mockImplementation(() => { throw new Error('boom'); });
    const res = await req('GET', '/api/admin/dashboard');
    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});

// ── GET /api/admin/stale-datasets ───────────────────────────

describe('GET /api/admin/stale-datasets', () => {
  test('returns stale datasets with default params', async () => {
    adminService.getStaleDatasets.mockReturnValue({
      stale: [{ file: 'test', searchTerm: 'Test Coin', compCount: 50, ageDays: 45 }],
      summary: { totalCSVs: 100, staleCount: 1, freshCount: 99, staleDays: 30, filterRegex: '' },
    });

    const res = await req('GET', '/api/admin/stale-datasets');
    expect(res.status).toBe(200);
    expect(res.body.stale).toHaveLength(1);
    expect(res.body.summary.totalCSVs).toBe(100);
    expect(adminService.getStaleDatasets).toHaveBeenCalledWith({ days: 30, limit: 50 });
  });

  test('passes custom days and limit', async () => {
    adminService.getStaleDatasets.mockReturnValue({
      stale: [],
      summary: { totalCSVs: 100, staleCount: 0, freshCount: 100, staleDays: 60, filterRegex: '' },
    });

    const res = await req('GET', '/api/admin/stale-datasets?days=60&limit=25');
    expect(res.status).toBe(200);
    expect(adminService.getStaleDatasets).toHaveBeenCalledWith({ days: 60, limit: 25 });
  });

  test('clamps days to valid range', async () => {
    adminService.getStaleDatasets.mockReturnValue({
      stale: [],
      summary: { totalCSVs: 0, staleCount: 0, freshCount: 0, staleDays: 1, filterRegex: '' },
    });

    await req('GET', '/api/admin/stale-datasets?days=0&limit=999');
    expect(adminService.getStaleDatasets).toHaveBeenCalledWith({ days: 1, limit: 500 });
  });
});

// ── GET /api/admin/data-health ──────────────────────────────

describe('GET /api/admin/data-health', () => {
  test('returns data health stats', async () => {
    adminService.getDatasetHealth.mockReturnValue({
      totalCSVs: 850,
      totalComps: 45000,
      emptyCSVs: 30,
      avgCompsPerCSV: 53,
      oldestData: '2023-06-01T00:00:00.000Z',
      newestData: '2026-04-19T00:00:00.000Z',
    });

    const res = await req('GET', '/api/admin/data-health');
    expect(res.status).toBe(200);
    expect(res.body.totalCSVs).toBe(850);
    expect(res.body.totalComps).toBe(45000);
    expect(res.body.emptyCSVs).toBe(30);
  });

  test('500 on service error', async () => {
    adminService.getDatasetHealth.mockImplementation(() => { throw new Error('disk error'); });
    const res = await req('GET', '/api/admin/data-health');
    expect(res.status).toBe(500);
  });
});
