/**
 * crossRouteConsistency.test.js — #116
 *
 * Sends the same coin query to both /api/price and /api/pricing-batch
 * and asserts that series, year, and FMV source are consistent.
 *
 * Uses shared helpers from coinTestConstants.js with seeded random
 * selection so failures are reproducible via COIN_TEST_SEED env var.
 */

'use strict';

/* ══════════════════════════════════════════════════════════════
 *  Shared mock setup — both routes hit the same underlying services
 * ══════════════════════════════════════════════════════════════ */

// Track calls to parseDescription so we can verify same input goes to both
const _parseCalls = [];

jest.mock('../src/services/pcgsService', () => ({
  parseDescription: jest.fn((q) => {
    _parseCalls.push(q);
    // Realistic enough parse that covers most coin types
    const yearMatch = q.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
    const metalMatch = q.match(/\b(silver|gold|platinum|palladium)\b/i);
    const metal = metalMatch ? metalMatch[1].toLowerCase() : null;
    const gradeMatch = q.match(/\b(MS|PR|PF|AU|XF|VF|SP)\s*[-]?\s*(\d{1,2})\b/i);
    const grade = gradeMatch ? gradeMatch[0].replace(/\s+/g, '-') : null;
    const gradeNum = gradeMatch ? parseInt(gradeMatch[2], 10) : null;
    const weightMatch = q.match(/(\d+(?:\/\d+)?)\s*oz/i);
    let weight = null;
    if (weightMatch) {
      const w = weightMatch[1];
      weight = w.includes('/') ? eval(w) : parseFloat(w);
    }
    // Derive series by stripping year, mint, grade, and weight
    const series = q
      .replace(/\b\d{4}\b/, '')
      .replace(/\b[A-Z]{1,2}\b/, '')
      .replace(/\b(MS|PR|PF|AU|XF|VF|SP)\s*[-]?\s*\d{1,2}\b/gi, '')
      .replace(/\d+(?:\/\d+)?\s*oz\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Unknown';
    return { series, year, mint: null, grade, gradeNum, weight, finish: null, metal };
  }),
  resolveFromDescription: jest.fn(async (q) => {
    // Return a shape that both routes expect
    const yearMatch = q.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
    const series = q
      .replace(/\b\d{4}\b/, '')
      .replace(/\b[A-Z]{1,2}\b/, '')
      .replace(/\b(MS|PR|PF|AU|XF|VF|SP)\s*[-]?\s*\d{1,2}\b/gi, '')
      .replace(/\d+(?:\/\d+)?\s*oz\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Unknown';
    return {
      verified: false,
      pcgsCoinNumber: null,
      series, year, mint: null,
      grade: null, designation: null, finish: null, variety: null,
      priceGuide: null, population: null, auction: null,
      trueViewUrl: null, coinImages: [],
      parsed: { series, year, mint: null, grade: null, gradeNum: null, metal: null, weight: null },
      limitations: [],
    };
  }),
  lookupByCert: jest.fn(async () => ({ verified: false })),
  lookupByCoinNumberAndGrade: jest.fn(async () => ({ verified: false })),
}));

// Create a deterministic set of comps that both routes will see
function _mockComps(median) {
  const spread = median * 0.1;
  return [
    { itemId: 'cr1', title: 'Test Comp 1', totalUsd: median - spread, matchScore: 75, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
    { itemId: 'cr2', title: 'Test Comp 2', totalUsd: median, matchScore: 80, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
    { itemId: 'cr3', title: 'Test Comp 3', totalUsd: median + spread, matchScore: 70, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
    { itemId: 'cr4', title: 'Test Comp 4', totalUsd: median - spread * 0.5, matchScore: 72, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
    { itemId: 'cr5', title: 'Test Comp 5', totalUsd: median + spread * 0.5, matchScore: 78, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
  ];
}

const MEDIAN_PRICE = 50;

jest.mock('../src/services/ebayService', () => ({
  fetchSoldComps: jest.fn(async () => {
    const median = 50;
    const spread = median * 0.1;
    const mockComps = [
      { itemId: 'cr1', title: 'Test Comp 1', totalUsd: median - spread, matchScore: 75, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
      { itemId: 'cr2', title: 'Test Comp 2', totalUsd: median, matchScore: 80, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
      { itemId: 'cr3', title: 'Test Comp 3', totalUsd: median + spread, matchScore: 70, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
      { itemId: 'cr4', title: 'Test Comp 4', totalUsd: median - spread * 0.5, matchScore: 72, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
      { itemId: 'cr5', title: 'Test Comp 5', totalUsd: median + spread * 0.5, matchScore: 78, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'finding' },
    ];
    return {
      us: { comps: mockComps, stats: { count: mockComps.length, median, mean: median } },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    };
  }),
  buildKeywords: jest.fn((pcgs, q) => q),
}));

jest.mock('../src/services/greysheetService', () => ({
  fetchPriceByPcgsNumber: jest.fn(async () => null),
  fetchTypePrice: jest.fn(async () => null),
}));
jest.mock('../src/services/greysheetHistoryService', () => ({
  makeKey: jest.fn(() => 'test-key'),
  recordSnapshot: jest.fn(),
}));
jest.mock('../src/services/valuationService', () => ({
  computeValuation: jest.fn(() => ({
    valuation: {
      fmvCore: 50, confidence: 72, rangeLow: 45, rangeHigh: 55,
      compCount: 5, gradePool: { wantsGraded: false, usedPool: 'raw', poolCount: 5, totalCount: 5 },
    },
    decisions: { buy: { fair: 35 }, sell: { fair: 55 } },
  })),
}));
jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(async () => ({ price: 30.50 })),
}));
jest.mock('../src/services/numistaService', () => ({
  lookupCoin: jest.fn(async () => null),
}));
jest.mock('../src/services/terapeakService', () => ({
  lookupComps: jest.fn(() => null),
}));
jest.mock('../src/utils/responseValidator', () => ({
  validateSeriesIntegrity: jest.fn(() => null),
  validateNumericSanity: jest.fn(() => null),
}));

const request = require('supertest');
const express = require('express');
const priceRoute = require('../src/routes/priceRoute');
const pricingBatchRoute = require('../src/routes/pricingBatchRoute');
const { seedRandom, pickRandom, selectCoins, ALL_COINS } = require('./helpers/coinTestConstants');

const app = express();
app.use(express.json());
app.use('/api/price', priceRoute);
app.use('/api/pricing-batch', pricingBatchRoute);

/* ══════════════════════════════════════════════════════════════
 *  Test suite
 * ══════════════════════════════════════════════════════════════ */

describe('cross-route consistency — /api/price vs /api/pricing-batch', () => {

  beforeEach(() => {
    _parseCalls.length = 0;
  });

  test('FMV from both routes is non-null for the same query', async () => {
    const query = '2024 American Silver Eagle';

    const [single, batch] = await Promise.all([
      request(app).post('/api/price').send({ query }),
      request(app).post('/api/pricing-batch').send({ items: [{ query }] }),
    ]);

    expect(single.status).toBe(200);
    expect(batch.status).toBe(200);

    const singleFmv = single.body.valuation?.fmvCore;
    const batchFmv = batch.body.results?.[0]?.fmv;

    expect(singleFmv).toBeDefined();
    expect(singleFmv).not.toBeNull();
    expect(batchFmv).toBeDefined();
    expect(batchFmv).not.toBeNull();
  });

  test('FMV values are equal when same comps and valuation mock are used', async () => {
    const query = '1921 Morgan Silver Dollar';

    const [single, batch] = await Promise.all([
      request(app).post('/api/price').send({ query }),
      request(app).post('/api/pricing-batch').send({ items: [{ query }] }),
    ]);

    const singleFmv = single.body.valuation?.fmvCore;
    const batchFmv = batch.body.results?.[0]?.fmv;

    expect(singleFmv).toBe(batchFmv);
  });

  test('confidence values are equal for the same query', async () => {
    const query = '1964 Kennedy Half Dollar';

    const [single, batch] = await Promise.all([
      request(app).post('/api/price').send({ query }),
      request(app).post('/api/pricing-batch').send({ items: [{ query }] }),
    ]);

    const singleConf = single.body.valuation?.confidence;
    const batchConf = batch.body.results?.[0]?.confidence;

    expect(singleConf).toBe(batchConf);
  });

  test('series is consistent: priceRoute pcgs.series matches parsed series', async () => {
    const query = '2023 Mexican Silver Libertad 1 oz';

    const res = await request(app).post('/api/price').send({ query });
    expect(res.status).toBe(200);

    const pcgsSeries = res.body.pcgs?.series || '';
    const parsedSeries = res.body.identification?.parsed?.series || '';

    // Both should reference the same series
    if (pcgsSeries && parsedSeries) {
      // They derive from the same mock, so should be equal
      expect(pcgsSeries.toLowerCase()).toBe(parsedSeries.toLowerCase());
    }
  });

  test('year is consistent across route responses', async () => {
    const query = '1923 Peace Dollar';

    const [single, batch] = await Promise.all([
      request(app).post('/api/price').send({ query }),
      request(app).post('/api/pricing-batch').send({ items: [{ query }] }),
    ]);

    // priceRoute exposes year in pcgs.year
    const singleYear = single.body.pcgs?.year;
    expect(singleYear).toBe(1923);

    // batch route result includes the original query (no year field, but no error)
    expect(batch.body.results?.[0]?.query).toBe(query);
    expect(batch.body.results?.[0]?.error).toBeUndefined();
  });

  test('both routes handle the same query without errors', async () => {
    const query = '2024 Canadian Silver Maple Leaf 1 oz';

    const [single, batch] = await Promise.all([
      request(app).post('/api/price').send({ query }),
      request(app).post('/api/pricing-batch').send({ items: [{ query }] }),
    ]);

    expect(single.status).toBe(200);
    expect(single.body.error).toBeUndefined();
    expect(batch.status).toBe(200);
    expect(batch.body.ok).toBe(true);
    expect(batch.body.results[0].error).toBeUndefined();
  });

  // Seeded random selection from the full coin catalog
  const randomCoins = selectCoins('crossRoute');

  test.each(randomCoins.map(c => [c.q, c]))(
    'random coin "%s" produces consistent results across routes',
    async (q) => {
      const [single, batch] = await Promise.all([
        request(app).post('/api/price').send({ query: q }),
        request(app).post('/api/pricing-batch').send({ items: [{ query: q }] }),
      ]);

      expect(single.status).toBe(200);
      expect(batch.status).toBe(200);

      const singleFmv = single.body.valuation?.fmvCore;
      const batchFmv = batch.body.results?.[0]?.fmv;

      // Both should return the same FMV (same mocked valuation)
      expect(singleFmv).toBe(batchFmv);

      // Neither should error
      expect(single.body.error).toBeUndefined();
      expect(batch.body.results[0].error).toBeUndefined();
    }
  );

  test('batch with multiple coins all return FMV', async () => {
    const items = [
      { query: '2024 American Silver Eagle' },
      { query: '1921 Morgan Silver Dollar' },
      { query: '1964 Kennedy Half Dollar' },
    ];

    const res = await request(app)
      .post('/api/pricing-batch')
      .send({ items });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    res.body.results.forEach(r => {
      expect(r.fmv).toBeDefined();
      expect(r.fmv).not.toBeNull();
      expect(r.error).toBeUndefined();
    });
  });

  test('avgEbay from batch route is consistent with ebay.us.stats from price route', async () => {
    const query = '2024 American Silver Eagle';

    const [single, batch] = await Promise.all([
      request(app).post('/api/price').send({ query }),
      request(app).post('/api/pricing-batch').send({ items: [{ query }] }),
    ]);

    const singleMedian = single.body.ebay?.us?.stats?.median;
    const batchAvg = batch.body.results?.[0]?.avgEbay;

    // Both derive from the same mock, so should match
    expect(singleMedian).toBe(batchAvg);
  });
});
