// __tests__/terapeakImport422SelfHeal.test.js
// Regression test for backlog #269H -- when /api/terapeak/import responds
// with HTTP 422 ("No valid comps found in CSV"), the server must
// self-heal: bump noDataCount, stamp noDataAt, and stamp page1At in
// aggregationMeta. This eliminates the wasted-retry loop where the local
// scraper kept re-fetching the same coin forever because the meta state
// never converged after a 422.
//
// Before this fix: 422 was returned but no metadata was written, so the
// freshness classifier kept seeing the coin as stale on every pass.
// After this fix: 2 consecutive 422s promote the coin to dormant via the
// existing classifier rule (noDataCount >= 2 && noDataAt within window).

'use strict';

const TEST_ADMIN_KEY = 'test-admin-api-key-32chars!!!!!';
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

const _updateCalls = [];
const _importCalls = [];

jest.mock('../src/services/terapeakService', () => ({
  parseCSV: jest.fn(),
  importComps: jest.fn((term, comps, opts) => {
    _importCalls.push({ term, compCount: comps.length, opts });
    return { stored: comps.length, duplicates: 0 };
  }),
  listDatasets: jest.fn(() => []),
  normalizeSearchKey: jest.fn((s) => String(s).toLowerCase().trim()),
  updateDatasetMeta: jest.fn((term, updates) => {
    _updateCalls.push({ term, updates });
    return {
      key: String(term).toLowerCase().trim(),
      aggregationMeta: { ...updates },
    };
  }),
  lookupComps: jest.fn(() => null),
  detectMetal: jest.fn(() => 'silver'),
  deleteDataset: jest.fn(() => true),
  deleteAllDatasets: jest.fn(() => 0),
  purgeStaleCSVs: jest.fn(() => ({ deleted: 0, kept: 0 })),
}));

jest.mock('../src/services/terapeakQuotaService', () => ({
  getStatus: jest.fn(() => ({ used: 5, remaining: 95, limit: 100, ok: true })),
  recordQueries: jest.fn(() => ({
    ok: true, used: 6, remaining: 94, limit: 100, warning: null,
  })),
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
  _importCalls.length = 0;
  jest.clearAllMocks();
  // Default: parseCSV returns ZERO comps so /import returns 422
  terapeakService.parseCSV.mockReturnValue({
    comps: [],
    skipped: 5,
    columns: ['Title', 'Sold Price', 'Sold Date'],
    unmappedColumns: [],
    totalRows: 5,
  });
});

// ── Multipart helper (matches the python scraper's request shape) ──
function postMultipart(path, fields, fileField, apiKey) {
  return new Promise((resolve, reject) => {
    const boundary = '----jest-test-boundary-' + Date.now();
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`
      );
    }
    if (fileField) {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileField.filename}"\r\n` +
        `Content-Type: text/csv\r\n\r\n` +
        `${fileField.content}\r\n`
      );
    }
    parts.push(`--${boundary}--\r\n`);
    const body = Buffer.from(parts.join(''), 'utf8');

    const url = new URL(baseUrl + path);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
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
    req.write(body);
    req.end();
  });
}

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

// ═══════════════════════════════════════════════════════════════
//  /import -- 422 self-heal (#269H acceptance criteria)
// ═══════════════════════════════════════════════════════════════
describe('POST /api/terapeak/import -- 422 self-heal (#269H)', () => {
  test('records noDataCount + noDataAt + page1At in meta on 422', async () => {
    const before = Date.now();
    const { status, body } = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: '1997 American Gold Eagle Tenth oz' },
      { filename: 'empty.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );
    const after = Date.now();

    expect(status).toBe(422);
    expect(body.error).toMatch(/No valid comps/i);

    // Acceptance: meta-write must occur exactly once on 422
    expect(_updateCalls).toHaveLength(1);
    const [{ term, updates }] = _updateCalls;
    expect(term).toBe('1997 American Gold Eagle Tenth oz');

    // Acceptance: noDataCount bumped, noDataAt stamped, page1At stamped
    expect(updates).toHaveProperty('noDataCount');
    expect(updates.noDataCount).toBeGreaterThanOrEqual(1);
    expect(updates).toHaveProperty('noDataAt');
    expect(Date.parse(updates.noDataAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(updates.noDataAt)).toBeLessThanOrEqual(after + 1);
    expect(updates).toHaveProperty('page1At');
    expect(Date.parse(updates.page1At)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(updates.page1At)).toBeLessThanOrEqual(after + 1);

    // Acceptance: importComps NOT called (no valid comps to store)
    expect(_importCalls).toHaveLength(0);
  });

  test('two consecutive 422s bump noDataCount to >= 2 (dormant trigger)', async () => {
    // listDatasets returns a coin with noDataCount=1 (simulating prior pass)
    terapeakService.listDatasets.mockReturnValue([
      {
        key: '1997 american gold eagle tenth oz',
        searchTerm: '1997 American Gold Eagle Tenth oz',
        compCount: 0,
        aggregationMeta: { noDataCount: 1, noDataAt: '2026-06-14T00:00:00Z' },
      },
    ]);

    const { status } = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: '1997 American Gold Eagle Tenth oz' },
      { filename: 'empty.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );

    expect(status).toBe(422);
    expect(_updateCalls).toHaveLength(1);
    // After 2nd strike, noDataCount must be 2 -- this is the dormant threshold
    // per src/services/freshnessClassifier.js DORMANT_MIN_NO_DATA_COUNT
    expect(_updateCalls[0].updates.noDataCount).toBe(2);
  });

  test('honors client-supplied page1At over server-stamped one', async () => {
    const clientStamp = '2026-06-16T12:00:00.000Z';
    const { status } = await postMultipart(
      '/api/terapeak/import',
      {
        searchTerm: '1982 Gold Krugerrand Quarter Oz',
        page1At: clientStamp,
      },
      { filename: 'empty.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );

    expect(status).toBe(422);
    expect(_updateCalls).toHaveLength(1);
    expect(_updateCalls[0].updates.page1At).toBe(clientStamp);
    // noDataAt is always server-stamped, never client-supplied
    expect(_updateCalls[0].updates.noDataAt).not.toBe(clientStamp);
  });

  test('does NOT write meta on 400 (missing file)', async () => {
    const { status } = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: 'some coin' },
      null, // no file
      TEST_ADMIN_KEY,
    );
    expect(status).toBe(400);
    expect(_updateCalls).toHaveLength(0);
  });

  test('does NOT write meta on 400 (missing searchTerm)', async () => {
    const { status } = await postMultipart(
      '/api/terapeak/import',
      {},
      { filename: 'empty.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );
    expect(status).toBe(400);
    expect(_updateCalls).toHaveLength(0);
  });

  test('does NOT write meta on successful 200 import (happy path unchanged)', async () => {
    terapeakService.parseCSV.mockReturnValue({
      comps: [{ title: 'Coin', totalUsd: 50, soldDate: '2026-06-01' }],
      skipped: 0,
      columns: ['Title', 'Sold Price', 'Sold Date'],
      unmappedColumns: [],
      totalRows: 1,
    });
    const { status, body } = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: '2024 American Silver Eagle' },
      { filename: 'one.csv', content: 'Title,Sold Price\nCoin,50' },
      TEST_ADMIN_KEY,
    );
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(_updateCalls).toHaveLength(0);
    expect(_importCalls).toHaveLength(1);
  });

  test('422 still returns the original detail payload (no regression)', async () => {
    const { status, body } = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: 'some coin' },
      { filename: 'empty.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );
    expect(status).toBe(422);
    expect(body).toHaveProperty('details');
    expect(body.details).toHaveProperty('totalRows');
    expect(body.details).toHaveProperty('skipped');
    expect(body.details).toHaveProperty('mappedColumns');
  });

  test('meta-write failure does NOT mask the 422 response', async () => {
    terapeakService.updateDatasetMeta.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const { status, body } = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: 'some coin' },
      { filename: 'empty.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );
    expect(status).toBe(422);
    expect(body.error).toMatch(/No valid comps/i);
  });
});

// ═══════════════════════════════════════════════════════════════
//  /import-text -- same self-heal behavior
// ═══════════════════════════════════════════════════════════════
describe('POST /api/terapeak/import-text -- 422 self-heal (#269H)', () => {
  test('records noDataCount + noDataAt + page1At in meta on 422', async () => {
    const before = Date.now();
    const { status, body } = await postJson(
      '/api/terapeak/import-text',
      {
        csvText: 'Title,Sold Price\n',
        searchTerm: '1989 China Twentieth Oz Gold Panda',
      },
      TEST_ADMIN_KEY,
    );
    const after = Date.now();

    expect(status).toBe(422);
    expect(body.error).toMatch(/No valid comps/i);

    expect(_updateCalls).toHaveLength(1);
    const [{ term, updates }] = _updateCalls;
    expect(term).toBe('1989 China Twentieth Oz Gold Panda');
    expect(updates.noDataCount).toBeGreaterThanOrEqual(1);
    expect(Date.parse(updates.noDataAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(updates.noDataAt)).toBeLessThanOrEqual(after + 1);
    expect(Date.parse(updates.page1At)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(updates.page1At)).toBeLessThanOrEqual(after + 1);
  });

  test('does NOT write meta on successful 200 (happy path unchanged)', async () => {
    terapeakService.parseCSV.mockReturnValue({
      comps: [{ title: 'Coin', totalUsd: 50, soldDate: '2026-06-01' }],
      skipped: 0,
      columns: ['Title', 'Sold Price', 'Sold Date'],
      unmappedColumns: [],
      totalRows: 1,
    });
    const { status } = await postJson(
      '/api/terapeak/import-text',
      { csvText: 'Title,Sold Price\nCoin,50', searchTerm: 'morgan' },
      TEST_ADMIN_KEY,
    );
    expect(status).toBe(200);
    expect(_updateCalls).toHaveLength(0);
  });
});
