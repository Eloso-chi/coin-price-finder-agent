// __tests__/barPriceRoute.test.js — Integration tests for POST /api/bar-price
'use strict';

jest.mock('../src/services/ebayService', () => ({
  fetchSoldComps: jest.fn(),
}));
jest.mock('../src/services/valuationService', () => ({
  computeValuation: jest.fn(),
}));
jest.mock('../src/data/constants', () => ({
  zodiacForYear: jest.fn(() => 'Dragon'),
  perthLunarSeries: jest.fn(() => ({ num: 'III' })),
}));

const http = require('http');
const express = require('express');
const { fetchSoldComps } = require('../src/services/ebayService');
const { computeValuation } = require('../src/services/valuationService');
const barPriceRoute = require('../src/routes/barPriceRoute');

let server, baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/bar-price', barPriceRoute);
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => jest.clearAllMocks());

// ── Helper ──────────────────────────────────────────────────
function post(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + '/api/bar-price');
    const r = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    r.write(JSON.stringify(body));
    r.end();
  });
}

const MOCK_EBAY = {
  us: { count: 10, median: 32, average: 33, stdDev: 2, min: 28, max: 38, prices: [] },
  global: { count: 5, median: 31, average: 32, stdDev: 3, min: 27, max: 37, prices: [] },
  usedFallback: false,
};

const MOCK_VALUATION = {
  valuation: { fairValue: 33, confidence: 'high', dataPoints: 10 },
  decisions: ['Enough comps for reliable estimate'],
};

// ════════════════════════════════════════════════════════════
//  Validation
// ════════════════════════════════════════════════════════════
describe('validation', () => {
  test('400 when metal is missing', async () => {
    const res = await post({ size: '1 oz' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metal and size/);
  });

  test('400 when size is missing', async () => {
    const res = await post({ metal: 'gold' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metal and size/);
  });
});

// ════════════════════════════════════════════════════════════
//  Successful response
// ════════════════════════════════════════════════════════════
describe('success', () => {
  test('returns bar pricing for a generic gold bar', async () => {
    fetchSoldComps.mockResolvedValue(MOCK_EBAY);
    computeValuation.mockReturnValue(MOCK_VALUATION);

    const res = await post({ metal: 'gold', size: '1 oz', brand: 'PAMP' });
    expect(res.status).toBe(200);
    expect(res.body.bar.metal).toBe('gold');
    expect(res.body.bar.size).toBe('1 oz');
    expect(res.body.bar.brand).toBe('PAMP');
    expect(res.body.ebay.us).toBeDefined();
    expect(res.body.valuation).toBeDefined();
  });

  test('builds correct eBay keywords', async () => {
    fetchSoldComps.mockResolvedValue(MOCK_EBAY);
    computeValuation.mockReturnValue(MOCK_VALUATION);

    await post({ metal: 'silver', size: '10 oz', brand: 'Engelhard', year: 1985 });

    const keywords = fetchSoldComps.mock.calls[0][0];
    expect(keywords).toContain('silver');
    expect(keywords).toContain('10 oz');
    expect(keywords).toContain('Engelhard');
    expect(keywords).toContain('1985');
    expect(keywords).toContain('bar');
  });

  test('passes askingPrice through to valuation', async () => {
    fetchSoldComps.mockResolvedValue(MOCK_EBAY);
    computeValuation.mockReturnValue(MOCK_VALUATION);

    const res = await post({ metal: 'gold', size: '1 oz', askingPrice: 2100 });
    expect(res.body.query.askingPrice).toBe(2100);
    // computeValuation should have received the askingPrice
    expect(computeValuation).toHaveBeenCalledWith(
      expect.objectContaining({ _isBar: true }),
      MOCK_EBAY,
      2100,
      null
    );
  });

  test('lunar series adds zodiac animal to keywords', async () => {
    fetchSoldComps.mockResolvedValue(MOCK_EBAY);
    computeValuation.mockReturnValue(MOCK_VALUATION);

    await post({ metal: 'gold', size: '1 oz', brand: 'Perth', series: 'lunar', year: 2024 });
    const keywords = fetchSoldComps.mock.calls[0][0];
    expect(keywords).toContain('Dragon');
    expect(keywords).toContain('Lunar');
  });

  test('sealed condition adds sealed OR assay to keywords', async () => {
    fetchSoldComps.mockResolvedValue(MOCK_EBAY);
    computeValuation.mockReturnValue(MOCK_VALUATION);

    await post({ metal: 'silver', size: '1 oz', condition: 'sealed' });
    const keywords = fetchSoldComps.mock.calls[0][0];
    expect(keywords).toContain('sealed OR assay');
  });
});

// ════════════════════════════════════════════════════════════
//  Error handling
// ════════════════════════════════════════════════════════════
describe('error handling', () => {
  test('500 on unhandled eBay error', async () => {
    fetchSoldComps.mockRejectedValue(new Error('eBay API down'));
    const res = await post({ metal: 'gold', size: '1 oz' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Internal server error/);
  });
});
