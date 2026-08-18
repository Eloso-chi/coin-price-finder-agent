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
