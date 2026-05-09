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
  getRollQuantity: jest.fn(() => 20),
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

// ════════════════════════════════════════════════════════════
//  Bar-specific response shape (#12)
// ════════════════════════════════════════════════════════════
describe('bar response shape', () => {
  beforeEach(() => {
    fetchSoldComps.mockResolvedValue(MOCK_EBAY);
    computeValuation.mockReturnValue(MOCK_VALUATION);
  });

  test('response.bar contains metal, size, brand, pureOzt, and condition', async () => {
    const res = await post({ metal: 'gold', size: '1 oz', brand: 'PAMP' });
    expect(res.status).toBe(200);
    expect(res.body.bar).toEqual(expect.objectContaining({
      metal: 'gold',
      size: '1 oz',
      brand: 'PAMP',
      pureOzt: expect.any(Number),
      condition: expect.any(String),
    }));
  });

  test('pureOzt is correct for different sizes', async () => {
    for (const [size, expected] of [['1 oz', 1], ['10 oz', 10], ['5 oz', 5]]) {
      const res = await post({ metal: 'silver', size });
      expect(res.status).toBe(200);
      expect(res.body.bar.pureOzt).toBe(expected);
    }
  });

  test('response.bar defaults brand to Generic when not provided', async () => {
    const res = await post({ metal: 'silver', size: '1 oz' });
    expect(res.status).toBe(200);
    expect(res.body.bar.brand).toBe('Generic');
  });

  test('response.query echoes input parameters', async () => {
    const res = await post({ metal: 'gold', size: '1 oz', brand: 'PAMP', condition: 'sealed', askingPrice: 2100 });
    expect(res.status).toBe(200);
    expect(res.body.query).toEqual(expect.objectContaining({
      metal: 'gold',
      size: '1 oz',
      brand: 'PAMP',
      condition: 'sealed',
      askingPrice: 2100,
    }));
  });

  test('response has ebay, valuation, and decisions at top level', async () => {
    const res = await post({ metal: 'gold', size: '1 oz' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ebay');
    expect(res.body).toHaveProperty('valuation');
    expect(res.body).toHaveProperty('decisions');
    expect(res.body.ebay).toHaveProperty('us');
    expect(res.body.ebay).toHaveProperty('keywords');
  });

  test('lunar bar has zodiacAnimal and series in response', async () => {
    const res = await post({ metal: 'gold', size: '1 oz', brand: 'Perth', series: 'lunar', year: 2024 });
    expect(res.status).toBe(200);
    expect(res.body.bar.zodiacAnimal).toBe('Dragon');
    expect(res.body.bar.series).toBe('Lunar');
  });

  test('response.bar.year passes through when provided', async () => {
    const res = await post({ metal: 'silver', size: '1 oz', year: 2020 });
    expect(res.status).toBe(200);
    expect(res.body.bar.year).toBe(2020);
  });
});

// ════════════════════════════════════════════════════════════
//  Fractional gram sizes (#187)
// ════════════════════════════════════════════════════════════
describe('fractional gram sizes', () => {
  beforeEach(() => {
    fetchSoldComps.mockResolvedValue(MOCK_EBAY);
    computeValuation.mockReturnValue(MOCK_VALUATION);
  });

  test('pureOzt correct for 0.5 gram', async () => {
    const res = await post({ metal: 'gold', size: '0.5 gram' });
    expect(res.status).toBe(200);
    expect(res.body.bar.pureOzt).toBeCloseTo(0.5 / 31.1035, 5);
  });

  test('pureOzt correct for .5 gram (no leading zero)', async () => {
    const res = await post({ metal: 'gold', size: '.5 gram' });
    expect(res.status).toBe(200);
    expect(res.body.bar.pureOzt).toBeCloseTo(0.5 / 31.1035, 5);
  });

  test('pureOzt correct for 1 gram', async () => {
    const res = await post({ metal: 'gold', size: '1 gram' });
    expect(res.status).toBe(200);
    expect(res.body.bar.pureOzt).toBeCloseTo(1 / 31.1035, 5);
  });

  test('pureOzt correct for 2.5 gram', async () => {
    const res = await post({ metal: 'gold', size: '2.5 gram' });
    expect(res.status).toBe(200);
    expect(res.body.bar.pureOzt).toBeCloseTo(2.5 / 31.1035, 5);
  });

  test('pureOzt correct for 1 kilo', async () => {
    const res = await post({ metal: 'silver', size: '1 kilo' });
    expect(res.status).toBe(200);
    expect(res.body.bar.pureOzt).toBeCloseTo(32.1507, 3);
  });

  test('.5 gram normalizes to 0.5 gram in eBay keywords', async () => {
    await post({ metal: 'gold', size: '.5 gram', brand: 'Geiger' });
    const keywords = fetchSoldComps.mock.calls[0][0];
    expect(keywords).toContain('0.5 gram');
    // Should NOT start with just ".5" (no leading zero)
    expect(keywords).not.toMatch(/(?<!\d)\.5 gram/);
  });

  test('expected.weight is set for weight-mismatch filtering', async () => {
    await post({ metal: 'gold', size: '0.5 gram', brand: 'PAMP' });
    const expected = fetchSoldComps.mock.calls[0][2];
    expect(expected.weight).toBeCloseTo(0.5 / 31.1035, 5);
  });

  test('expected.weight is set for oz sizes too', async () => {
    await post({ metal: 'gold', size: '1 oz' });
    const expected = fetchSoldComps.mock.calls[0][2];
    expect(expected.weight).toBe(1);
  });

  test('expected.barSize is normalized', async () => {
    await post({ metal: 'gold', size: '.5 gram' });
    const expected = fetchSoldComps.mock.calls[0][2];
    expect(expected.barSize).toBe('0.5 gram');
  });
});

// ════════════════════════════════════════════════════════════
//  Bar series detection (#187)
// ════════════════════════════════════════════════════════════
describe('bar series detection', () => {
  beforeEach(() => {
    fetchSoldComps.mockResolvedValue(MOCK_EBAY);
    computeValuation.mockReturnValue(MOCK_VALUATION);
  });

  test('Geiger edelmetalle adds series keywords to search', async () => {
    await post({ metal: 'gold', size: '1 gram', brand: 'Geiger', series: 'edelmetalle' });
    const keywords = fetchSoldComps.mock.calls[0][0];
    expect(keywords).toContain('edelmetalle');
    expect(keywords).toContain('Geiger');
    expect(keywords).toContain('bar');
  });

  test('response.bar.series is set for Geiger Edelmetalle', async () => {
    const res = await post({ metal: 'gold', size: '1 gram', brand: 'Geiger', series: 'edelmetalle' });
    expect(res.status).toBe(200);
    expect(res.body.bar.series).toBe('Edelmetalle');
  });

  test('PAMP fortuna adds fortuna to keywords', async () => {
    await post({ metal: 'gold', size: '1 oz', brand: 'PAMP', series: 'fortuna' });
    const keywords = fetchSoldComps.mock.calls[0][0];
    expect(keywords).toContain('fortuna');
  });

  test('response.bar.series is set for PAMP Fortuna', async () => {
    const res = await post({ metal: 'gold', size: '1 oz', brand: 'PAMP', series: 'fortuna' });
    expect(res.status).toBe(200);
    expect(res.body.bar.series).toBe('Fortuna');
  });

  test('Perth Mint cast adds cast to keywords', async () => {
    await post({ metal: 'gold', size: '1 oz', brand: 'Perth Mint', series: 'cast' });
    const keywords = fetchSoldComps.mock.calls[0][0];
    expect(keywords).toContain('cast');
  });

  test('expected.barSeries and barSeriesRe are set', async () => {
    await post({ metal: 'gold', size: '1 oz', brand: 'PAMP', series: 'fortuna' });
    const expected = fetchSoldComps.mock.calls[0][2];
    expect(expected.barSeries).toBe('Fortuna');
    expect(expected.barSeriesRe).toBeInstanceOf(RegExp);
  });

  test('unknown series leaves barSeries null', async () => {
    await post({ metal: 'gold', size: '1 oz', brand: 'PAMP', series: 'nonexistent' });
    const expected = fetchSoldComps.mock.calls[0][2];
    expect(expected.barSeries).toBeNull();
    expect(expected.barSeriesRe).toBeNull();
  });

  test('lunar series still takes priority over bar series detection', async () => {
    const res = await post({ metal: 'gold', size: '1 oz', brand: 'Perth', series: 'lunar', year: 2024 });
    expect(res.status).toBe(200);
    expect(res.body.bar.series).toBe('Lunar');
    expect(res.body.bar.zodiacAnimal).toBe('Dragon');
  });

  test('no series leaves bar.series null', async () => {
    const res = await post({ metal: 'gold', size: '1 oz', brand: 'PAMP' });
    expect(res.status).toBe(200);
    expect(res.body.bar.series).toBeNull();
  });
});
