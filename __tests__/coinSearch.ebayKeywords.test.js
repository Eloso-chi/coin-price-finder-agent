/**
 * coinSearch.ebayKeywords.test.js
 *
 * Focused tests on eBay keyword generation and quality.
 * Verifies that buildKeywords produces search terms that will
 * find the correct coin — not a different denomination or type.
 *
 *   npm test -- __tests__/coinSearch.ebayKeywords.test.js
 */

'use strict';

const { parseDescription }  = require('../src/services/pcgsService');
const { buildKeywords }     = require('../src/services/ebayService');
const {
  normalize,
  containsAny,
  containsNone,
  tokensFor,
} = require('./helpers/coinTestConstants');

/* ═══════════════════════════════════════════════════════════════
 *  1. buildKeywords from parsed data with a known series
 * ═══════════════════════════════════════════════════════════════ */
describe('buildKeywords — with resolved series', () => {

  test.each([
    [{ year: 1956, mint: 'D', series: 'Franklin' },           '1956 D Franklin half dollar', 'franklin'],
    [{ year: 1964, series: 'Kennedy' },                        '1964 Kennedy half dollar',    'kennedy'],
    [{ year: 1999, mint: 'P', series: 'Washington' },          '1999 P Washington quarter',   'washington'],
    [{ year: 1964, series: 'Roosevelt' },                      '1964 Roosevelt dime',         'roosevelt'],
    [{ year: 1959, series: 'Lincoln' },                        '1959 Lincoln penny',          'lincoln'],
    [{ year: 2005, series: 'Jefferson' },                      '2005 Jefferson nickel',       'jefferson'],
    [{ year: 1921, series: 'Morgan' },                         '1921 Morgan dollar',          'morgan'],
    [{ year: 1964, mint: 'D', series: 'Kennedy', grade: 'MS65' }, '1964-D Kennedy half MS65', 'kennedy'],
  ])('pcgs=%j → keywords include "%s"', (pcgsData, rawQuery, mustContain) => {
    const kw = buildKeywords(pcgsData, rawQuery, null);
    expect(normalize(kw)).toContain(normalize(mustContain));
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  2. buildKeywords — fallback when series is missing
 * ═══════════════════════════════════════════════════════════════ */
describe('buildKeywords — missing series fallback', () => {

  test('year + mint only → falls back to raw query', () => {
    const kw = buildKeywords({ year: 1956, mint: 'D' }, '1956 D half dollar', null);
    expect(kw).toBe('1956 D half dollar');
  });

  test('null pcgsData → returns raw query', () => {
    const kw = buildKeywords(null, '1964 Kennedy half dollar', null);
    expect(kw).toBe('1964 Kennedy half dollar');
  });

  test('empty pcgsData → returns raw query', () => {
    const kw = buildKeywords({}, '2020 Washington quarter', null);
    expect(kw).toBe('2020 Washington quarter');
  });

  test('year only (no mint, no series) → raw query', () => {
    const kw = buildKeywords({ year: 1921 }, '1921 Morgan dollar', null);
    expect(kw).toBe('1921 Morgan dollar');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  3. buildKeywords — weight injection for bullion
 * ═══════════════════════════════════════════════════════════════ */
describe('buildKeywords — weight injection', () => {

  test('1/2 oz weight appended', () => {
    const kw = buildKeywords(
      { year: 2020, series: 'American Gold Eagle' },
      '2020 1/2 oz Gold Eagle',
      0.5
    );
    expect(kw).toContain('1/2 oz');
    expect(normalize(kw)).toContain('american gold eagle');
  });

  test('1/4 oz weight appended', () => {
    const kw = buildKeywords(
      { year: 2020, series: 'American Gold Eagle' },
      '2020 1/4 oz Gold Eagle',
      0.25
    );
    expect(kw).toContain('1/4 oz');
  });

  test('1 oz weight NOT appended (standard)', () => {
    const kw = buildKeywords(
      { year: 2023, series: 'American Silver Eagle' },
      '2023 Silver Eagle',
      1
    );
    expect(kw).not.toContain(' oz');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  4. End-to-end: parse → buildKeywords for each denomination
 *     Verify positive and negative token assertions
 * ═══════════════════════════════════════════════════════════════ */
describe('parse → buildKeywords token assertions', () => {

  const cases = [
    { denom: 'Half Dollar', queries: ['1956 D half dollar', '1964 half dollar', '2026 half dollar'] },
    { denom: 'Quarter',     queries: ['1999 P quarter', '2020 S quarter'] },
    { denom: 'Dime',        queries: ['1964 dime', '2010 D dime'] },
    { denom: 'Penny',       queries: ['1959 penny', '2019 penny'] },
    { denom: 'Nickel',      queries: ['2005 nickel', '1938 nickel'] },
  ];

  for (const { denom, queries } of cases) {
    describe(denom, () => {
      const tokens = tokensFor(denom);

      test.each(queries)('"%s" → has positive tokens, no negative tokens', (q) => {
        const parsed = parseDescription(q);
        const kw = buildKeywords(parsed, q, null);

        expect(containsAny(kw, tokens.positive)).toBe(true);
        expect(containsNone(kw, tokens.negative)).toBe(true);
      });
    });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  5. Grade and designation pass-through
 * ═══════════════════════════════════════════════════════════════ */
describe('buildKeywords — grade & designation', () => {

  test('grade is included when present', () => {
    const kw = buildKeywords(
      { year: 1964, series: 'Kennedy', grade: 'MS65' },
      '1964 Kennedy half dollar MS65',
      null
    );
    expect(kw).toContain('MS65');
  });

  test('designation is included when present', () => {
    const kw = buildKeywords(
      { year: 1964, series: 'Kennedy', grade: 'PR69', designation: 'DCAM' },
      '1964 Kennedy half dollar PR69 DCAM',
      null
    );
    expect(kw).toContain('DCAM');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  6. Semiquincentennial keyword handling
 * ═══════════════════════════════════════════════════════════════ */
describe('Semiquincentennial keyword handling', () => {

  test('parseDescription recognises "semiquincentennial half dollar"', () => {
    const parsed = parseDescription('2026 Semiquincentennial half dollar');
    expect(parsed.year).toBe(2026);
    expect(parsed.series).toBeDefined();
    expect(normalize(parsed.series)).toContain('semiquincentennial');
  });

  test('parseDescription recognises "semiquincentennial quarter"', () => {
    const parsed = parseDescription('2026 Semiquincentennial quarter');
    expect(parsed.year).toBe(2026);
    expect(parsed.series).toBeDefined();
    expect(normalize(parsed.series)).toContain('semiquincentennial');
  });

  test('"cent" inside "semiquincentennial" does not trigger penny negative', () => {
    const kw = '2026 Semiquincentennial Half Dollar';
    const tokens = tokensFor('Half Dollar');
    // The word "semiquincentennial" contains "cent" — our helper should handle it
    expect(containsNone(kw, tokens.negative)).toBe(true);
  });
});
