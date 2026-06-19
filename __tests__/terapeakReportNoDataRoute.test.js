// __tests__/terapeakReportNoDataRoute.test.js
// Backlog #271H Item 4: regression coverage for POST /api/terapeak/report-no-data.
// Prior to this file the endpoint had zero test coverage. Cases mirror the
// shape of __tests__/terapeakImport422SelfHeal.test.js (same mocked
// terapeakService, same in-process express harness).
//
// Acceptance points (#271H):
//   - 400 on missing / non-string searchTerm.
//   - 200 + meta-write on a new dataset (noDataCount stamped to 1).
//   - 200 + monotonic increment on an existing entry with noDataCount=1.
//   - Cap at NO_DATA_CAP (5) -- prevCount=5 must NOT produce noDataCount=6.
//   - Response payload shape preserved (status, key, noDataCount, noDataAt).
//   - Meta-write failure must NOT leak a 500 -- response is 200 with a
//     warning marker (#271H Item 3 throw-safety).

'use strict';

const TEST_ADMIN_KEY = 'test-admin-api-key-32chars!!!!!';
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

const _updateCalls = [];

jest.mock('../src/services/terapeakService', () => ({
  listDatasets: jest.fn(() => []),
  normalizeSearchKey: jest.fn((s) => String(s).toLowerCase().trim()),
  updateDatasetMeta: jest.fn((term, updates) => {
    _updateCalls.push({ term, updates });
    return {
      key: String(term).toLowerCase().trim(),
      aggregationMeta: { ...updates },
    };
  }),
  // Unused by /report-no-data but required so the route module loads cleanly.
  parseCSV: jest.fn(),
  importComps: jest.fn(),
  lookupComps: jest.fn(() => null),
  detectMetal: jest.fn(() => 'silver'),
  deleteDataset: jest.fn(() => true),
  deleteAllDatasets: jest.fn(() => 0),
  purgeStaleCSVs: jest.fn(() => ({ deleted: 0, kept: 0 })),
}));

jest.mock('../src/services/terapeakQuotaService', () => ({
  getStatus: jest.fn(() => ({ used: 0, remaining: 100, limit: 100, ok: true })),
  recordQueries: jest.fn(() => ({ ok: true, used: 1, remaining: 99, limit: 100, warning: null })),
}));

const http = require('http');
const express = require('express');
const terapeakRoute = require('../src/routes/terapeakRoute');
const terapeakService = require('../src/services/terapeakService');

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
  _updateCalls.length = 0;
  jest.clearAllMocks();
  // Default: dataset is brand new (not in the store)
  terapeakService.listDatasets.mockReturnValue([]);
});

function postJson(path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(baseUrl + path);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    if (apiKey) opts.headers['x-api-key'] = apiKey;
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('POST /api/terapeak/report-no-data (#271H Item 4)', () => {
  test('400 when searchTerm is missing', async () => {
    const { status, body } = await postJson('/api/terapeak/report-no-data', {}, TEST_ADMIN_KEY);
    expect(status).toBe(400);
    expect(body.error).toMatch(/searchTerm is required/i);
    expect(_updateCalls).toHaveLength(0);
  });

  test('400 when searchTerm is a non-string (e.g. array)', async () => {
    const { status, body } = await postJson(
      '/api/terapeak/report-no-data',
      { searchTerm: ['a', 'b'] },
      TEST_ADMIN_KEY,
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/searchTerm is required/i);
    expect(_updateCalls).toHaveLength(0);
  });

  test('200 + meta-write on a new dataset (noDataCount stamped to 1)', async () => {
    const before = Date.now();
    const { status, body } = await postJson(
      '/api/terapeak/report-no-data',
      { searchTerm: '1997 American Gold Eagle Tenth oz' },
      TEST_ADMIN_KEY,
    );
    const after = Date.now();

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.key).toBe('1997 american gold eagle tenth oz');
    expect(body.noDataCount).toBe(1);
    expect(Date.parse(body.noDataAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.noDataAt)).toBeLessThanOrEqual(after + 1);

    expect(_updateCalls).toHaveLength(1);
    expect(_updateCalls[0].term).toBe('1997 American Gold Eagle Tenth oz');
    expect(_updateCalls[0].updates.noDataCount).toBe(1);
  });

  test('200 + monotonic increment on existing entry with noDataCount=1', async () => {
    terapeakService.listDatasets.mockReturnValue([
      {
        key: '1997 american gold eagle tenth oz',
        searchTerm: '1997 American Gold Eagle Tenth oz',
        compCount: 0,
        aggregationMeta: { noDataCount: 1, noDataAt: '2026-06-14T00:00:00Z' },
      },
    ]);

    const { status, body } = await postJson(
      '/api/terapeak/report-no-data',
      { searchTerm: '1997 American Gold Eagle Tenth oz' },
      TEST_ADMIN_KEY,
    );

    expect(status).toBe(200);
    expect(body.noDataCount).toBe(2);
    expect(_updateCalls).toHaveLength(1);
    expect(_updateCalls[0].updates.noDataCount).toBe(2);
  });

  test('noDataCount is capped at NO_DATA_CAP (5) -- prevCount=5 -> stays 5 (#271H Item 1)', async () => {
    terapeakService.listDatasets.mockReturnValue([
      {
        key: 'capped coin',
        searchTerm: 'capped coin',
        compCount: 0,
        aggregationMeta: { noDataCount: 5, noDataAt: '2026-06-14T00:00:00Z' },
      },
    ]);

    const { status, body } = await postJson(
      '/api/terapeak/report-no-data',
      { searchTerm: 'capped coin' },
      TEST_ADMIN_KEY,
    );

    expect(status).toBe(200);
    expect(body.noDataCount).toBe(5);
    expect(_updateCalls[0].updates.noDataCount).toBe(5);
  });

  test('payload shape unchanged (status, key, noDataCount, noDataAt)', async () => {
    const { status, body } = await postJson(
      '/api/terapeak/report-no-data',
      { searchTerm: 'shape coin' },
      TEST_ADMIN_KEY,
    );

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['key', 'noDataAt', 'noDataCount', 'status']);
  });

  test('meta-write failure returns 200 with warning, not 500 (#271H Item 3)', async () => {
    terapeakService.updateDatasetMeta.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const { status, body } = await postJson(
      '/api/terapeak/report-no-data',
      { searchTerm: 'unwritable coin' },
      TEST_ADMIN_KEY,
    );

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.warning).toBe('meta-write-failed');
    expect(body.noDataCount).toBeNull();
    expect(body.noDataAt).toBeNull();
  });
});
