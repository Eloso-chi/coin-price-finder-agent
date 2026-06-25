// __tests__/terapeakImport422DormancyIntegration.test.js
// End-to-end integration test that joins the real route + service write path
// with the real freshnessClassifier read path for dormant behavior.
//
// Dormancy is now driven by explicit no-results reporting via
// POST /api/terapeak/report-no-data, not by 422 parse failures.
//
// META_PATH isolation: jest's setupFiles hook at __tests__/setup/meta-path.js
// redirects every worker to its own tmp meta sidecar, so this test writing the
// real sidecar will NOT collide with auditDuplicateKeys.test.js or any
// sibling.

'use strict';

const TEST_ADMIN_KEY = 'test-admin-api-key-32chars!!!!!';
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

const http = require('http');
const express = require('express');

// Real services (no jest.mock here)
const terapeakService = require('../src/services/terapeakService');
const freshnessClassifier = require('../src/services/freshnessClassifier');

jest.mock('../src/services/terapeakQuotaService', () => ({
  getStatus: jest.fn(() => ({ used: 0, remaining: 100, limit: 100, ok: true })),
  recordQueries: jest.fn(() => ({ ok: true, used: 1, remaining: 99, limit: 100, warning: null })),
}));

const terapeakRoute = require('../src/routes/terapeakRoute');

let app, server, baseUrl;
const SEARCH_TERM = '__271h_dormancy_integration_' + Date.now();

beforeAll((done) => {
  app = express();
  app.use('/api/terapeak', terapeakRoute);
  server = app.listen(0, () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  try {
    const key = terapeakService.normalizeSearchKey(SEARCH_TERM);
    terapeakService.deleteDataset(key);
  } catch (_) { /* ignore */ }
  server.close(done);
});

// Multipart helper copied from terapeakImport422SelfHeal.test.js so this test
// matches the python scraper's exact request shape end-to-end.
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

describe('end-to-end: two report-no-data calls mark the dataset dormant', () => {
  test('route -> service -> classifier chain: noDataCount reaches >=2 and shouldSkipRefresh skip=true with reason=dormant', async () => {
    // First create a skeleton dataset key (without comps) via 422 import.
    const seed = await postMultipart(
      '/api/terapeak/import',
      { searchTerm: SEARCH_TERM },
      { filename: 'empty-seed.csv', content: 'Title,Sold Price\n' },
      TEST_ADMIN_KEY,
    );
    expect(seed.status).toBe(422);

    // Explicit no-results reports drive noDataCount and dormancy.
    const r1 = await postJson(
      '/api/terapeak/report-no-data',
      { searchTerm: SEARCH_TERM },
      TEST_ADMIN_KEY,
    );
    expect(r1.status).toBe(200);

    const r2 = await postJson(
      '/api/terapeak/report-no-data',
      { searchTerm: SEARCH_TERM },
      TEST_ADMIN_KEY,
    );
    expect(r2.status).toBe(200);

    // Read meta back from the real service (in-memory, no debounce wait needed)
    const key = terapeakService.normalizeSearchKey(SEARCH_TERM);
    const datasets = terapeakService.listDatasets();
    const entry = datasets.find(d => d.key === key);
    expect(entry).toBeTruthy();
    expect(entry.aggregationMeta).toBeTruthy();
    expect(entry.aggregationMeta.noDataCount).toBeGreaterThanOrEqual(2);
    expect(entry.aggregationMeta.noDataAt).toBeTruthy();

    // Now drive the real freshnessClassifier with that meta.
    // The classifier consumes a `meta` object shaped like a sidecar entry --
    // includes `compCount` plus the aggregationMeta fields flattened in.
    const classifierMeta = {
      compCount: entry.compCount || 0,
      ...entry.aggregationMeta,
    };

    const state = freshnessClassifier.classify(classifierMeta);
    expect(state.isDormant).toBe(true);

    const decision = freshnessClassifier.shouldSkipRefresh(classifierMeta);
    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe('dormant');
  });
});
