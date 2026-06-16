// __tests__/coinRouteValidation.test.js -- validation edge cases for /api/coins/*
//
// Complements __tests__/coinRoute.test.js (which exercises happy paths and
// basic auth). This file focuses on:
//   1. Body-shape validation: array/null/primitive bodies for POST endpoints.
//   2. Backup-format gating for /import (wrong format, oversized, malformed coins).
//   3. /bulk-delete input validation.
//   4. PUT with no actionable fields.
//   5. SQL/NoSQL-injection-style strings are stored as opaque text (not interpreted).
//   6. Error envelopes are safe (no stack traces, no internal paths).
'use strict';

jest.mock('../src/services/authService', () => ({
  verifyToken: jest.fn((token) => {
    if (token === 'valid-token') return { userId: 'val-user' };
    throw new Error('Invalid token');
  }),
}));

jest.mock('../src/services/coinStorageService', () => {
  const coins = new Map();
  return {
    getAllCoins: jest.fn((u) => [...(coins.get(u) || [])]),
    count: jest.fn((u) => (coins.get(u) || []).length),
    addCoin: jest.fn((u, c) => {
      const hash = 'h-' + Math.random().toString(36).slice(2, 8);
      if (!coins.has(u)) coins.set(u, []);
      coins.get(u).push({ ...c, coinHash: hash });
      return hash;
    }),
    coinHash: jest.fn((c) => 'h-' + (c.series || '') + '-' + (c.year || '')),
    importCoins: jest.fn((u, arr) => {
      if (!coins.has(u)) coins.set(u, []);
      coins.get(u).push(...arr.map(c => ({ ...c, coinHash: 'h-' + Math.random() })));
      return { imported: arr.length, skipped: 0 };
    }),
    updateCount: jest.fn(() => false),
    updateCostPer: jest.fn(() => false),
    removeCoin: jest.fn(() => false),
    bulkDelete: jest.fn((_u, hashes) => hashes.length),
    exportCoins: jest.fn(() => ({ format: 'coin-price-agent-backup-v1', coins: [] })),
    _resetStore: jest.fn(() => { coins.clear(); }),
  };
});

const express = require('express');
const request = require('supertest');
const coinRoute = require('../src/routes/coinRoute');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/coins', coinRoute);
  return app;
}

const AUTH = { Authorization: 'Bearer valid-token' };

function isSafeErrorBody(body) {
  if (!body || typeof body !== 'object') return false;
  if (!('error' in body)) return false;
  const txt = JSON.stringify(body);
  if (/\bstack\b/i.test(txt)) return false;
  if (/__dirname|__filename/.test(txt)) return false;
  if (/at\s+\w+\s+\(/.test(txt)) return false;
  if (/[A-Z]:\\\\|\/Users\/|\/home\//.test(txt)) return false;
  return true;
}

describe('POST /api/coins -- body shape validation', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('rejects array body with 400', async () => {
    const res = await request(app).post('/api/coins').set(AUTH).send([{ series: 'X' }]);
    expect(res.status).toBe(400);
    expect(isSafeErrorBody(res.body)).toBe(true);
  });

  test('rejects null body with 400', async () => {
    const res = await request(app).post('/api/coins').set(AUTH)
      .set('Content-Type', 'application/json').send('null');
    expect(res.status).toBe(400);
  });

  test('rejects primitive (string) body with 400', async () => {
    const res = await request(app).post('/api/coins').set(AUTH)
      .set('Content-Type', 'application/json').send('"just a string"');
    expect(res.status).toBe(400);
  });

  test('rejects primitive (number) body with 400', async () => {
    const res = await request(app).post('/api/coins').set(AUTH)
      .set('Content-Type', 'application/json').send('42');
    expect(res.status).toBe(400);
  });

  test('accepts empty object as a coin (sanitization handled downstream)', async () => {
    const res = await request(app).post('/api/coins').set(AUTH).send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('coinHash');
  });

  test('accepts SQL-injection-shaped strings as opaque text', async () => {
    const res = await request(app).post('/api/coins').set(AUTH).send({
      series: "Morgan Dollar'; DROP TABLE coins; --",
      year: '1921',
      mint: 'P',
      grade: 'MS65',
      notes: '{"$ne": null}',
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('coinHash');
  });
});

describe('POST /api/coins/get -- body shape validation', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('rejects null body with 400', async () => {
    const res = await request(app).post('/api/coins/get').set(AUTH)
      .set('Content-Type', 'application/json').send('null');
    expect(res.status).toBe(400);
  });

  test('returns coin: null when no match found', async () => {
    const res = await request(app).post('/api/coins/get').set(AUTH).send({
      series: 'Unknown', year: 9999, mint: 'P', grade: 'F',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ coin: null });
  });
});

describe('POST /api/coins/import -- backup format gating', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('rejects missing format with 400', async () => {
    const res = await request(app).post('/api/coins/import').set(AUTH)
      .send({ coins: [{ series: 'X' }] });
    expect(res.status).toBe(400);
  });

  test('rejects wrong format string with 400', async () => {
    const res = await request(app).post('/api/coins/import').set(AUTH)
      .send({ format: 'malicious-v99', coins: [] });
    expect(res.status).toBe(400);
  });

  test('rejects coins as non-array with 400', async () => {
    const res = await request(app).post('/api/coins/import').set(AUTH)
      .send({ format: 'coin-price-agent-backup-v1', coins: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  test('accepts exactly 5000 coins (boundary)', async () => {
    const coins = Array.from({ length: 5000 }, (_, i) => ({ series: 'X', year: 1900 + (i % 100) }));
    const res = await request(app).post('/api/coins/import').set(AUTH)
      .send({ format: 'coin-price-agent-backup-v1', coins });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(5000);
  });

  test('rejects 5001 coins (boundary +1) with 400', async () => {
    const coins = Array.from({ length: 5001 }, (_, i) => ({ series: 'X', year: i }));
    const res = await request(app).post('/api/coins/import').set(AUTH)
      .send({ format: 'coin-price-agent-backup-v1', coins });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max 5000/i);
  });
});

describe('POST /api/coins/bulk-delete -- input validation', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('rejects non-array hashes field with 400', async () => {
    const res = await request(app).post('/api/coins/bulk-delete').set(AUTH)
      .send({ hashes: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/array/i);
  });

  test('rejects missing hashes field with 400', async () => {
    const res = await request(app).post('/api/coins/bulk-delete').set(AUTH).send({});
    expect(res.status).toBe(400);
  });

  test('accepts empty hashes array (no-op) with 200', async () => {
    const res = await request(app).post('/api/coins/bulk-delete').set(AUTH)
      .send({ hashes: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 0 });
  });
});

describe('PUT /api/coins/:hash -- mutation validation', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('PUT with no actionable fields returns 404 (mock always says not-found)', async () => {
    const res = await request(app).put('/api/coins/some-hash').set(AUTH).send({});
    expect(res.status).toBe(404);
  });

  test('PUT with non-existent hash returns 404', async () => {
    const res = await request(app).put('/api/coins/nonexistent').set(AUTH)
      .send({ count: 5 });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/coins/:hash -- not-found semantics', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('returns 404 for unknown hash', async () => {
    const res = await request(app).delete('/api/coins/nonexistent').set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('error envelopes -- security hygiene', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('all 400 responses lack stack traces and file paths', async () => {
    const responses = await Promise.all([
      request(app).post('/api/coins').set(AUTH).send([1, 2, 3]),
      request(app).post('/api/coins/import').set(AUTH).send({ format: 'bad', coins: [] }),
      request(app).post('/api/coins/bulk-delete').set(AUTH).send({ hashes: 'x' }),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(isSafeErrorBody(res.body)).toBe(true);
    }
  });
});
