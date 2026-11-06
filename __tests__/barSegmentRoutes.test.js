// __tests__/barSegmentRoutes.test.js -- #333H Phase 1
// Route-level tests for bar segmentation. POST /api/bar-price runs through the
// REAL ebayService filters and the REAL valuationService; only the network and
// data edges are mocked (axios, Terapeak lookup, spot price, spot history).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Persistence isolation: the eBay cache writes under CACHE_DIR.
const TMP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bar-segment-routes-'));
process.env.CACHE_DIR = TMP_CACHE_DIR;
process.env.EBAY_APP_ID = 'test-app-id';
process.env.EBAY_CLIENT_SECRET = 'test-secret';
process.env.EBAY_THROTTLE_MS = '0';

jest.mock('axios');
jest.mock('../src/services/terapeakService');
jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(async (sym) => ({ price: sym === 'XAU' ? 2000 : 30, currency: 'USD' })),
}));
jest.mock('../src/services/metalsHistoryService', () => ({
  ...jest.requireActual('../src/services/metalsHistoryService'),
  getSpotOnDate: jest.fn(() => null),
}));

const http = require('http');
const express = require('express');
const axios = require('axios');
const terapeakService = require('../src/services/terapeakService');
const ebayService = require('../src/services/ebayService');
const barPriceRoute = require('../src/routes/barPriceRoute');
const { detectBarBrands } = require('../src/data/barSeries');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/bar-price', barPriceRoute);
  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_CACHE_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  ebayService.clearCache();
  axios.post.mockRejectedValue(new Error('network disabled in tests'));
  axios.get.mockRejectedValue(new Error('network disabled in tests'));
});

function post(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + '/api/bar-price');
    const r = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    r.on('error', reject);
    r.write(JSON.stringify(body));
    r.end();
  });
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

function terapeakComps(rows) {
  return {
    searchTerm: 'bar',
    lastImport: daysAgo(1),
    comps: rows.map(([title, totalUsd], i) => ({
      title,
      totalUsd,
      soldDate: daysAgo(1 + i),
      conditionId: '1000',
      _source: 'terapeak',
    })),
  };
}

function seedComps(rows) {
  terapeakService.lookupComps.mockReturnValue(terapeakComps(rows));
}

const REQ = { options: { usMinComps: 1 } };

function titlesOf(res) {
  return (res.body.ebay.us.comps || []).map(c => c.title);
}

// Silver spot is mocked at $30, so a 1 oz bar sells near $34-36.
const MIXED_1OZ_SILVER = [
  ['1 oz .999 Silver Bar Generic Stackable', 34],
  ['Silver Bar 1 oz .999 Fine Hand Poured', 35],
  ['1 oz Silver Bar .999 Unbranded Sealed', 36],
  ['PAMP Suisse 1 oz Silver Bar Lady Fortuna', 45],
  ['PAMP Suisse 1 oz Silver Bar Rosa', 44],
  ['PAMP Suisse 1 oz Silver Bar', 43],
  ['Geiger Edelmetalle 1 oz Silver Bar Square', 41],
  ['Johnson Matthey 1 oz Silver Bar', 52],
  ['Sunshine Mining 1 oz Silver Bar Vintage', 60],
];

describe('generic segment (no maker)', () => {
  test('admits no comp that detectBarBrands recognizes and names the segment', async () => {
    seedComps(MIXED_1OZ_SILVER);
    const res = await post({ metal: 'silver', size: '1 oz', ...REQ });

    expect(res.status).toBe(200);
    const titles = titlesOf(res);
    expect(titles).toHaveLength(3);
    expect(titles.every(t => detectBarBrands(t).length === 0)).toBe(true);
    expect(res.body.ebay.us.removed.barMakerExcluded).toBe(6);
    expect(res.body.bar.segment).toEqual(expect.objectContaining({ class: 'generic', brand: null, series: null }));
    expect(res.body.valuation.barSegment).toEqual(expect.objectContaining({ class: 'generic', compCount: 3 }));
    expect(res.body.valuation.fmvCore).not.toBeNull();
  });
});

describe('brand segment (maker only)', () => {
  test('admits every PAMP series and no other maker', async () => {
    seedComps(MIXED_1OZ_SILVER);
    const res = await post({ metal: 'silver', size: '1 oz', brand: 'PAMP Suisse', ...REQ });

    expect(res.status).toBe(200);
    const titles = titlesOf(res);
    expect(titles).toEqual(expect.arrayContaining([
      'PAMP Suisse 1 oz Silver Bar Lady Fortuna',
      'PAMP Suisse 1 oz Silver Bar Rosa',
      'PAMP Suisse 1 oz Silver Bar',
    ]));
    expect(titles.some(t => /geiger|johnson|sunshine/i.test(t))).toBe(false);
    expect(res.body.bar.segment).toEqual(expect.objectContaining({ class: 'brand', brand: 'PAMP', series: null }));
    expect(res.body.valuation.barSegment.class).toBe('brand');
  });

  test('fewer than three survivors returns no FMV with an explicit label', async () => {
    seedComps(MIXED_1OZ_SILVER);
    const res = await post({ metal: 'silver', size: '1 oz', brand: 'Geiger', ...REQ });

    expect(res.status).toBe(200);
    expect(res.body.valuation.fmvCore).toBeNull();
    expect(res.body.valuation.dataSource.label).toBe('insufficient-brand-comps');
    expect(res.body.valuation.barSegment).toEqual(expect.objectContaining({ class: 'brand', compCount: 1 }));
    expect(res.body.valuation.explanation.join(' ')).toMatch(/other bar segments were not substituted/i);
  });
});

describe('series segment (maker and series)', () => {
  test('admits only the requested series and no other maker', async () => {
    seedComps([
      ...MIXED_1OZ_SILVER,
      ['PAMP Suisse 1 oz Silver Bar Lady Fortuna Sealed', 46],
      ['PAMP Suisse Fortuna 1 oz Silver Bar Assay', 47],
    ]);
    const res = await post({ metal: 'silver', size: '1 oz', brand: 'PAMP', series: 'fortuna', ...REQ });

    expect(res.status).toBe(200);
    const titles = titlesOf(res);
    expect(titles.every(t => /fortuna/i.test(t) || detectBarBrands(t).includes('PAMP'))).toBe(true);
    expect(titles.some(t => /rosa/i.test(t))).toBe(false);
    expect(titles.some(t => /geiger|johnson|sunshine/i.test(t))).toBe(false);
    expect(res.body.ebay.us.removed.barSeriesMismatch).toBe(1);
    expect(res.body.bar.segment).toEqual(expect.objectContaining({ class: 'series', brand: 'PAMP', series: 'Fortuna' }));
    expect(res.body.valuation.barSegment.class).toBe('series');
  });
});

describe('maker the registry does not know', () => {
  test('stays a brand segment and admits only titles naming that maker', async () => {
    seedComps([
      ['Acme Metals 1 oz Silver Bar', 36],
      ['Acme Metals 1 oz Silver Bar Sealed', 37],
      ['Acme Metals 1 oz .999 Silver Bar', 38],
      ['1 oz .999 Silver Bar Generic Stackable', 34],
      ['PAMP Suisse 1 oz Silver Bar', 43],
    ]);
    const res = await post({ metal: 'silver', size: '1 oz', brand: 'Acme Metals', ...REQ });

    expect(res.status).toBe(200);
    expect(titlesOf(res)).toHaveLength(3);
    expect(titlesOf(res).every(t => /acme/i.test(t))).toBe(true);
    expect(res.body.bar.segment).toEqual(expect.objectContaining({ class: 'brand', brand: 'Acme Metals' }));
  });
});

describe('result cache identity', () => {
  test('a generic bar segment never reuses an unsegmented result for the same keywords', async () => {
    seedComps(MIXED_1OZ_SILVER);
    const base = { metal: 'silver', weight: 1 };
    const generic = await ebayService.fetchSoldComps('1 oz silver bar', { usMinComps: 1 }, {
      ...base, barSegment: { class: 'generic', barBrand: null, barSeries: null },
    });
    const unsegmented = await ebayService.fetchSoldComps('1 oz silver bar', { usMinComps: 1 }, { ...base });

    expect(generic.us.comps).toHaveLength(3);
    expect(unsegmented.us.comps.length).toBeGreaterThan(generic.us.comps.length);
  });
});

describe('melt floor and ceiling run on /api/bar-price', () => {
  test('drops a comp far below melt and an unweighted comp far above it', async () => {
    seedComps([
      ['1 oz .999 Silver Bar Generic Stackable', 34],
      ['Silver Bar 1 oz .999 Fine Hand Poured', 35],
      ['1 oz Silver Bar .999 Unbranded Sealed', 36],
      ['1 oz .999 Silver Bar Plain Unbranded', 6],
      ['Silver Bar .999 Fine Rare Unbranded', 900],
    ]);
    const res = await post({ metal: 'silver', size: '1 oz', ...REQ });

    expect(res.status).toBe(200);
    expect(res.body.ebay.us.removed.meltFloor).toBe(1);
    expect(res.body.ebay.us.removed.meltSanity).toBe(1);
    expect(titlesOf(res)).toHaveLength(3);
  });
});

describe('premium ceiling depends on the metal, not the bar size', () => {
  test('a 100 oz silver bar keeps a 60% premium (old rule capped it at 40%)', async () => {
    const price = 30 * 100 * 1.6;
    seedComps([
      ['100 oz .999 Silver Bar Generic', price],
      ['Silver Bar 100 oz Fine Unbranded', price],
      ['100 oz Silver Bar .999 Poured', price],
    ]);
    const res = await post({ metal: 'silver', size: '100 oz', ...REQ });

    expect(res.status).toBe(200);
    expect(res.body.bar.pureOzt).toBe(100);
    expect(res.body.valuation.fmvCore).toBeGreaterThan(30 * 100 * 1.55);
    expect(res.body.valuation.fmvCore).toBeLessThan(30 * 100 * 1.65);
  });

  test('a 1 gram gold bar is capped at 40% over spot (old rule allowed 100%)', async () => {
    const spotGram = 2000 / 31.1035;
    const price = spotGram * 2.0;
    seedComps([
      ['1 gram Gold Bar .9999 Generic', price],
      ['Gold Bar 1 gram Fine Unbranded', price],
      ['1 gram .9999 Gold Bar Sealed Assay', price],
    ]);
    const res = await post({ metal: 'gold', size: '1 gram', ...REQ });

    expect(res.status).toBe(200);
    expect(res.body.valuation.fmvCore).toBeGreaterThan(spotGram * 1.38);
    expect(res.body.valuation.fmvCore).toBeLessThan(spotGram * 1.42);
  });
});

describe('size handling', () => {
  test.each([
    ['25 gram', 25 / 31.1035],
    ['250 gram', 250 / 31.1035],
    ['500 gram', 500 / 31.1035],
    ['1/10 oz', 0.1],
    ['1/2 oz', 0.5],
    ['20 oz', 20],
    ['50 oz', 50],
    ['100 oz', 100],
    ['1000 oz', 1000],
    ['1 kilo', 32.1507],
  ])('reports pureOzt for %s', async (size, expectedOzt) => {
    seedComps([]);
    const res = await post({ metal: 'silver', size, ...REQ });
    expect(res.status).toBe(200);
    expect(res.body.bar.pureOzt).toBeCloseTo(expectedOzt, 4);
  });

  test.each(['3 stone', '0 oz', '-1 oz', 'heavy', '1 oz; DROP', '5000 oz', {}])(
    'rejects an unrecognized size (%p) instead of defaulting to 1 oz',
    async (size) => {
      const res = await post({ metal: 'silver', size, ...REQ });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/size/i);
    }
  );

  test('rejects an unsupported metal', async () => {
    const res = await post({ metal: 'copper', size: '1 oz', ...REQ });
    expect(res.status).toBe(400);
  });
});
