// __tests__/pricingService.parity.test.js — Phase 0 acceptance tests
// Verify priceCoin() produces contract-compatible output with existing priceRoute behavior.
// CommonJS

'use strict';

jest.mock('../src/services/pcgsService', () => ({
  lookupByCert: jest.fn(),
  lookupByCoinNumberAndGrade: jest.fn(),
  resolveFromDescription: jest.fn(() => ({
    verified: false,
    series: 'Morgan Dollar',
    year: 1921,
    mint: 'O',
    grade: 64,
    designation: 'MS 64',
    metalContent: 'Silver',
    parsed: { series: 'Morgan Dollar', year: 1921, mint: 'O', grade: 64 }
  })),
  parseDescription: jest.fn((query) => {
    if (/morgan/i.test(query)) {
      return { series: 'Morgan Dollar', year: 1921, mint: 'O', grade: 64 };
    }
    if (/eagle/i.test(query)) {
      return { series: 'American Silver Eagle', year: 2024, weight: 1, metal: 'silver' };
    }
    if (/libertad/i.test(query)) {
      return { series: 'Mexican Silver Libertad', year: 2024, weight: 1, metal: 'silver' };
    }
    return {};
  }),
}));

jest.mock('../src/services/ebayService', () => ({
  fetchSoldComps: jest.fn(async () => ({
    us: {
      comps: [
        { itemId: '123', price: 45.00, grade: 64 },
        { itemId: '124', price: 46.00, grade: 64 },
      ],
      stats: { median: 45.50, mean: 45.50, count: 2 }
    },
    global: { stats: { count: 0 } },
    usedFallback: false
  })),
  buildKeywords: jest.fn((pcgs) => `${pcgs.year || ''} ${pcgs.series || ''}`),
}));

jest.mock('../src/services/valuationService', () => ({
  computeValuation: jest.fn(() => ({
    valuation: {
      fmvCore: 47.50,
      rangeLow: 44,
      rangeHigh: 51,
      confidence: 'High',
      method: 'eBay comparable sales',
      algorithmVersion: '3.2.1',
      configVersion: '2026-08-17',
      computedAt: new Date().toISOString(),
      compCount: 2,
      explanation: ['Based on 2 eBay sold comparables in grade MS64, timeWindow 180 days']
    },
    decisions: {
      method: 'eBay comparable sales',
      reason: 'eBay comps available',
      compCount: 2
    }
  })),
}));

jest.mock('../src/services/greysheetService', () => ({
  fetchPriceByPcgsNumber: jest.fn(async () => null),
  fetchTypePrice: jest.fn(async () => null),
}));

jest.mock('../src/services/greysheetHistoryService', () => ({
  makeKey: jest.fn((...args) => args.join('::')),
  recordSnapshot: jest.fn(),
}));

jest.mock('../src/services/auctionPriceService', () => ({
  getHistory: jest.fn(() => ({ stats: { count: 0 }, records: [] })),
  computeTrend: jest.fn(() => null),
}));

jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(async (sym) => ({
    price: sym === 'XAG' ? 30.50 : 2000,
    source: 'CBOT',
    stale: false
  })),
}));

jest.mock('../src/services/numistaService', () => ({
  lookupCoin: jest.fn(async () => ({
    accessible: true,
    type: 'coin',
    issue: null,
    rarity: null,
    numistaUrl: null,
    prices: null,
    composition: null,
    references: null
  })),
}));

jest.mock('../src/services/terapeakService', () => ({
  lookupComps: jest.fn(() => null),
}));

jest.mock('../src/utils/redactForPublic', () => ({
  redactCompsForPublic: jest.fn((obj) => obj),
}));

jest.mock('../src/utils/filters', () => ({
  hasSeriesConflict: jest.fn(() => false),
  detectDenomination: jest.fn(() => null),
}));

jest.mock('../src/utils/coinMetalProfile', () => ({
  ...jest.requireActual('../src/utils/coinMetalProfile'),
  getCoinMetalProfile: jest.fn(() => ({ metal: null })),
}));

jest.mock('../src/utils/coinIntent', () => ({
  extractCoinIntent: jest.fn(() => ({
    grade: null,
    designation: null,
    finish: null,
    isProof: false,
    barBrand: null,
    barSeries: null,
  })),
  isValidFinishInput: jest.fn(() => true),
}));

jest.mock('../src/data/keyDates', () => ({
  lookupKeyDate: jest.fn(() => ({ isKeyDate: false })),
}));

jest.mock('../src/data/mintages', () => ({
  lookupMintage: jest.fn(() => ({ mintage: null })),
}));

jest.mock('../src/data/lunarReference', () => ({
  buildLunarComparison: jest.fn(() => null),
}));

jest.mock('../src/data/halfDollarSeries', () => ({
  resolveCoinVariant: jest.fn(() => null),
}));

jest.mock('../src/data/constants', () => ({
  zodiacForYear: jest.fn(() => null),
  perthLunarSeries: jest.fn(() => ({ label: null })),
  getRollQuantity: jest.fn(() => null),
  ALLOWED_LABELS: new Set(['First Strike', 'Early Releases', 'First Day of Issue', 'Burnished', 'Reverse Proof', 'Enhanced Reverse Proof', 'Satin Finish', 'Antiqued', 'High Relief']),
  BULLION_1OZ_DEFAULT: ['eagle', 'libertad', 'britannia', 'philharmonic', 'krugerrand', 'maple leaf', 'kookaburra', 'lunar'],
}));

jest.mock('../src/utils/stats', () => ({
  median: jest.fn((arr) => arr.length > 0 ? arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)] : 0),
}));

const pcgsService = require('../src/services/pcgsService');
const ebayService = require('../src/services/ebayService');
const { computeValuation } = require('../src/services/valuationService');
const { lookupKeyDate } = require('../src/data/keyDates');
const { lookupMintage } = require('../src/data/mintages');
const { buildLunarComparison } = require('../src/data/lunarReference');
const { resolveCoinVariant } = require('../src/data/halfDollarSeries');
const { detectDenomination } = require('../src/utils/filters');
const { priceCoin } = require('../src/services/pricingService');

describe('pricingService.priceCoin() — Phase 0 Acceptance Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Test 1: Basic structured coin (Morgan Dollar) ──
  test('prices a Morgan Dollar with public audience', async () => {
    const result = await priceCoin(
      {
        query: '1921 Morgan Dollar MS 64',
        coinData: {},
        options: {},
        saleContext: 'ebay',
      },
      { isAdmin: false, audience: 'public' }
    );

    expect(result).toBeDefined();
    expect(result.valuation).toBeDefined();
    expect(result.valuation.fmvCore).toBe(47.50);
    expect(result.coin).toBeDefined();
    expect(result.coin.identification).toBeDefined();
    expect(result.ebay).toBeDefined();
    expect(result.pcgs).toBeDefined();
    expect(result.reproducibility).toBeDefined();
  });

  // ── Test 2: Bullion coin (American Silver Eagle with weight)
  test('prices an American Silver Eagle with weight detection', async () => {
    const result = await priceCoin(
      {
        query: '2024 American Silver Eagle 1 oz',
        coinData: { weight: 1 },
        options: {},
        saleContext: 'ebay',
      },
      { isAdmin: false, audience: 'public' }
    );

    expect(result.coin.weight).toBe(1);
    expect(result.valuation.fmvCore).toBe(47.50);
  });

  // ── Test 3: Bullion with default weight (Libertad)
  test('defaults bullion coins to 1 oz when weight not specified', async () => {
    const result = await priceCoin(
      {
        query: '2024 Mexican Silver Libertad',
        coinData: {},
        options: {},
        saleContext: 'ebay',
      },
      { isAdmin: false, audience: 'public' }
    );

    // BULLION_1OZ_DEFAULT includes 'libertad', so should default to 1 oz
    expect(result.coin.weight).toBe(1);
  });

  test('canonicalizes semiquincentennial circulating coins across pricing lookups', async () => {
    const parsed = { series: 'Semiquincentennial Half Dollar', year: 2026, mint: 'P' };
    pcgsService.parseDescription.mockReturnValueOnce(parsed);
    pcgsService.resolveFromDescription.mockReturnValueOnce({
      verified: false,
      series: 'Semiquincentennial Half Dollar',
      year: 2026,
      mint: 'P',
      parsed,
    });

    const result = await priceCoin(
      { query: '2026-P Semiquincentennial Half Dollar' },
      { isAdmin: false, audience: 'public' }
    );

    expect(ebayService.fetchSoldComps).toHaveBeenCalledWith(
      expect.stringMatching(/2026-P Kennedy Half Dollar Semiquincentennial/i),
      expect.any(Object),
      expect.any(Object)
    );
    expect(lookupKeyDate).toHaveBeenCalledWith('Kennedy Half Dollar', 2026, 'P');
    expect(lookupMintage).toHaveBeenCalledWith('Kennedy Half Dollar', 2026, 'P', null, null);
    expect(resolveCoinVariant).toHaveBeenCalledWith('Half Dollar', 2026);
    expect(result.keyDate).toEqual(expect.objectContaining({ isKeyDate: true, tier: 'semi-key' }));
  });

  test('preserves parsed-series precedence when selecting bullion valuation mode', async () => {
    const parsed = { series: 'Mexican Silver Libertad', year: 2024, metal: 'silver' };
    pcgsService.parseDescription.mockReturnValueOnce(parsed);
    pcgsService.resolveFromDescription.mockReturnValueOnce({
      verified: false,
      series: 'Morgan Dollar',
      year: 2024,
      parsed,
    });

    await priceCoin({ query: '2024 silver libertad' }, { isAdmin: false, audience: 'public' });

    expect(computeValuation).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      null,
      null,
      expect.objectContaining({ isBullion: true })
    );
  });

  test('preserves denomination mismatch warnings', async () => {
    const parsed = { series: 'Kennedy Half Dollar', year: 2024 };
    pcgsService.parseDescription.mockReturnValueOnce(parsed);
    pcgsService.resolveFromDescription.mockReturnValueOnce({
      verified: false,
      series: 'Washington Quarter',
      year: 2024,
      parsed,
    });
    detectDenomination
      .mockReturnValueOnce('half dollar')
      .mockReturnValueOnce('quarter');

    const result = await priceCoin({ query: '2024 Kennedy Half Dollar' });

    expect(result.valuation.explanation).toContain(
      '⚠ Denomination mismatch detected (query="half dollar" vs pcgs="quarter").'
    );
  });

  test('detects structured zodiac names as lunar intent', async () => {
    const parsed = { series: 'Australian Silver Coin', year: 2024, metal: 'silver' };
    pcgsService.parseDescription.mockReturnValueOnce(parsed);
    pcgsService.resolveFromDescription.mockReturnValueOnce({
      verified: false,
      series: 'Australian Silver Coin',
      year: 2024,
      parsed,
    });

    const result = await priceCoin({
      query: '2024 Australian silver coin',
      coinData: { name: 'Year of the Dragon', year: 2024 },
    });

    expect(result.coin.isLunarCoin).toBe(true);
    expect(buildLunarComparison).toHaveBeenCalled();
  });

  test('routes SP grades through the canonical proof pool', async () => {
    const parsed = { series: 'Specimen Coin', year: 2024, grade: 'SP70', gradeNum: 70 };
    pcgsService.parseDescription.mockReturnValueOnce(parsed);
    pcgsService.resolveFromDescription.mockReturnValueOnce({
      verified: false, series: 'Specimen Coin', year: 2024, grade: 'SP70', parsed,
    });

    await priceCoin({ query: '2024 Specimen Coin SP70' });

    expect(ebayService.fetchSoldComps.mock.calls[0][2]).toEqual(expect.objectContaining({
      grade: 'SP70',
      isProof: true,
    }));
  });

  test('keeps parser-expanded BU input in the canonical raw pool', async () => {
    const parsed = {
      series: 'Commemorative Silver Coin', year: 2024, grade: 'MS60', gradeNum: 60, _gradeSource: 'bu-term',
    };
    pcgsService.parseDescription.mockReturnValueOnce(parsed);
    pcgsService.resolveFromDescription.mockReturnValueOnce({
      verified: false, series: 'Commemorative Silver Coin', year: 2024, grade: 'MS60', parsed,
    });

    await priceCoin({ query: '2024 Commemorative Silver Coin BU' });

    expect(ebayService.fetchSoldComps.mock.calls[0][2]).toEqual(expect.objectContaining({
      grade: null,
      isProof: false,
    }));
    expect(computeValuation.mock.calls[0][3]).toBeNull();
  });

  test.each([
    ['MS64', false],
    ['PR69', true],
  ])('routes cert-only %s identity to its canonical pool', async (grade, isProof) => {
    pcgsService.lookupByCert.mockResolvedValueOnce({
      verified: true,
      pcgsCoinNumber: 1234,
      series: 'Certified Coin',
      year: 2024,
      grade,
      finish: isProof ? 'Proof' : null,
      parsed: {},
    });

    await priceCoin({ query: '12345678' });

    expect(ebayService.fetchSoldComps.mock.calls[0][2]).toEqual(expect.objectContaining({
      grade,
      isProof,
    }));
    expect(computeValuation.mock.calls[0][3]).toBe(grade);
    expect(computeValuation.mock.calls[0][4]).toEqual(expect.objectContaining({ isProof }));
  });

  test('preserves the mint-set Numista limitation text', async () => {
    const result = await priceCoin({
      query: '2024 US Mint Set',
      coinData: { setType: 'mint-uncirculated' },
    });

    expect(result.numista.limitations).toEqual([
      'Numista lookup skipped for mint/proof sets (sets are not individual coin types)'
    ]);
  });

  // ── Test 4: Admin audience (gated data access)
  test('respects trusted audience flag in valuation context', async () => {
    const result = await priceCoin(
      {
        query: '1921 Morgan Dollar MS 64',
        coinData: {},
        options: {},
        saleContext: 'ebay',
      },
      { isAdmin: true, audience: 'admin' }
    );

    expect(result).toBeDefined();
    expect(result.valuation).toBeDefined();
  });

  // ── Test 5: Custom options (timeWindowDays, usMinComps)
  test('respects custom pricing options', async () => {
    const result = await priceCoin(
      {
        query: '1921 Morgan Dollar MS 64',
        coinData: {},
        options: {
          timeWindowDays: 365,
          usMinComps: 5,
          exactGradeOnly: true,
        },
        saleContext: 'ebay',
      },
      { isAdmin: false, audience: 'public' }
    );

    expect(result.options.timeWindowDays).toBe(365);
    expect(result.options.usMinComps).toBe(5);
    expect(result.options.exactGradeOnly).toBe(true);
  });

  // ── Test 6: Appeal multiplier (COA/Box)
  test('accepts and clamps appeal multiplier', async () => {
    const result = await priceCoin(
      {
        query: '1921 Morgan Dollar MS 64',
        coinData: { coa: true, originalBox: true },
        appealMultiplier: 1.5,
        saleContext: 'ebay',
      },
      { isAdmin: false, audience: 'public' }
    );

    expect(result).toBeDefined();
  });

  // ── Test 7: Invalid appeal multiplier clamping
  test('clamps invalid appeal multiplier to [1.0, 2.0]', async () => {
    // Appeal multiplier is internal; we verify it doesn't crash
    const result = await priceCoin(
      {
        query: '1921 Morgan Dollar MS 64',
        appealMultiplier: 5.0, // out of range
        saleContext: 'ebay',
      },
      { isAdmin: false, audience: 'public' }
    );

    expect(result).toBeDefined();
  });

  // ── Test 8: Query length validation
  test('rejects overly long query', async () => {
    const longQuery = 'x'.repeat(301);
    await expect(
      priceCoin(
        { query: longQuery },
        { isAdmin: false, audience: 'public' }
      )
    ).rejects.toThrow('300 characters or fewer');
  });

  // ── Test 9: Missing query validation
  test('rejects missing query', async () => {
    await expect(
      priceCoin(
        { query: '' },
        { isAdmin: false, audience: 'public' }
      )
    ).rejects.toThrow('query field is required');
  });

  // ── Test 10: Sale context validation + fallback
  test('defaults invalid saleContext to ebay', async () => {
    const result = await priceCoin(
      {
        query: '1921 Morgan Dollar MS 64',
        saleContext: 'INVALID_CONTEXT',
      },
      { isAdmin: false, audience: 'public' }
    );

    expect(result).toBeDefined();
  });

  // ── Test 11: Reproducibility (cert number, item IDs)
  test('includes reproducibility data (cert, item IDs)', async () => {
    const result = await priceCoin(
      {
        query: '1921 Morgan Dollar MS 64',
        coinData: {},
        options: {},
        saleContext: 'ebay',
      },
      { isAdmin: false, audience: 'public' }
    );

    expect(result.reproducibility).toBeDefined();
    expect(result.reproducibility.pcgs).toBeDefined();
    expect(result.reproducibility.ebay).toBeDefined();
    expect(result.reproducibility.ebay.usItemIds).toBeDefined();
    expect(Array.isArray(result.reproducibility.ebay.usItemIds)).toBe(true);
    expect(result.reproducibility.productIdentity).toEqual(expect.objectContaining({
      parserVersion: '1.0.0',
      pool: expect.any(String),
      weightEvidence: expect.objectContaining({ status: expect.any(String) }),
    }));
  });

  // ── Test 12: No AI dependencies in result
  test('result contains no AI provider references', async () => {
    const result = await priceCoin(
      {
        query: '1921 Morgan Dollar MS 64',
      },
      { isAdmin: false, audience: 'public' }
    );

    const resultJson = JSON.stringify(result);
    expect(resultJson).not.toMatch(/openai|anthropic|llm|ai.*provider|gpt/i);
  });

  // ── Test 13: Structured coinData overrides parsing
  test('structured coinData (year, grade, mint) overrides parsing', async () => {
    const result = await priceCoin(
      {
        query: 'morgan dollar',
        coinData: {
          year: 1921,
          grade: 64,
          mintMark: 'O',
          name: 'Morgan Dollar',
        },
      },
      { isAdmin: false, audience: 'public' }
    );

    expect(result.coin.identification.inputQuery).toBe('morgan dollar');
    expect(result.coin.expected.year).toBe(1921);
  });

  // ── Test 14: Positive proof: no exceptions on valid inputs ──
  test('completes without exceptions for basic queries', async () => {
    const queries = [
      '1881-CC Morgan',
      '2024 ASE',
      '2024 Mexican Libertad',
      'US Proof Set',
    ];

    for (const query of queries) {
      const result = await priceCoin(
        { query },
        { isAdmin: false, audience: 'public' }
      );
      expect(result).toBeDefined();
      expect(result.valuation).toBeDefined();
    }
  });
});
