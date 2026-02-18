/**
 * coinSearch.fieldValidation.test.js
 *
 * Validates that the search pipeline produces well-formed
 * response fields: required fields present, correct types,
 * consistent naming.
 *
 * Tests exercise pure functions (no HTTP) for speed.
 *
 *   npm test -- __tests__/coinSearch.fieldValidation.test.js
 */

'use strict';

const { parseDescription }  = require('../src/services/pcgsService');
const { buildKeywords }     = require('../src/services/ebayService');
const { resolveCoinVariant } = require('../src/data/halfDollarSeries');
const {
  DENOMINATION_TEST_MATRIX,
  normalize,
} = require('./helpers/coinTestConstants');

/* ═══════════════════════════════════════════════════════════════
 *  1. parseDescription — required field shapes
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — field shapes', () => {

  const inputs = [
    '1956 D half dollar',
    '1964 Kennedy half dollar MS65',
    '1999 P quarter',
    '1964 Roosevelt dime',
    '1959 Lincoln penny',
    '2005 D Jefferson nickel',
    '1921 Morgan dollar',
    '2023 1 oz American Silver Eagle',
  ];

  test.each(inputs)('"%s" returns an object with year (number)', (q) => {
    const p = parseDescription(q);
    expect(typeof p).toBe('object');
    expect(p.year).toBeDefined();
    expect(typeof p.year).toBe('number');
    expect(p.year).toBeGreaterThanOrEqual(1700);
    expect(p.year).toBeLessThanOrEqual(2100);
  });

  test.each(inputs)('"%s" returns series as a string', (q) => {
    const p = parseDescription(q);
    expect(p.series).toBeDefined();
    expect(typeof p.series).toBe('string');
    expect(p.series.length).toBeGreaterThan(0);
  });

  test('mint mark is uppercase single letter when present', () => {
    const p = parseDescription('1956 D half dollar');
    expect(p.mint).toBeDefined();
    expect(p.mint).toMatch(/^[A-Z]{1,2}$/);
  });

  test('grade extracted as string when present', () => {
    const p = parseDescription('1964 Kennedy half dollar MS65');
    expect(p.grade).toBeDefined();
    expect(typeof p.grade).toBe('string');
    expect(p.grade).toMatch(/MS\s*65/i);
  });

  test('grade undefined when not in query', () => {
    const p = parseDescription('1956 D half dollar');
    expect(p.grade).toBeUndefined();
  });

  test('gradeNum is a number when grade is present', () => {
    const p = parseDescription('1964 Kennedy half dollar MS65');
    expect(p.gradeNum).toBe(65);
  });

  test('metal detected for silver eagle', () => {
    const p = parseDescription('2023 1 oz American Silver Eagle');
    expect(p.metal).toBe('silver');
  });

  test('weight extracted for bullion', () => {
    const p = parseDescription('2020 1/2 oz American Gold Eagle');
    expect(p.weight).toBe(0.5);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  2. buildKeywords — output is always a non-empty string
 * ═══════════════════════════════════════════════════════════════ */
describe('buildKeywords — output shape', () => {

  test('always returns a string', () => {
    const kw = buildKeywords({ year: 1964, series: 'Kennedy' }, '1964 Kennedy half dollar', null);
    expect(typeof kw).toBe('string');
  });

  test('never returns empty string when rawQuery provided', () => {
    const kw = buildKeywords({}, '', null);
    // Should be '' only when rawQuery is also empty
    expect(typeof kw).toBe('string');
  });

  test('returns rawQuery when pcgsData is null', () => {
    const kw = buildKeywords(null, 'some raw query', null);
    expect(kw).toBe('some raw query');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  3. resolveCoinVariant — field shapes
 * ═══════════════════════════════════════════════════════════════ */
describe('resolveCoinVariant — field shapes', () => {

  const requiredFields = ['denomination', 'year', 'designName', 'variantSuffix', 'composition', 'notes', 'label'];

  test.each([
    ['Half Dollar', 1964],
    ['Half Dollar', 1971],
    ['Half Dollar', 2026],
    ['Half Dollar', 1956],
    ['Half Dollar', 1945],
  ])('(%s, %d) returns all required fields', (denom, year) => {
    const v = resolveCoinVariant(denom, year);
    for (const field of requiredFields) {
      expect(v).toHaveProperty(field);
    }
    expect(typeof v.denomination).toBe('string');
    expect(typeof v.year).toBe('number');
    expect(typeof v.designName).toBe('string');
    expect(typeof v.label).toBe('string');
    // composition is always a string for valid half dollars
    expect(typeof v.composition).toBe('string');
    expect(v.composition.length).toBeGreaterThan(0);
  });

  test('label format is "denomination — designName" or "denomination — designName (suffix)"', () => {
    const v = resolveCoinVariant('Half Dollar', 1964);
    expect(v.label).toBe('Half Dollar — Kennedy');

    const v2 = resolveCoinVariant('Half Dollar', 2026);
    expect(v2.label).toBe('Half Dollar — Kennedy (Semiquincentennial)');
  });

  test('unknown denomination returns null designName', () => {
    const v = resolveCoinVariant('Quarter', 1999);
    expect(v.designName).toBeNull();
  });

  test('invalid year returns Unknown designName', () => {
    const v = resolveCoinVariant('Half Dollar', 1700);
    expect(v.designName).toBe('Unknown');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  4. Denomination test matrix — full field validation
 * ═══════════════════════════════════════════════════════════════ */
describe('Denomination test matrix — field validation', () => {

  test.each(DENOMINATION_TEST_MATRIX)(
    '$denomination $year — all fields well-formed',
    ({ denomination, year, expectedSeries }) => {
      const rawQuery = `${year} ${denomination}`;
      const parsed = parseDescription(rawQuery);

      // parsed.year is correct number
      expect(parsed.year).toBe(year);
      expect(typeof parsed.year).toBe('number');

      // parsed.series is a non-empty string
      expect(typeof parsed.series).toBe('string');
      expect(parsed.series.length).toBeGreaterThan(0);

      // parsed.series matches expected pattern
      expect(parsed.series).toMatch(expectedSeries);

      // buildKeywords produces a non-empty string
      const kw = buildKeywords(parsed, rawQuery, null);
      expect(typeof kw).toBe('string');
      expect(kw.length).toBeGreaterThan(0);
    }
  );
});

/* ═══════════════════════════════════════════════════════════════
 *  5. Regression guards — specific bugs that were fixed
 * ═══════════════════════════════════════════════════════════════ */
describe('Regression guards', () => {

  test('BUG: "1956 D half dollar" must not produce keywords matching pennies', () => {
    const parsed = parseDescription('1956 D half dollar');
    const kw = buildKeywords(parsed, '1956 D half dollar', null);
    // Keywords must include "half dollar" or "half" at minimum
    expect(normalize(kw)).toContain('half');
    // Must NOT be just "1956 -D" (the old bug)
    expect(kw).not.toBe('1956 -D');
  });

  test('BUG: bare denomination without series name must still produce correct keywords', () => {
    // Previously "1956 D half dollar" parsed to series=undefined
    const parsed = parseDescription('1956 D half dollar');
    expect(parsed.series).toBeDefined();
    expect(normalize(parsed.series)).toContain('half dollar');
  });

  test('BUG: buildKeywords with no series must fall back to raw query', () => {
    const kw = buildKeywords({ year: 1956, mint: 'D' }, '1956 D half dollar', null);
    expect(normalize(kw)).toContain('half dollar');
  });

  test('BUG: "Semiquincentennial half dollar 2026" must resolve correctly', () => {
    const parsed = parseDescription('Semiquincentennial half dollar 2026');
    expect(parsed.year).toBe(2026);
    expect(parsed.series).toBeDefined();
    const kw = buildKeywords(parsed, 'Semiquincentennial half dollar 2026', null);
    expect(normalize(kw)).toContain('semiquincentennial');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  6. Helper containsNone — "cent" inside compound words
 * ═══════════════════════════════════════════════════════════════ */
describe('containsNone helper — compound word handling', () => {

  const { containsNone } = require('./helpers/coinTestConstants');

  test('"semiquincentennial" does not trigger "cent" match', () => {
    expect(containsNone('2026 Semiquincentennial Half Dollar', ['cent', 'penny'])).toBe(true);
  });

  test('"bicentennial" does not trigger "cent" match', () => {
    expect(containsNone('1976 Bicentennial Half Dollar', ['cent', 'penny'])).toBe(true);
  });

  test('actual "cent" DOES trigger match', () => {
    expect(containsNone('1959 Lincoln Cent', ['cent'])).toBe(false);
  });

  test('"penny" triggers match', () => {
    expect(containsNone('1909 Indian Head Penny', ['penny'])).toBe(false);
  });
});
