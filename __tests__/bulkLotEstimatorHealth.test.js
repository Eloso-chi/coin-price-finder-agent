'use strict';

const express = require('express');
const request = require('supertest');
const { setTimeout: delay } = require('timers/promises');
const { ALL_COINS } = require('./helpers/coinTestConstants');
const { generateRandomLots } = require('./helpers/randomLots');

const mockFetchCalls = [];

function mockStableHash(input) {
  let hash = 2166136261;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mockMedianFromCall(keywords, opts, expected) {
  const key = [
    keywords || '',
    opts?.timeWindowDays || 0,
    opts?.maxPages || 0,
    opts?.usMinComps || 0,
    expected?.metal || '',
    expected?.year || '',
    expected?.series || '',
    expected?.grade || '',
    expected?.finish || '',
  ].join('|');
  const raw = mockStableHash(key);
  // Range: 50.00 - 169.99
  return +((50 + (raw % 12000) / 100).toFixed(2));
}

function parseWeight(query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  const frac = q.match(/\b(1\/2|1\/4|1\/10|1\/20)\s*oz\b/);
  if (frac) {
    const map = { '1/2': 0.5, '1/4': 0.25, '1/10': 0.1, '1/20': 0.05 };
    return map[frac[1]] || null;
  }
  const num = q.match(/\b(\d+(?:\.\d+)?)\s*oz\b/);
  return num ? parseFloat(num[1]) : null;
}

function mockParseDescription(query) {
  const q = String(query || '');
  const yearMatch = q.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
  const metalMatch = q.match(/\b(silver|gold|platinum|palladium)\b/i);
  const metal = metalMatch ? metalMatch[1].toLowerCase() : null;
  const gradeMatch = q.match(/\b(MS|PR|PF|AU|XF|VF|SP)\s*[- ]?\s*(\d{1,2})\b/i);
  const grade = gradeMatch ? `${gradeMatch[1].toUpperCase()}-${gradeMatch[2]}` : null;
  const gradeNum = gradeMatch ? parseInt(gradeMatch[2], 10) : null;
  const finish = /\bproof\b/i.test(q) || /\b(PR|PF)-?\d{1,2}\b/i.test(q) ? 'Proof' : null;
  const weight = parseWeight(q);

  let series = q
    .replace(/\b(1[6-9]\d{2}|20[0-2]\d)\b/g, '')
    .replace(/\b(silver|gold|platinum|palladium)\b/gi, '')
    .replace(/\b(1\/2|1\/4|1\/10|1\/20|\d+(?:\.\d+)?)\s*oz\b/gi, '')
    .replace(/\b(MS|PR|PF|AU|XF|VF|SP)\s*[- ]?\s*\d{1,2}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!series) series = 'Unknown Coin';

  return {
    series,
    year,
    mint: null,
    grade,
    gradeNum,
    weight,
    finish,
    metal,
    isRoll: /\broll|tube\b/i.test(q),
    designation: null,
    _gradeSource: null,
    _exclusions: null,
    label: null,
  };
}

jest.mock('../src/services/pcgsService', () => ({
  parseDescription: jest.fn((q) => mockParseDescription(q)),
  resolveFromDescription: jest.fn(async (q) => {
    const parsed = mockParseDescription(q);
    return {
      verified: false,
      series: parsed.series,
      year: parsed.year,
      mint: parsed.mint,
      grade: parsed.grade,
      finish: parsed.finish,
      designation: parsed.designation,
      metalContent: parsed.metal,
      pcgsCoinNumber: null,
      parsed,
    };
  }),
  lookupByCert: jest.fn(async () => ({ verified: false })),
  lookupByCoinNumberAndGrade: jest.fn(async () => ({ verified: false })),
}));

jest.mock('../src/services/ebayService', () => ({
  buildKeywords: jest.fn((pcgs, query, weight) => {
    const parts = [];
    if (pcgs?.year) parts.push(String(pcgs.year));
    if (pcgs?.mint && pcgs?.year) {
      parts.pop();
      parts.push(`${pcgs.year}-${pcgs.mint}`);
    }
    if (pcgs?.series) parts.push(pcgs.series);
    if (pcgs?.finish) parts.push(pcgs.finish);
    if (pcgs?.grade && pcgs.grade !== 'Proof') parts.push(pcgs.grade);
    if (weight) parts.push(`${weight} oz`);
    return parts.length ? parts.join(' ') : query;
  }),
  fetchSoldComps: jest.fn(async (keywords, opts = {}, expected = {}) => {
    mockFetchCalls.push({ keywords, opts: { ...opts }, expected: { ...expected } });
    const median = mockMedianFromCall(keywords, opts, expected);
    const count = Math.max(opts.usMinComps || 8, 10);
    const comps = Array.from({ length: count }, (_, i) => ({
      itemId: `m-${i}`,
      title: `Comp ${i}`,
      totalUsd: +(median + (i % 2 ? 1.25 : -1.25)).toFixed(2),
      matchScore: 80,
      gradeType: expected.grade ? 'graded' : 'raw',
      soldDate: new Date().toISOString(),
      _source: 'terapeak',
    }));
    return {
      us: { comps, stats: { count: comps.length, median, mean: median } },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    };
  }),
  clearCache: jest.fn(),
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
  computeValuation: jest.fn((_pcgs, ebay) => {
    const median = ebay?.us?.stats?.median ?? null;
    return {
      valuation: {
        fmvCore: median,
        confidence: 85,
        rangeLow: median ? +(median * 0.9).toFixed(2) : null,
        rangeHigh: median ? +(median * 1.1).toFixed(2) : null,
        method: 'ebay-median',
      },
      decisions: { buy: {}, sell: {} },
    };
  }),
}));

jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(async () => ({ price: 31.5, currency: 'USD', source: 'mock' })),
}));

jest.mock('../src/utils/coinMetalProfile', () => ({
  getCoinMetalProfile: jest.fn((query) => {
    const q = String(query || '').toLowerCase();
    let metal = null;
    if (/\bgold\b/.test(q)) metal = 'gold';
    else if (/\bsilver\b/.test(q)) metal = 'silver';
    else if (/\bplatinum\b/.test(q)) metal = 'platinum';
    else if (/\bpalladium\b/.test(q)) metal = 'palladium';
    return { isMetalBased: !!metal, metal };
  }),
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

const { _cache } = require('../src/services/bulkEvaluateService');
const priceRoute = require('../src/routes/priceRoute');
const bulkEvaluateRoute = require('../src/routes/bulkEvaluateRoute');

const app = express();
app.use(express.json());
app.use('/api/price', priceRoute);
app.use('/api/bulk-evaluate', bulkEvaluateRoute);

function callsByQuery(calls) {
  const out = new Map();
  for (const call of calls) {
    const q = call.expected?._rawQuery || '';
    if (!out.has(q)) out.set(q, []);
    out.get(q).push(call);
  }
  return out;
}

async function waitForBulkResult(jobId, maxPolls = 80) {
  for (let i = 0; i < maxPolls; i++) {
    const poll = await request(app).get(`/api/bulk-evaluate/${jobId}`);
    if (poll.status === 200 && poll.body.status === 'complete') return poll.body;
    if (poll.status === 200 && poll.body.status === 'error') {
      throw new Error(`bulk job failed: ${poll.body.error}`);
    }
    await delay(15);
  }
  throw new Error(`bulk job ${jobId} timed out`);
}

describe('bulk lot estimator parity and consistency', () => {
  beforeEach(() => {
    mockFetchCalls.length = 0;
    _cache.clear();
  });

  test('randomized lots preserve individual-vs-bulk parity', async () => {
    const pool = ALL_COINS
      .map((c) => c.q)
      .filter((q) => !/lunar|dragon|semiquincentennial/i.test(String(q)));

    const { lots, seed } = generateRandomLots({
      pool,
      lotCount: 7,
      minLotSize: 4,
      maxLotSize: 8,
      maxQty: 3,
      seed: 18652,
    });

    expect(lots.length).toBe(7);

    for (const lot of lots) {
      mockFetchCalls.length = 0;
      const individualPrices = [];

      for (const item of lot.items) {
        const single = await request(app).post('/api/price').send({ query: item.query });
        expect(single.status).toBe(200);
        expect(single.body.error).toBeUndefined();
        const fmv = single.body.valuation?.fmvCore;
        expect(typeof fmv).toBe('number');
        individualPrices.push({ query: item.query, qty: item.qty, fmv });
      }

      const singleCalls = mockFetchCalls.slice();

      mockFetchCalls.length = 0;
      const submit = await request(app).post('/api/bulk-evaluate').send({ items: lot.items });
      expect(submit.status).toBe(202);
      const bulkState = await waitForBulkResult(submit.body.jobId);

      expect(bulkState.results).toHaveLength(lot.items.length);
      expect(bulkState.lotSummary).toBeTruthy();

      let individualTotal = 0;
      let bulkTotal = 0;

      for (let i = 0; i < lot.items.length; i++) {
        const expected = individualPrices[i];
        const actual = bulkState.results[i];

        expect(actual.query).toBe(expected.query);
        expect(actual.fmv).toBe(expected.fmv);

        individualTotal += expected.fmv * expected.qty;
        bulkTotal += actual.totalFmv || 0;
      }

      const lotDeltaPct = Math.abs((bulkTotal - individualTotal) / Math.max(1, individualTotal)) * 100;
      expect(lotDeltaPct).toBeLessThanOrEqual(0.01);
      expect(Math.abs((bulkState.lotSummary.totalFmv || 0) - bulkTotal)).toBeLessThanOrEqual(0.01);

      // Ensure the fetch knobs used by bulk path match strict parity settings.
      for (const call of mockFetchCalls) {
        expect(call.opts.timeWindowDays).toBe(180);
        expect(call.opts.maxPages).toBe(3);
        expect(call.opts.usMinComps).toBe(call.expected.isRoll ? 3 : 8);
      }

      // Ensure both routes generate equivalent keywords per query.
      const singleByQuery = callsByQuery(singleCalls);
      const bulkByQuery = callsByQuery(mockFetchCalls);
      for (const query of lot.items.map((c) => c.query)) {
        const a = (singleByQuery.get(query) || []).map((c) => c.keywords).sort();
        const b = (bulkByQuery.get(query) || []).map((c) => c.keywords).sort();
        expect(a).toEqual(b);
      }
    }

    // Assert seed used so failures are reproducible.
    expect(seed).toBe(18652);
  });

  test('same lot is stable across repeated bulk runs', async () => {
    const pool = ALL_COINS.map((c) => c.q).filter((q) => !/lunar|dragon/i.test(String(q)));
    const { lots } = generateRandomLots({
      pool,
      lotCount: 1,
      minLotSize: 10,
      maxLotSize: 10,
      maxQty: 3,
      seed: 99123,
    });

    const lot = lots[0].items;

    const totals = [];
    const snapshots = [];

    for (let run = 0; run < 3; run++) {
      const submit = await request(app).post('/api/bulk-evaluate').send({ items: lot });
      expect(submit.status).toBe(202);
      const state = await waitForBulkResult(submit.body.jobId);
      totals.push(state.lotSummary.totalFmv);
      snapshots.push(state.results.map((r) => ({ query: r.query, fmv: r.fmv, qty: r.qty, totalFmv: r.totalFmv })));
    }

    expect(totals[1]).toBe(totals[0]);
    expect(totals[2]).toBe(totals[0]);
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  });
});
