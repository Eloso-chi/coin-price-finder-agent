'use strict';

/**
 * adminRouteCoverage.test.js -- Coverage for /api/admin endpoints
 * not covered by the existing adminRoute.test.js.
 *
 * Coverage gap pin (test-coverage Tier 3): src/routes/adminRoute.js was
 * at 60.5% line / 44.4% function coverage after Tier 1+2. The existing
 * adminRoute.test.js covers /dashboard, /stale-datasets, /data-health,
 * /terapeak-meta. This file adds:
 *   GET  /prefetch-status   (success + 500 path)
 *   POST /prefetch-trigger  (202 on trigger + 500 on exception)
 *   GET  /pcgs-quota
 *   GET  /auction-history   (input guards + happy path + 500)
 *   POST /auction-fetch     (input guards + happy path + 500)
 */

jest.mock('../src/services/adminService');
jest.mock('../src/services/prefetchScheduler', () => ({
  getSchedulerStatus: jest.fn(),
  triggerManual: jest.fn(),
}));
jest.mock('../src/services/pcgsQuotaService', () => ({
  getStatus: jest.fn(),
}));
jest.mock('../src/services/auctionPriceService', () => ({
  getHistory: jest.fn(),
  fetchByGrade: jest.fn(),
}));

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const adminRoute = require('../src/routes/adminRoute');
const prefetchScheduler = require('../src/services/prefetchScheduler');
const pcgsQuotaService = require('../src/services/pcgsQuotaService');
const auctionPriceService = require('../src/services/auctionPriceService');

const TEST_KEY = 'test-admin-key-12345';
let server, baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
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
    baseUrl = `http://127.0.0.1:${s.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });

beforeEach(() => jest.clearAllMocks());

function req(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const opts = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers: { 'x-api-key': TEST_KEY, ...headers },
    };
    let data = null;
    if (body != null) {
      data = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

// ============================================================
//  GET /prefetch-status
// ============================================================

describe('GET /api/admin/prefetch-status', () => {
  test('returns scheduler status', async () => {
    prefetchScheduler.getSchedulerStatus.mockReturnValue({
      running: false,
      lastRun: '2024-06-10T12:00:00Z',
      callsMade: 12,
    });
    const res = await req('GET', '/api/admin/prefetch-status');
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(false);
    expect(res.body.callsMade).toBe(12);
  });

  test('returns 500 when scheduler throws', async () => {
    prefetchScheduler.getSchedulerStatus.mockImplementation(() => {
      throw new Error('manifest read failure');
    });
    const res = await req('GET', '/api/admin/prefetch-status');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/prefetch status/i);
  });

  test('401 without API key', async () => {
    const res = await req('GET', '/api/admin/prefetch-status', { 'x-api-key': '' });
    expect(res.status).toBe(401);
  });
});

// ============================================================
//  POST /prefetch-trigger
// ============================================================

describe('POST /api/admin/prefetch-trigger', () => {
  test('returns 202 and the trigger response on success', async () => {
    prefetchScheduler.triggerManual.mockReturnValue({
      triggered: true,
      runId: 'run-1234',
    });
    const res = await req('POST', '/api/admin/prefetch-trigger');
    expect(res.status).toBe(202);
    expect(res.body.triggered).toBe(true);
    expect(res.body.runId).toBe('run-1234');
  });

  test('returns 500 when trigger throws', async () => {
    prefetchScheduler.triggerManual.mockImplementation(() => {
      throw new Error('already running');
    });
    const res = await req('POST', '/api/admin/prefetch-trigger');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/already running/);
  });

  test('401 without API key', async () => {
    const res = await req('POST', '/api/admin/prefetch-trigger', { 'x-api-key': '' });
    expect(res.status).toBe(401);
  });
});

// ============================================================
//  GET /pcgs-quota
// ============================================================

describe('GET /api/admin/pcgs-quota', () => {
  test('returns quota status', async () => {
    pcgsQuotaService.getStatus.mockReturnValue({
      used: 42, remaining: 458, limit: 500,
    });
    const res = await req('GET', '/api/admin/pcgs-quota');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ used: 42, remaining: 458, limit: 500 });
  });

  test('401 without API key', async () => {
    const res = await req('GET', '/api/admin/pcgs-quota', { 'x-api-key': '' });
    expect(res.status).toBe(401);
  });
});

// ============================================================
//  GET /auction-history
// ============================================================

describe('GET /api/admin/auction-history', () => {
  test('returns history for valid pcgsNo + grade', async () => {
    auctionPriceService.getHistory.mockReturnValue({
      records: [{ Date: '06-2024', Price: 250 }],
      stats: { count: 1 },
    });
    const res = await req('GET', '/api/admin/auction-history?pcgsNo=7130&grade=65');
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(auctionPriceService.getHistory).toHaveBeenCalledWith(7130, 65);
  });

  test('400 when pcgsNo missing', async () => {
    const res = await req('GET', '/api/admin/auction-history?grade=65');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pcgsNo/i);
  });

  test('400 when grade missing', async () => {
    const res = await req('GET', '/api/admin/auction-history?pcgsNo=7130');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/grade/i);
  });

  test('400 when pcgsNo is not numeric', async () => {
    const res = await req('GET', '/api/admin/auction-history?pcgsNo=abc&grade=65');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pcgsNo/i);
  });

  test('500 when getHistory throws', async () => {
    auctionPriceService.getHistory.mockImplementation(() => {
      throw new Error('storage read failure');
    });
    const res = await req('GET', '/api/admin/auction-history?pcgsNo=7130&grade=65');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/auction history/i);
  });

  test('401 without API key', async () => {
    const res = await req('GET',
      '/api/admin/auction-history?pcgsNo=7130&grade=65',
      { 'x-api-key': '' });
    expect(res.status).toBe(401);
  });
});

// ============================================================
//  POST /auction-fetch
// ============================================================

describe('POST /api/admin/auction-fetch', () => {
  test('returns fetch result for valid query params', async () => {
    auctionPriceService.fetchByGrade.mockResolvedValue({
      records: [{ Date: '06-2024', Price: 250 }],
      stats: { count: 1 },
      fromCache: false,
      newRecords: 1,
    });
    const res = await req('POST', '/api/admin/auction-fetch?pcgsNo=7130&grade=65');
    expect(res.status).toBe(200);
    expect(res.body.newRecords).toBe(1);
    expect(auctionPriceService.fetchByGrade).toHaveBeenCalledWith(7130, 65,
      { force: true });
  });

  test('accepts pcgsNo + grade from JSON body when query missing', async () => {
    auctionPriceService.fetchByGrade.mockResolvedValue({
      records: [], stats: { count: 0 }, fromCache: false, newRecords: 0,
    });
    const res = await req('POST', '/api/admin/auction-fetch', {},
      { pcgsNo: 7296, grade: 65 });
    expect(res.status).toBe(200);
    expect(auctionPriceService.fetchByGrade).toHaveBeenCalledWith(7296, 65,
      { force: true });
  });

  test('400 when pcgsNo missing from both query and body', async () => {
    const res = await req('POST', '/api/admin/auction-fetch?grade=65');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pcgsNo/i);
  });

  test('400 when grade missing from both query and body', async () => {
    const res = await req('POST', '/api/admin/auction-fetch?pcgsNo=7130');
    expect(res.status).toBe(400);
  });

  test('400 when pcgsNo is not numeric', async () => {
    const res = await req('POST', '/api/admin/auction-fetch?pcgsNo=xyz&grade=65');
    expect(res.status).toBe(400);
  });

  test('500 when fetchByGrade rejects (e.g. PCGS API key missing)', async () => {
    auctionPriceService.fetchByGrade.mockRejectedValue(
      new Error('PCGS API key not configured'));
    const res = await req('POST', '/api/admin/auction-fetch?pcgsNo=7130&grade=65');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/PCGS API key/i);
  });

  test('500 propagates network/upstream failures', async () => {
    auctionPriceService.fetchByGrade.mockRejectedValue(new Error('ETIMEDOUT'));
    const res = await req('POST', '/api/admin/auction-fetch?pcgsNo=7130&grade=65');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ETIMEDOUT/);
  });

  test('401 without API key', async () => {
    const res = await req('POST',
      '/api/admin/auction-fetch?pcgsNo=7130&grade=65',
      { 'x-api-key': '' });
    expect(res.status).toBe(401);
  });
});
