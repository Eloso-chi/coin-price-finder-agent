// __tests__/coinVariantRoute.test.js — Integration tests for GET /api/coin-variant
'use strict';

jest.mock('../src/data/halfDollarSeries', () => ({
  resolveCoinVariant: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const { resolveCoinVariant } = require('../src/data/halfDollarSeries');
const coinVariantRoute = require('../src/routes/coinVariantRoute');

let app;

beforeAll(() => {
  app = express();
  app.use('/api/coin-variant', coinVariantRoute);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/coin-variant', () => {
  test('returns 200 with variant data for valid denomination + year', async () => {
    resolveCoinVariant.mockReturnValue({
      denomination: 'Half Dollar',
      year: 2024,
      designName: 'Kennedy',
      variantSuffix: null,
      composition: 'Copper-Nickel Clad',
      notes: null,
      label: 'Half Dollar — Kennedy',
    });

    const res = await request(app)
      .get('/api/coin-variant')
      .query({ denomination: 'Half Dollar', year: '2024' });

    expect(res.status).toBe(200);
    expect(res.body.designName).toBe('Kennedy');
    expect(res.body.composition).toBe('Copper-Nickel Clad');
    expect(res.body.label).toBe('Half Dollar — Kennedy');
    expect(resolveCoinVariant).toHaveBeenCalledWith('Half Dollar', '2024');
  });

  test('passes denomination and year query params to resolveCoinVariant', async () => {
    resolveCoinVariant.mockReturnValue({ designName: 'Walking Liberty' });

    await request(app)
      .get('/api/coin-variant')
      .query({ denomination: 'Half Dollar', year: '1940' });

    expect(resolveCoinVariant).toHaveBeenCalledWith('Half Dollar', '1940');
  });

  test('returns result even when query params are missing', async () => {
    resolveCoinVariant.mockReturnValue({
      designName: 'Unknown',
      notes: 'Missing denomination or year',
    });

    const res = await request(app).get('/api/coin-variant');

    expect(res.status).toBe(200);
    expect(resolveCoinVariant).toHaveBeenCalledWith(undefined, undefined);
    expect(res.body.designName).toBe('Unknown');
  });

  test('returns variant with suffix for special years', async () => {
    resolveCoinVariant.mockReturnValue({
      denomination: 'Half Dollar',
      year: 2026,
      designName: 'Kennedy',
      variantSuffix: 'Semiquincentennial',
      composition: 'Copper-Nickel Clad',
      notes: '250th Anniversary of Independence',
      label: 'Half Dollar — Kennedy (Semiquincentennial)',
    });

    const res = await request(app)
      .get('/api/coin-variant')
      .query({ denomination: 'Half Dollar', year: '2026' });

    expect(res.status).toBe(200);
    expect(res.body.variantSuffix).toBe('Semiquincentennial');
    expect(res.body.notes).toContain('250th Anniversary');
  });

  test('response is JSON content-type', async () => {
    resolveCoinVariant.mockReturnValue({ designName: 'Kennedy' });

    const res = await request(app)
      .get('/api/coin-variant')
      .query({ denomination: 'Half Dollar', year: '2024' });

    expect(res.headers['content-type']).toMatch(/json/);
  });

  test('only responds to GET method', async () => {
    const res = await request(app)
      .post('/api/coin-variant')
      .send({ denomination: 'Half Dollar', year: 2024 });

    // Express returns 404 for unmatched method on this route
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
