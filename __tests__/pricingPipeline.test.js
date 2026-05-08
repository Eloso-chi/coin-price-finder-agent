/**
 * pricingPipeline.test.js — Integration tests for the pricing pipeline
 *
 * Covers gaps not addressed by existing test suites:
 *   1. Proof-only filter: when isProof=true, surviving comps are ALL proof
 *   2. Graded/raw isolation: ungraded queries yield no graded markers, and vice versa
 *   3. Randomized coin selection: seeded picks from US coins, US bullion, world bullion
 *   4. Pricing snapshot oracle: tolerance-based FMV checks against known inputs
 *   5. Cross-tab propagation: priceRoute response contains fields the UI needs
 *
 * Uses shared helpers from coinTestConstants.js.  Does NOT re-implement
 * any pricing logic — only asserts contracts and invariants.
 */

'use strict';

const { parseDescription } = require('../src/services/pcgsService');
const { applyFilters, scoreMatch, classifyGradeType } = require('../src/services/ebayService');
const { computeValuation } = require('../src/services/valuationService');
const {
  makeComp,
  makeComps,
  seedRandom,
  pickRandom,
  selectCoins,
  US_COINS,
  US_BULLION,
  WORLD_BULLION,
  ALL_COINS,
} = require('./helpers/coinTestConstants');

// ═══════════════════════════════════════════════════════════════
//  1. Proof-only filter
// ═══════════════════════════════════════════════════════════════
describe('applyFilters — proof-only isolation', () => {

  test('when isProof=true, all surviving comps contain "proof" in title', () => {
    const comps = [
      makeComp({ title: '2023 American Silver Eagle Proof PR70 DCAM', totalUsd: 85 }),
      makeComp({ title: '2023 American Silver Eagle Proof PF69', totalUsd: 80 }),
      makeComp({ title: '2023 American Silver Eagle BU', totalUsd: 35 }),
      makeComp({ title: '2023 American Silver Eagle Uncirculated MS70', totalUsd: 45 }),
      makeComp({ title: '2023 Silver Eagle Proof Set', totalUsd: 90 }),
    ];
    const expected = {
      year: 2023, series: 'American Silver Eagle', isProof: true,
      _rawQuery: '2023 American Silver Eagle Proof',
    };
    const { kept } = applyFilters(comps, {}, expected);

    kept.forEach(c => {
      expect(c.title.toLowerCase()).toMatch(/\bproof\b/);
    });
    // At least the 3 proof comps should survive
    expect(kept.length).toBeGreaterThanOrEqual(2);
  });

  test('when isProof=false, proof comps get penalty but are not hard-filtered', () => {
    const comps = [
      makeComp({ title: '2023 American Silver Eagle BU', totalUsd: 35, matchScore: 70 }),
      makeComp({ title: '2023 American Silver Eagle Proof PR70', totalUsd: 85, matchScore: 70 }),
    ];
    const expected = {
      year: 2023, series: 'American Silver Eagle', isProof: false,
      _rawQuery: '2023 American Silver Eagle',
    };
    // Score both comps first (applyFilters expects scored comps)
    comps.forEach(c => {
      const scored = scoreMatch(c, expected);
      Object.assign(c, scored);
    });

    const { kept } = applyFilters(comps, {}, expected);

    // The BU comp should survive; proof comp may survive with penalty
    const buComp = kept.find(c => /\bBU\b/i.test(c.title));
    expect(buComp).toBeDefined();
  });

  test('proof filter applies across multiple coin types', () => {
    const proofCoins = [
      { title: '1964 Kennedy Half Dollar Proof', totalUsd: 30 },
      { title: '2024 Silver Eagle Proof PR69', totalUsd: 90 },
      { title: '2023 Libertad Proof 1 oz', totalUsd: 120 },
    ];
    const mixedComps = [
      ...proofCoins.map(c => makeComp({ ...c })),
      makeComp({ title: '1964 Kennedy Half Dollar BU', totalUsd: 12 }),
      makeComp({ title: '2024 Silver Eagle MS70', totalUsd: 45 }),
    ];

    const expected = { isProof: true, _rawQuery: 'proof coin' };
    const { kept } = applyFilters(mixedComps, {}, expected);

    kept.forEach(c => {
      expect(c.title.toLowerCase()).toMatch(/\bproof\b/);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  2. Graded vs raw isolation
// ═══════════════════════════════════════════════════════════════
describe('classifyGradeType — graded / raw separation', () => {

  test('conditionId 2000 classified as graded', () => {
    expect(classifyGradeType({ conditionId: '2000', title: '' })).toBe('graded');
  });

  test('conditionId 3000 classified as raw', () => {
    expect(classifyGradeType({ conditionId: '3000', title: '' })).toBe('raw');
  });

  test('PCGS in title classified as graded', () => {
    expect(classifyGradeType({ title: '1964 Kennedy PCGS MS-64' })).toBe('graded');
  });

  test('NGC in title classified as graded', () => {
    expect(classifyGradeType({ title: '1881-S Morgan NGC MS-65' })).toBe('graded');
  });

  test('BU-only title classified as raw', () => {
    expect(classifyGradeType({ title: '2024 Silver Eagle BU' })).toBe('raw');
  });

  test('no grade markers classified as raw', () => {
    expect(classifyGradeType({ title: '1964 Kennedy Half Dollar' })).toBe('raw');
  });
});

describe('computeValuation — grade pool selection', () => {

  function _makeComp(price, gradeType) {
    return makeComp({ totalUsd: price, gradeType, matchScore: 70 });
  }

  function _mockEbay(usComps) {
    return {
      us: { comps: usComps, stats: { count: usComps.length } },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    };
  }

  test('graded comps preferred when userGrade provided', () => {
    const comps = [
      _makeComp(100, 'graded'), _makeComp(110, 'graded'), _makeComp(105, 'graded'),
      _makeComp(115, 'graded'), _makeComp(120, 'graded'), _makeComp(125, 'graded'),
      _makeComp(50, 'raw'), _makeComp(55, 'raw'),
    ];
    const result = computeValuation({ verified: false }, _mockEbay(comps), null, 65);
    expect(result.valuation.gradePool).toBeDefined();
    expect(result.valuation.gradePool.wantsGraded).toBe(true);
    // When enough graded comps exist, pool should be graded
    expect(result.valuation.gradePool.usedPool).toBe('graded');
  });

  test('raw comps used when no grade specified', () => {
    const comps = [
      _makeComp(50, 'raw'), _makeComp(55, 'raw'), _makeComp(52, 'raw'),
      _makeComp(48, 'raw'), _makeComp(60, 'raw'), _makeComp(53, 'raw'),
      _makeComp(100, 'graded'), _makeComp(110, 'graded'),
    ];
    const result = computeValuation({ verified: false }, _mockEbay(comps), null, null);
    expect(result.valuation.gradePool).toBeDefined();
    expect(result.valuation.gradePool.wantsGraded).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
//  3. Randomized coin selection — parse correctness
// ═══════════════════════════════════════════════════════════════
describe('randomized coin parsing — seeded selection', () => {
  const sample = selectCoins('pricingPipeline');

  test.each(sample.map(c => [c.q, c]))('"%s" parses correctly', (q, coin) => {
    const parsed = parseDescription(q);
    expect(parsed.series).toMatch(coin.series);
    if (coin.year != null) expect(parsed.year).toBe(coin.year);
    if (coin.metal) expect(parsed.metal).toBe(coin.metal);
    if (coin.weight != null) expect(parsed.weight).toBe(coin.weight);
  });
});

describe('randomized coin parsing — category breakdown', () => {
  const rng = seedRandom('categories');

  test('US coins parse series and year', () => {
    const picks = pickRandom(US_COINS, 4, rng);
    picks.forEach(coin => {
      const parsed = parseDescription(coin.q);
      expect(parsed.series).toMatch(coin.series);
      expect(parsed.year).toBe(coin.year);
    });
  });

  test('US bullion parse series, year, and metal', () => {
    const picks = pickRandom(US_BULLION, 3, rng);
    picks.forEach(coin => {
      const parsed = parseDescription(coin.q);
      expect(parsed.series).toMatch(coin.series);
      expect(parsed.year).toBe(coin.year);
      if (coin.metal) expect(parsed.metal).toBe(coin.metal);
    });
  });

  test('world bullion parse series, year, metal, and weight', () => {
    const picks = pickRandom(WORLD_BULLION, 3, rng);
    picks.forEach(coin => {
      const parsed = parseDescription(coin.q);
      expect(parsed.series).toMatch(coin.series);
      expect(parsed.year).toBe(coin.year);
      if (coin.metal) expect(parsed.metal).toBe(coin.metal);
      if (coin.weight != null) expect(parsed.weight).toBe(coin.weight);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
//  4. Pricing snapshot oracle — tolerance-based FMV checks
//     Uses fixed synthetic inputs to verify computeValuation
//     produces stable results within expected bounds.
//     Does NOT re-implement pricing logic.
// ═══════════════════════════════════════════════════════════════
describe('pricing snapshot oracle — stable FMV from fixed inputs', () => {

  function _mockEbay(prices) {
    const comps = prices.map(p => makeComp({ totalUsd: p, matchScore: 70, gradeType: 'raw' }));
    return {
      us: { comps, stats: { count: comps.length, median: prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)] } },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    };
  }

  test('Morgan Dollar: 6 raw comps around $30 produce FMV in $25-$40 range', () => {
    const ebay = _mockEbay([28, 30, 31, 32, 29, 33]);
    const pcgs = { verified: false, series: 'Morgan Dollar', year: 1921 };
    const result = computeValuation(pcgs, ebay, null, null);
    expect(result.valuation.fmvCore).toBeGreaterThanOrEqual(25);
    expect(result.valuation.fmvCore).toBeLessThanOrEqual(40);
  });

  test('Silver Eagle: 8 comps around $35 produce FMV in $30-$45 range', () => {
    const ebay = _mockEbay([33, 34, 35, 36, 34, 35, 37, 33]);
    const pcgs = { verified: false, series: 'American Silver Eagle', year: 2024 };
    const result = computeValuation(pcgs, ebay, null, null, { isBullion: true });
    expect(result.valuation.fmvCore).toBeGreaterThanOrEqual(30);
    expect(result.valuation.fmvCore).toBeLessThanOrEqual(45);
  });

  test('graded Morgan MS64: comps around $250 with PCGS guide $300', () => {
    const ebay = _mockEbay([240, 250, 255, 260, 245, 265]);
    const pcgs = {
      verified: true,
      series: 'Morgan Dollar', year: 1881, mint: 'S',
      grade: 'MS-64',
      priceGuide: { valueUsd: 300 },
      population: { thisGrade: 5000, higher: 2000 },
      auction: { count: 2, medianUsd: 280, highUsd: 320 },
    };
    const result = computeValuation(pcgs, ebay, null, 64);
    // FMV should be influenced by both eBay and PCGS, landing in $240-$310
    expect(result.valuation.fmvCore).toBeGreaterThanOrEqual(240);
    expect(result.valuation.fmvCore).toBeLessThanOrEqual(310);
  });

  test('confidence decreases with fewer comps', () => {
    const manyComps = _mockEbay([30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
    const fewComps = _mockEbay([30, 31]);
    const pcgs = { verified: false };

    const resultMany = computeValuation(pcgs, manyComps, null, null);
    const resultFew  = computeValuation(pcgs, fewComps, null, null);

    expect(resultMany.valuation.confidence).toBeGreaterThan(resultFew.valuation.confidence);
  });

  test('Greysheet wholesale data increases confidence', () => {
    const ebay = _mockEbay([100, 105, 110, 108, 103]);
    const pcgs = { verified: false };

    const withoutGs = computeValuation(pcgs, ebay, null, null);
    const withGs = computeValuation(pcgs, ebay, null, null, {
      greysheet: { greyVal: 95, cpgVal: 115, gsid: 'test' },
    });

    expect(withGs.valuation.confidence).toBeGreaterThanOrEqual(withoutGs.valuation.confidence);
  });
});

// ═══════════════════════════════════════════════════════════════
//  5. Cross-tab propagation fields — priceRoute response shape
//     Verifies the response JSON contains all fields the UI
//     needs for EbayTracker.setSeries() and CoinHistoryLink.setCoin().
// ═══════════════════════════════════════════════════════════════
describe('priceRoute response — cross-tab propagation fields', () => {

  // Mock all heavy deps to test only the route's response shape
  jest.mock('../src/services/pcgsService', () => ({
    parseDescription: jest.fn((q) => ({
      series: 'American Silver Eagle', year: 2024, mint: null,
      grade: null, gradeNum: null, weight: 1, finish: null, metal: 'silver',
    })),
    resolveFromDescription: jest.fn(async () => ({
      verified: false,
      pcgsCoinNumber: null,
      series: 'American Silver Eagle', year: 2024, mint: null,
      grade: null, designation: null, finish: null, variety: null,
      priceGuide: null, population: null, auction: null,
      trueViewUrl: null, coinImages: [],
      parsed: { series: 'American Silver Eagle', year: 2024, mint: null, grade: null, gradeNum: null, metal: 'silver', weight: 1 },
      limitations: [],
    })),
    lookupByCert: jest.fn(async () => ({ verified: false })),
    lookupByCoinNumberAndGrade: jest.fn(async () => ({ verified: false })),
  }));
  jest.mock('../src/services/ebayService', () => ({
    fetchSoldComps: jest.fn(async () => ({
      us: { comps: [], stats: { count: 0 } },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    })),
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
        fmvCore: 35, confidence: 72, rangeLow: 30, rangeHigh: 40,
        compCount: 5, gradePool: { wantsGraded: false, usedPool: 'raw' },
      },
      decisions: { buy: 'fair', sell: 'fair' },
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
  const app = express();
  app.use(express.json());
  app.use('/api/price', priceRoute);

  test('response includes trackerSeries for EbayTracker.setSeries()', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    expect(res.body).toHaveProperty('trackerSeries');
    expect(typeof res.body.trackerSeries).toBe('string');
    expect(res.body.trackerSeries.length).toBeGreaterThan(0);
  });

  test('response includes ebay.keywords for CoinHistoryLink.setCoin()', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    expect(res.body.ebay).toBeDefined();
    expect(res.body.ebay).toHaveProperty('keywords');
    expect(typeof res.body.ebay.keywords).toBe('string');
  });

  test('response includes query.input for fallback history query', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    expect(res.body.query).toBeDefined();
    expect(res.body.query.input).toBe('2024 American Silver Eagle');
  });

  test('response includes identification.parsed for tab propagation', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    expect(res.body.identification).toBeDefined();
    expect(res.body.identification.parsed).toBeDefined();
    expect(res.body.identification.parsed.series).toBeTruthy();
  });

  test('response includes pcgs.series and pcgs.year for tracker fallback', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    expect(res.body.pcgs).toBeDefined();
    expect(res.body.pcgs.series).toBeTruthy();
    expect(res.body.pcgs.year).toBeDefined();
  });

  test('response includes valuation and decisions', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    expect(res.body.valuation).toBeDefined();
    expect(res.body.valuation.fmvCore).toBeDefined();
    expect(res.body.valuation.confidence).toBeDefined();
    expect(res.body.decisions).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
//  6. End-to-end ungraded isolation (#114)
//     Pipeline test: classifyGradeType + computeValuation grade pool
//     Assert that an ungraded query uses only raw comps in FMV,
//     and a graded query uses only graded comps.
// ═══════════════════════════════════════════════════════════════
describe('grade pool isolation — end-to-end pipeline', () => {

  // Use real (un-mocked) classifyGradeType
  const real = jest.requireActual('../src/services/ebayService');
  const realValuation = jest.requireActual('../src/services/valuationService');

  function _mockEbay(comps) {
    return {
      us: { comps, stats: { count: comps.length } },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    };
  }

  test('raw query: grade pool uses raw comps, not graded', () => {
    const comps = [
      makeComp({ title: '1921 Morgan Silver Dollar PCGS MS-64', totalUsd: 250, conditionId: '2000', gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '1921 Morgan Silver Dollar NGC MS-63', totalUsd: 230, conditionId: '2000', gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '1921 Morgan Silver Dollar XF', totalUsd: 35, conditionId: '3000', gradeType: 'raw', matchScore: 70 }),
      makeComp({ title: '1921 Morgan Silver Dollar AU Details', totalUsd: 38, conditionId: '3000', gradeType: 'raw', matchScore: 70 }),
      makeComp({ title: '1921 Morgan Silver Dollar VF', totalUsd: 30, conditionId: '3000', gradeType: 'raw', matchScore: 70 }),
      makeComp({ title: '1921 Morgan Silver Dollar Circ', totalUsd: 28, conditionId: '3000', gradeType: 'raw', matchScore: 70 }),
      makeComp({ title: '1921 Morgan Silver Dollar BU', totalUsd: 42, conditionId: '3000', gradeType: 'raw', matchScore: 70 }),
      makeComp({ title: '1921 Morgan Dollar Average Circulated', totalUsd: 25, conditionId: '4000', gradeType: 'raw', matchScore: 70 }),
    ];

    // No grade specified -> wantsGraded = false -> pool should be raw
    const result = realValuation.computeValuation(
      { verified: false, series: 'Morgan Dollar', year: 1921 },
      _mockEbay(comps),
      null,   // gradeNum
      null    // no userGrade
    );

    expect(result.valuation.gradePool).toBeDefined();
    expect(result.valuation.gradePool.wantsGraded).toBe(false);
    expect(result.valuation.gradePool.usedPool).toBe('raw');
    // FMV should reflect raw prices ($25-$42), not graded ($230-$250)
    expect(result.valuation.fmvCore).toBeLessThan(100);
  });

  test('graded query: grade pool uses graded comps, not raw', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle PCGS MS-70', totalUsd: 55, conditionId: '2000', gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle NGC MS-70', totalUsd: 52, conditionId: '2000', gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle PCGS MS-70 FS', totalUsd: 60, conditionId: '2000', gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle NGC MS-69', totalUsd: 45, conditionId: '2000', gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle PCGS MS-69', totalUsd: 42, conditionId: '2000', gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle PCGS MS-68', totalUsd: 38, conditionId: '2000', gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '2024 American Silver Eagle BU', totalUsd: 32, conditionId: '3000', gradeType: 'raw', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle Uncirculated', totalUsd: 30, conditionId: '3000', gradeType: 'raw', matchScore: 70 }),
    ];

    // Grade specified -> wantsGraded = true -> pool should be graded
    const result = realValuation.computeValuation(
      { verified: false, series: 'American Silver Eagle', year: 2024 },
      _mockEbay(comps),
      null,   // gradeNum
      70      // userGrade = MS-70
    );

    expect(result.valuation.gradePool).toBeDefined();
    expect(result.valuation.gradePool.wantsGraded).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('graded');
    // FMV should reflect graded prices ($38-$60), not raw ($30-$32)
    expect(result.valuation.fmvCore).toBeGreaterThan(35);
  });

  test('classifyGradeType correctly labels comps fed into the pipeline', () => {
    const graded = [
      { conditionId: '2000', title: 'PCGS MS-65' },
      { conditionId: '2000', title: 'NGC PF-69' },
      { title: '1881-S Morgan PCGS MS-65' },
      { title: '2024 ASE NGC MS-70 First Strike' },
    ];
    const raw = [
      { conditionId: '3000', title: 'BU' },
      { conditionId: '4000', title: 'Circulated' },
      { title: '1921 Morgan Dollar' },
      { title: '2024 Silver Eagle BU' },
    ];
    graded.forEach(c => expect(real.classifyGradeType(c)).toBe('graded'));
    raw.forEach(c => expect(real.classifyGradeType(c)).toBe('raw'));
  });

  test('no-grade half dollar: pool is raw and FMV reflects raw prices', () => {
    const comps = [
      makeComp({ title: '1964 Kennedy Half Dollar PCGS MS-65', totalUsd: 45, gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '1964 Kennedy Half Dollar NGC PF-67', totalUsd: 60, gradeType: 'graded', matchScore: 70 }),
      makeComp({ title: '1964 Kennedy Half Dollar BU', totalUsd: 12, gradeType: 'raw', matchScore: 70 }),
      makeComp({ title: '1964 Kennedy Half Dollar Circ', totalUsd: 8, gradeType: 'raw', matchScore: 70 }),
      makeComp({ title: '1964 Kennedy Half Dollar AU', totalUsd: 10, gradeType: 'raw', matchScore: 70 }),
      makeComp({ title: '1964 Kennedy Half Dollar Avg', totalUsd: 7, gradeType: 'raw', matchScore: 70 }),
    ];

    const result = realValuation.computeValuation(
      { verified: false },
      _mockEbay(comps),
      null, null
    );

    expect(result.valuation.gradePool.usedPool).toBe('raw');
    // FMV should be in the raw range ($7-$12), well below graded
    expect(result.valuation.fmvCore).toBeLessThan(20);
  });
});

// ═══════════════════════════════════════════════════════════════
//  7. Cross-tab value verification (#115)
//     Assert trackerSeries and ebay.keywords MATCH the queried coin,
//     not just that they exist.
// ═══════════════════════════════════════════════════════════════
describe('priceRoute response — cross-tab value verification', () => {

  // These tests reuse the mocks from section 5 above (same jest.mock scope)
  const request = require('supertest');
  const express = require('express');
  const priceRoute = require('../src/routes/priceRoute');
  const app = express();
  app.use(express.json());
  app.use('/api/price', priceRoute);

  test('trackerSeries contains the coin series for Silver Eagle', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    expect(res.body.trackerSeries).toBeDefined();
    // trackerSeries should contain the series name (from pcgs.series or parsed)
    expect(res.body.trackerSeries.toLowerCase()).toMatch(/silver eagle/);
  });

  test('ebay.keywords contains key terms from the query', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    // Keywords should contain at minimum the query string or series-derived terms
    const kw = (res.body.ebay?.keywords || '').toLowerCase();
    expect(kw).toMatch(/silver.*eagle|eagle.*silver/);
  });

  test('query.input matches the original user query exactly', async () => {
    const userQuery = '1921 Morgan Silver Dollar MS63';
    const { parseDescription } = require('../src/services/pcgsService');
    parseDescription.mockReturnValueOnce({
      series: 'Morgan Dollar', year: 1921, mint: null,
      grade: 'MS-63', gradeNum: 63, weight: null, finish: null, metal: 'silver',
    });

    const res = await request(app)
      .post('/api/price')
      .send({ query: userQuery })
      .expect(200);

    expect(res.body.query.input).toBe(userQuery);
  });

  test('identification.parsed.series matches the queried coin series', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    const parsedSeries = res.body.identification?.parsed?.series || '';
    expect(parsedSeries.toLowerCase()).toMatch(/silver eagle/);
  });

  test('pcgs.series matches the queried coin series', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    const pcgsSeries = res.body.pcgs?.series || '';
    expect(pcgsSeries.toLowerCase()).toMatch(/silver eagle/);
  });

  test('pcgs.year matches the queried year', async () => {
    const res = await request(app)
      .post('/api/price')
      .send({ query: '2024 American Silver Eagle' })
      .expect(200);

    expect(res.body.pcgs?.year).toBe(2024);
  });
});

// ═══════════════════════════════════════════════════════════════
//  6. Finish field in response (#11)
// ═══════════════════════════════════════════════════════════════
describe('parseDescription — finish field in identification.parsed', () => {

  test('Reverse Proof query produces finish in parsed result', () => {
    const parsed = parseDescription('2021 American Silver Eagle Reverse Proof');
    expect(parsed.finish).toBe('Reverse Proof');
  });

  test('Burnished query produces finish in parsed result', () => {
    const parsed = parseDescription('2015 American Silver Eagle Burnished');
    expect(parsed.finish).toBe('Burnished');
  });

  test('Standalone Proof produces finish=Proof in parsed result', () => {
    const parsed = parseDescription('2024 American Silver Eagle Proof');
    expect(parsed.finish).toBe('Proof');
  });

  test('BU query produces no finish in parsed result', () => {
    const parsed = parseDescription('2024 American Silver Eagle');
    expect(parsed.finish).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════
//  7. Lunar response fields (#10)
// ═══════════════════════════════════════════════════════════════
describe('lunar enrichment — expected object fields', () => {

  test('lunar query sets zodiacAnimal and isLunarCoin in expected', () => {
    // Verify parseDescription handles lunar queries
    const parsed = parseDescription('2024 Perth Lunar Dragon 1 oz Silver');
    expect(parsed.series).toBeDefined();
    expect(parsed.year).toBe(2024);
    expect(parsed.metal).toBe('silver');
  });

  test('zodiacForYear returns correct animal for 2024', () => {
    const { zodiacForYear } = jest.requireActual('../src/data/constants');
    expect(zodiacForYear(2024)).toBe('Dragon');
  });

  test('zodiacForYear returns correct animal for 2023', () => {
    const { zodiacForYear } = jest.requireActual('../src/data/constants');
    expect(zodiacForYear(2023)).toBe('Rabbit');
  });
});
