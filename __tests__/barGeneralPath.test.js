// __tests__/barGeneralPath.test.js -- #333H Phase 1
// The same bar request must get the same segment and the same comp set on
// /api/bar-price, /api/price (priceCoin) and /api/pricing-batch. Everything
// below the routes is real (ebayService filters, valuationService, coinIntent,
// parseDescription); only network and data edges are mocked.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bar-general-path-'));
process.env.CACHE_DIR = TMP_CACHE_DIR;
process.env.EBAY_APP_ID = 'test-app-id';
process.env.EBAY_CLIENT_SECRET = 'test-secret';
process.env.EBAY_THROTTLE_MS = '0';

jest.mock('axios');
jest.mock('../src/services/terapeakService');
jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(async (sym) => ({ price: sym === 'XAU' ? 2000 : 30, currency: 'USD', source: 'test', stale: false })),
}));
jest.mock('../src/services/metalsHistoryService', () => ({
  ...jest.requireActual('../src/services/metalsHistoryService'),
  getSpotOnDate: jest.fn(() => null),
}));
jest.mock('../src/services/pcgsService', () => ({
  ...jest.requireActual('../src/services/pcgsService'),
  resolveFromDescription: jest.fn(async () => ({ verified: false })),
}));
jest.mock('../src/services/greysheetService', () => ({
  fetchPriceByPcgsNumber: jest.fn(async () => null),
  fetchTypePrice: jest.fn(async () => null),
}));
jest.mock('../src/services/greysheetHistoryService', () => ({
  makeKey: jest.fn((...a) => a.join('::')),
  recordSnapshot: jest.fn(),
}));
jest.mock('../src/services/auctionPriceService', () => ({
  getHistory: jest.fn(() => ({ stats: { count: 0 }, records: [] })),
  computeTrend: jest.fn(() => null),
}));
jest.mock('../src/services/numistaService', () => ({
  lookupCoin: jest.fn(async () => ({ accessible: false })),
}));
jest.mock('../src/services/auditService', () => ({
  writeValuationAudit: jest.fn(async () => {}),
}));

const http = require('http');
const express = require('express');
const terapeakService = require('../src/services/terapeakService');
const ebayService = require('../src/services/ebayService');
const { priceCoin } = require('../src/services/pricingService');
const barPriceRoute = require('../src/routes/barPriceRoute');
const pricingBatchRoute = require('../src/routes/pricingBatchRoute');
const { computeValuation } = require('../src/services/valuationService');
const { getSpotOnDate } = require('../src/services/metalsHistoryService');

let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/bar-price', barPriceRoute);
  app.use('/api/pricing-batch', pricingBatchRoute);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  }));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_CACHE_DIR, { recursive: true, force: true });
});

let fetchSpy;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  ebayService.clearCache();
  fetchSpy = jest.spyOn(ebayService, 'fetchSoldComps');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function post(route, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + route);
    const r = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
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

function seed(rows) {
  terapeakService.lookupComps.mockReturnValue({
    searchTerm: 'bar',
    lastImport: daysAgo(1),
    comps: rows.map(([title, totalUsd, soldDate], i) => ({
      title, totalUsd, soldDate: soldDate || daysAgo(1 + i), conditionId: '1000', _source: 'terapeak',
    })),
  });
}

const POOL = [
  ['1 oz .999 Silver Bar Generic Stackable', 34],
  ['Silver Bar 1 oz .999 Fine Hand Poured', 35],
  ['1 oz Silver Bar .999 Unbranded Sealed', 36],
  ['PAMP Suisse 1 oz Silver Bar Lady Fortuna', 45],
  ['PAMP Suisse Fortuna 1 oz Silver Bar Assay', 46],
  ['PAMP Suisse 1 oz Silver Bar Rosa', 44],
  ['PAMP Suisse 1 oz Silver Bar', 43],
  ['Geiger Edelmetalle 1 oz Silver Bar Square', 41],
  ['Johnson Matthey 1 oz Silver Bar', 52],
  ['Sunshine Mint 1 oz Silver Bar', 47],
  ['Sunshine Mining 1 oz Silver Bar Vintage', 60],
  ['JM Bullion 1 oz Silver Bar', 37],
];

const CASES = [
  { name: 'generic', query: '1 oz silver bar', route: { metal: 'silver', size: '1 oz' }, cls: 'generic' },
  { name: 'brand', query: 'PAMP Suisse 1 oz silver bar', route: { metal: 'silver', size: '1 oz', brand: 'PAMP Suisse' }, cls: 'brand' },
  {
    name: 'series', query: 'PAMP Suisse 1 oz silver bar Lady Fortuna',
    route: { metal: 'silver', size: '1 oz', brand: 'PAMP Suisse', series: 'fortuna' }, cls: 'series',
  },
  { name: 'bare Sunshine', query: 'Sunshine 1 oz silver bar', route: { metal: 'silver', size: '1 oz', brand: 'Sunshine' }, cls: 'brand' },
];

const COMP_OPTS = { usMinComps: 1 };

async function viaRoute(c) {
  const res = await post('/api/bar-price', { ...c.route, options: COMP_OPTS });
  expect(res.status).toBe(200);
  return {
    titles: res.body.ebay.us.comps.map(x => x.title).sort(),
    segment: res.body.bar.segment,
    valuationSegment: res.body.valuation.barSegment,
    valuation: res.body.valuation,
  };
}

async function viaPriceCoin(c) {
  const result = await priceCoin({ query: c.query, coinData: {}, options: COMP_OPTS }, { isAdmin: false, audience: 'public' });
  const comps = (await fetchSpy.mock.results[0].value).us.comps;
  return { titles: comps.map(x => x.title).sort(), valuationSegment: result.valuation.barSegment, valuation: result.valuation };
}

async function viaBatch(c) {
  const res = await post('/api/pricing-batch', { items: [{ query: c.query, options: COMP_OPTS }] });
  expect(res.status).toBe(200);
  const comps = (await fetchSpy.mock.results[0].value).us.comps;
  return { titles: comps.map(x => x.title).sort(), valuationSegment: res.body.results[0].barSegment, result: res.body.results[0] };
}

describe.each(CASES)('same bar on every route: $name', (c) => {
  test('segment class and comp set match across the three routes', async () => {
    seed(POOL);
    const a = await viaRoute(c);
    ebayService.clearCache(); fetchSpy.mockClear();
    const b = await viaPriceCoin(c);
    ebayService.clearCache(); fetchSpy.mockClear();
    const d = await viaBatch(c);

    expect(a.valuationSegment.class).toBe(c.cls);
    expect(b.valuationSegment.class).toBe(c.cls);
    expect(d.valuationSegment.class).toBe(c.cls);
    expect(a.valuationSegment.label).toBe(b.valuationSegment.label);
    expect(a.valuationSegment.label).toBe(d.valuationSegment.label);
    expect(a.titles.length).toBeGreaterThanOrEqual(1);
    expect(b.titles).toEqual(a.titles);
    expect(d.titles).toEqual(a.titles);
  });
});

describe('segment contents on the general path', () => {
  test('generic /api/price admits only unbranded comps', async () => {
    seed(POOL);
    const out = await viaPriceCoin(CASES[0]);
    expect(out.titles).toEqual([
      '1 oz .999 Silver Bar Generic Stackable',
      '1 oz Silver Bar .999 Unbranded Sealed',
      'JM Bullion 1 oz Silver Bar',
      'Silver Bar 1 oz .999 Fine Hand Poured',
    ]);
  });

  test('series /api/pricing-batch admits only that series for that maker', async () => {
    seed(POOL);
    const out = await viaBatch(CASES[2]);
    expect(out.titles).toEqual([
      'PAMP Suisse 1 oz Silver Bar',
      'PAMP Suisse 1 oz Silver Bar Lady Fortuna',
      'PAMP Suisse Fortuna 1 oz Silver Bar Assay',
    ]);
  });

  test('brand segment with a registry alias keeps the Sunshine Mint titles', async () => {
    seed(POOL);
    const out = await viaPriceCoin(CASES[3]);
    expect(out.titles).toEqual(['Sunshine Mint 1 oz Silver Bar']);
  });

  test('a bar with fewer than three comps in the segment returns no FMV with a label on /api/price', async () => {
    seed(POOL);
    const out = await viaPriceCoin(CASES[3]);
    expect(out.valuation.fmvCore).toBeNull();
    expect(out.valuation.dataSource.label).toBe('insufficient-brand-comps');
    expect(out.valuationSegment.compCount).toBe(out.valuation.compCount);
  });

  test('a series-less bar is priced as bullion on every route (same method)', async () => {
    seed(POOL);
    const a = await viaRoute(CASES[0]);
    ebayService.clearCache(); fetchSpy.mockClear();
    const b = await viaPriceCoin(CASES[0]);
    ebayService.clearCache(); fetchSpy.mockClear();
    const d = await viaBatch(CASES[0]);

    expect(a.valuation.method).toBe('bullion-spot-premium');
    expect(b.valuation.method).toBe('bullion-spot-premium');
    expect(d.result.method).toBe('bullion-spot-premium');
  });
});

describe('coin queries are not bar requests', () => {
  test.each([
    'Silver Eagle 1 oz bar code',
    'Morgan dollar silver bar cent',
    'Franklin Mint 1 oz silver bar',
    'Silver Eagle in Sunshine Mint bar-style capsule',
    '1921 Morgan Dollar',
  ])('%s gets no bar segment', async (query) => {
    seed([['Generic coin 1 oz', 40], ['Generic coin 1 oz', 41], ['Generic coin 1 oz', 42]]);
    const result = await priceCoin({ query, coinData: {}, options: COMP_OPTS }, { isAdmin: false, audience: 'public' });
    expect(result.valuation.barSegment).toBeUndefined();
    const expectedArg = fetchSpy.mock.calls[0][2];
    expect(expectedArg.type).toBeUndefined();
    expect(expectedArg.barSegment == null).toBe(true);
  });
});

describe('premium ceiling: coins keep the old rule, bars use the metal', () => {
  const usComp = (price) => ({ title: 't', totalUsd: price, soldDate: daysAgo(2), _source: 'terapeak', matchScore: 80, gradeType: 'raw' });
  const ebay = (price) => {
    const list = [usComp(price), usComp(price), usComp(price), usComp(price), usComp(price)];
    return { us: { comps: list, stats: { count: 5, median: price, mean: price } }, global: { comps: [], stats: { count: 0 } }, usedFallback: false };
  };

  test('without a bar segment a 100 oz total spot of 3000 is capped at 40%', () => {
    const { valuation } = computeValuation({ verified: false }, ebay(4800), null, null, { isBullion: true, spotPrice: 3000 });
    expect(valuation.fmvCore).toBeLessThan(3000 * 1.45);
  });

  test('with a silver bar segment the same total spot keeps up to 100%', () => {
    const segment = { class: 'generic', barBrand: null, barSeries: null, label: 'Generic' };
    const { valuation } = computeValuation({ verified: false }, ebay(4800), null, null, {
      isBullion: true, spotPrice: 3000, metal: 'silver', barSegment: segment,
    });
    expect(valuation.fmvCore).toBeGreaterThan(3000 * 1.55);
  });

  test('barSegment.compCount repeats the response compCount when asking-price comps are mixed in', () => {
    const segment = { class: 'generic', barBrand: null, barSeries: null, label: 'Generic' };
    const sold = (price) => usComp(price);
    const asking = (price) => ({ ...usComp(price), _source: 'browse' });
    const list = [sold(34), sold(35), sold(36), asking(40), asking(41)];
    const { valuation } = computeValuation({ verified: false }, {
      us: { comps: list, stats: { count: 5, median: 36, mean: 37 } }, global: { comps: [], stats: { count: 0 } }, usedFallback: false,
    }, null, null, { isBullion: true, spotPrice: 30, metal: 'silver', barSegment: segment });

    expect(valuation.compCount).toBe(3);
    expect(valuation.barSegment.compCount).toBe(valuation.compCount);
  });

  test('platinum and palladium bars are capped at 40%', () => {
    for (const metal of ['platinum', 'palladium']) {
      const segment = { class: 'generic', barBrand: null, barSeries: null, label: 'Generic' };
      const { valuation } = computeValuation({ verified: false }, ebay(60), null, null, {
        isBullion: true, spotPrice: 30, metal, barSegment: segment,
      });
      expect(valuation.fmvCore).toBeLessThan(30 * 1.45);
    }
  });
});

describe('melt floor uses the spot price on the sale date', () => {
  test('a comp below 40% of that day spot is dropped even though today spot would keep it', async () => {
    const OLD = daysAgo(40);
    getSpotOnDate.mockImplementation((sym, date) => (date === OLD ? 80 : null));
    seed([
      ['1 oz .999 Silver Bar Generic Stackable', 34],
      ['Silver Bar 1 oz .999 Fine Hand Poured', 35],
      ['1 oz Silver Bar .999 Unbranded Sealed', 36],
      ['1 oz .999 Silver Bar Plain Unbranded', 20, OLD],
    ]);
    const res = await post('/api/bar-price', { metal: 'silver', size: '1 oz', options: COMP_OPTS });

    expect(res.status).toBe(200);
    expect(res.body.ebay.us.removed.meltFloor).toBe(1);
    expect(res.body.ebay.us.comps.map(c => c.totalUsd).sort()).toEqual([34, 35, 36]);
  });

  test('fractional bars get the melt floor too', async () => {
    seed([
      ['5 gram .999 Silver Bar Generic', 5.5],
      ['Silver Bar 5 gram Fine Unbranded', 5.8],
      ['5 gram Silver Bar .999 Sealed', 6.0],
      ['5 gram .999 Silver Bar Plain', 0.5],
    ]);
    const res = await post('/api/bar-price', { metal: 'silver', size: '5 gram', options: COMP_OPTS });

    expect(res.status).toBe(200);
    expect(res.body.ebay.us.removed.meltFloor).toBe(1);
  });
});
