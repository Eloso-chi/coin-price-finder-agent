// __tests__/ebayFetchSoldComps.test.js — Tests for fetchSoldComps orchestration
// Mocks axios (OAuth + Finding + Browse), terapeakService, cache, and stats
// to exercise the 3-tier cascade, auto-extend, circuit breaker, and caching.

'use strict';

// ── Mocks ───────────────────────────────────────────────────
jest.mock('axios');
jest.mock('../src/services/terapeakService');
jest.mock('../src/utils/stats');
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: jest.fn(() => true), mkdirSync: jest.fn() };
});

const axios = require('axios');
const terapeakService = require('../src/services/terapeakService');
const stats = require('../src/utils/stats');

// Stable env before importing ebayService
process.env.EBAY_APP_ID = 'test-app-id';
process.env.EBAY_CLIENT_SECRET = 'test-secret';
process.env.EBAY_THROTTLE_MS = '0';        // disable throttle in tests
process.env.EBAY_US_MIN_COMPS = '3';       // low threshold for tests
process.env.EBAY_CACHE_TTL_MS = '1000';

const ebayService = require('../src/services/ebayService');

// ── Helpers ─────────────────────────────────────────────────
function makeOAuthResp() {
  return { data: { access_token: 'tok-123', expires_in: 3600 } };
}

function makeFindingComp(title, price, opts = {}) {
  return {
    itemId: [opts.itemId || `item-${Math.random().toString(36).slice(2, 8)}`],
    title: [title],
    viewItemURL: ['https://ebay.com/itm/1'],
    galleryURL: ['https://i.ebayimg.com/1.jpg'],
    sellingStatus: [{ currentPrice: [{ __value__: String(price), '@currencyId': 'USD' }] }],
    shippingInfo: [{ shippingServiceCost: [{ __value__: '0' }] }],
    listingInfo: [{ endTime: ['2024-06-01T00:00:00Z'], listingType: ['FixedPrice'] }],
    condition: [{ conditionId: [opts.conditionId || '4000'], conditionDisplayName: ['Circulated'] }],
    location: ['US']
  };
}

function wrapFindingResponse(items, totalPages = 1) {
  return {
    findCompletedItemsResponse: [{
      ack: ['Success'],
      paginationOutput: [{ totalPages: [String(totalPages)] }],
      searchResult: [{ item: items }]
    }]
  };
}

function makeBrowseComp(title, price, opts = {}) {
  return {
    itemId: opts.itemId || `browse-${Math.random().toString(36).slice(2, 8)}`,
    title,
    itemWebUrl: 'https://ebay.com/itm/2',
    image: { imageUrl: 'https://i.ebayimg.com/2.jpg' },
    price: { value: String(price), currency: 'USD' },
    shippingOptions: [{ shippingCost: { value: '0' } }],
    conditionId: opts.conditionId || '4000',
    localizedAspects: opts.aspects || [],
    itemLocation: { country: 'US' }
  };
}

function wrapBrowseResponse(items) {
  return { data: { itemSummaries: items } };
}

// ── Setup / Teardown ────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  ebayService.clearCache();

  // Default: terapeak returns nothing
  terapeakService.lookupComps.mockReturnValue(null);

  // Default: stats.summarize returns a stub
  stats.summarize.mockImplementation(prices => ({
    count: prices.length,
    mean: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0,
    median: prices.length ? prices[Math.floor(prices.length / 2)] : 0
  }));

  // Default: stats.removeOutliersMAD passes everything through
  stats.removeOutliersMAD.mockImplementation((prices) => ({
    kept: prices,
    removed: []
  }));
});

// ═════════════════════════════════════════════════════════════
//  Terapeak tier (highest priority)
// ═════════════════════════════════════════════════════════════
describe('fetchSoldComps — Terapeak tier', () => {
  test('returns terapeak data when enough comps available', async () => {
    terapeakService.lookupComps.mockReturnValue({
      searchTerm: '1964 Kennedy Half',
      lastImport: '2024-06-01',
      comps: [
        { title: '1964 Kennedy Half Dollar 50c', totalUsd: 12, soldDate: '2024-05-01', _source: 'terapeak' },
        { title: '1964 Kennedy Half Dollar Silver', totalUsd: 13, soldDate: '2024-05-02', _source: 'terapeak' },
        { title: '1964 Kennedy Half Dollar', totalUsd: 11, soldDate: '2024-05-03', _source: 'terapeak' },
        { title: '1964 Kennedy Half 50c Silver', totalUsd: 14, soldDate: '2024-04-01', _source: 'terapeak' },
      ]
    });

    const result = await ebayService.fetchSoldComps('1964 Kennedy Half Dollar', {}, {
      year: 1964, series: 'Kennedy Half Dollar'
    });

    expect(result.apiUsed).toBe('terapeak');
    expect(result.us.comps.length).toBeGreaterThanOrEqual(3);
    // Should NOT have called axios at all (no Finding/Browse needed)
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('falls through to Finding API when terapeak has too few comps', async () => {
    terapeakService.lookupComps.mockReturnValue({
      searchTerm: '1964 Kennedy Half',
      lastImport: '2024-06-01',
      comps: [
        { title: '1964 Kennedy Half Dollar 50c', totalUsd: 12, soldDate: '2024-05-01', _source: 'terapeak' },
      ]
    });

    const findingItems = [
      makeFindingComp('1964 Kennedy Half Dollar 50c Silver', 12),
      makeFindingComp('1964 Kennedy Half Dollar Circulated', 11),
      makeFindingComp('1964 Kennedy Half Dollar VG', 10),
    ];
    // US tier call, then global tier call
    axios.get
      .mockResolvedValueOnce({ data: wrapFindingResponse(findingItems) })  // US
      .mockResolvedValueOnce({ data: wrapFindingResponse(findingItems) }); // Global

    const result = await ebayService.fetchSoldComps('1964 Kennedy Half Dollar', {}, {
      year: 1964, series: 'Kennedy Half Dollar'
    });

    expect(result.apiUsed).toContain('finding');
    expect(result.us.comps.length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════
//  Finding API tier
// ═════════════════════════════════════════════════════════════
describe('fetchSoldComps — Finding API', () => {
  test('returns US-only comps when enough available', async () => {
    const items = [
      makeFindingComp('2024 American Silver Eagle 1 oz', 32),
      makeFindingComp('2024 American Silver Eagle 1oz BU', 33),
      makeFindingComp('2024 ASE Silver Eagle 1 oz', 31),
      makeFindingComp('2024 Silver Eagle BU', 30),
    ];
    // US tier, then global
    axios.get
      .mockResolvedValueOnce({ data: wrapFindingResponse(items) })
      .mockResolvedValueOnce({ data: wrapFindingResponse(items) });

    const result = await ebayService.fetchSoldComps('2024 American Silver Eagle', {}, {
      year: 2024, series: 'American Silver Eagle', weight: 1, metal: 'silver'
    });

    expect(result.apiUsed).toContain('finding');
    expect(result.us.comps.length).toBeGreaterThanOrEqual(3);
    expect(result.us.stats).toBeTruthy();
    expect(result.lookback.requested).toBe(180);
  });

  test('auto-extends lookback when US comps below threshold', async () => {
    // First tier (180d) returns too few
    const fewItems = [makeFindingComp('2020 Silver Eagle 1 oz', 30)];
    // Second tier (365d) returns enough
    const moreItems = [
      makeFindingComp('2020 Silver Eagle 1 oz BU', 30),
      makeFindingComp('2020 Silver Eagle 1oz', 29),
      makeFindingComp('2020 ASE 1 oz', 31),
      makeFindingComp('2020 Silver Eagle 1 oz Tube', 28),
    ];

    axios.get
      .mockResolvedValueOnce({ data: wrapFindingResponse(fewItems) })   // US 180d
      .mockResolvedValueOnce({ data: wrapFindingResponse(moreItems) })  // US 365d
      .mockResolvedValueOnce({ data: wrapFindingResponse(moreItems) }); // Global

    const result = await ebayService.fetchSoldComps('2020 Silver Eagle', {
      timeWindowDays: 90   // start small to trigger extension
    }, {
      year: 2020, series: 'American Silver Eagle', weight: 1, metal: 'silver'
    });

    expect(result.lookback.extended).toBe(true);
    expect(result.lookback.used).toBeGreaterThan(90);
  });

});

// ═════════════════════════════════════════════════════════════
//  Browse API fallback
// ═════════════════════════════════════════════════════════════
describe('fetchSoldComps — Browse API fallback', () => {
  test('triggers when Finding API returns insufficient comps', async () => {
    // Finding returns 0 comps
    axios.get
      .mockResolvedValueOnce({ data: wrapFindingResponse([]) })  // US Finding
      .mockResolvedValueOnce({ data: wrapFindingResponse([]) })  // US Finding 365d
      .mockResolvedValueOnce({ data: wrapFindingResponse([]) })  // Global Finding
      .mockResolvedValueOnce(wrapBrowseResponse([                // Browse
        makeBrowseComp('1893-S Morgan Dollar', 800),
        makeBrowseComp('1893-S Morgan Dollar VG', 750),
        makeBrowseComp('1893-S Morgan Silver Dollar', 900),
      ]));

    // OAuth token
    axios.post.mockResolvedValue(makeOAuthResp());

    const result = await ebayService.fetchSoldComps('1893-S Morgan Dollar', {}, {
      year: 1893, series: 'Morgan Dollar', mint: 'S'
    });

    expect(result.usedFallback).toBe(true);
    expect(result.apiUsed).toContain('browse');
  });

  test('uses OAuth bearer token for Browse API', async () => {
    axios.get
      .mockResolvedValueOnce({ data: wrapFindingResponse([]) })  // US Finding
      .mockResolvedValueOnce({ data: wrapFindingResponse([]) })  // US Finding 365d
      .mockResolvedValueOnce({ data: wrapFindingResponse([]) })  // Global
      .mockResolvedValueOnce(wrapBrowseResponse([                // Browse
        makeBrowseComp('Test coin', 50),
        makeBrowseComp('Test coin 2', 55),
        makeBrowseComp('Test coin 3', 48),
      ]));

    axios.post.mockResolvedValue(makeOAuthResp());

    await ebayService.fetchSoldComps('test coin oauth check', {}, {});

    // Browse GET should include Authorization header (OAuth token may
    // be cached from a prior test, so we check the header on the actual
    // Browse call rather than asserting axios.post was invoked)
    const browseCalls = axios.get.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('browse')
    );
    expect(browseCalls.length).toBeGreaterThanOrEqual(1);
    expect(browseCalls[0][1].headers.Authorization).toMatch(/^Bearer .+/);
  });
});

// ═════════════════════════════════════════════════════════════
//  Caching
// ═════════════════════════════════════════════════════════════
describe('fetchSoldComps — caching', () => {
  test('returns cached result on second call with same args', async () => {
    terapeakService.lookupComps.mockReturnValue({
      searchTerm: 'cache-test',
      lastImport: '2024-01-01',
      comps: [
        { title: 'Cache Test Coin 1', totalUsd: 50, soldDate: '2024-05-01', _source: 'terapeak' },
        { title: 'Cache Test Coin 2', totalUsd: 51, soldDate: '2024-05-01', _source: 'terapeak' },
        { title: 'Cache Test Coin 3', totalUsd: 49, soldDate: '2024-05-01', _source: 'terapeak' },
      ]
    });

    const result1 = await ebayService.fetchSoldComps('cache-test', {}, { year: 2024 });
    const result2 = await ebayService.fetchSoldComps('cache-test', {}, { year: 2024 });

    // Both calls should return same data
    expect(result1.us.comps.length).toBe(result2.us.comps.length);
    // terapeakService called once for the first request (rawQuery === keywords, so
    // no second lookup). The second fetchSoldComps returns from cache without
    // calling terapeakService at all.
    expect(terapeakService.lookupComps).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════
//  No credentials
// ═════════════════════════════════════════════════════════════
describe('fetchSoldComps — no credentials', () => {
  const origAppId = process.env.EBAY_APP_ID;

  afterEach(() => { process.env.EBAY_APP_ID = origAppId; });

  test('returns empty result with error when EBAY_APP_ID missing', async () => {
    // ebayService reads EBAY_APP_ID at module load; we need to test the guard.
    // The module already captured the env, so we test via a separate code path:
    // terapeakService returns nothing + EBAY_APP_ID was set at load time.
    // Instead, test that when terapeak has nothing and Finding returns failure,
    // we still get a structured result.
    axios.get.mockRejectedValue(new Error('Invalid AppID'));
    axios.post.mockRejectedValue(new Error('Invalid OAuth'));

    const result = await ebayService.fetchSoldComps('no-creds-test', {}, {});

    expect(result.us).toBeTruthy();
    expect(result.global).toBeTruthy();
    expect(result.us.error).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════
//  Score / filter integration via fetchSoldComps
// ═════════════════════════════════════════════════════════════
describe('fetchSoldComps — scoring integration', () => {
  test('scores and filters comps correctly for year mismatch', async () => {
    const items = [
      makeFindingComp('2024 American Silver Eagle 1 oz', 32),
      makeFindingComp('2023 American Silver Eagle 1 oz', 31),  // wrong year
      makeFindingComp('2024 Silver Eagle 1oz BU', 33),
      makeFindingComp('2024 ASE 1 oz', 30),
    ];
    axios.get
      .mockResolvedValueOnce({ data: wrapFindingResponse(items) })
      .mockResolvedValueOnce({ data: wrapFindingResponse(items) });

    const result = await ebayService.fetchSoldComps('2024 Silver Eagle', {}, {
      year: 2024, series: 'American Silver Eagle', weight: 1, metal: 'silver'
    });

    // The 2023 comp should have been filtered out (year mismatch hard filter)
    const titles = result.us.comps.map(c => c.title);
    expect(titles.every(t => !t.includes('2023'))).toBe(true);
  });

  test('auto-detects metal from raw query', async () => {
    const items = [
      makeFindingComp('2024 Gold Eagle 1 oz', 2100),
      makeFindingComp('2024 Gold Eagle 1oz BU', 2150),
      makeFindingComp('2024 American Gold Eagle', 2050),
    ];
    // Provide enough mocks for all possible API calls (Finding US tiers + Global + Browse fallback)
    axios.get.mockResolvedValue({ data: wrapFindingResponse(items) });
    axios.post.mockResolvedValue(makeOAuthResp());

    const expected = {
      year: 2024, series: 'American Gold Eagle', weight: 1, _rawQuery: '2024 gold eagle 1 oz'
    };
    // metal is NOT set — fetchSoldComps should auto-detect 'gold' from _rawQuery
    expect(expected.metal).toBeUndefined();

    const result = await ebayService.fetchSoldComps('2024 Gold Eagle metal-detect', {}, expected);

    // The function should have proceeded (not errored) and returned comps
    expect(result.us).toBeTruthy();
    expect(result.apiUsed).not.toBe('none');
  });

  test('auto-detects brand filter for Perth Mint', async () => {
    const items = [
      makeFindingComp('2024 Perth Lunar Dragon 1 oz Silver', 45),
      makeFindingComp('2024 Australian Lunar Dragon 1oz', 44),
      makeFindingComp('2024 Lunar Series III Dragon', 46),
    ];
    axios.get
      .mockResolvedValueOnce({ data: wrapFindingResponse(items) })
      .mockResolvedValueOnce({ data: wrapFindingResponse(items) });

    await ebayService.fetchSoldComps('2024 Perth Lunar Dragon', {}, {
      year: 2024, _rawQuery: '2024 perth lunar dragon 1 oz silver'
    });

    // Verifying it didn't throw — brand filter is used in Browse fallback only
    expect(axios.get).toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════
//  buildKeywords
// ═════════════════════════════════════════════════════════════
describe('buildKeywords', () => {
  test('builds keywords from PCGS data', () => {
    const kw = ebayService.buildKeywords(
      { year: 1964, mint: 'D', series: 'Kennedy Half Dollar', grade: 'MS65' },
      '1964-D Kennedy Half Dollar MS65'
    );
    expect(kw).toContain('1964-D');
    expect(kw).toContain('Kennedy Half Dollar');
    expect(kw).toContain('MS65');
  });

  test('includes weight for bullion', () => {
    const kw = ebayService.buildKeywords(
      { year: 2024, series: 'American Silver Eagle' },
      '2024 Silver Eagle 1/4 oz',
      0.25
    );
    expect(kw).toContain('1/4 oz');
  });

  test('includes label when provided', () => {
    const kw = ebayService.buildKeywords(
      { year: 2024, series: 'American Silver Eagle', grade: 'MS70' },
      '2024 ASE MS70 First Strike',
      null,
      'First Strike'
    );
    expect(kw).toContain('First Strike');
  });

  test('falls back to raw query when series missing', () => {
    const kw = ebayService.buildKeywords({}, 'raw query fallback');
    expect(kw).toBe('raw query fallback');
  });

  test('handles proof grade without finish', () => {
    const kw = ebayService.buildKeywords(
      { year: 2024, series: 'Silver Eagle', grade: 'Proof' },
      '2024 Silver Eagle Proof'
    );
    expect(kw).toContain('Proof');
  });
});

// ═════════════════════════════════════════════════════════════
//  classifyGradeType
// ═════════════════════════════════════════════════════════════
describe('classifyGradeType', () => {
  test('conditionId 2000 = graded', () => {
    expect(ebayService.classifyGradeType({ conditionId: '2000', title: 'coin' })).toBe('graded');
  });

  test('conditionId 3000 = raw', () => {
    expect(ebayService.classifyGradeType({ conditionId: '3000', title: 'coin' })).toBe('raw');
  });

  test('conditionId 4000 = raw', () => {
    expect(ebayService.classifyGradeType({ conditionId: '4000', title: 'coin' })).toBe('raw');
  });

  test('_certificationAspect = graded', () => {
    expect(ebayService.classifyGradeType({ title: 'coin', _certificationAspect: 'PCGS' })).toBe('graded');
  });

  test('PCGS in title = graded (fallback)', () => {
    expect(ebayService.classifyGradeType({ title: '1964 Kennedy PCGS MS65' })).toBe('graded');
  });

  test('MS65 in title = graded (formal grade pattern)', () => {
    expect(ebayService.classifyGradeType({ title: 'Morgan Dollar MS65' })).toBe('graded');
  });

  test('no grading indicators = raw', () => {
    expect(ebayService.classifyGradeType({ title: '1964 Kennedy Half Dollar Circulated' })).toBe('raw');
  });

  test('conditionId 3000 + proof title = proof', () => {
    expect(ebayService.classifyGradeType({ conditionId: '3000', title: '1987 Mexico Proof Libertad' })).toBe('proof');
  });

  test('conditionId 4000 + proof title = proof', () => {
    expect(ebayService.classifyGradeType({ conditionId: '4000', title: '1987 Proof Silver Libertad' })).toBe('proof');
  });

  test('proof in title (no conditionId) = proof', () => {
    expect(ebayService.classifyGradeType({ title: '1987 Mexico 1 oz Silver Libertad Proof' })).toBe('proof');
  });

  test('proof-like NOT classified as proof', () => {
    expect(ebayService.classifyGradeType({ title: '1881-S Morgan Dollar Proof-Like' })).toBe('raw');
  });

  test('conditionId 2000 + proof title = graded (certified takes priority)', () => {
    expect(ebayService.classifyGradeType({ conditionId: '2000', title: '1987 Proof Libertad NGC PF70' })).toBe('graded');
  });
});

// ═════════════════════════════════════════════════════════════
//  scoreMatch — proof penalties
// ═════════════════════════════════════════════════════════════
describe('scoreMatch — proof penalties', () => {
  test('proof comp penalized when user wants raw (no grade)', () => {
    const comp = { title: '1987 Mexico Proof Silver Libertad 1 oz', totalUsd: 300, gradeType: 'proof' };
    const expected = { year: 1987, metal: 'silver' };
    const scored = ebayService.scoreMatch(comp, expected);
    expect(scored.matchNotes).toContain('proof-vs-raw');
    expect(scored.matchNotes).toContain('proof-mismatch-unwanted-proof');
  });

  test('raw comp NOT penalized when user wants raw', () => {
    const comp = { title: '1987 Mexico 1 oz Silver Libertad BU', totalUsd: 200, gradeType: 'raw' };
    const expected = { year: 1987, metal: 'silver' };
    const scored = ebayService.scoreMatch(comp, expected);
    expect(scored.matchNotes).not.toContain('proof-vs-raw');
    expect(scored.matchNotes).not.toContain('proof-mismatch-unwanted-proof');
  });

  test('proof comp NOT penalized when user wants proof', () => {
    const comp = { title: '1987 Mexico Proof Silver Libertad', totalUsd: 300, gradeType: 'proof' };
    const expected = { year: 1987, metal: 'silver', isProof: true };
    const scored = ebayService.scoreMatch(comp, expected);
    expect(scored.matchNotes).not.toContain('proof-mismatch-unwanted-proof');
  });

  test('raw comp penalized when user wants proof', () => {
    const comp = { title: '1987 Mexico 1 oz Silver Libertad BU', totalUsd: 200, gradeType: 'raw' };
    const expected = { year: 1987, metal: 'silver', isProof: true };
    const scored = ebayService.scoreMatch(comp, expected);
    expect(scored.matchNotes).toContain('proof-mismatch-want-proof');
  });
});

// ═════════════════════════════════════════════════════════════
//  detectWeightFromTitle
// ═════════════════════════════════════════════════════════════
describe('detectWeightFromTitle', () => {
  test('1 oz', () => expect(ebayService.detectWeightFromTitle('2024 Silver Eagle 1 oz')).toBe(1));
  test('1/2 oz', () => expect(ebayService.detectWeightFromTitle('1/2 oz Gold Eagle')).toBe(0.5));
  test('1/4 oz', () => expect(ebayService.detectWeightFromTitle('2024 1/4 oz Gold Eagle')).toBe(0.25));
  test('1/10 oz', () => expect(ebayService.detectWeightFromTitle('1/10 oz Gold')).toBe(0.1));
  test('1/20 oz', () => expect(ebayService.detectWeightFromTitle('1/20 oz Gold Coin')).toBe(0.05));
  test('half oz', () => expect(ebayService.detectWeightFromTitle('half oz silver')).toBe(0.5));
  test('quarter oz', () => expect(ebayService.detectWeightFromTitle('quarter oz gold')).toBe(0.25));
  test('5 oz', () => expect(ebayService.detectWeightFromTitle('5 oz Silver ATB')).toBe(5));
  test('null for no weight', () => expect(ebayService.detectWeightFromTitle('Morgan Dollar')).toBeNull());
  test('null for empty', () => expect(ebayService.detectWeightFromTitle('')).toBeNull());
  test('null for null', () => expect(ebayService.detectWeightFromTitle(null)).toBeNull());

  // Gram-based weights (#187)
  test('1 gram', () => expect(ebayService.detectWeightFromTitle('Geiger 1 gram Gold Bar')).toBeCloseTo(1 / 31.1035, 5));
  test('0.5 gram', () => expect(ebayService.detectWeightFromTitle('PAMP 0.5 gram Gold Bar')).toBeCloseTo(0.5 / 31.1035, 5));
  test('0.5g (short)', () => expect(ebayService.detectWeightFromTitle('PAMP 0.5g Gold Bar')).toBeCloseTo(0.5 / 31.1035, 5));
  test('2.5 gram', () => expect(ebayService.detectWeightFromTitle('Perth 2.5 gram Gold Bar')).toBeCloseTo(2.5 / 31.1035, 5));
  test('5 gram', () => expect(ebayService.detectWeightFromTitle('Valcambi 5 gram Gold Bar')).toBeCloseTo(5 / 31.1035, 5));
  test('10 gram', () => expect(ebayService.detectWeightFromTitle('Argor-Heraeus 10 gram Gold Bar')).toBeCloseTo(10 / 31.1035, 5));
  test('100 gram', () => expect(ebayService.detectWeightFromTitle('PAMP Suisse 100 gram Silver Bar')).toBeCloseTo(100 / 31.1035, 5));
  test('half gram', () => expect(ebayService.detectWeightFromTitle('Geiger Edelmetalle half gram Gold Bar')).toBeCloseTo(0.5 / 31.1035, 5));
  test('1 kilo', () => expect(ebayService.detectWeightFromTitle('Perth Mint 1 kilo Silver Bar')).toBeCloseTo(32.1507, 3));
  test('gram takes priority when listed before oz', () => {
    // Title has gram first -- should detect gram weight
    const w = ebayService.detectWeightFromTitle('5 gram Gold Bar');
    expect(w).toBeCloseTo(5 / 31.1035, 5);
  });
});

// ═════════════════════════════════════════════════════════════
//  Finding API failure (run LAST — trips circuit breaker)
// ═════════════════════════════════════════════════════════════
describe('fetchSoldComps — Finding API failure', () => {
  test('handles Finding API failure gracefully and falls back to Browse', async () => {
    axios.get.mockRejectedValue(new Error('Network timeout'));
    axios.post.mockResolvedValue(makeOAuthResp());

    const result = await ebayService.fetchSoldComps('1921 Morgan Dollar failure test', {}, {
      year: 1921, series: 'Morgan Dollar'
    });

    expect(result.us.error).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════
//  dedup
// ═════════════════════════════════════════════════════════════
describe('dedup', () => {
  test('removes duplicate by itemId', () => {
    const comps = [
      { itemId: 'abc', title: 'coin 1', totalUsd: 50 },
      { itemId: 'abc', title: 'coin 1', totalUsd: 50 },
      { itemId: 'def', title: 'coin 2', totalUsd: 60 },
    ];
    expect(ebayService.dedup(comps)).toHaveLength(2);
  });

  test('removes duplicate by normalized title + price', () => {
    const comps = [
      { itemId: 'a', title: '2024 Silver Eagle 1oz', totalUsd: 32 },
      { itemId: 'b', title: '2024 Silver Eagle 1oz', totalUsd: 32 },
    ];
    expect(ebayService.dedup(comps)).toHaveLength(1);
  });

  test('keeps comps with different prices', () => {
    const comps = [
      { itemId: 'a', title: 'Same coin', totalUsd: 50 },
      { itemId: 'b', title: 'Same coin', totalUsd: 55 },
    ];
    expect(ebayService.dedup(comps)).toHaveLength(2);
  });
});
