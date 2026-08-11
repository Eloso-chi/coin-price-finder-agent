// __tests__/pricingBatchRoute.test.js — Tests for POST /api/pricing-batch
// Follows the same pattern as marketRoute.test.js

'use strict';

// Mock heavy dependencies so tests are fast and isolated
jest.mock('../src/services/pcgsService', () => ({
  parseDescription: jest.fn((q) => ({
    series: 'Morgan Dollar',
    year: 1921,
    mint: null,
    grade: 'MS-65',
    gradeNum: 65,
    weight: null,
  })),
  resolveFromDescription: jest.fn(async () => ({ verified: false })),
}));

jest.mock('../src/services/ebayService', () => ({
  buildKeywords: jest.fn((pcgs, query) => query),
  fetchSoldComps: jest.fn(async () => ({
    us: {
      comps: [
        { itemId: 'c1', title: 'Test Comp', totalUsd: 50, matchScore: 80, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
        { itemId: 'c2', title: 'Test Comp 2', totalUsd: 55, matchScore: 75, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
        { itemId: 'c3', title: 'Test Comp 3', totalUsd: 48, matchScore: 70, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
      ],
      stats: { count: 3, median: 50, mean: 51 },
    },
    global: { comps: [], stats: { count: 0 } },
    usedFallback: false,
  })),
}));

jest.mock('../src/services/valuationService', () => ({
  computeValuation: jest.fn(() => ({
    valuation: {
      fmvCore: 52.00, rangeLow: 45.00, rangeHigh: 58.00, confidence: 72,
      algorithmVersion: '1.0.0', configVersion: `sha256:${'b'.repeat(64)}`,
      computedAt: '2026-08-11T12:34:56.000Z', dataSource: { label: 'sold-data' },
    },
    decisions: { buy: {}, sell: {} },
  })),
}));

jest.mock('../src/services/auditService', () => ({
  writeValuationAudit: jest.fn(async () => {}),
}));

jest.mock('../src/data/keyDates', () => ({
  lookupKeyDate: jest.fn(() => ({ isKeyDate: false })),
}));

jest.mock('../src/data/constants', () => ({
  ...jest.requireActual('../src/data/constants'),
  zodiacForYear: jest.fn(() => null),
  perthLunarSeries: jest.fn(() => null),
  getRollQuantity: jest.fn(() => 20),
}));

jest.mock('../src/utils/filters', () => ({
  detectDenomination: jest.fn(() => null),
}));

const http = require('http');
const express = require('express');
const pricingBatchRoute = require('../src/routes/pricingBatchRoute');
const { computeValuation } = require('../src/services/valuationService');
const { fetchSoldComps } = require('../src/services/ebayService');
const { writeValuationAudit } = require('../src/services/auditService');

let app, server, baseUrl;

beforeAll((done) => {
  app = express();
  app.use(express.json());
  app.use('/api/pricing-batch', pricingBatchRoute);
  server = app.listen(0, () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(baseUrl + path);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('POST /api/pricing-batch', () => {
  test('returns 400 when items is missing', async () => {
    const { status, body } = await post('/api/pricing-batch', {});
    expect(status).toBe(400);
    expect(body).toHaveProperty('error', 'items array is required');
  });

  test('returns 400 when items is empty', async () => {
    const { status, body } = await post('/api/pricing-batch', { items: [] });
    expect(status).toBe(400);
    expect(body).toHaveProperty('error', 'items array is required');
  });

  test('returns 400 when items exceeds maximum', async () => {
    const items = Array.from({ length: 26 }, (_, i) => ({ query: `coin ${i}` }));
    const { status, body } = await post('/api/pricing-batch', { items });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Maximum 25/);
  });

  test('rejects item queries longer than 300 characters', async () => {
    writeValuationAudit.mockClear();
    const { status, body } = await post('/api/pricing-batch', {
      items: [{ query: 'x'.repeat(301) }],
    });
    expect(status).toBe(400);
    expect(body.error).toContain('300');
    expect(writeValuationAudit).not.toHaveBeenCalled();
  });

  test('returns pricing for a single item', async () => {
    writeValuationAudit.mockClear();
    const { status, body } = await post('/api/pricing-batch', {
      items: [{ query: '1921 Morgan Dollar MS-65' }],
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toHaveProperty('fmv');
    expect(body.results[0]).toHaveProperty('rangeLow');
    expect(body.results[0]).toHaveProperty('rangeHigh');
    expect(body.results[0]).toHaveProperty('avgEbay');
    expect(body.results[0]).toHaveProperty('confidence');
    expect(body.results[0].fmv).toBe(52.00);
    expect(writeValuationAudit).toHaveBeenCalledTimes(1);
    expect(writeValuationAudit).toHaveBeenCalledWith(expect.objectContaining({
      query: '1921 Morgan Dollar MS-65',
      fmv: 52,
      method: 'sold-data',
      algorithmVersion: '1.0.0',
      computedAt: '2026-08-11T12:34:56.000Z',
    }));
  });

  test('preserves sparse-series source details and zero confidence', async () => {
    computeValuation.mockReturnValueOnce({
      valuation: {
        fmvCore: null,
        rangeLow: null,
        rangeHigh: null,
        confidence: 0,
        dataSource: {
          label: 'insufficient-series-comps',
          soldCount: 2,
          activeCount: 0,
          totalComps: 2,
          soldRatio: 1,
          browseOnly: false,
        },
      },
      decisions: { buy: {}, sell: {} },
    });

    const { status, body } = await post('/api/pricing-batch', {
      items: [{ query: 'PAMP Suisse twins 1 gram gold bar' }],
    });

    expect(status).toBe(200);
    expect(body.results[0]).toEqual(expect.objectContaining({
      fmv: null,
      confidence: 0,
      dataSource: {
        label: 'insufficient-series-comps',
        soldCount: 2,
        activeCount: 0,
        totalComps: 2,
        soldRatio: 1,
        browseOnly: false,
      },
    }));
  });

  test('returns pricing for multiple items', async () => {
    const items = [
      { query: '1921 Morgan Dollar MS-65' },
      { query: '1964 Kennedy Half Dollar PR-69' },
      { query: '1986 American Silver Eagle MS-70' },
    ];
    const { status, body } = await post('/api/pricing-batch', { items });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results).toHaveLength(3);
    body.results.forEach(r => {
      expect(r).toHaveProperty('fmv');
      expect(r).toHaveProperty('query');
    });
  });

  test('accepts items with coinData', async () => {
    const { status, body } = await post('/api/pricing-batch', {
      items: [{
        query: '1921 Morgan Dollar MS-65',
        coinData: { name: 'Morgan Dollar', year: 1921, mintMark: '', grade: 'MS-65' },
      }],
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results[0].fmv).toBe(52.00);
  });

  test.each([
    [{ barBrand: {}, barSeries: 'Fortuna' }],
    [{ barBrand: ['PAMP'], barSeries: ['Fortuna'] }],
    [{ barBrand: 'constructor', barSeries: 'prototype' }],
  ])('neutralizes unsafe structured bar intent through the route %#', async (coinData) => {
    const { status } = await post('/api/pricing-batch', {
      items: [{ query: 'generic 1 gram gold bar', coinData }],
    });
    const expected = fetchSoldComps.mock.calls.at(-1)[2];

    expect(status).toBe(200);
    expect(expected.barBrand).toBeNull();
    expect(expected.barSeries).toBeNull();
  });

  test('handles item with missing query gracefully', async () => {
    const { status, body } = await post('/api/pricing-batch', {
      items: [{ coinData: { name: 'Morgan Dollar' } }],
    });
    expect(status).toBe(200);
    expect(body.results[0]).toHaveProperty('error', 'missing query');
  });

  test('returns exactly 25 results for maximum batch', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ query: `coin ${i}` }));
    const { status, body } = await post('/api/pricing-batch', { items });
    expect(status).toBe(200);
    expect(body.results).toHaveLength(25);
  });
});
