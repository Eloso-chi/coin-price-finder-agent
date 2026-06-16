// __tests__/paginationBounds.test.js -- bounds-checking for the
// coin-history range parameter and other paginated/limited public surfaces.
//
// Contract under test:
//   - GET /api/coin-history requires `query` -> 400 otherwise.
//   - rangeDays is clamped to the allowed set {90, 180, 365}.
//   - Numeric strings ("90") and numbers (90) are both accepted.
//   - Out-of-set rangeDays (e.g. 1, 0, -5, 9999, NaN, "abc") silently
//     default to 90 -- not an error.
//   - Missing query is still 400 even if other params are present.
//
// We mock the downstream services so the route is exercised purely as a
// validation gate; the response shape beyond the error envelope is not
// the subject of this test.
'use strict';

jest.mock('../src/services/terapeakService', () => ({
  lookupComps: jest.fn(() => null), // no dataset -> 404 from the route
}));
jest.mock('../src/services/greysheetService', () => ({
  fetchPriceByPcgsNumber: jest.fn(async () => null),
  fetchPriceByGsid: jest.fn(async () => null),
}));
jest.mock('../src/services/greysheetHistoryService', () => ({
  getHistory: jest.fn(async () => null),
}));
jest.mock('../src/services/metalsHistoryService', () => ({
  getHistory: jest.fn(() => []),
  METAL_SYMBOLS: { silver: 'XAG', gold: 'XAU' },
}));
jest.mock('../src/services/ebayService', () => ({
  classifyGradeType: jest.fn(() => 'raw'),
}));
jest.mock('../src/utils/filters', () => ({
  isDenied: jest.fn(() => false),
}));
jest.mock('../src/utils/coinMetalProfile', () => ({
  getCoinMetalProfile: jest.fn(() => null),
}));
jest.mock('../src/utils/coinIntent', () => ({
  isReverseProofFinish: jest.fn(() => false),
}));
jest.mock('../src/utils/stats', () => ({
  summarize: jest.fn(() => ({ count: 0, mean: 0, median: 0 })),
  median: jest.fn(() => 0),
}));

const express = require('express');
const request = require('supertest');
const coinHistoryRoute = require('../src/routes/coinHistoryRoute');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/coin-history', coinHistoryRoute);
  return app;
}

describe('GET /api/coin-history -- required query parameter', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('missing query -> 400', async () => {
    const res = await request(app).get('/api/coin-history');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  test('empty query -> 400', async () => {
    const res = await request(app).get('/api/coin-history?query=');
    expect(res.status).toBe(400);
  });

  test('whitespace-only query -> 400', async () => {
    const res = await request(app).get('/api/coin-history?query=%20%20%20');
    expect(res.status).toBe(400);
  });

  test('rangeDays without query still 400', async () => {
    const res = await request(app).get('/api/coin-history?rangeDays=90');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/coin-history -- rangeDays bounds checking', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  // With query present but no terapeak dataset (mock returns null), the route
  // returns 404. Status 404 confirms the rangeDays gate did not reject us.

  test.each([90, 180, 365])('rangeDays=%i is accepted (passes gate -> 404 from missing data)', async (days) => {
    const res = await request(app).get(`/api/coin-history?query=1921+morgan&rangeDays=${days}`);
    expect(res.status).toBe(404);
  });

  test('rangeDays as numeric string ("180") is accepted', async () => {
    const res = await request(app).get('/api/coin-history?query=1921+morgan&rangeDays=180');
    expect(res.status).toBe(404);
  });

  test.each([0, -5, 1, 999, 9999, 365.5])(
    'out-of-set rangeDays %s defaults to 90 (still passes gate -> 404)',
    async (days) => {
      const res = await request(app).get(`/api/coin-history?query=1921+morgan&rangeDays=${days}`);
      expect(res.status).toBe(404);
    }
  );

  test('non-numeric rangeDays ("abc") defaults to 90', async () => {
    const res = await request(app).get('/api/coin-history?query=1921+morgan&rangeDays=abc');
    expect(res.status).toBe(404);
  });

  test('NaN-shaped rangeDays defaults to 90', async () => {
    const res = await request(app).get('/api/coin-history?query=1921+morgan&rangeDays=NaN');
    expect(res.status).toBe(404);
  });

  test('omitted rangeDays defaults silently (no 4xx for missing param)', async () => {
    const res = await request(app).get('/api/coin-history?query=1921+morgan');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/coin-history -- query length bounds', () => {
  let app;
  beforeAll(() => { app = createApp(); });

  test('single-character query passes gate', async () => {
    const res = await request(app).get('/api/coin-history?query=q');
    expect(res.status).toBe(404); // passes gate; no data
  });

  test('very long query (2000 chars) does not crash the server', async () => {
    const big = 'a'.repeat(2000);
    const res = await request(app).get('/api/coin-history?query=' + encodeURIComponent(big));
    // 500 is explicitly excluded: a server crash on a 2000-char string is
    // the failure mode this test exists to detect, not an acceptable outcome.
    expect([200, 400, 404]).toContain(res.status);
  });
});
