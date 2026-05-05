/**
 * metalsRoute.test.js — Integration tests for GET /api/metals
 *
 * Covers: parameter validation, single metal lookup, multi-metal lookup,
 * currency parameter, error handling (502 for provider failures, 500 for unexpected).
 */

'use strict';

const express = require('express');
const request = require('supertest');

// ── Mocks ────────────────────────────────────────────────────

jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(),
  getMetalsSpotPrices: jest.fn(),
}));

jest.mock('../src/services/MetalsSpotPriceError', () => ({
  MetalsSpotPriceError: class MetalsSpotPriceError extends Error {
    constructor(message, { providersTried, metal, currency } = {}) {
      super(message);
      this.name = 'MetalsSpotPriceError';
      this.providersTried = providersTried || [];
      this.metal = metal;
      this.currency = currency;
    }
  },
}));

const { getMetalsSpotPrice, getMetalsSpotPrices } = require('../src/services/metalsSpotPrice');
const { MetalsSpotPriceError } = require('../src/services/MetalsSpotPriceError');

const metalsRoute = require('../src/routes/metalsRoute');

function buildApp() {
  const app = express();
  app.use('/api/metals', metalsRoute);
  return app;
}

// ═══════════════════════════════════════════════════════════════
//  GET /api/metals (multi-metal)
// ═══════════════════════════════════════════════════════════════

describe('GET /api/metals', () => {
  const app = buildApp();

  test('returns XAU + XAG by default', async () => {
    getMetalsSpotPrices.mockResolvedValue({
      XAU: { metal: 'XAU', price: 2350, currency: 'USD' },
      XAG: { metal: 'XAG', price: 30.5, currency: 'USD' },
    });

    const res = await request(app).get('/api/metals');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.prices.XAU.price).toBe(2350);
    expect(res.body.prices.XAG.price).toBe(30.5);
  });

  test('accepts custom metals list', async () => {
    getMetalsSpotPrices.mockResolvedValue({
      XPT: { metal: 'XPT', price: 1050, currency: 'USD' },
    });

    const res = await request(app).get('/api/metals?metals=XPT');
    expect(res.status).toBe(200);
    expect(res.body.prices.XPT).toBeDefined();
  });

  test('accepts currency parameter', async () => {
    getMetalsSpotPrices.mockResolvedValue({
      XAU: { metal: 'XAU', price: 2150, currency: 'EUR' },
    });

    const res = await request(app).get('/api/metals?metals=XAU&currency=EUR');
    expect(res.status).toBe(200);
    expect(getMetalsSpotPrices).toHaveBeenCalledWith(['XAU'], 'EUR');
  });

  test('returns 400 for invalid metal', async () => {
    const res = await request(app).get('/api/metals?metals=FAKE');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('returns 502 when all providers fail', async () => {
    getMetalsSpotPrices.mockRejectedValue(
      new MetalsSpotPriceError('All providers failed', {
        providersTried: ['GoldAPI', 'MetalsAPI'],
        metal: 'XAU',
        currency: 'USD',
      })
    );

    const res = await request(app).get('/api/metals');
    expect(res.status).toBe(502);
    expect(res.body.providersTried).toContain('GoldAPI');
  });

  test('returns 500 for unexpected errors', async () => {
    getMetalsSpotPrices.mockRejectedValue(new Error('unexpected'));
    const res = await request(app).get('/api/metals');
    expect(res.status).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════
//  GET /api/metals/:metal (single)
// ═══════════════════════════════════════════════════════════════

describe('GET /api/metals/:metal', () => {
  const app = buildApp();

  test('returns single metal price', async () => {
    getMetalsSpotPrice.mockResolvedValue({
      metal: 'XAU',
      price: 2350,
      currency: 'USD',
      provider: 'GoldAPI',
      timestamp: '2026-05-05T12:00:00Z',
    });

    const res = await request(app).get('/api/metals/XAU');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.price).toBe(2350);
    expect(res.body.metal).toBe('XAU');
  });

  test('is case-insensitive', async () => {
    getMetalsSpotPrice.mockResolvedValue({
      metal: 'XAG', price: 31, currency: 'USD',
    });

    const res = await request(app).get('/api/metals/xag');
    expect(res.status).toBe(200);
    expect(getMetalsSpotPrice).toHaveBeenCalledWith('XAG', 'USD');
  });

  test('returns 400 for invalid metal', async () => {
    const res = await request(app).get('/api/metals/BITCOIN');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('returns 502 when provider fails', async () => {
    getMetalsSpotPrice.mockRejectedValue(
      new MetalsSpotPriceError('Provider timeout', {
        providersTried: ['GoldAPI'],
        metal: 'XAG',
        currency: 'USD',
      })
    );

    const res = await request(app).get('/api/metals/XAG');
    expect(res.status).toBe(502);
    expect(res.body.metal).toBe('XAG');
  });
});
