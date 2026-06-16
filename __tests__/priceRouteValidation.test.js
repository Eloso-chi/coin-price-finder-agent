// __tests__/priceRouteValidation.test.js -- input validation & safety for POST /api/price
//
// Contract under test:
//   1. Missing/empty/whitespace `query` -> 400 with safe error message.
//   2. Wrong content-types and malformed JSON -> 400 (handled by express.json()).
//   3. Oversized payloads do not crash the server.
//   4. Invalid `saleContext` falls back silently to 'ebay' (per the route's
//      VALID_SALE_CONTEXTS allow-list); no error to client.
//   5. `appealMultiplier` clamps to [1.0, 2.0] for negative/NaN/oversized input.
//   6. Error responses NEVER expose stack traces, file paths, or internal
//      field names (no `stack`, no `__dirname`, no `Cannot read property`).
//   7. NoSQL/SQL-injection-style query strings are treated as opaque text.
//
// Strategy: mock every downstream service so the route can be exercised
// without network or filesystem I/O. supertest for the HTTP layer.
'use strict';

// All downstream services are mocked to a minimal happy path. We're not
// testing the valuation pipeline here -- we're testing the input gate and
// error envelopes.
jest.mock('../src/services/pcgsService', () => ({
  parseDescription: jest.fn(() => ({ series: 'X', year: 2024, mint: null, grade: null })),
  resolveFromDescription: jest.fn(async () => ({
    verified: false, series: 'X', year: 2024, mint: null, grade: null,
    parsed: { series: 'X', year: 2024, mint: null, grade: null },
    limitations: [],
  })),
  lookupByCert: jest.fn(async () => null),
  lookupByCoinNumberAndGrade: jest.fn(async () => null),
}));
jest.mock('../src/services/ebayService', () => ({
  buildKeywords: jest.fn(() => 'k'),
  fetchSoldComps: jest.fn(async () => ({
    us: { comps: [], stats: { count: 0 }, removed: {} },
    global: { comps: [], stats: { count: 0 } },
    usedFallback: false, keywords: 'k',
  })),
}));
jest.mock('../src/services/greysheetService', () => ({
  fetchPriceByPcgsNumber: jest.fn(async () => null),
  fetchPriceByGsid: jest.fn(async () => null),
  fetchCollectible: jest.fn(async () => null),
  fetchTypePrice: jest.fn(async () => null),
}));
jest.mock('../src/services/greysheetHistoryService', () => ({
  getHistory: jest.fn(async () => null),
}));
jest.mock('../src/services/auctionPriceService', () => ({
  fetchAuctionPrice: jest.fn(async () => null),
}));
jest.mock('../src/services/valuationService', () => ({
  computeValuation: jest.fn(() => ({
    valuation: {
      fmvCore: 1, rangeLow: 0.5, rangeHigh: 1.5, confidence: 50, compCount: 0,
      explanation: [], dataSource: { soldCount: 0, totalComps: 0 },
      gradePool: {}, method: 'raw-blend', saleContext: 'eBay Retail',
    },
    decisions: { buy: {}, sell: {} },
  })),
}));
jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(async () => null),
}));
jest.mock('../src/services/numistaService', () => ({
  lookupCoin: jest.fn(async () => ({ accessible: false })),
}));
jest.mock('../src/services/terapeakService', () => ({
  lookupComps: jest.fn(() => null),
}));
jest.mock('../src/data/keyDates', () => ({ lookupKeyDate: jest.fn(() => ({ isKeyDate: false })) }));
jest.mock('../src/data/mintages', () => ({ lookupMintage: jest.fn(() => ({ mintage: null })) }));
jest.mock('../src/data/lunarReference', () => ({ buildLunarComparison: jest.fn(() => null) }));
jest.mock('../src/data/halfDollarSeries', () => ({ resolveCoinVariant: jest.fn(() => null) }));
jest.mock('../src/utils/responseValidator', () => ({
  validateSeriesIntegrity: jest.fn(() => ({ valid: true })),
  validateNumericSanity: jest.fn(() => ({ valid: true })),
}));
jest.mock('../src/utils/filters', () => ({
  hasSeriesConflict: jest.fn(() => false),
  detectDenomination: jest.fn(() => null),
}));
jest.mock('../src/utils/redactForPublic', () => ({ redactCompsForPublic: jest.fn((x) => x) }));
jest.mock('../src/utils/coinIntent', () => ({ extractCoinIntent: jest.fn(() => ({ grade: null, designation: null, finish: null, isProof: false })) }));
jest.mock('../src/utils/coinMetalProfile', () => ({ getCoinMetalProfile: jest.fn(() => ({ metal: null })) }));

const express = require('express');
const request = require('supertest');
const priceRoute = require('../src/routes/priceRoute');
// Pull the *mocked* modules so we can spy on their call args.
const valuationService = require('../src/services/valuationService');
const pcgsService = require('../src/services/pcgsService');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/price', priceRoute);
  return app;
}

function isSafeErrorBody(body) {
  if (!body || typeof body !== 'object') return false;
  if (!('error' in body)) return false;
  const txt = JSON.stringify(body);
  if (/\bstack\b/i.test(txt)) return false;
  if (/__dirname|__filename/.test(txt)) return false;
  if (/at\s+\w+\s+\(/.test(txt)) return false;          // stack frame
  if (/[A-Z]:\\\\|\/Users\/|\/home\//.test(txt)) return false; // file paths
  if (/Cannot read propert(y|ies)/i.test(txt)) return false;
  return true;
}

describe('POST /api/price -- input validation', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('empty body -> 400 with safe error', async () => {
    const res = await request(app).post('/api/price').send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(isSafeErrorBody(res.body)).toBe(true);
  });

  test('missing query field -> 400', async () => {
    const res = await request(app).post('/api/price').send({ options: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  test('query: null -> 400', async () => {
    const res = await request(app).post('/api/price').send({ query: null });
    expect(res.status).toBe(400);
  });

  test('query: empty string -> 400', async () => {
    const res = await request(app).post('/api/price').send({ query: '' });
    expect(res.status).toBe(400);
  });

  test('query: numeric 0 -> 400 (falsy guard)', async () => {
    const res = await request(app).post('/api/price').send({ query: 0 });
    expect(res.status).toBe(400);
  });

  test('query: false -> 400', async () => {
    const res = await request(app).post('/api/price').send({ query: false });
    expect(res.status).toBe(400);
  });

  test('query: valid one-char string passes the input gate (not 400)', async () => {
    const res = await request(app).post('/api/price').send({ query: 'q' });
    // We only assert the input gate: anything that is not a 4xx means the
    // validator accepted the input. 5xx is acceptable here because the
    // downstream valuation pipeline uses minimal mocks.
    expect(res.status).not.toBe(400);
    if (res.status >= 400) expect(isSafeErrorBody(res.body)).toBe(true);
  });

  test('query: 5000-char string is processed without crashing the server', async () => {
    const big = 'a'.repeat(5000);
    const res = await request(app).post('/api/price').send({ query: big });
    expect([200, 400, 500]).toContain(res.status);
    if (res.status >= 400) expect(isSafeErrorBody(res.body)).toBe(true);
  });

  test('body as array -> 400 (req.body.query is undefined)', async () => {
    const res = await request(app).post('/api/price').send(['1921 morgan']);
    expect(res.status).toBe(400);
  });

  test('malformed JSON body -> 400 from express.json()', async () => {
    const res = await request(app)
      .post('/api/price')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');
    expect(res.status).toBe(400);
  });

  test('wrong content-type (text/plain) -> 400 (no parsed body)', async () => {
    const res = await request(app)
      .post('/api/price')
      .set('Content-Type', 'text/plain')
      .send('1921 morgan');
    expect(res.status).toBe(400);
  });

  test('invalid saleContext silently defaults to ebay (no client 4xx)', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '1921 morgan', saleContext: 'EVIL_CONTEXT' });
    expect(res.status).not.toBe(400);
    if (res.status >= 400) expect(isSafeErrorBody(res.body)).toBe(true);
  });

  test('NoSQL-injection-shaped string is passed verbatim to pcgsService.parseDescription (treated as opaque text)', async () => {
    pcgsService.parseDescription.mockClear();
    const injection = '{"$gt": ""}';
    const res = await request(app)
      .post('/api/price')
      .send({ query: injection });
    expect(res.status).not.toBe(400);
    if (res.status >= 400) expect(isSafeErrorBody(res.body)).toBe(true);
    // The contract: the route MUST forward the raw string to the parser without
    // unwrapping the Mongo-operator-shaped object. If the route ever stringified
    // -> JSON.parsed the input, this assertion would fail.
    expect(pcgsService.parseDescription).toHaveBeenCalledWith(injection);
  });

  test('appealMultiplier negative number is clamped to 1.0 before reaching computeValuation', async () => {
    valuationService.computeValuation.mockClear();
    const res = await request(app)
      .post('/api/price')
      .send({ query: 'q', appealMultiplier: -50 });
    expect(res.status).not.toBe(400);
    if (res.status >= 400) expect(isSafeErrorBody(res.body)).toBe(true);
    expect(valuationService.computeValuation).toHaveBeenCalled();
    const opts = valuationService.computeValuation.mock.calls[0][4];
    expect(opts.appealMultiplier).toBe(1.0);
  });

  test('appealMultiplier > 2.0 is clamped to 2.0 before reaching computeValuation', async () => {
    valuationService.computeValuation.mockClear();
    const res = await request(app)
      .post('/api/price')
      .send({ query: 'q', appealMultiplier: 9999 });
    expect(res.status).not.toBe(400);
    if (res.status >= 400) expect(isSafeErrorBody(res.body)).toBe(true);
    expect(valuationService.computeValuation).toHaveBeenCalled();
    const opts = valuationService.computeValuation.mock.calls[0][4];
    expect(opts.appealMultiplier).toBe(2.0);
  });

  test('appealMultiplier NaN-coerced string is clamped to 1.0 before reaching computeValuation', async () => {
    valuationService.computeValuation.mockClear();
    const res = await request(app)
      .post('/api/price')
      .send({ query: 'q', appealMultiplier: 'not-a-number' });
    expect(res.status).not.toBe(400);
    if (res.status >= 400) expect(isSafeErrorBody(res.body)).toBe(true);
    expect(valuationService.computeValuation).toHaveBeenCalled();
    const opts = valuationService.computeValuation.mock.calls[0][4];
    expect(opts.appealMultiplier).toBe(1.0);
  });

  test('appealMultiplier exact upper boundary (2.0) is preserved (not over-clamped)', async () => {
    valuationService.computeValuation.mockClear();
    const res = await request(app)
      .post('/api/price')
      .send({ query: 'q', appealMultiplier: 2.0 });
    expect(res.status).not.toBe(400);
    expect(valuationService.computeValuation).toHaveBeenCalled();
    const opts = valuationService.computeValuation.mock.calls[0][4];
    expect(opts.appealMultiplier).toBe(2.0);
  });

  test('appealMultiplier just-over upper boundary (2.0001) is clamped down to 2.0', async () => {
    valuationService.computeValuation.mockClear();
    const res = await request(app)
      .post('/api/price')
      .send({ query: 'q', appealMultiplier: 2.0001 });
    expect(res.status).not.toBe(400);
    expect(valuationService.computeValuation).toHaveBeenCalled();
    const opts = valuationService.computeValuation.mock.calls[0][4];
    expect(opts.appealMultiplier).toBe(2.0);
  });

  test('500 envelope (forced downstream failure) never leaks stack traces or paths', async () => {
    // Force computeValuation to throw so the 500 path is actually exercised.
    valuationService.computeValuation.mockImplementationOnce(() => {
      throw new Error('forced failure for envelope test');
    });
    const res = await request(app).post('/api/price').send({ query: 'q' });
    expect(res.status).toBe(500);
    expect(isSafeErrorBody(res.body)).toBe(true);
  });

  test('400 error body never leaks stack frames or paths', async () => {
    const res = await request(app).post('/api/price').send({});
    expect(res.status).toBe(400);
    expect(isSafeErrorBody(res.body)).toBe(true);
  });
});
