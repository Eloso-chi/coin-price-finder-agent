// __tests__/coinRoute.test.js -- Integration tests for /api/coins/* endpoints
// Tests auth middleware, CRUD operations, import validation, and bulk-delete.

'use strict';

jest.mock('../src/services/authService', () => ({
  verifyToken: jest.fn((token) => {
    if (token === 'valid-token') return { userId: 'test-user' };
    throw new Error('Invalid token');
  }),
}));

jest.mock('../src/services/coinStorageService', () => {
  const coins = new Map();
  return {
    getAllCoins: jest.fn((userId) => [...(coins.get(userId) || [])]),
    count: jest.fn((userId) => (coins.get(userId) || []).length),
    exportCoins: jest.fn((userId) => ({
      format: 'coin-price-agent-backup-v1',
      coins: coins.get(userId) || [],
    })),
    addCoin: jest.fn((userId, coin) => {
      const hash = 'h-' + (coin.series || '') + '-' + (coin.year || '');
      if (!coins.has(userId)) coins.set(userId, []);
      coins.get(userId).push({ ...coin, coinHash: hash });
      return hash;
    }),
    coinHash: jest.fn((coin) => 'h-' + (coin.series || '') + '-' + (coin.year || '')),
    importCoins: jest.fn((_userId, coinArr) => ({
      imported: coinArr.length,
      skipped: 0,
    })),
    updateCount: jest.fn((userId, hash, count) => {
      const arr = coins.get(userId) || [];
      const found = arr.find(c => c.coinHash === hash);
      if (!found) return false;
      found.count = count;
      return true;
    }),
    updateCostPer: jest.fn((userId, hash, costPer) => {
      const arr = coins.get(userId) || [];
      const found = arr.find(c => c.coinHash === hash);
      if (!found) return false;
      found.costPer = costPer;
      return true;
    }),
    removeCoin: jest.fn((userId, hash) => {
      const arr = coins.get(userId) || [];
      const idx = arr.findIndex(c => c.coinHash === hash);
      if (idx === -1) return false;
      arr.splice(idx, 1);
      return true;
    }),
    bulkDelete: jest.fn((_userId, hashes) => hashes.length),
  };
});

const http = require('http');
const express = require('express');
const coinRoute = require('../src/routes/coinRoute');

let app, server, baseUrl;

beforeAll((done) => {
  app = express();
  app.use(express.json());
  app.use('/api/coins', coinRoute);
  server = app.listen(0, () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

// ── HTTP helpers ────────────────────────────────────────────
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
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
//  Auth middleware
// ═══════════════════════════════════════════════════════════════
describe('/api/coins — auth', () => {
  test('rejects requests without token (401)', async () => {
    const { status, body } = await request('GET', '/api/coins');
    expect(status).toBe(401);
    expect(body).toHaveProperty('error');
  });

  test('rejects invalid token (401)', async () => {
    const { status, body } = await request('GET', '/api/coins', null, 'bad-token');
    expect(status).toBe(401);
    expect(body.error).toMatch(/invalid|expired/i);
  });

  test('accepts valid token', async () => {
    const { status, body } = await request('GET', '/api/coins', null, 'valid-token');
    expect(status).toBe(200);
    expect(body).toHaveProperty('coins');
  });
});

// ═══════════════════════════════════════════════════════════════
//  CRUD operations
// ═══════════════════════════════════════════════════════════════
describe('/api/coins — CRUD', () => {
  test('POST /api/coins adds a coin and returns hash', async () => {
    const coin = { series: 'Morgan Dollar', year: 1881, mint: 'CC' };
    const { status, body } = await request('POST', '/api/coins', coin, 'valid-token');
    expect(status).toBe(200);
    expect(body).toHaveProperty('coinHash');
    expect(typeof body.coinHash).toBe('string');
  });

  test('POST /api/coins rejects array body (400)', async () => {
    const { status, body } = await request('POST', '/api/coins', [1, 2, 3], 'valid-token');
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid/i);
  });

  test('POST /api/coins rejects empty object body (400)', async () => {
    // Send empty string instead of proper coin object
    const { status } = await request('POST', '/api/coins', '', 'valid-token');
    // Express JSON parser returns 400 for malformed JSON
    expect([400, 422]).toContain(status);
  });

  test('GET /api/coins/count returns count', async () => {
    const { status, body } = await request('GET', '/api/coins/count', null, 'valid-token');
    expect(status).toBe(200);
    expect(body).toHaveProperty('count');
    expect(typeof body.count).toBe('number');
  });

  test('GET /api/coins/export returns backup format', async () => {
    const { status, body } = await request('GET', '/api/coins/export', null, 'valid-token');
    expect(status).toBe(200);
    expect(body).toHaveProperty('format', 'coin-price-agent-backup-v1');
    expect(body).toHaveProperty('coins');
  });

  test('PUT /api/coins/:hash returns 404 for missing coin', async () => {
    const { status, body } = await request('PUT', '/api/coins/nonexistent', { count: 2 }, 'valid-token');
    // Mock returns false for unknown hash
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  test('DELETE /api/coins/:hash returns 404 for missing coin', async () => {
    const { status, body } = await request('DELETE', '/api/coins/nonexistent', null, 'valid-token');
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Import validation
// ═══════════════════════════════════════════════════════════════
describe('/api/coins/import — validation', () => {
  test('rejects invalid format field (400)', async () => {
    const { status, body } = await request('POST', '/api/coins/import', {
      format: 'wrong-format',
      coins: [],
    }, 'valid-token');
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid backup/i);
  });

  test('rejects missing coins array (400)', async () => {
    const { status, body } = await request('POST', '/api/coins/import', {
      format: 'coin-price-agent-backup-v1',
    }, 'valid-token');
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid backup/i);
  });

  test('rejects > 5000 coins (400 or 413)', async () => {
    // Large payloads may be rejected by Express body-size limit (413) before
    // reaching the route's 5000-coin check (400). Both are correct rejections.
    const bigArray = new Array(5001).fill({ series: 'X', year: 2000 });
    const { status } = await request('POST', '/api/coins/import', {
      format: 'coin-price-agent-backup-v1',
      coins: bigArray,
    }, 'valid-token');
    expect([400, 413]).toContain(status);
  });

  test('accepts valid import payload', async () => {
    const { status, body } = await request('POST', '/api/coins/import', {
      format: 'coin-price-agent-backup-v1',
      coins: [{ series: 'ASE', year: 2024 }],
    }, 'valid-token');
    expect(status).toBe(200);
    expect(body).toHaveProperty('imported', 1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Bulk delete
// ═══════════════════════════════════════════════════════════════
describe('/api/coins/bulk-delete', () => {
  test('rejects non-array hashes (400)', async () => {
    const { status, body } = await request('POST', '/api/coins/bulk-delete', { hashes: 'not-array' }, 'valid-token');
    expect(status).toBe(400);
    expect(body.error).toMatch(/array/i);
  });

  test('returns deleted count', async () => {
    const { status, body } = await request('POST', '/api/coins/bulk-delete', { hashes: ['h1', 'h2'] }, 'valid-token');
    expect(status).toBe(200);
    expect(body).toHaveProperty('deleted', 2);
  });
});
