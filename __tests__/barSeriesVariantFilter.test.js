'use strict';

const { parseDescription } = require('../src/services/pcgsService');
const { applyFilters, scoreMatch } = require('../src/services/ebayService');
const { computeValuation } = require('../src/services/valuationService');
const {
  BAR_SERIES,
  canonicalizeBarIntent,
  detectBarSeries,
  detectSeriesFromTitle,
  getSeriesForBrand,
} = require('../src/data/barSeries');

function comp(title, overrides = {}) {
  return {
    title,
    totalUsd: 200,
    matchScore: 70,
    matchNotes: [],
    gradeType: 'raw',
    ...overrides,
  };
}

describe('#285W bar-series intent', () => {
  test.each([
    ['PAMP Suisse 1 gram gold bar Zodiac - Gemini', 'PAMP', 'Zodiac - Gemini'],
    ['PAMP 1 oz silver bar Lady of Liberty', 'PAMP', 'Lady of Liberty'],
    ['Geiger 1 oz silver bar Fireworks', 'Geiger', 'Fireworks'],
  ])('parses %s', (query, barBrand, barSeries) => {
    expect(parseDescription(query)).toEqual(expect.objectContaining({ barBrand, barSeries }));
  });

  test('does not add bar intent to an ordinary coin query', () => {
    const parsed = parseDescription('1881-S Morgan Dollar MS65');
    expect(parsed.barBrand).toBeUndefined();
    expect(parsed.barSeries).toBeUndefined();
  });

  test('does not treat a Perth Mint bullion coin as a bar product', () => {
    const parsed = parseDescription('2024 Perth Mint Kangaroo 1 oz gold coin');
    expect(parsed.barBrand).toBeUndefined();
    expect(parsed.barSeries).toBeUndefined();
  });

  test('prefers a specific PAMP zodiac design over the broad Lunar family', () => {
    const parsed = parseDescription('PAMP Suisse Lunar Gemini 1 oz gold bar');
    expect(parsed).toEqual(expect.objectContaining({
      barBrand: 'PAMP',
      barSeries: 'Zodiac - Gemini',
    }));
  });

  test.each([
    ['PAMP Suisse rose 1 gram gold bar', 'Rosa'],
    ['PAMP Suisse twins 1 gram gold bar', 'Zodiac - Gemini'],
    ['PAMP Suisse lady fortuna 1 gram gold bar', 'Fortuna'],
  ])('honors catalog aliases in %s', (query, barSeries) => {
    expect(parseDescription(query).barSeries).toBe(barSeries);
  });

  test('canonicalizes valid structured intent and neutralizes unsafe catalog inputs', () => {
    expect(canonicalizeBarIntent('pamp suisse', 'twins')).toEqual({
      barBrand: 'PAMP',
      barSeries: 'Zodiac - Gemini',
    });
    expect(canonicalizeBarIntent('constructor', 'prototype')).toEqual({ barBrand: null, barSeries: null });
    expect(canonicalizeBarIntent({}, [])).toEqual({ barBrand: null, barSeries: null });
    expect(getSeriesForBrand('constructor')).toEqual([]);
    expect(detectBarSeries('PAMP', {})).toBeNull();
  });
});

describe('#285W bar-series scoring and filtering', () => {
  const expected = { barBrand: 'PAMP', barSeries: 'Zodiac - Gemini' };

  test('adds ten points for an exact series match and stays neutral when unidentified', () => {
    const exact = scoreMatch(comp('PAMP Suisse Zodiac Gemini 1 gram gold bar'), expected);
    const unidentified = scoreMatch(comp('PAMP Suisse 1 gram gold bar in assay'), expected);

    expect(exact.matchScore - unidentified.matchScore).toBe(10);
    expect(exact.matchNotes).toContain('bar-series-match');
    expect(unidentified.matchNotes).not.toContain('bar-series-match');
  });

  test('rejects identified competing PAMP series but keeps exact and unidentified titles', () => {
    const comps = [
      comp('PAMP Suisse Zodiac Gemini 1 gram gold bar'),
      comp('PAMP Suisse Lady Fortuna 1 gram gold bar'),
      comp('PAMP Suisse Rosa 1 gram gold bar'),
      comp('PAMP Suisse 1 gram gold bar in assay'),
    ];

    const { kept, removed } = applyFilters(comps, {}, expected);

    expect(kept.map(item => item.title)).toEqual([
      'PAMP Suisse Zodiac Gemini 1 gram gold bar',
      'PAMP Suisse 1 gram gold bar in assay',
    ]);
    expect(removed.barSeriesMismatch).toBe(2);
  });

  test('isolates Geiger Fireworks from other identified Geiger series', () => {
    const comps = [
      comp('Geiger Edelmetalle Fireworks 1 oz silver bar'),
      comp('Geiger Edelmetalle Original 1 oz silver bar'),
      comp('Geiger 1 oz silver bar in assay'),
    ];

    const { kept, removed } = applyFilters(comps, {}, {
      barBrand: 'Geiger',
      barSeries: 'Fireworks',
    });

    expect(kept).toHaveLength(2);
    expect(removed.barSeriesMismatch).toBe(1);
  });

  test('rejects a different known manufacturer before matching a shared series', () => {
    const comps = [
      comp('Perth Mint Cast 1 oz gold bar'),
      comp('Scottsdale Cast 1 oz gold bar'),
      comp('Cast 1 oz gold bar in assay'),
      comp('1 oz gold bar in assay'),
    ];
    const expected = { barBrand: 'Perth Mint', barSeries: 'Cast' };

    const { kept, removed } = applyFilters(
      comps.map(item => scoreMatch(item, expected)),
      {},
      expected
    );

    expect(kept.map(item => item.title)).toEqual([
      'Perth Mint Cast 1 oz gold bar',
      'Cast 1 oz gold bar in assay',
      '1 oz gold bar in assay',
    ]);
    expect(removed.barBrandMismatch).toBe(1);
    expect(removed.barSeriesMismatch).toBe(0);
  });

  test('rejects a title that names both the expected and a competing manufacturer', () => {
    const comps = [
      comp('PAMP Suisse Zodiac Gemini 1 gram gold bar'),
      comp('PAMP Valcambi Zodiac Gemini 1 gram gold bar'),
    ];

    const { kept, removed } = applyFilters(comps, {}, expected);

    expect(kept.map(item => item.title)).toEqual([
      'PAMP Suisse Zodiac Gemini 1 gram gold bar',
    ]);
    expect(removed.barBrandMismatch).toBe(1);
  });

  test.each([
    ['Geiger 1 oz silver bar ships from USA', { barBrand: 'Geiger', barSeries: 'Fireworks' }],
    ['Geiger 1 oz silver bar holiday gift', { barBrand: 'Geiger', barSeries: 'Fireworks' }],
  ])('keeps unidentified listing title %s', (title, seriesIntent) => {
    const { kept, removed } = applyFilters([comp(title)], {}, seriesIntent);

    expect(kept.map(item => item.title)).toEqual([title]);
    expect(removed.barSeriesMismatch).toBe(0);
  });

  test('does not apply broad query aliases while classifying listing titles', () => {
    expect(detectSeriesFromTitle('PAMP', 'PAMP 1 gram gold bar cross pendant')).toBeNull();
    expect(detectSeriesFromTitle('PAMP', 'PAMP 1 gram divisible gold bar')).toBeNull();
  });

  test('classifies each comp once across scoring and filtering', () => {
    const gemini = BAR_SERIES.pamp.find(entry => entry.series === 'Zodiac - Gemini');
    const scan = jest.spyOn(gemini.re, 'test');
    const expected = { barBrand: 'PAMP', barSeries: 'Zodiac - Gemini' };
    const item = scoreMatch(comp('PAMP Suisse Gemini 1 gram gold bar'), expected);

    applyFilters([item], {}, expected);

    expect(scan).toHaveBeenCalledTimes(1);
    scan.mockRestore();
  });

  test('keeps uncataloged brands unchanged', () => {
    const comps = [
      comp('Sunshine Minting 1 oz silver bar'),
      comp('Sunshine Minting Eagle design 1 oz silver bar'),
    ];

    const { kept, removed } = applyFilters(comps, {}, {
      barBrand: 'Sunshine Minting',
      barSeries: 'Eagle',
    });

    expect(kept).toHaveLength(2);
    expect(removed.barSeriesMismatch).toBe(0);
  });

  test('lets the existing metal filter reject a same-series wrong-metal comp', () => {
    const comps = [
      comp('PAMP Suisse Rosa 1 gram gold bar'),
      comp('PAMP Suisse Rosa 1 gram silver bar'),
    ];

    const { kept, removed } = applyFilters(comps, {}, {
      barBrand: 'PAMP',
      barSeries: 'Rosa',
      metal: 'gold',
    });

    expect(kept.map(item => item.title)).toEqual(['PAMP Suisse Rosa 1 gram gold bar']);
    expect(removed.metalMismatch).toBe(1);
    expect(removed.barSeriesMismatch).toBe(0);
  });
});

describe('#285W sparse-series valuation contract', () => {
  function ebayWithComps(comps) {
    return {
      us: { comps },
      global: { comps: [] },
      usedFallback: false,
    };
  }

  test('returns an explicit null FMV when fewer than three isolated comps remain', () => {
    const comps = [
      comp('PAMP Suisse Zodiac Sagittarius 1 gram gold bar', { totalUsd: 190, _source: 'terapeak' }),
      comp('PAMP Suisse Zodiac Sagittarius 1 gram gold bar assay', { totalUsd: 205, _source: 'terapeak' }),
    ];

    const { valuation } = computeValuation(
      { verified: false },
      ebayWithComps(comps),
      null,
      null,
      { barSeries: 'Zodiac - Sagittarius' }
    );

    expect(valuation).toEqual(expect.objectContaining({
      fmvCore: null,
      confidence: 0,
      lowData: true,
      compCount: 2,
    }));
    expect(valuation.dataSource.label).toBe('insufficient-series-comps');
    expect(valuation.explanation.join(' ')).toMatch(/other bar designs were not substituted/i);
  });

  test('uses normal valuation math when at least three isolated comps remain', () => {
    const comps = [190, 200, 210].map((totalUsd, index) => comp(
      `PAMP Suisse Zodiac Gemini 1 gram gold bar ${index}`,
      { totalUsd, _source: 'terapeak', soldDate: new Date().toISOString() }
    ));

    const { valuation } = computeValuation(
      { verified: false },
      ebayWithComps(comps),
      null,
      null,
      { barSeries: 'Zodiac - Gemini' }
    );

    expect(valuation.fmvCore).toBe(200);
    expect(valuation.compCount).toBe(3);
    expect(valuation.dataSource.label).toBe('sold-data');
  });
});