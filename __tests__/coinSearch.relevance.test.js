/**
 * coinSearch.relevance.test.js
 *
 * Unit tests verifying that the coin search pipeline resolves
 * denominations correctly and produces eBay keywords that target
 * the requested coin type — NOT a different denomination.
 *
 * These tests exercise the exported pure functions directly
 * (no HTTP, no network) so they run fast and deterministically.
 *
 *   npm test -- __tests__/coinSearch.relevance.test.js
 */

'use strict';

const { parseDescription }  = require('../src/services/pcgsService');
const { buildKeywords, scoreMatch } = require('../src/services/ebayService');
const { resolveCoinVariant } = require('../src/data/halfDollarSeries');
const {
  DENOMINATION_TEST_MATRIX,
  NAMED_SERIES_TEST_MATRIX,
  normalize,
  containsAny,
  containsNone,
  tokensFor,
} = require('./helpers/coinTestConstants');

/* ═══════════════════════════════════════════════════════════════
 *  1. parseDescription — denomination extraction
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — denomination extraction', () => {

  test.each([
    ['1964 half dollar',       'Half Dollar'],
    ['1956 D half dollar',     'Half Dollar'],
    ['2026 half dollar',       'Half Dollar'],
    ['1999 quarter',           'Quarter'],
    ['2020 S quarter',         'Quarter'],
    ['1964 dime',              'Dime'],
    ['2010 D dime',            'Dime'],
    ['1959 penny',             'Penny'],
    ['2019 cent',              'Cent'],
    ['2005 nickel',            'Nickel'],
    ['1921 dollar',            'Dollar'],
  ])('"%s" → series includes "%s"', (input, expectedSeriesToken) => {
    const parsed = parseDescription(input);
    expect(parsed.series).toBeDefined();
    expect(normalize(parsed.series)).toContain(normalize(expectedSeriesToken));
  });

  test.each([
    ['1964 Kennedy half dollar',     'Kennedy'],
    ['1921 Morgan',                  'Morgan'],
    ['1942 Walking Liberty half',    'Walking Liberty Half'],
    ['1958 Franklin half',           'Franklin'],
    ['2020 Washington quarter',      'Washington'],
    ['1944 Mercury dime',            'Mercury'],
    ['1964 Roosevelt dime',          'Roosevelt'],
    ['1909 Indian Head cent',        'Indian Head Cent'],
    ['1937 Buffalo nickel',          'Buffalo Nickel'],
    ['2005 Jefferson nickel',        'Jefferson'],
  ])('"%s" → series contains "%s"', (input, expectedToken) => {
    const parsed = parseDescription(input);
    expect(parsed.series).toBeDefined();
    expect(normalize(parsed.series)).toContain(normalize(expectedToken));
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  2. parseDescription — year + mint extraction
 * ═══════════════════════════════════════════════════════════════ */
describe('parseDescription — year & mint extraction', () => {

  test.each([
    ['1956 D half dollar',  1956, 'D'],
    ['2026 S quarter',      2026, 'S'],
    ['1964-D dime',         1964, 'D'],
    ['1999 P quarter',      1999, 'P'],
    ['2019 W cent',         2019, 'W'],
    ['1921 dollar',         1921, null],
  ])('"%s" → year=%d, mint=%s', (input, expectedYear, expectedMint) => {
    const parsed = parseDescription(input);
    expect(parsed.year).toBe(expectedYear);
    if (expectedMint) {
      expect(parsed.mint).toBe(expectedMint);
    } else {
      expect(parsed.mint).toBeUndefined();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  3. buildKeywords — denomination preserved in eBay keywords
 * ═══════════════════════════════════════════════════════════════ */
describe('buildKeywords — denomination preserved', () => {

  describe.each([
    ['Half Dollar', '1956 D half dollar',  ['half', 'dollar']],
    ['Half Dollar', '1964 half dollar',    ['half', 'dollar']],
    ['Half Dollar', '2026 half dollar',    ['half', 'dollar']],
    ['Quarter',     '1999 P quarter',      ['quarter']],
    ['Quarter',     '2020 quarter',        ['quarter']],
    ['Dime',        '1964 dime',           ['dime']],
    ['Dime',        '2010 D dime',         ['dime']],
    ['Penny',       '1959 penny',          ['penny']],
    ['Cent',        '2019 cent',           ['cent']],
    ['Nickel',      '2005 nickel',         ['nickel']],
    ['Dollar',      '1921 dollar',         ['dollar']],
  ])('%s: "%s"', (denom, rawQuery, requiredTokens) => {
    let keywords;

    beforeAll(() => {
      const parsed = parseDescription(rawQuery);
      keywords = buildKeywords(parsed, rawQuery, null);
    });

    test('keywords are non-empty', () => {
      expect(keywords.length).toBeGreaterThan(0);
    });

    test('keywords contain denomination tokens', () => {
      const kw = normalize(keywords);
      for (const token of requiredTokens) {
        expect(kw).toContain(token);
      }
    });
  });

  test('keywords without series fall back to raw query', () => {
    // Simulate a pcgsData with year + mint only (no series)
    const pcgsData = { year: 1956, mint: 'D' };
    const kw = buildKeywords(pcgsData, '1956 D half dollar', null);
    expect(normalize(kw)).toContain('half dollar');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  4. buildKeywords — no cross-denomination contamination
 * ═══════════════════════════════════════════════════════════════ */
describe('buildKeywords — no cross-denomination contamination', () => {

  test.each([
    ['Half Dollar', '1956 D half dollar'],
    ['Quarter',     '1999 quarter'],
    ['Dime',        '1964 dime'],
    ['Penny',       '1959 penny'],
    ['Nickel',      '2005 nickel'],
  ])('%s search "%s" has no conflicting denomination tokens', (denom, rawQuery) => {
    const parsed = parseDescription(rawQuery);
    const kw = buildKeywords(parsed, rawQuery, null);
    const tokens = tokensFor(denom);
    if (tokens) {
      expect(containsNone(kw, tokens.negative)).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  5. scoreMatch — series-match scoring
 * ═══════════════════════════════════════════════════════════════ */
describe('scoreMatch — series awareness', () => {

  test('half dollar comp scores higher with "Half Dollar" series expect', () => {
    // Use raw (ungraded) titles to avoid graded-vs-raw penalty skewing the comparison
    const halfComp = { title: '1956-D Franklin Half Dollar BU', price: 50 };
    const pennyComp = { title: '1956-D Lincoln Wheat Penny', price: 0.50 };
    const expected = { year: 1956, mint: 'D', series: 'Half Dollar' };

    scoreMatch(halfComp, expected);
    scoreMatch(pennyComp, expected);

    expect(halfComp.matchScore).toBeGreaterThan(pennyComp.matchScore);
    expect(halfComp.matchNotes).toContain('series-match');
    expect(pennyComp.matchNotes).not.toContain('series-match');
  });

  test('quarter comp scores "series-match" when expected is Quarter', () => {
    const comp = { title: '1999-P Washington Quarter PCGS MS67', price: 25 };
    const expected = { year: 1999, mint: 'P', series: 'Quarter' };
    scoreMatch(comp, expected);
    expect(comp.matchNotes).toContain('series-match');
  });

  test('dime comp does NOT score series-match when expected is Half Dollar', () => {
    const comp = { title: '1964 Roosevelt Dime MS65', price: 3 };
    const expected = { year: 1964, series: 'Half Dollar' };
    scoreMatch(comp, expected);
    expect(comp.matchNotes).not.toContain('series-match');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  6. resolveCoinVariant — design series for half dollars
 * ═══════════════════════════════════════════════════════════════ */
describe('resolveCoinVariant — denomination test matrix', () => {

  const halfDollarCases = [
    { year: 1964, design: 'Kennedy',   comp: '90% Silver' },
    { year: 1971, design: 'Kennedy',   comp: 'Copper-Nickel Clad' },
    { year: 2025, design: 'Kennedy',   comp: 'Copper-Nickel Clad' },
    { year: 2026, design: 'Kennedy',   comp: 'Copper-Nickel Clad', suffix: 'Semiquincentennial' },
    { year: 1956, design: 'Franklin',  comp: '90% Silver' },
    { year: 1945, design: 'Walking Liberty', comp: '90% Silver' },
    { year: 1900, design: 'Barber',    comp: '90% Silver' },
  ];

  test.each(halfDollarCases)(
    'Half Dollar $year → $design ($comp)',
    ({ year, design, comp, suffix }) => {
      const v = resolveCoinVariant('Half Dollar', year);
      expect(v.denomination).toBe('Half Dollar');
      expect(v.year).toBe(year);
      expect(v.designName).toBe(design);
      expect(v.composition).toBe(comp);
      if (suffix) {
        expect(v.variantSuffix).toBe(suffix);
        expect(v.label).toContain(suffix);
      }
    }
  );

  test('non-half-dollar denomination returns passthrough', () => {
    const v = resolveCoinVariant('Quarter', 1999);
    expect(v.designName).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  7. Full pipeline: parse → keywords → tokens check
 *     (denomination test matrix)
 * ═══════════════════════════════════════════════════════════════ */
describe('Full pipeline — bare denomination test matrix', () => {

  test.each(DENOMINATION_TEST_MATRIX)(
    '$denomination $year',
    ({ denomination, year, expectedSeries }) => {
      const rawQuery = `${year} ${denomination}`;
      const parsed = parseDescription(rawQuery);

      // a) Year extracted
      expect(parsed.year).toBe(year);

      // b) Series matches expected denomination pattern
      expect(parsed.series).toBeDefined();
      expect(parsed.series).toMatch(expectedSeries);

      // c) eBay keywords contain correct denomination tokens
      const kw = buildKeywords(parsed, rawQuery, null);
      const tokens = tokensFor(denomination);
      if (tokens) {
        expect(containsAny(kw, tokens.positive)).toBe(true);
        expect(containsNone(kw, tokens.negative)).toBe(true);
      }
    }
  );
});

describe('Full pipeline — named series test matrix', () => {

  test.each(NAMED_SERIES_TEST_MATRIX)(
    '"$query" → series matches $expectedSeries',
    ({ query, expectedSeries }) => {
      const parsed = parseDescription(query);
      expect(parsed.series).toBeDefined();
      expect(parsed.series).toMatch(expectedSeries);
    }
  );
});
