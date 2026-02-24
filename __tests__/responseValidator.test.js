/**
 * responseValidator.test.js — Tests for src/utils/responseValidator.js
 *
 * Validates the response validation utility itself, plus provides
 * combinatorial testing across coin families × years × grades.
 */

'use strict';

const {
  validateSchema,
  validateNumericSanity,
  validateSeriesIntegrity,
  validateFMVReasonability,
  validateResponse,
} = require('../src/utils/responseValidator');

// ── Helper: build a valid response skeleton ──────────────────
function validResponse(overrides = {}) {
  return {
    query: { input: '1964 Kennedy Half Dollar', askingPrice: null },
    identification: {
      inputQuery: '1964 Kennedy Half Dollar',
      resolvedVia: 'pcgs-search',
      parsed: { series: 'Kennedy Half Dollar', year: 1964 },
    },
    pcgs: {
      verified: false,
      series: 'Kennedy Half Dollar',
      year: 1964,
      ...overrides.pcgs,
    },
    ebay: {
      us: {
        comps: overrides.comps || [
          { totalUsd: 10, title: '1964 Kennedy Half Dollar BU' },
          { totalUsd: 12, title: '1964 Kennedy Half Dollar Silver' },
          { totalUsd: 11, title: '1964 Kennedy Half Dollar UNC' },
        ],
        stats: { count: 3 },
      },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    },
    valuation: {
      fmvCore: 11.00,
      rangeLow: 10.00,
      rangeHigh: 12.00,
      confidence: 55,
      explanation: ['Raw coin blend.'],
      dataSource: { soldCount: 3, activeCount: 0, totalComps: 3, soldRatio: 1, browseOnly: false, label: 'sold-data' },
      gradePool: { wantsGraded: false, usedPool: 'raw', gradedCount: 0, rawCount: 3, poolCount: 3, totalCount: 3 },
    },
    decisions: {
      buy: { max70: 7.70, max75: 8.25, max80: 8.80, askingPrice: null, recommendation: null, notes: [] },
      sell: { fast: 10.12, normal: 11.00, premium: 11.55, offerFloor: 10.00, notes: [] },
    },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
//  validateSchema
// ═══════════════════════════════════════════════════════════════

describe('validateSchema()', () => {
  test('valid response passes', () => {
    const { valid, errors } = validateSchema(validResponse());
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test('null response fails', () => {
    const { valid, errors } = validateSchema(null);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('missing top-level keys detected', () => {
    const { errors } = validateSchema({ query: {} });
    expect(errors.some(e => e.includes('identification'))).toBe(true);
    expect(errors.some(e => e.includes('valuation'))).toBe(true);
    expect(errors.some(e => e.includes('decisions'))).toBe(true);
  });

  test('missing valuation sub-keys detected', () => {
    const resp = validResponse();
    delete resp.valuation.fmvCore;
    delete resp.valuation.confidence;
    const { errors } = validateSchema(resp);
    expect(errors.some(e => e.includes('fmvCore'))).toBe(true);
    expect(errors.some(e => e.includes('confidence'))).toBe(true);
  });

  test('missing decisions sub-keys detected', () => {
    const resp = validResponse();
    delete resp.decisions.buy;
    const { errors } = validateSchema(resp);
    expect(errors.some(e => e.includes('decisions.buy'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  validateNumericSanity
// ═══════════════════════════════════════════════════════════════

describe('validateNumericSanity()', () => {
  test('valid numbers pass', () => {
    const { valid } = validateNumericSanity(validResponse());
    expect(valid).toBe(true);
  });

  test('negative fmvCore detected', () => {
    const resp = validResponse();
    resp.valuation.fmvCore = -5;
    const { valid, errors } = validateNumericSanity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('negative'))).toBe(true);
  });

  test('NaN fmvCore detected', () => {
    const resp = validResponse();
    resp.valuation.fmvCore = NaN;
    const { valid, errors } = validateNumericSanity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('not a valid number'))).toBe(true);
  });

  test('rangeLow > fmvCore detected', () => {
    const resp = validResponse();
    resp.valuation.rangeLow = 15;
    resp.valuation.fmvCore = 10;
    const { valid, errors } = validateNumericSanity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('rangeLow'))).toBe(true);
  });

  test('rangeHigh < fmvCore detected', () => {
    const resp = validResponse();
    resp.valuation.rangeHigh = 5;
    resp.valuation.fmvCore = 10;
    const { valid, errors } = validateNumericSanity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('rangeHigh'))).toBe(true);
  });

  test('confidence > 100 detected', () => {
    const resp = validResponse();
    resp.valuation.confidence = 150;
    const { valid, errors } = validateNumericSanity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('out of range'))).toBe(true);
  });

  test('buy max ordering validated', () => {
    const resp = validResponse();
    resp.decisions.buy.max70 = 10;
    resp.decisions.buy.max75 = 5;  // wrong!
    const { valid, errors } = validateNumericSanity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('max70'))).toBe(true);
  });

  test('sell ordering validated', () => {
    const resp = validResponse();
    resp.decisions.sell.fast = 20;
    resp.decisions.sell.normal = 10;  // wrong!
    const { valid, errors } = validateNumericSanity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('sell.fast'))).toBe(true);
  });

  test('null values pass (no data scenario)', () => {
    const resp = validResponse();
    resp.valuation.fmvCore = null;
    resp.valuation.rangeLow = null;
    resp.valuation.rangeHigh = null;
    const { valid } = validateNumericSanity(resp);
    expect(valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  validateSeriesIntegrity
// ═══════════════════════════════════════════════════════════════

describe('validateSeriesIntegrity()', () => {
  test('matching series passes', () => {
    const { valid } = validateSeriesIntegrity(validResponse());
    expect(valid).toBe(true);
  });

  test('series conflict detected: Jefferson query → Buffalo PCGS', () => {
    const resp = validResponse();
    resp.query.input = '1950 D Jefferson Nickel MS-64';
    resp.identification.inputQuery = '1950 D Jefferson Nickel MS-64';
    resp.pcgs.series = 'Buffalo Five Cents';
    const { valid, errors } = validateSeriesIntegrity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('Series conflict'))).toBe(true);
  });

  test('denomination mismatch detected: quarter query → dollar PCGS', () => {
    const resp = validResponse();
    resp.query.input = '1964 D Washington Quarter';
    resp.identification.inputQuery = '1964 D Washington Quarter';
    resp.pcgs.series = 'Morgan Dollar';
    const { valid, errors } = validateSeriesIntegrity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('Denomination mismatch'))).toBe(true);
  });

  test('comp series conflicts detected', () => {
    const resp = validResponse();
    resp.pcgs.series = 'Jefferson Nickel';
    resp.ebay.us.comps = [
      { totalUsd: 35, title: '1950-D Jefferson Nickel BU' },
      { totalUsd: 50, title: '1937 Buffalo Nickel VF' }, // conflict!
    ];
    const { valid, errors } = validateSeriesIntegrity(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('eBay comps have series conflicts'))).toBe(true);
  });

  test('same-series comps pass', () => {
    const resp = validResponse();
    resp.pcgs.series = 'Kennedy Half Dollar';
    resp.ebay.us.comps = [
      { totalUsd: 10, title: '1964 Kennedy Half Dollar BU' },
      { totalUsd: 12, title: '1964-D Kennedy Half Dollar Silver' },
    ];
    const { valid } = validateSeriesIntegrity(resp);
    expect(valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  validateFMVReasonability
// ═══════════════════════════════════════════════════════════════

describe('validateFMVReasonability()', () => {
  test('FMV within comp range passes', () => {
    const { valid } = validateFMVReasonability(validResponse());
    expect(valid).toBe(true);
  });

  test('FMV > 3× max comp detected', () => {
    const resp = validResponse();
    resp.valuation.fmvCore = 500; // way above $10-12 comps
    const { valid, errors } = validateFMVReasonability(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('>3×'))).toBe(true);
  });

  test('FMV < 1/3 min comp detected', () => {
    const resp = validResponse();
    resp.valuation.fmvCore = 1; // way below $10-12 comps
    const { valid, errors } = validateFMVReasonability(resp);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('<1/3'))).toBe(true);
  });

  test('null FMV passes (no data)', () => {
    const resp = validResponse();
    resp.valuation.fmvCore = null;
    const { valid } = validateFMVReasonability(resp);
    expect(valid).toBe(true);
  });

  test('too few comps skips check', () => {
    const resp = validResponse();
    resp.ebay.us.comps = [{ totalUsd: 10, title: 'Test' }];
    resp.valuation.fmvCore = 500;
    const { valid } = validateFMVReasonability(resp);
    expect(valid).toBe(true); // skipped — not enough data
  });
});

// ═══════════════════════════════════════════════════════════════
//  validateResponse — combined
// ═══════════════════════════════════════════════════════════════

describe('validateResponse()', () => {
  test('fully valid response', () => {
    const { valid, errors } = validateResponse(validResponse());
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test('multiple violations detected', () => {
    const resp = validResponse();
    resp.valuation.fmvCore = -5;
    resp.valuation.confidence = 150;
    delete resp.decisions.sell;
    const { valid, errors } = validateResponse(resp);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  test('error categories are labeled', () => {
    const resp = validResponse();
    resp.valuation.fmvCore = -5;
    const { errors } = validateResponse(resp);
    expect(errors.some(e => e.startsWith('[numeric]'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Combinatorial matrix: families × years
//  Tests that synthetic responses for each coin family pass validation
// ═══════════════════════════════════════════════════════════════

describe('combinatorial response validation', () => {
  const COIN_MATRIX = [
    // Nickels
    { series: 'Jefferson Nickel', years: [1938, 1950, 1964, 2005, 2024], denom: 'nickel' },
    { series: 'Buffalo Nickel', years: [1913, 1920, 1937], denom: 'nickel' },
    // Half Dollars
    { series: 'Kennedy Half Dollar', years: [1964, 1971, 1980, 2024], denom: 'half dollar' },
    { series: 'Franklin Half Dollar', years: [1948, 1955, 1963], denom: 'half dollar' },
    { series: 'Walking Liberty Half Dollar', years: [1916, 1935, 1947], denom: 'half dollar' },
    // Quarters
    { series: 'Washington Quarter', years: [1932, 1964, 1999, 2024], denom: 'quarter' },
    { series: 'Standing Liberty Quarter', years: [1916, 1924, 1930], denom: 'quarter' },
    // Dimes
    { series: 'Roosevelt Dime', years: [1946, 1964, 2020], denom: 'dime' },
    { series: 'Mercury Dime', years: [1916, 1935, 1945], denom: 'dime' },
    // Dollars
    { series: 'Morgan Dollar', years: [1878, 1893, 1921], denom: 'dollar' },
    { series: 'Peace Dollar', years: [1921, 1925, 1935], denom: 'dollar' },
    // Cents
    { series: 'Lincoln Penny', years: [1909, 1943, 1959, 2024], denom: 'cent' },
  ];

  const GRADES = [null, 'MS-64', 'VF-20'];
  const MINTS = [null, 'D', 'S'];

  for (const { series, years, denom } of COIN_MATRIX) {
    describe(series, () => {
      for (const year of years) {
        for (const grade of GRADES) {
          for (const mint of MINTS) {
            const label = `${year}${mint ? '-' + mint : ''} ${grade || 'raw'}`;
            test(label, () => {
              const query = `${year}${mint ? ' ' + mint : ''} ${series}${grade ? ' ' + grade : ''}`;
              const resp = validResponse({
                query: { input: query },
                identification: {
                  inputQuery: query,
                  resolved: 'test',
                  parsed: { series, year, mint, grade },
                },
                pcgs: { series, year, mint, grade, verified: !!grade },
                comps: [
                  { totalUsd: 10, title: `${year}${mint ? '-' + mint : ''} ${series} BU` },
                  { totalUsd: 12, title: `${year} ${series} Silver` },
                  { totalUsd: 11, title: `${year} ${series} UNC` },
                ],
              });

              const result = validateResponse(resp);
              if (!result.valid) {
                // Log the specific errors for debugging
                console.log(`FAIL: ${query}`, result.errors);
              }
              expect(result.valid).toBe(true);
            });
          }
        }
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════
//  Cross-series contamination matrix
//  For every pair of same-denomination series, verify contaminated
//  responses are caught by the validator
// ═══════════════════════════════════════════════════════════════

describe('cross-series contamination detection', () => {
  const CONTAMINATION_PAIRS = [
    { query: 'Jefferson Nickel', contaminated: 'Buffalo Nickel' },
    { query: 'Buffalo Nickel', contaminated: 'Jefferson Nickel' },
    { query: 'Kennedy Half Dollar', contaminated: 'Franklin Half Dollar' },
    { query: 'Franklin Half Dollar', contaminated: 'Kennedy Half Dollar' },
    { query: 'Kennedy Half Dollar', contaminated: 'Walking Liberty Half Dollar' },
    { query: 'Washington Quarter', contaminated: 'Standing Liberty Quarter' },
    { query: 'Roosevelt Dime', contaminated: 'Mercury Dime' },
    { query: 'Mercury Dime', contaminated: 'Barber Dime' },
    { query: 'Morgan Dollar', contaminated: 'Peace Dollar' },
    { query: 'Peace Dollar', contaminated: 'Morgan Dollar' },
    { query: 'Lincoln Penny', contaminated: 'Indian Head Cent' },
  ];

  test.each(CONTAMINATION_PAIRS)(
    'detects: $query query with $contaminated PCGS series',
    ({ query, contaminated }) => {
      const resp = validResponse({
        query: { input: `1950 ${query}` },
        identification: { inputQuery: `1950 ${query}`, parsed: { series: query } },
        pcgs: { series: contaminated },
      });

      const result = validateSeriesIntegrity(resp);
      expect(result.valid).toBe(false);
    }
  );

  test.each(CONTAMINATION_PAIRS)(
    'detects: $query comps mixed with $contaminated',
    ({ query, contaminated }) => {
      const resp = validResponse({
        pcgs: { series: query },
      });
      resp.ebay.us.comps = [
        { totalUsd: 10, title: `1950 ${query} BU` },
        { totalUsd: 15, title: `1940 ${contaminated} VF` },
      ];

      const result = validateSeriesIntegrity(resp);
      expect(result.valid).toBe(false);
    }
  );
});
