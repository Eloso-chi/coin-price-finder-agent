// __tests__/terapeakImport422SelfHeal.test.js
// Regression guard: 422 parse failures on /api/terapeak/import and
// /api/terapeak/import-text must NOT mutate dataset metadata.
//
// No-data/dormancy markers are only written through /report-no-data
// or importComps page-1 empty-refresh paths.

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
describe('POST /api/terapeak/import -- 422 does not write meta', () => {
  test('does not write noData/page1 markers on 422', async () => {
    const { status, body } = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: '1997 American Gold Eagle Tenth oz' },
      { filename: 'empty.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );

    expect(status).toBe(422);
    expect(body.error).toMatch(/No valid comps/i);

    // 422 invalid/empty upload should not be interpreted as successful no-data refresh.
    expect(_updateCalls).toHaveLength(0);

    // Acceptance: importComps NOT called (no valid comps to store)
    expect(_importCalls).toHaveLength(0);
  });

  test('two consecutive 422s still do not touch metadata', async () => {
    const first = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: '1997 American Gold Eagle Tenth oz' },
      { filename: 'empty-a.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );
    const { status } = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: '1997 American Gold Eagle Tenth oz' },
      { filename: 'empty-b.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );

    expect(first.status).toBe(422);
    expect(status).toBe(422);
    expect(_updateCalls).toHaveLength(0);
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
describe('POST /api/terapeak/import-text -- 422 does not write meta', () => {
  test('does not write noData/page1 markers on 422', async () => {
    const { status, body } = await postJson(
      '/api/terapeak/import-text',
      {
        csvText: 'Title,Sold Price\n',
        searchTerm: '1989 China Twentieth Oz Gold Panda',
      },
      TEST_ADMIN_KEY,
    );

    expect(status).toBe(422);
    expect(body.error).toMatch(/No valid comps/i);
    expect(_updateCalls).toHaveLength(0);
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
