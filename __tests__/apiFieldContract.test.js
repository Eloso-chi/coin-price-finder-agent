/**
 * apiFieldContract.test.js — UI field contract validation
 *
 * Ensures every /api/price response contains all fields required by the
 * frontend UI. Goes deeper than priceRoute.test.js by validating nested
 * field types and checking error-response shapes.
 *
 * Gap addressed: API Response Shape — missing UI field contract checks
 * and error response shape validation.
 */

'use strict';

// ── Mock all service deps (same pattern as priceRoute.test.js) ──

jest.mock('../src/services/pcgsService', () => ({
  parseDescription: jest.fn((q) => ({
    series: 'Morgan Dollar',
    year: 1921,
    mint: null,
    grade: null,
    gradeNum: null,
    weight: null,
    finish: null,
  })),
  resolveFromDescription: jest.fn(async () => ({
    verified: false,
    pcgsCoinNumber: null,
    series: 'Morgan Dollar',
    year: 1921,
    mint: null,
    grade: null,
    designation: null,
    finish: null,
    variety: null,
    priceGuide: null,
    population: null,
    auction: null,
    trueViewUrl: null,
    coinImages: [],
    parsed: { series: 'Morgan Dollar', year: 1921, mint: null, grade: null, gradeNum: null },
    limitations: ['PCGS API key not configured'],
  })),
  lookupByCert: jest.fn(async () => null),
  lookupByCoinNumberAndGrade: jest.fn(async () => null),
}));

jest.mock('../src/services/ebayService', () => ({
  buildKeywords: jest.fn(() => '1921 Morgan Silver Dollar'),
  fetchSoldComps: jest.fn(async () => ({
    us: {
      comps: [
        { itemId: '1', title: '1921 Morgan Silver Dollar BU', totalUsd: 70, matchScore: 80, gradeType: 'raw', soldDate: '2025-12-01', _source: 'terapeak' },
        { itemId: '2', title: '1921 Morgan Dollar Silver Coin', totalUsd: 72, matchScore: 75, gradeType: 'raw', soldDate: '2025-12-05', _source: 'terapeak' },
        { itemId: '3', title: '1921-P Morgan $1 Silver Dollar', totalUsd: 68, matchScore: 78, gradeType: 'raw', soldDate: '2025-12-10', _source: 'terapeak' },
        { itemId: '4', title: '1921 Morgan Silver Dollar AU', totalUsd: 75, matchScore: 72, gradeType: 'raw', soldDate: '2025-12-15', _source: 'terapeak' },
        { itemId: '5', title: '1921 Morgan Silver Dollar EF', totalUsd: 65, matchScore: 70, gradeType: 'raw', soldDate: '2025-12-20', _source: 'terapeak' },
      ],
      stats: { count: 5, mean: 70, median: 70, p25: 67, p75: 73, min: 65, max: 75 },
      removed: { denied: 0, nonUsd: 0, outlier: 1 },
    },
    global: { comps: [], stats: { count: 0 } },
    usedFallback: false,
    keywords: '1921 Morgan Silver Dollar',
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

jest.mock('../src/services/valuationService', () => ({
  computeValuation: jest.fn(() => ({
    valuation: {
      fmvCore: 70.00,
      rangeLow: 65.00,
      rangeHigh: 75.00,
      confidence: 82,
      lowData: false,
      compCount: 5,
      explanation: ['Raw coin blend. Base weights: eBay 70%, PCGS 10%, Greysheet 20%.'],
      dataSource: { soldCount: 5, activeCount: 0, totalComps: 5, soldRatio: 1, browseOnly: false, label: 'sold-data' },
      gradePool: { wantsGraded: false, wantsProof: false, usedPool: 'raw', gradedCount: 0, rawCount: 5, proofCount: 0, poolCount: 5, totalCount: 5, poolFallback: false },
      method: 'raw-blend',
      saleContext: 'eBay Retail',
    },
    decisions: {
      buy: { max70: 49, max75: 52.5, max80: 56, askingPrice: null, recommendation: null, notes: [] },
      sell: { fast: 64.40, normal: 70.00, premium: 73.50, offerFloor: 65.00, notes: [] },
    },
  })),
}));

jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(async () => ({ price: 30.50 })),
}));

jest.mock('../src/services/numistaService', () => ({
  lookupCoin: jest.fn(async () => ({ accessible: false, limitations: ['mocked'] })),
}));

jest.mock('../src/data/keyDates', () => ({
  lookupKeyDate: jest.fn(() => ({ isKeyDate: false })),
}));

jest.mock('../src/data/mintages', () => ({
  lookupMintage: jest.fn(() => ({ mintage: null, series: null })),
}));

jest.mock('../src/data/lunarReference', () => ({
  buildLunarComparison: jest.fn(() => null),
}));

jest.mock('../src/data/halfDollarSeries', () => ({
  resolveCoinVariant: jest.fn(() => null),
}));

jest.mock('../src/data/constants', () => ({
  zodiacForYear: jest.fn(() => null),
  perthLunarSeries: jest.fn(() => ({ label: null, series: null })),
  getRollQuantity: jest.fn(() => 20),
  BULLION_1OZ_DEFAULT: [
    'libertad', 'silver eagle', 'gold eagle', 'maple leaf', 'britannia',
    'philharmonic', 'krugerrand', 'kangaroo', 'kookaburra', 'panda',
    'gold buffalo', 'platinum eagle', 'palladium eagle', 'lunar', 'polar bear'
  ],
  ALLOWED_LABELS: new Set([
    'First Strike', 'Early Releases', 'First Releases', 'First Day of Issue',
    'Burnished', 'Reverse Proof', 'Enhanced Reverse Proof',
    'Satin Finish', 'Antiqued', 'High Relief', 'Prooflike',
    'Colorized', 'Privy', 'Type 1', 'Type 2',
  ]),
}));

jest.mock('../src/utils/responseValidator', () => ({
  validateSeriesIntegrity: jest.fn(() => ({ valid: true })),
  validateNumericSanity: jest.fn(() => ({ valid: true })),
}));

jest.mock('../src/utils/filters', () => ({
  hasSeriesConflict: jest.fn(() => false),
  detectDenomination: jest.fn(() => null),
}));

const express = require('express');
const request = require('supertest');
const priceRoute = require('../src/routes/priceRoute');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/price', priceRoute);
  return app;
}

// ═══════════════════════════════════════════════════════════════
//  UI Field Contract — required top-level fields
// ═══════════════════════════════════════════════════════════════

describe('API field contract — /api/price', () => {
  let app;
  let response;

  beforeAll(async () => {
    app = createApp();
    const res = await request(app)
      .post('/api/price')
      .send({ query: '1921 Morgan Silver Dollar' });
    response = res.body;
  });

  // ── Top-level fields ──

  test('has query object with input', () => {
    expect(response.query).toBeDefined();
    expect(response.query.input).toBe('1921 Morgan Silver Dollar');
    expect(response.query).toHaveProperty('askingPrice');
    expect(response.query).toHaveProperty('options');
  });

  test('has identification object', () => {
    expect(response.identification).toBeDefined();
    expect(response.identification).toHaveProperty('inputQuery');
    expect(response.identification).toHaveProperty('resolvedVia');
    expect(response.identification).toHaveProperty('parsed');
  });

  test('identification.parsed has required coin identity fields', () => {
    const { parsed } = response.identification;
    expect(parsed).toHaveProperty('series');
    expect(parsed).toHaveProperty('year');
  });

  test('has pcgs object', () => {
    expect(response.pcgs).toBeDefined();
    expect(response.pcgs).toHaveProperty('verified');
    expect(response.pcgs).toHaveProperty('series');
    expect(response.pcgs).toHaveProperty('year');
  });

  test('has ebay object with us tier', () => {
    expect(response.ebay).toBeDefined();
    expect(response.ebay).toHaveProperty('us');
    expect(response.ebay.us).toHaveProperty('comps');
    expect(response.ebay.us).toHaveProperty('stats');
    expect(response.ebay).toHaveProperty('keywords');
  });

  test('has valuation object with all pricing fields', () => {
    const { valuation } = response;
    expect(valuation).toBeDefined();
    expect(typeof valuation.fmvCore).toBe('number');
    expect(typeof valuation.rangeLow).toBe('number');
    expect(typeof valuation.rangeHigh).toBe('number');
    expect(typeof valuation.confidence).toBe('number');
    expect(valuation).toHaveProperty('explanation');
    expect(valuation).toHaveProperty('method');
    expect(valuation).toHaveProperty('compCount');
  });

  test('valuation range sanity: rangeLow <= fmvCore <= rangeHigh', () => {
    const { valuation } = response;
    expect(valuation.rangeLow).toBeLessThanOrEqual(valuation.fmvCore);
    expect(valuation.fmvCore).toBeLessThanOrEqual(valuation.rangeHigh);
  });

  test('has decisions object with buy and sell', () => {
    const { decisions } = response;
    expect(decisions).toBeDefined();
    expect(decisions).toHaveProperty('buy');
    expect(decisions).toHaveProperty('sell');
  });

  test('decisions.buy has max70, max75, max80', () => {
    const { buy } = response.decisions;
    expect(buy).toHaveProperty('max70');
    expect(buy).toHaveProperty('max75');
    expect(buy).toHaveProperty('max80');
    expect(typeof buy.max70).toBe('number');
  });

  test('decisions.sell has fast, normal, premium', () => {
    const { sell } = response.decisions;
    expect(sell).toHaveProperty('fast');
    expect(sell).toHaveProperty('normal');
    expect(sell).toHaveProperty('premium');
    expect(typeof sell.normal).toBe('number');
  });

  test('valuation.dataSource has sold/active counts', () => {
    const { dataSource } = response.valuation;
    expect(dataSource).toBeDefined();
    expect(dataSource).toHaveProperty('soldCount');
    expect(dataSource).toHaveProperty('activeCount');
    expect(dataSource).toHaveProperty('totalComps');
    expect(dataSource).toHaveProperty('browseOnly');
    expect(dataSource).toHaveProperty('label');
  });

  test('valuation.gradePool has pool selection info', () => {
    const { gradePool } = response.valuation;
    expect(gradePool).toBeDefined();
    expect(gradePool).toHaveProperty('wantsGraded');
    expect(gradePool).toHaveProperty('usedPool');
    expect(gradePool).toHaveProperty('poolCount');
    expect(gradePool).toHaveProperty('totalCount');
  });

  test('has keyDate object', () => {
    expect(response.keyDate).toBeDefined();
    expect(response.keyDate).toHaveProperty('isKeyDate');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Error response shape validation
// ═══════════════════════════════════════════════════════════════

describe('API field contract — error responses', () => {
  let app;

  beforeEach(() => {
    app = createApp();
  });

  test('400 error has error field as string', async () => {
    const res = await request(app).post('/api/price').send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(typeof res.body.error).toBe('string');
  });

  test('400 error does not leak stack traces', async () => {
    const res = await request(app).post('/api/price').send({});
    expect(res.body).not.toHaveProperty('stack');
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\w+\s+\(/);
  });

  test('numeric askingPrice is preserved in response', async () => {
    const validRes = await request(app)
      .post('/api/price')
      .send({ query: '1921 Morgan', askingPrice: 100 });
    expect(validRes.body.query.askingPrice).toBe(100);
  });

  // NOTE: Non-numeric askingPrice is currently passed through unvalidated.
  // This documents current behavior -- consider adding input validation.
  test('non-numeric askingPrice is passed through (current behavior)', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '1921 Morgan', askingPrice: 'not-a-number' });
    expect(res.status).toBe(200);
    // Currently no server-side validation -- string passes through
    expect(res.body.query.askingPrice).toBe('not-a-number');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Field type validation (numeric fields are numbers, not strings)
// ═══════════════════════════════════════════════════════════════

describe('API field contract — type safety', () => {
  let app;

  beforeAll(async () => {
    app = createApp();
  });

  test('all numeric pricing fields are typeof number', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '1921 Morgan Silver Dollar' });

    const { valuation, decisions } = res.body;
    expect(typeof valuation.fmvCore).toBe('number');
    expect(typeof valuation.rangeLow).toBe('number');
    expect(typeof valuation.rangeHigh).toBe('number');
    expect(typeof valuation.confidence).toBe('number');
    expect(typeof decisions.buy.max70).toBe('number');
    expect(typeof decisions.sell.normal).toBe('number');
  });

  test('confidence is between 0 and 100', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '1921 Morgan Silver Dollar' });

    expect(res.body.valuation.confidence).toBeGreaterThanOrEqual(0);
    expect(res.body.valuation.confidence).toBeLessThanOrEqual(100);
  });

  test('explanation is array of strings', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '1921 Morgan Silver Dollar' });

    expect(Array.isArray(res.body.valuation.explanation)).toBe(true);
    res.body.valuation.explanation.forEach(e => {
      expect(typeof e).toBe('string');
    });
  });
});
