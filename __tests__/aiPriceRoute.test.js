'use strict';

jest.mock('../src/services/pricingService', () => ({
  priceCoin: jest.fn(async (input, trustedContext) => ({
    valuation: {
      fmvCore: 47.5,
      method: 'deterministic-boundary',
      confidence: 'medium',
      compCount: 2,
      algorithmVersion: '1.0.0',
      configVersion: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      computedAt: '2026-08-17T00:00:00.000Z',
    },
    ebay: {
      usedFallback: false,
      us: { comps: [{ itemId: 'licensed-id', _source: 'terapeak' }] },
    },
    pcgs: { verified: true },
    reproducibility: {
      ebay: { usItemIds: ['licensed-id'], globalItemIds: [] },
    },
    mode: 'ai',
    trustedAudience: trustedContext?.audience || 'public',
    query: input.query,
  })),
}));

jest.mock('../src/services/auditService', () => ({
  writeValuationAudit: jest.fn(() => Promise.resolve(false)),
}));

const request = require('supertest');
const express = require('express');
const aiPriceRoute = require('../src/routes/aiPriceRoute');
const { priceCoin } = require('../src/services/pricingService');
const { writeValuationAudit } = require('../src/services/auditService');
const { ProductIdentityError, resolveProductIdentity } = require('../src/utils/productIdentityResolver');

function createApp(isAdmin = false) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAdmin = isAdmin;
    req.id = 'request-phase2';
    if (isAdmin) req.adminActor = { userId: 'admin-user' };
    next();
  });
  app.use('/api/ai', aiPriceRoute);
  return app;
}

describe('POST /api/ai/price', () => {
  let app;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
  });

  test('returns 400 when query is missing', async () => {
    const res = await request(app)
      .post('/api/ai/price')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  test('returns 400 for typed ambiguous product identity failures', async () => {
    const identity = resolveProductIdentity({ text: '1 oz and 5 oz Silver set' });
    priceCoin.mockRejectedValueOnce(new ProductIdentityError('Product identity is ambiguous (weight).', identity));

    const res = await request(app)
      .post('/api/ai/price')
      .send({ query: '2025 American Silver Eagle 1 oz and 5 oz set' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      ok: false,
      code: 'AMBIGUOUS_PRODUCT_IDENTITY',
    }));
  });

  test('calls the shared deterministic pricing boundary and returns AI mode payload', async () => {
    const res = await request(app)
      .post('/api/ai/price')
      .send({ query: '2024 American Silver Eagle' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe('ai');
    expect(res.body.provider).toBe('deterministic-boundary');
    expect(priceCoin).toHaveBeenCalledTimes(1);
    expect(res.body.response.valuation.fmvCore).toBe(47.5);
    expect(res.body.answer).toMatch(/estimated fair market value.*\$47\.50/i);
    expect(res.body.provenance).toBeDefined();
    expect(res.body.provenance.valuation).toEqual({
      method: 'deterministic-boundary',
      algorithm: 'deterministic-boundary',
      algorithmVersion: '1.0.0',
      configVersion: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      computedAt: '2026-08-17T00:00:00.000Z',
      confidence: 'medium',
      compCount: 2,
      lowData: false,
      dataSource: null,
      compositeBasis: null,
      warning: null,
    });
    expect(res.body.provenance.reproducibility).toEqual({
      pcgsVerified: true,
      usCompCount: 1,
      globalCompCount: 0,
    });
    expect(res.body.response.ebay.us.comps[0]).toEqual({
      itemId: 'licensed-id',
      _source: 'ebay-sold',
    });
    expect(res.body.handoff).toEqual({
      query: '2024 American Silver Eagle',
      coinData: null,
      options: {},
      weight: null,
      askingPrice: null,
      saleContext: null,
      appealMultiplier: null,
    });
    expect(writeValuationAudit).toHaveBeenCalledWith(expect.objectContaining({
      query: '2024 American Silver Eagle',
      algorithmVersion: '1.0.0',
      configVersion: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      requestId: 'request-phase2',
    }));
  });

  test('preserves composite provenance and warning from deterministic pricing', async () => {
    const compositeBasis = {
      usedCohort: true,
      cohortYears: [2018, 2019, 2021, 2022],
      cohortCompCount: 4,
      exactYearCompCount: 1,
      populationGateApplied: false,
    };
    priceCoin.mockResolvedValueOnce({
      valuation: {
        fmvCore: 500,
        method: 'raw-blend (composite)',
        confidence: 30,
        compCount: 5,
        lowData: false,
        dataSource: { label: 'cross-year-composite' },
        gradePool: { compositeBasis },
      },
      ebay: { usedFallback: false, us: { comps: [] } },
      pcgs: { verified: false },
    });

    const res = await request(app).post('/api/ai/price').send({
      query: '2020 Mexican Silver Libertad Proof 5 oz',
    });

    expect(res.body.provenance.valuation).toEqual(expect.objectContaining({
      method: 'raw-blend (composite)',
      confidence: 30,
      dataSource: { label: 'cross-year-composite' },
      compositeBasis,
      warning: expect.stringMatching(/composite estimate/i),
    }));
    expect(res.body.answer).toMatch(/composite estimate/i);
    expect(res.body.answer).toMatch(/nearby-year sales were used as a proxy/i);
  });

  test('accepts only allowlisted structured context for a conversation handoff', async () => {
    const res = await request(app)
      .post('/api/ai/price')
      .send({
        structuredContext: {
          query: '1964 Kennedy Half Dollar',
          coinData: { year: 1964, name: 'Kennedy Half Dollar' },
          weight: 0.5,
          options: { timeWindowDays: 90 },
          trustedContext: { isAdmin: true, audience: 'admin' },
          internalToken: 'must-not-forward',
        },
      });

    expect(res.status).toBe(200);
    expect(priceCoin).toHaveBeenCalledWith({
      query: '1964 Kennedy Half Dollar',
      coinData: { year: 1964, name: 'Kennedy Half Dollar' },
      weight: 0.5,
      options: { timeWindowDays: 90 },
      saleContext: undefined,
      askingPrice: undefined,
      appealMultiplier: undefined,
    }, { isAdmin: false, audience: 'public' });
    expect(res.body.handoff.query).toBe('1964 Kennedy Half Dollar');
    expect(res.body.handoff.coinData).toEqual({ year: 1964, name: 'Kennedy Half Dollar' });
    expect(res.body.handoff.trustedContext).toBeUndefined();
  });

  test('preserves licensed provenance for server-authenticated admin context only', async () => {
    const res = await request(createApp(true))
      .post('/api/ai/price')
      .send({ query: '2024 American Silver Eagle' });

    expect(res.status).toBe(200);
    expect(res.body.response.ebay.us.comps[0]._source).toBe('terapeak');
    expect(priceCoin).toHaveBeenCalledWith(expect.any(Object), { isAdmin: true, audience: 'admin' });
  });

  test('returns a safe clarification for ambiguous queries', async () => {
    const res = await request(app)
      .post('/api/ai/price')
      .send({ query: 'coin' });

    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/need more detail|ambiguous|clarification/i);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
  });

  test('refuses to invent a price when deterministic data is unavailable', async () => {
    priceCoin.mockResolvedValueOnce({
      valuation: { fmvCore: null, rangeLow: null, rangeHigh: null, compCount: 0 },
    });

    const res = await request(app)
      .post('/api/ai/price')
      .send({ query: '2024 Mexican Silver Libertad' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/couldn't find enough deterministic sold-comparable data/i);
    expect(res.body.answer).toMatch(/won't invent/i);
  });

  test('reports a low-confidence spot-only bullion estimate when FMV exists without comps', async () => {
    priceCoin.mockResolvedValueOnce({
      valuation: { fmvCore: 63.95, rangeLow: 57.55, rangeHigh: 70.34, compCount: 0, confidence: 0 },
    });

    const res = await request(app)
      .post('/api/ai/price')
      .send({ query: '2024 1oz silver Libertad' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/\$63\.95.*spot pricing only/i);
    expect(res.body.answer).toMatch(/no sold comparables/i);
  });

  test('discloses a deterministic single-comp estimate in answer and provenance', async () => {
    priceCoin.mockResolvedValueOnce({
      valuation: {
        fmvCore: 700,
        rangeLow: 630,
        rangeHigh: 770,
        compCount: 1,
        confidence: 0,
        lowData: true,
      },
    });

    const res = await request(app)
      .post('/api/ai/price')
      .send({ query: '2016 Mexican Silver Libertad Proof 5 oz' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/warning:.*single-comp estimate.*outlier/i);
    expect(res.body.provenance.valuation).toMatchObject({
      confidence: 0,
      compCount: 1,
      lowData: true,
      warning: expect.stringMatching(/single-comp estimate/i),
    });
  });

  test('extracts the coin subject from a natural-language value question', async () => {
    priceCoin.mockResolvedValueOnce({
      valuation: { fmvCore: 63.95, rangeLow: 57.55, rangeHigh: 70.34, compCount: 0 },
    });

    const res = await request(app)
      .post('/api/ai/price')
      .send({ query: 'What is the value of my 2024 Mexican Silver Libertad 1 oz?' });

    expect(res.status).toBe(200);
    expect(priceCoin).toHaveBeenCalledWith(expect.objectContaining({
      query: '2024 Mexican Silver Libertad 1 oz',
    }), expect.any(Object));
    expect(res.body.answer).toMatch(/for 2024 Mexican Silver Libertad 1 oz is \$63\.95/i);
  });

  test('extracts the coin subject for conversational deterministic fallback', async () => {
    const res = await request(app)
      .post('/api/ai/price')
      .send({ query: 'What is a fair price for my 2024 1oz silver Libertad?' });

    expect(res.status).toBe(200);
    expect(priceCoin).toHaveBeenCalledWith(expect.objectContaining({
      query: '2024 1oz silver Libertad',
    }), expect.any(Object));
    expect(res.body.answer).toMatch(/2024 1oz silver Libertad/i);
  });

  test('degrades gracefully when pricing service rejects', async () => {
    priceCoin.mockRejectedValueOnce(new Error('pricing service unavailable'));

    const res = await request(app)
      .post('/api/ai/price')
      .send({ query: '2024 American Silver Eagle' });

    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/pricing service unavailable|service unavailable/i);
  });
});
