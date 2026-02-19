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
const { buildKeywords, scoreMatch, detectWeightFromTitle } = require('../src/services/ebayService');
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

/* ═══════════════════════════════════════════════════════════════
 *  9. detectWeightFromTitle — bullion weight extraction
 * ═══════════════════════════════════════════════════════════════ */
describe('detectWeightFromTitle', () => {

  test.each([
    ['2023 Mexican Silver Libertad 1/4 oz BU',               0.25],
    ['American Silver Eagle 1 oz .999 Fine',                  1],
    ['2022 Gold Maple Leaf 1/10 oz',                          0.1],
    ['1/2 OZ SILVER PANDA 2019',                              0.5],
    ['1/20 oz Gold Libertad 2021',                            0.05],
    ['5 oz ATB Silver Quarter',                               5],
    ['10oz Silver Bar',                                       10],
    ['2 oz Silver Queens Beasts',                             2],
    ['Silver Libertad 1.5 oz BU',                             1.5],
    ['Quarter oz Gold Eagle',                                 0.25],
    ['Half oz Platinum Coin',                                 0.5],
    ['2023 Silver Libertad BU',                               null],  // no weight → null
    ['1956-D Franklin Half Dollar',                           null],  // non-bullion
  ])('"%s" → %s', (title, expectedOz) => {
    expect(detectWeightFromTitle(title)).toBe(expectedOz);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  10. scoreMatch — weight scoring for bullion
 * ═══════════════════════════════════════════════════════════════ */
describe('scoreMatch — weight scoring', () => {

  test('matching weight gets bonus', () => {
    const comp = { title: '2023 Mexican Silver Libertad 1/4 oz BU', totalUsd: 18 };
    scoreMatch(comp, { weight: 0.25, metal: 'silver' });
    expect(comp.matchNotes).toContain('weight-match');
    expect(comp.matchScore).toBeGreaterThanOrEqual(70);
  });

  test('1 oz comp penalized when expected is 1/4 oz', () => {
    const comp = { title: '2023 Mexican Silver Libertad 1 oz BU', totalUsd: 40 };
    scoreMatch(comp, { weight: 0.25, metal: 'silver' });
    expect(comp.matchNotes).toContain('weight-mismatch');
    expect(comp.matchScore).toBeLessThan(50);
  });

  test('no weight in title + fractional expected → penalty', () => {
    const comp = { title: '2023 Mexican Silver Libertad BU', totalUsd: 45 };
    scoreMatch(comp, { weight: 0.25, metal: 'silver' });
    expect(comp.matchNotes).toContain('weight-not-stated');
  });

  test('no weight expected → no weight scoring applied', () => {
    const comp = { title: '2023 Mexican Silver Libertad 1 oz BU', totalUsd: 40 };
    scoreMatch(comp, { series: 'Silver Libertad', metal: 'silver' });
    expect(comp.matchNotes).not.toContain('weight-match');
    expect(comp.matchNotes).not.toContain('weight-mismatch');
  });

  test('weight-match comp scores higher than weight-mismatch comp', () => {
    const match = { title: '2023 Silver Libertad 1/4 oz', totalUsd: 18 };
    const wrong = { title: '2023 Silver Libertad 1 oz', totalUsd: 40 };
    scoreMatch(match, { year: 2023, weight: 0.25, metal: 'silver' });
    scoreMatch(wrong, { year: 2023, weight: 0.25, metal: 'silver' });
    expect(match.matchScore).toBeGreaterThan(wrong.matchScore);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  11. scoreMatch — precious metal melt cross-check
 * ═══════════════════════════════════════════════════════════════ */
describe('scoreMatch — precious metal melt cross-check', () => {

  test('comp priced above 2× full-oz melt with no weight → melt penalty', () => {
    // Silver at $32/oz; comp at $70 with no weight in title
    const comp = { title: '2023 Silver Libertad BU', totalUsd: 70 };
    scoreMatch(comp, { weight: 0.25, metal: 'silver', meltPerOz: 32 });
    expect(comp.matchNotes).toContain('price-exceeds-melt');
  });

  test('comp priced below 2× full-oz melt → no melt penalty', () => {
    const comp = { title: '2023 Silver Libertad BU', totalUsd: 25 };
    scoreMatch(comp, { weight: 0.25, metal: 'silver', meltPerOz: 32 });
    expect(comp.matchNotes).not.toContain('price-exceeds-melt');
  });

  test('comp with explicit weight in title → melt check skipped (handled by weight scoring)', () => {
    const comp = { title: '2023 Silver Libertad 1 oz BU', totalUsd: 70 };
    scoreMatch(comp, { weight: 0.25, metal: 'silver', meltPerOz: 32 });
    // Should get weight-mismatch but NOT price-exceeds-melt (already caught)
    expect(comp.matchNotes).toContain('weight-mismatch');
    expect(comp.matchNotes).not.toContain('price-exceeds-melt');
  });

  test('no meltPerOz provided → no melt check', () => {
    const comp = { title: '2023 Silver Libertad BU', totalUsd: 70 };
    scoreMatch(comp, { weight: 0.25, metal: 'silver' });
    expect(comp.matchNotes).not.toContain('price-exceeds-melt');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  Mint-mark match / mismatch scoring
 * ═══════════════════════════════════════════════════════════════ */
describe('scoreMatch — mint-mark verification', () => {

  test('exact mint match (1892-S searched, 1892-S in title) → mint-match bonus', () => {
    const comp = { title: '1892-S Morgan Silver Dollar XF', totalUsd: 200 };
    scoreMatch(comp, { mint: 'S', year: 1892, series: 'Morgan Dollar' });
    expect(comp.matchNotes).toContain('mint-match');
    expect(comp.matchNotes).not.toContain('mint-mismatch');
  });

  test('mint mismatch (want S, title says O) → mint-mismatch penalty', () => {
    const comp = { title: '1892-O Morgan Silver Dollar XF', totalUsd: 45 };
    scoreMatch(comp, { mint: 'S', year: 1892, series: 'Morgan Dollar' });
    expect(comp.matchNotes).toContain('mint-mismatch');
    expect(comp.matchNotes).not.toContain('mint-match');
    expect(comp.matchScore).toBeLessThan(50);
  });

  test('mint mismatch (want D, title says CC) → mint-mismatch penalty', () => {
    const comp = { title: '1884 CC Morgan Dollar MS63', totalUsd: 300 };
    scoreMatch(comp, { mint: 'D', year: 1884, series: 'Morgan Dollar' });
    expect(comp.matchNotes).toContain('mint-mismatch');
  });

  test('no mint in title → no bonus or penalty (benefit of doubt)', () => {
    const comp = { title: '1892 Morgan Silver Dollar VF', totalUsd: 100 };
    scoreMatch(comp, { mint: 'S', year: 1892, series: 'Morgan Dollar' });
    expect(comp.matchNotes).not.toContain('mint-match');
    expect(comp.matchNotes).not.toContain('mint-mismatch');
  });

  test('no expected mint → no mint scoring applied', () => {
    const comp = { title: '1892-O Morgan Silver Dollar XF', totalUsd: 45 };
    scoreMatch(comp, { year: 1892, series: 'Morgan Dollar' });
    expect(comp.matchNotes).not.toContain('mint-match');
    expect(comp.matchNotes).not.toContain('mint-mismatch');
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  buildKeywords — mint-mark in eBay search keywords
 * ═══════════════════════════════════════════════════════════════ */
describe('buildKeywords — mint-mark formatting', () => {

  test('year + mint → joined as "1892-S" (not "-S")', () => {
    const kw = buildKeywords({ year: 1892, mint: 'S', series: 'Morgan Dollar' }, '1892-S Morgan Dollar');
    expect(kw).toContain('1892-S');
    // Must NOT have standalone " -S " that eBay would treat as exclusion
    expect(kw).not.toMatch(/\s-S\b/);
  });

  test('mint without year → mint appended standalone', () => {
    const kw = buildKeywords({ mint: 'D', series: 'Morgan Dollar' }, 'Morgan Dollar D');
    expect(kw).toContain('D');
  });

  test('no mint → no mint in keywords', () => {
    const kw = buildKeywords({ year: 1892, series: 'Morgan Dollar' }, '1892 Morgan Dollar');
    expect(kw).not.toMatch(/-[SDPWO]\b/);
  });
});
