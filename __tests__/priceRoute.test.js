// __tests__/priceRoute.test.js — Integration tests for POST /api/price
'use strict';

// ── Mock heavy dependencies ──
jest.mock('../src/services/pcgsService', () => ({
  parseDescription: jest.fn((q) => ({
    series: 'Morgan Dollar',
    year: 1881,
    mint: 'CC',
    grade: 'MS-64',
    gradeNum: 64,
    weight: null,
    finish: null,
  })),
  resolveFromDescription: jest.fn(async () => ({
    verified: false,
    pcgsCoinNumber: null,
    series: 'Morgan Dollar',
    year: 1881,
    mint: 'CC',
    grade: null,
    designation: null,
    finish: null,
    variety: null,
    priceGuide: null,
    population: null,
    auction: null,
    trueViewUrl: null,
    coinImages: [],
    parsed: { series: 'Morgan Dollar', year: 1881, mint: 'CC', grade: 'MS-64', gradeNum: 64 },
    limitations: ['PCGS API key not configured'],
  })),
  lookupByCert: jest.fn(async () => ({
    verified: true,
    pcgsCoinNumber: 7126,
    series: 'Morgan Dollar',
    year: 1881,
    mint: 'CC',
    grade: 'MS-64',
    priceGuide: { valueUsd: 900 },
    population: { thisGrade: 9515, higher: 8974 },
    auction: { count: 0, medianUsd: null, highUsd: null },
    trueViewUrl: null,
    coinImages: [],
    limitations: [],
  })),
  lookupByCoinNumberAndGrade: jest.fn(async () => ({
    verified: true,
    pcgsCoinNumber: 7126,
    series: 'Morgan Dollar',
    year: 1881,
    mint: 'CC',
    grade: 'MS-64',
    priceGuide: { valueUsd: 900 },
    population: { thisGrade: 9515, higher: 8974 },
    auction: { count: 0, medianUsd: null, highUsd: null },
    trueViewUrl: null,
    coinImages: [],
    limitations: [],
  })),
}));

jest.mock('../src/services/ebayService', () => ({
  buildKeywords: jest.fn((_pcgs, query, _w, label) => {
    return label ? `${query} ${label}` : query;
  }),
  fetchSoldComps: jest.fn(async () => ({
    us: {
      comps: [
        { itemId: 'u1', title: '1881-CC Morgan MS64', totalUsd: 835, matchScore: 90, gradeType: 'certified', soldDate: new Date().toISOString(), _source: 'finding' },
        { itemId: 'u2', title: '1881-CC Morgan MS64 PCGS', totalUsd: 850, matchScore: 88, gradeType: 'certified', soldDate: new Date().toISOString(), _source: 'finding' },
      ],
      stats: { count: 2, median: 842, mean: 842 },
    },
    global: { comps: [], stats: { count: 0 } },
    usedFallback: false,
  })),
}));

jest.mock('../src/services/valuationService', () => ({
  computeValuation: jest.fn(() => ({
    valuation: { fmvCore: 835, rangeLow: 780, rangeHigh: 890, confidence: 82, explanation: [] },
    decisions: { buy: { max70: 584.5 }, sell: { normal: 835 } },
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
  ...jest.requireActual('../src/data/constants'),
  zodiacForYear: jest.fn(() => null),
  perthLunarSeries: jest.fn(() => ({ label: null, series: null })),
  getRollQuantity: jest.fn(() => 20),
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
const ebayService = require('../src/services/ebayService');
const pcgsService = require('../src/services/pcgsService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/price', priceRoute);
  return app;
}

describe('POST /api/price', () => {
  let app;
  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
  });

  // ── Basic validation ──
  test('returns 400 when query is missing', async () => {
    const res = await request(app).post('/api/price').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  test('returns 400 for empty body', async () => {
    const res = await request(app).post('/api/price').send();
    expect(res.status).toBe(400);
  });

  // ── Successful pricing ──
  test('returns 200 with full response for valid query', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '1881-CC Morgan Dollar MS 64' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('valuation');
    expect(res.body).toHaveProperty('decisions');
    expect(res.body).toHaveProperty('pcgs');
    expect(res.body).toHaveProperty('ebay');
    expect(res.body).toHaveProperty('identification');
    expect(res.body.query.input).toBe('1881-CC Morgan Dollar MS 64');
  });

  test('passes askingPrice through to response', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '1881-CC Morgan Dollar MS 64', askingPrice: 650 });

    expect(res.status).toBe(200);
    expect(res.body.query.askingPrice).toBe(650);
  });

  test('passes options through', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '1881-CC Morgan', options: { timeWindowDays: 90, exactGradeOnly: true } });

    expect(res.status).toBe(200);
    expect(res.body.query.options.timeWindowDays).toBe(90);
    expect(res.body.query.options.exactGradeOnly).toBe(true);
  });

  // ── Label validation (#19) ──
  test('passes valid label to buildKeywords', async () => {
    await request(app)
      .post('/api/price')
      .send({ query: '2024 ASE MS70', coinData: { label: 'First Strike' } });

    const call = ebayService.buildKeywords.mock.calls[0];
    expect(call[3]).toBe('First Strike');
  });

  test('strips invalid label (not in allowlist)', async () => {
    await request(app)
      .post('/api/price')
      .send({ query: '2024 ASE MS70', coinData: { label: '<script>alert(1)</script>' } });

    const call = ebayService.buildKeywords.mock.calls[0];
    expect(call[3]).toBeNull();
  });

  test('strips empty string label', async () => {
    await request(app)
      .post('/api/price')
      .send({ query: '2024 ASE MS70', coinData: { label: '' } });

    const call = ebayService.buildKeywords.mock.calls[0];
    expect(call[3]).toBeNull();
  });

  test('valid label appears in response expected object', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 ASE MS70', coinData: { label: 'Early Releases' } });

    expect(res.status).toBe(200);
    const call = ebayService.buildKeywords.mock.calls[0];
    expect(call[3]).toBe('Early Releases');
  });

  // ── Proof detection ──
  test('detects proof from PF grade prefix', async () => {
    const proofParsed = {
      series: 'American Silver Eagle',
      year: 2024,
      mint: 'W',
      grade: 'PF70',
      gradeNum: 70,
      finish: null,
    };
    // parseDescription is called twice: once for peek (roll detection) and once inside resolveFromDescription
    pcgsService.parseDescription.mockReturnValue(proofParsed);
    pcgsService.resolveFromDescription.mockResolvedValueOnce({
      verified: false,
      series: 'American Silver Eagle',
      year: 2024,
      mint: 'W',
      grade: 'PF70',
      parsed: proofParsed,
      priceGuide: null, population: null, auction: null, trueViewUrl: null, coinImages: [], limitations: [],
    });

    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024-W ASE PF70' });

    expect(res.status).toBe(200);
    const expectedArg = ebayService.fetchSoldComps.mock.calls[0][2];
    expect(expectedArg.isProof).toBe(true);
  });

  test('detects proof from finish=Proof in parsed description', async () => {
    const proofParsed = {
      series: 'American Silver Eagle',
      year: 2024,
      mint: 'W',
      grade: 'Proof',
      gradeNum: null,
      finish: 'Proof',
    };
    pcgsService.parseDescription.mockReturnValue(proofParsed);
    pcgsService.resolveFromDescription.mockResolvedValueOnce({
      verified: false,
      series: 'American Silver Eagle',
      year: 2024,
      mint: 'W',
      grade: 'Proof',
      finish: 'Proof',
      parsed: proofParsed,
      priceGuide: null, population: null, auction: null, trueViewUrl: null, coinImages: [], limitations: [],
    });

    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024-W American Silver Eagle Proof' });

    expect(res.status).toBe(200);
    const expectedArg = ebayService.fetchSoldComps.mock.calls[0][2];
    expect(expectedArg.isProof).toBe(true);
  });

  // ── Cert number routing ──
  test('routes cert number queries to lookupByCert', async () => {
    await request(app)
      .post('/api/price')
      .send({ query: '12345678' });

    expect(pcgsService.lookupByCert).toHaveBeenCalledWith('12345678');
  });

  // ── PCGS coin number routing ──
  test('routes pcgsNumber via coinData to lookupByCoinNumberAndGrade', async () => {
    await request(app)
      .post('/api/price')
      .send({ query: 'Morgan Dollar', coinData: { pcgsNumber: 7126, grade: 'MS-64' } });

    expect(pcgsService.lookupByCoinNumberAndGrade).toHaveBeenCalledWith(7126, 64);
  });

  // ── Bullion weight defaulting ──
  test('defaults bullion to 1 oz when no weight specified', async () => {
    const aseParsed = {
      series: 'American Silver Eagle',
      year: 2024,
      mint: null,
      grade: 'MS-70',
      gradeNum: 70,
      weight: null,
    };
    pcgsService.parseDescription.mockReturnValue(aseParsed);
    pcgsService.resolveFromDescription.mockResolvedValueOnce({
      verified: false,
      series: 'American Silver Eagle',
      year: 2024,
      mint: null,
      parsed: aseParsed,
      priceGuide: null, population: null, auction: null, trueViewUrl: null, coinImages: [], limitations: [],
    });

    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle MS70' });

    expect(res.status).toBe(200);
    expect(res.body.query.weight).toBe(1);
  });

  // ── Semiquincentennial routing ──
  test('resolves semiquincentennial half dollar to Kennedy Half Dollar eBay keywords', async () => {
    pcgsService.parseDescription.mockReturnValueOnce({
      series: 'Semiquincentennial Half Dollar',
      year: 2026,
      mint: 'P',
      grade: null,
    });
    pcgsService.resolveFromDescription.mockResolvedValueOnce({
      verified: false,
      series: 'Semiquincentennial Half Dollar',
      year: 2026,
      mint: 'P',
      parsed: { series: 'Semiquincentennial Half Dollar', year: 2026, mint: 'P' },
      priceGuide: null,
      population: null,
      auction: null,
      trueViewUrl: null,
      coinImages: [],
      limitations: [],
    });

    const res = await request(app)
      .post('/api/price')
      .send({ query: '2026-P Semiquincentennial Half Dollar' });

    expect(res.status).toBe(200);
    expect(res.body.ebay.keywords).toMatch(/Kennedy Half Dollar/i);
    expect(res.body.ebay.keywords).toMatch(/Semiquincentennial/i);
  });

  // ── Roll detection ──
  test('builds roll keywords for roll queries', async () => {
    pcgsService.parseDescription.mockReturnValueOnce({
      series: 'Lincoln Cent',
      year: 1960,
      mint: 'D',
      grade: null,
      isRoll: true,
    });
    pcgsService.resolveFromDescription.mockResolvedValueOnce({
      verified: false,
      series: 'Lincoln Cent',
      year: 1960,
      mint: 'D',
      parsed: { series: 'Lincoln Cent', year: 1960, mint: 'D', isRoll: true },
      priceGuide: null,
      population: null,
      auction: null,
      trueViewUrl: null,
      coinImages: [],
      limitations: [],
    });

    const res = await request(app)
      .post('/api/price')
      .send({ query: '1960 D Lincoln cent roll' });

    expect(res.status).toBe(200);
    expect(res.body.ebay.keywords).toMatch(/roll/i);
  });

  // ── Error handling ──
  test('returns 500 on unhandled error', async () => {
    pcgsService.resolveFromDescription.mockRejectedValueOnce(new Error('Boom'));

    const res = await request(app)
      .post('/api/price')
      .send({ query: '1881-CC Morgan Dollar' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
  });

  // ── All 9 valid labels are accepted ──
  const VALID_LABELS = [
    'First Strike', 'Early Releases', 'First Day of Issue',
    'Burnished', 'Reverse Proof', 'Enhanced Reverse Proof',
    'Satin Finish', 'Antiqued', 'High Relief',
  ];
  test.each(VALID_LABELS)('accepts valid label: %s', async (label) => {
    await request(app)
      .post('/api/price')
      .send({ query: '2024 ASE MS70', coinData: { label } });

    const call = ebayService.buildKeywords.mock.calls[0];
    expect(call[3]).toBe(label);
  });
});
