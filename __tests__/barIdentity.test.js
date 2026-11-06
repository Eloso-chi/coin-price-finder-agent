// __tests__/barIdentity.test.js -- #333H Phase 1: one bar identity for every route
'use strict';

const {
  parseBarSize,
  resolveBarSegment,
  getBarSegment,
  describeBarSegment,
  barMaxPremium,
} = require('../src/utils/barIdentity');
const { detectBarBrand, detectBarBrands, canonicalizeBarBrand } = require('../src/data/barSeries');
const { extractBrand } = require('../src/services/marketAggregator');
const { parseDescription } = require('../src/services/pcgsService');
const { extractCoinIntent } = require('../src/utils/coinIntent');
const { applyFilters, scoreMatch } = require('../src/services/ebayService');

describe('parseBarSize', () => {
  test.each([
    ['0.5 gram', 0.5 / 31.1035],
    ['.5 gram', 0.5 / 31.1035],
    ['1 g', 1 / 31.1035],
    ['25 grams', 25 / 31.1035],
    ['250 gram', 250 / 31.1035],
    ['500 gm', 500 / 31.1035],
    ['1 oz', 1],
    ['1oz', 1],
    ['1 ozt', 1],
    ['1 troy oz', 1],
    ['2.5 oz', 2.5],
    ['1/10 oz', 0.1],
    ['1/4 oz', 0.25],
    ['1/2 oz', 0.5],
    ['20 oz', 20],
    ['100 oz', 100],
    ['1000 oz', 1000],
    ['1 kilo', 32.1507],
    ['kilo', 32.1507],
    ['2 kg', 64.3014],
    ['  10 OZ  ', 10],
  ])('parses %p', (size, ozt) => {
    expect(parseBarSize(size).weightOzt).toBeCloseTo(ozt, 4);
  });

  test.each([
    '', '   ', 'oz', '3 stone', '0 oz', '0 gram', '-1 oz', '1/0 oz', '5000 oz', '1 oz extra',
    '1 oz; drop', 'x'.repeat(60), null, undefined, 5, {}, [],
  ])('returns null for %p instead of a default weight', (size) => {
    expect(parseBarSize(size)).toBeNull();
  });
});

describe('resolveBarSegment', () => {
  test('no maker is the generic class', () => {
    expect(resolveBarSegment({})).toEqual(expect.objectContaining({
      class: 'generic', barBrand: null, barSeries: null,
    }));
    expect(resolveBarSegment({ brand: '   ', series: 'fortuna' }).class).toBe('generic');
  });

  test('a recognized maker is the brand class and canonicalizes aliases', () => {
    expect(resolveBarSegment({ brand: 'pamp suisse' })).toEqual(expect.objectContaining({
      class: 'brand', barBrand: 'PAMP', barSeries: null,
    }));
    expect(resolveBarSegment({ brand: 'Perth' }).barBrand).toBe('Perth Mint');
  });

  test('a maker plus a recognized series is the series class', () => {
    const seg = resolveBarSegment({ brand: 'PAMP', series: 'lady fortuna' });
    expect(seg).toEqual(expect.objectContaining({ class: 'series', barBrand: 'PAMP', barSeries: 'Fortuna' }));
    expect(seg.barSeriesRe).toBeInstanceOf(RegExp);
    expect(seg.label).toBe('PAMP / Fortuna');
  });

  test('an unrecognized series on a known maker stays brand class and is reported', () => {
    expect(resolveBarSegment({ brand: 'PAMP', series: 'nonexistent' })).toEqual(expect.objectContaining({
      class: 'brand', barSeries: null, unrecognizedSeries: 'nonexistent',
    }));
  });

  test('a maker the registry does not know is still the brand class', () => {
    expect(resolveBarSegment({ brand: 'Acme Metals' })).toEqual(expect.objectContaining({
      class: 'brand', barBrand: null, requestedBrand: 'Acme Metals',
    }));
  });

  test('lunar requests match by animal, never by catalog series', () => {
    expect(resolveBarSegment({ brand: 'PAMP', series: 'lunar', isLunar: true })).toEqual(expect.objectContaining({
      class: 'brand', barSeries: null,
    }));
  });

  test('describeBarSegment is a compact, serializable view', () => {
    const view = describeBarSegment(resolveBarSegment({ brand: 'Geiger', series: 'fireworks' }));
    expect(view).toEqual({ class: 'series', brand: 'Geiger', series: 'Fireworks', label: 'Geiger / Fireworks' });
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(describeBarSegment(null)).toBeNull();
  });
});

describe('getBarSegment (legacy #285W callers)', () => {
  test('derives series and brand classes from barBrand / barSeries', () => {
    expect(getBarSegment({ barBrand: 'PAMP', barSeries: 'Fortuna' }).class).toBe('series');
    expect(getBarSegment({ barBrand: 'PAMP' }).class).toBe('brand');
    expect(getBarSegment({})).toBeNull();
    expect(getBarSegment(null)).toBeNull();
  });

  test('an explicit barSegment wins; an invalid one is ignored', () => {
    expect(getBarSegment({ barSegment: { class: 'generic' } }).class).toBe('generic');
    expect(getBarSegment({ barSegment: { class: 'bogus' }, barBrand: 'PAMP' }).class).toBe('brand');
  });
});

describe('barMaxPremium', () => {
  test('is set by metal and never by bar size', () => {
    expect(barMaxPremium('silver')).toBe(1.0);
    expect(barMaxPremium('Gold')).toBe(0.4);
    expect(barMaxPremium('platinum')).toBe(0.4);
    expect(barMaxPremium('palladium')).toBe(0.4);
    expect(barMaxPremium(undefined)).toBe(0.4);
    expect(barMaxPremium('constructor')).toBe(0.4);
  });
});

describe('one brand registry', () => {
  test('JM Bullion is a dealer, not Johnson Matthey', () => {
    expect(detectBarBrands('JM Bullion 1 oz Silver Bar')).toEqual([]);
    expect(detectBarBrand('Johnson Matthey 100 oz Silver Bar')).toBe('Johnson Matthey');
    expect(extractBrand('JM Bullion 1 oz Silver Bar')).toBe('Generic');
    expect(extractBrand('Johnson Matthey 100oz Silver')).toBe('JM');
  });

  test('Sunshine Minting and Sunshine Mining are different makers', () => {
    expect(detectBarBrands('Sunshine Mint 1 oz Silver Bar')).toEqual(['Sunshine Minting']);
    expect(detectBarBrands('Sunshine Minting 10 oz Silver Bar')).toEqual(['Sunshine Minting']);
    expect(detectBarBrands('Sunshine Mining Silver Bar')).toEqual(['Sunshine Mining']);
    expect(detectBarBrands('Sunshine State souvenir token')).toEqual([]);
    expect(extractBrand('Sunshine Mint silver bar')).toBe('Sunshine');
    expect(extractBrand('Sunshine Mining silver bar')).toBe('Sunshine Mining');
  });

  test('compound makers do not also match their parent maker', () => {
    expect(detectBarBrands('Argor-Heraeus 1 oz Gold Bar')).toEqual(['Argor-Heraeus']);
    expect(detectBarBrands('Heraeus 1 oz Gold Bar')).toEqual(['Heraeus']);
    expect(detectBarBrands('MMTC-PAMP 1 oz Gold Bar')).toEqual(['MMTC-PAMP']);
    expect(detectBarBrands('PAMP Suisse 1 oz Gold Bar')).toEqual(['PAMP']);
    expect(detectBarBrands('Royal Canadian Mint 1 oz Silver Bar')).toEqual(['Royal Canadian Mint']);
    expect(detectBarBrands('Royal Mint 1 oz Silver Bar')).toEqual(['Royal Mint']);
  });

  test('every market-matrix maker is recognized by the comp filters', () => {
    for (const title of [
      'PAMP 1 oz', 'Valcambi 1 oz', 'Credit Suisse 1 oz', 'Perth Mint 1 oz', 'Royal Canadian Mint 1 oz',
      'Johnson Matthey 1 oz', 'Engelhard 1 oz', 'Sunshine Mint 1 oz', 'Asahi 1 oz', 'Scottsdale 1 oz',
      'Geiger 1 oz', 'Argor-Heraeus 1 oz', 'Metalor 1 oz', 'Heraeus 1 oz', 'SilverTowne 1 oz', 'APMEX 1 oz',
      'A-Mark 1 oz', 'MMTC-PAMP 1 oz', 'Royal Mint 1 oz', 'Umicore 1 oz',
    ]) {
      expect(detectBarBrands(title).length).toBe(1);
      expect(extractBrand(title)).not.toBe('Generic');
    }
  });

  test('canonicalizeBarBrand accepts canonical names and aliases only', () => {
    expect(canonicalizeBarBrand('Scottsdale Mint')).toBe('Scottsdale');
    expect(canonicalizeBarBrand('rcm')).toBe('Royal Canadian Mint');
    expect(canonicalizeBarBrand('JM Bullion')).toBeNull();
    expect(canonicalizeBarBrand('constructor')).toBeNull();
  });
});

describe('the general path builds the same segment as /api/bar-price', () => {
  function intentFor(query) {
    return extractCoinIntent({ parsed: parseDescription(query) });
  }

  test.each([
    ['1 oz silver bar', {}, 'generic'],
    ['PAMP Suisse 1 oz silver bar', { brand: 'PAMP' }, 'brand'],
    ['PAMP Suisse 1 oz silver bar Lady Fortuna', { brand: 'PAMP', series: 'fortuna' }, 'series'],
    ['Geiger 1 oz silver bar Fireworks', { brand: 'Geiger', series: 'fireworks' }, 'series'],
  ])('%s', (query, routeInput, cls) => {
    const fromQuery = intentFor(query).barSegment;
    const fromRoute = resolveBarSegment(routeInput);
    expect(fromQuery.class).toBe(cls);
    expect(describeBarSegment(fromQuery)).toEqual(describeBarSegment(fromRoute));
  });

  test('ordinary coin queries have no bar segment', () => {
    expect(intentFor('1881-S Morgan Dollar MS65').barSegment).toBeNull();
    expect(intentFor('2024 Perth Mint Kangaroo 1 oz gold coin').barSegment).toBeNull();
    expect(intentFor('1 oz silver round').barSegment).toBeNull();
  });

  test('both paths keep the same comps from the same pool', () => {
    const pool = [
      { title: '1 oz .999 Silver Bar Generic', totalUsd: 34 },
      { title: 'PAMP Suisse 1 oz Silver Bar Lady Fortuna', totalUsd: 45 },
      { title: 'PAMP Suisse 1 oz Silver Bar Rosa', totalUsd: 44 },
      { title: 'Geiger 1 oz Silver Bar Fireworks', totalUsd: 41 },
      { title: 'Johnson Matthey 1 oz Silver Bar', totalUsd: 52 },
    ].map(c => ({ matchScore: 70, matchNotes: [], gradeType: 'raw', ...c }));

    for (const [query, routeInput] of [
      ['1 oz silver bar', {}],
      ['PAMP Suisse 1 oz silver bar', { brand: 'PAMP' }],
      ['PAMP Suisse 1 oz silver bar Lady Fortuna', { brand: 'PAMP', series: 'fortuna' }],
    ]) {
      const viaIntent = intentFor(query).barSegment;
      const viaRoute = resolveBarSegment(routeInput);
      const keep = (segment) => applyFilters(
        pool.map(c => scoreMatch({ ...c }, { type: 'bar', barSegment: segment })),
        {},
        { type: 'bar', barSegment: segment, barBrand: segment.barBrand, barSeries: segment.barSeries }
      ).kept.map(c => c.title);
      expect(keep(viaIntent)).toEqual(keep(viaRoute));
    }
  });

  test('segments isolate the pool as specified', () => {
    const pool = [
      { title: '1 oz .999 Silver Bar Generic', totalUsd: 34 },
      { title: 'PAMP Suisse 1 oz Silver Bar Lady Fortuna', totalUsd: 45 },
      { title: 'PAMP Suisse 1 oz Silver Bar Rosa', totalUsd: 44 },
      { title: 'Geiger 1 oz Silver Bar Fireworks', totalUsd: 41 },
    ].map(c => ({ matchScore: 70, matchNotes: [], gradeType: 'raw', ...c }));
    const run = (input) => {
      const segment = resolveBarSegment(input);
      return applyFilters(pool.map(c => ({ ...c })), {}, {
        barSegment: segment, barBrand: segment.barBrand, barSeries: segment.barSeries,
      }).kept.map(c => c.title);
    };

    expect(run({})).toEqual(['1 oz .999 Silver Bar Generic']);
    expect(run({ brand: 'PAMP' })).toEqual([
      '1 oz .999 Silver Bar Generic',
      'PAMP Suisse 1 oz Silver Bar Lady Fortuna',
      'PAMP Suisse 1 oz Silver Bar Rosa',
    ]);
    expect(run({ brand: 'PAMP', series: 'fortuna' })).toEqual([
      '1 oz .999 Silver Bar Generic',
      'PAMP Suisse 1 oz Silver Bar Lady Fortuna',
    ]);
  });
});
