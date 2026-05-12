// __tests__/terapeakRoute.test.js -- Integration tests for /api/terapeak/* endpoints
// Tests admin auth guard, dataset CRUD, quota enforcement, and input validation.

'use strict';

const TEST_ADMIN_KEY = 'test-admin-api-key-32chars!!!!!';

// Set env before requiring route
process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;

jest.mock('../src/services/terapeakService', () => ({
  parseCSV: jest.fn(() => ({
    comps: [{ title: 'Test', totalUsd: 50, soldDate: '2024-01-01' }],
    skipped: 0,
    columns: ['Title', 'Sold Price', 'Sold Date'],
    unmappedColumns: [],
    totalRows: 1,
  })),
  importComps: jest.fn(() => ({ stored: 1, duplicates: 0 })),
  listDatasets: jest.fn(() => [
    { key: 'morgan-1881', compCount: 25, lastImported: '2024-01-01' },
  ]),
  lookupComps: jest.fn((q) => {
    if (q === 'morgan 1881') return { searchTerm: 'morgan 1881', comps: [{ title: 'Morgan', totalUsd: 200 }], lastImport: '2024-01-01' };
    return null;
  }),
  detectMetal: jest.fn(() => 'silver'),
  deleteDataset: jest.fn((key) => key === 'morgan-1881'),
  deleteAllDatasets: jest.fn(() => 3),
  purgeStaleCSVs: jest.fn(() => ({ deleted: 2, kept: 10 })),
}));

jest.mock('../src/services/terapeakQuotaService', () => ({
  getStatus: jest.fn(() => ({
    used: 5, remaining: 95, limit: 100, ok: true
  })),
  recordQueries: jest.fn((count, label) => ({
    ok: true, used: 6, remaining: 94, limit: 100, warning: null,
  })),
}));

const http = require('http');
const express = require('express');
const terapeakRoute = require('../src/routes/terapeakRoute');
const quotaService = require('../src/services/terapeakQuotaService');

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

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  // Restore default quota behavior
  quotaService.recordQueries.mockReturnValue({
    ok: true, used: 6, remaining: 94, limit: 100, warning: null,
  });
});

// ── HTTP helpers ────────────────────────────────────────────
function request(method, path, body, apiKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (apiKey) opts.headers['x-api-key'] = apiKey;
    if (body != null) {
      const data = JSON.stringify(body);
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (chunk) => (buf += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf) });
        } catch {
          resolve({ status: res.statusCode, body: buf });
        }
      });
    });
    req.on('error', reject);
    if (body != null) req.write(JSON.stringify(body));
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════
//  Admin auth guard (requireAdmin)
// ═══════════════════════════════════════════════════════════════
describe('/api/terapeak — admin auth', () => {
  test('rejects missing API key (401)', async () => {
    const { status, body } = await request('POST', '/api/terapeak/import-text', {
      csvText: 'Title,Sold Price\nCoin,50',
      searchTerm: 'test',
    });
    expect(status).toBe(401);
    expect(body.error).toMatch(/invalid|missing/i);
  });

  test('rejects wrong API key (401)', async () => {
    const { status, body } = await request('POST', '/api/terapeak/import-text', {
      csvText: 'Title,Sold Price\nCoin,50',
      searchTerm: 'test',
    }, 'wrong-key-wrong-key-wrong-key!!');
    expect(status).toBe(401);
    expect(body.error).toMatch(/invalid|missing/i);
  });

  test('accepts valid admin key', async () => {
    const { status } = await request('POST', '/api/terapeak/import-text', {
      csvText: 'Title,Sold Price\nCoin,50',
      searchTerm: 'test',
    }, TEST_ADMIN_KEY);
    expect(status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Public endpoints (no auth)
// ═══════════════════════════════════════════════════════════════
describe('/api/terapeak — public endpoints', () => {
  test('GET /datasets returns dataset list', async () => {
    const { status, body } = await request('GET', '/api/terapeak/datasets');
    expect(status).toBe(200);
    expect(body).toHaveProperty('datasets');
    expect(Array.isArray(body.datasets)).toBe(true);
    expect(body.datasets.length).toBeGreaterThan(0);
  });

  test('GET /lookup returns comps for known query', async () => {
    const { status, body } = await request('GET', '/api/terapeak/lookup?q=morgan%201881');
    expect(status).toBe(200);
    expect(body.found).toBe(true);
    expect(body).toHaveProperty('comps');
  });

  test('GET /lookup returns empty for unknown query', async () => {
    const { status, body } = await request('GET', '/api/terapeak/lookup?q=unknown');
    expect(status).toBe(200);
    expect(body.found).toBe(false);
  });

  test('GET /lookup returns 400 when q is missing', async () => {
    const { status } = await request('GET', '/api/terapeak/lookup');
    expect(status).toBe(400);
  });

  test('GET /quota returns quota status', async () => {
    const { status, body } = await request('GET', '/api/terapeak/quota');
    expect(status).toBe(200);
    expect(body).toHaveProperty('used');
    expect(body).toHaveProperty('remaining');
    expect(body).toHaveProperty('limit');
  });
});

// ═══════════════════════════════════════════════════════════════
//  import-text — input validation & quota
// ═══════════════════════════════════════════════════════════════
describe('/api/terapeak/import-text — validation', () => {
  test('rejects missing csvText (400)', async () => {
    const { status, body } = await request('POST', '/api/terapeak/import-text', {
      searchTerm: 'test',
    }, TEST_ADMIN_KEY);
    expect(status).toBe(400);
    expect(body.error).toMatch(/csvText/i);
  });

  test('rejects missing searchTerm (400)', async () => {
    const { status, body } = await request('POST', '/api/terapeak/import-text', {
      csvText: 'Title,Sold Price\nCoin,50',
    }, TEST_ADMIN_KEY);
    expect(status).toBe(400);
    expect(body.error).toMatch(/searchTerm/i);
  });

  test('returns 429 when quota exhausted', async () => {
    quotaService.recordQueries.mockReturnValue({
      ok: false, used: 100, remaining: 0, limit: 100,
      warning: 'Daily limit reached',
    });
    const { status, body } = await request('POST', '/api/terapeak/import-text', {
      csvText: 'Title,Sold Price\nCoin,50',
      searchTerm: 'test',
    }, TEST_ADMIN_KEY);
    expect(status).toBe(429);
    expect(body.error).toMatch(/limit/i);
    expect(body).toHaveProperty('quota');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Dataset management (admin)
// ═══════════════════════════════════════════════════════════════
describe('/api/terapeak — dataset management', () => {
  test('DELETE /datasets/:key requires admin', async () => {
    const { status } = await request('DELETE', '/api/terapeak/datasets/morgan-1881');
    expect(status).toBe(401);
  });

  test('DELETE /datasets/:key with admin key succeeds', async () => {
    const { status, body } = await request('DELETE', '/api/terapeak/datasets/morgan-1881', null, TEST_ADMIN_KEY);
    expect(status).toBe(200);
    expect(body).toHaveProperty('status', 'ok');
  });

  test('DELETE /datasets (all) requires admin', async () => {
    const { status } = await request('DELETE', '/api/terapeak/datasets');
    expect(status).toBe(401);
  });
});
