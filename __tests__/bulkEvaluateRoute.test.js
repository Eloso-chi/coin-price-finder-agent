// __tests__/bulkEvaluateRoute.test.js -- Tests for bulk-evaluate route parsers & endpoints
'use strict';

const route = require('../src/routes/bulkEvaluateRoute');
const parseText  = route._parseTextInput;
const parseJson  = route._parseJsonInput;

// ── parseTextInput ───────────────────────────────────────────

describe('parseTextInput', () => {
  it('parses simple lines into coin objects', () => {
    const text = '1921 Morgan Silver Dollar\n2024 American Silver Eagle';
    const coins = parseText(text);
    expect(coins).toHaveLength(2);
    expect(coins[0].query).toBe('1921 Morgan Silver Dollar');
    expect(coins[1].query).toBe('2024 American Silver Eagle');
  });

  it('parses pipe-delimited fields', () => {
    const text = '1921 Morgan Dollar | qty=5 | grade=MS-63';
    const coins = parseText(text);
    expect(coins).toHaveLength(1);
    expect(coins[0].query).toBe('1921 Morgan Dollar');
    expect(coins[0].qty).toBe(5);
    expect(coins[0].grade).toBe('MS-63');
  });

  it('skips blank lines and comments', () => {
    const text = '# my lot\n\n1921 Morgan Dollar\n   \n# skip this\n2024 ASE';
    const coins = parseText(text);
    expect(coins).toHaveLength(2);
    expect(coins[0].query).toBe('1921 Morgan Dollar');
  });

  it('returns empty array for null/empty', () => {
    expect(parseText(null)).toEqual([]);
    expect(parseText('')).toEqual([]);
    expect(parseText(123)).toEqual([]);
  });

  it('supports year, mint, weight fields', () => {
    const text = 'Gold Eagle | year=2024 | mint=W | weight=1';
    const coins = parseText(text);
    expect(coins[0].year).toBe('2024');
    expect(coins[0].mintMark).toBe('W');
    expect(coins[0].weight).toBe(1);
  });

  it('handles Windows line endings', () => {
    const text = 'Coin A\r\nCoin B\r\nCoin C';
    const coins = parseText(text);
    expect(coins).toHaveLength(3);
  });

  it('caps at MAX_COINS', () => {
    const lines = Array.from({ length: 600 }, (_, i) => 'Coin ' + i).join('\n');
    const coins = parseText(lines);
    expect(coins.length).toBeLessThanOrEqual(500);
  });
});

// ── parseJsonInput ───────────────────────────────────────────

describe('parseJsonInput', () => {
  it('parses array of objects', () => {
    const items = [
      { query: '1921 Morgan Dollar', qty: 5, grade: 'MS-63' },
      { query: '2024 ASE' },
    ];
    const coins = parseJson(items);
    expect(coins).toHaveLength(2);
    expect(coins[0].query).toBe('1921 Morgan Dollar');
    expect(coins[0].qty).toBe(5);
    expect(coins[0].grade).toBe('MS-63');
    expect(coins[1].qty).toBe(1); // default qty
  });

  it('handles string items', () => {
    const coins = parseJson(['Morgan Dollar', 'ASE']);
    expect(coins).toHaveLength(2);
    expect(coins[0].query).toBe('Morgan Dollar');
  });

  it('handles alternate field names (name, coin, mint, quantity)', () => {
    const items = [{ name: 'Foo', quantity: 3, mint: 'D' }];
    const coins = parseJson(items);
    expect(coins[0].query).toBe('Foo');
    expect(coins[0].qty).toBe(3);
    expect(coins[0].mintMark).toBe('D');
  });

  it('returns empty for non-array', () => {
    expect(parseJson(null)).toEqual([]);
    expect(parseJson('hello')).toEqual([]);
    expect(parseJson({})).toEqual([]);
  });

  it('truncates query at 300 chars', () => {
    const coins = parseJson([{ query: 'X'.repeat(400) }]);
    expect(coins[0].query.length).toBe(300);
  });

  it('caps at MAX_COINS', () => {
    const items = Array.from({ length: 600 }, () => ({ query: 'Coin' }));
    const coins = parseJson(items);
    expect(coins.length).toBeLessThanOrEqual(500);
  });
});

// ── HTTP endpoint smoke tests (supertest) ────────────────────

let request;
let app;
try {
  const supertest = require('supertest');
  const express = require('express');
  app = express();
  app.use(express.json());
  app.use('/api/bulk-evaluate', route);
  request = supertest(app);
} catch {
  // supertest not installed -- skip integration tests
}

const describeHttp = request ? describe : describe.skip;

describeHttp('POST /api/bulk-evaluate', () => {
  it('rejects empty body', async () => {
    const res = await request.post('/api/bulk-evaluate').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('rejects if no parseable coins', async () => {
    const res = await request.post('/api/bulk-evaluate').send({ text: '   ' });
    expect(res.status).toBe(400);
  });
});

describeHttp('GET /api/bulk-evaluate/:jobId (poll)', () => {
  it('returns 404 for unknown jobId', async () => {
    const res = await request.get('/api/bulk-evaluate/no-such-id');
    expect(res.status).toBe(404);
  });
});
