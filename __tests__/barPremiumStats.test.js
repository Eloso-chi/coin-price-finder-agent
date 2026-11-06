// __tests__/barPremiumStats.test.js -- #333H phase 3: premium over spot by bar segment
'use strict';

const {
  bucketForWeight,
  classifyBarTitle,
  trimOutliers,
  quantile,
  buildBarPremiumReport,
  buildLineCandidates,
} = require('../src/utils/barPremiumStats');
const { lookupSpotInEntries, createSpotIndex } = require('../src/utils/spotLookup');

describe('bucketForWeight', () => {
  test.each([
    [1, '1 oz'], [10, '10 oz'], [100, '100 oz'], [0.1, '1/10 oz'], [1 / 31.1035, '1 g'],
    [50 / 31.1035, '50 g'], [32.1507, '1 kilo'], [1.015, '1 oz'],
  ])('%p ozt is the %s bucket', (ozt, label) => {
    expect(bucketForWeight(ozt).label).toBe(label);
  });

  test.each([0, -1, null, undefined, NaN, 0.97, 3.5, 1.2])('%p matches no bucket', (ozt) => {
    expect(bucketForWeight(ozt)).toBeNull();
  });
});

describe('classifyBarTitle', () => {
  test('a series bar', () => {
    expect(classifyBarTitle('1 oz PAMP Suisse Lady Fortuna Silver Bar')).toEqual({
      ok: true, metal: 'silver', bucket: '1 oz', weightOzt: 1, class: 'series', brand: 'PAMP', series: 'Fortuna',
    });
  });

  test('a brand-only bar in grams', () => {
    const c = classifyBarTitle('10 gram Valcambi Gold Bar');
    expect(c).toEqual(expect.objectContaining({ ok: true, metal: 'gold', bucket: '10 g', class: 'brand', brand: 'Valcambi', series: null }));
  });

  test('a generic bar', () => {
    expect(classifyBarTitle('1 oz .999 Fine Silver Bar Unbranded')).toEqual(expect.objectContaining({ ok: true, class: 'generic', brand: null }));
  });

  test.each([
    ['Engelhard Gold Standard 10oz Silver Bar', 'silver'],
    ['Istanbul Gold Refinery 10oz Silver Bar', 'silver'],
    ['Emirates Gold 10oz Silver Bar', 'silver'],
    ['Gold Refineries 1 oz Silver Bar', 'silver'],
  ])('%s is a silver bar (the gold in a name is not the metal)', (title, metal) => {
    const c = classifyBarTitle(title);
    expect(c).toEqual(expect.objectContaining({ ok: true, metal }));
  });

  test('"in original packaging" is not the Geiger Original series, but a real Original bar is', () => {
    expect(classifyBarTitle('1 oz Geiger Silver Bar in original packaging').series).toBeNull();
    expect(classifyBarTitle('1 oz Geiger Silver Bar in Original Box').series).toBeNull();
    expect(classifyBarTitle('1 oz Geiger Original Silver Bar').series).toBe('Original');
  });

  test('CombiBar and Kinebar names count as bars', () => {
    expect(classifyBarTitle('Valcambi CombiBar 50 gram gold').ok).toBe(true);
    expect(classifyBarTitle('1 oz Heraeus Kinebar gold').ok).toBe(true);
  });

  test.each([
    ['Lot of 5 PAMP 1 oz Silver Bars', 'multi-item'],
    ['PAMP 1 oz Silver Bar Set of 3', 'multi-item'],
    ['2 x 1 oz Silver Bar', 'multi-item'],
    ['1 oz Silver Round .999', 'not-a-bar'],
    ['PAMP Geiger 1 oz Silver Bar', 'multiple-makers'],
    ['Silver Bar .999 Fine', 'no-weight'],
    ['3.5 oz Silver Bar', 'odd-weight'],
    ['1 oz Bar Fine', 'no-metal'],
    ['100 oz Cast Iron Silver Gold Ingot Mold Bar', 'non-bar-item'],
    ['Glass Sugar Bowl 10oz Coffee Bar Storage Gold or Silver', 'non-bar-item'],
    ['Graphite Mold for 10 oz Silver Bar', 'non-bar-item'],
    ['Vinyl Sleeve Holder 1 oz Silver Bar', 'non-bar-item'],
    ['1 oz Copper Bar', 'non-bar-item'],
    ['10 oz Silver Bar Gold Plated', 'non-bar-item'],
    ['1 oz Gold and Silver Bar Set Collector', 'multi-item'],
    ['1 oz Gold Silver Bar', 'multiple-metals'],
    ['', 'not-a-bar'],
    [null, 'not-a-bar'],
  ])('%p is excluded as %s', (title, reason) => {
    expect(classifyBarTitle(title)).toEqual({ ok: false, reason });
  });
});

describe('trimOutliers and quantile', () => {
  test('small samples are only sorted', () => {
    expect(trimOutliers([5, 1, 100, 2])).toEqual([1, 2, 5, 100]);
  });

  test('a large sample drops values beyond 1.5 IQR', () => {
    expect(trimOutliers([10, 11, 12, 10, 11, 12, 10, 11, 500])).not.toContain(500);
  });

  test('quantile interpolates and handles empty input', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('lookupSpotInEntries', () => {
  const entries = { '2026-01-10': 30, '2026-01-20': 32 };

  test('exact day, nearest prior day within 7 days, first later day within 7 days', () => {
    expect(lookupSpotInEntries(entries, '2026-01-10T12:00:00Z')).toBe(30);
    expect(lookupSpotInEntries(entries, '2026-01-15')).toBe(30);
    expect(lookupSpotInEntries(entries, '2026-01-08')).toBe(30);
  });

  test('a gap over 7 days, empty data and bad input are null', () => {
    expect(lookupSpotInEntries(entries, '2026-02-15')).toBeNull();
    expect(lookupSpotInEntries(entries, '2025-12-01')).toBeNull();
    expect(lookupSpotInEntries({}, '2026-01-10')).toBeNull();
    expect(lookupSpotInEntries(undefined, '2026-01-10')).toBeNull();
    expect(lookupSpotInEntries(entries, '')).toBeNull();
    expect(lookupSpotInEntries(entries, 5)).toBeNull();
  });

  test('maxGapDays and allowLater narrow the lookup', () => {
    expect(lookupSpotInEntries(entries, '2026-01-14', { maxGapDays: 3 })).toBeNull();
    expect(lookupSpotInEntries(entries, '2026-01-13', { maxGapDays: 3 })).toBe(30);
    expect(lookupSpotInEntries(entries, '2026-01-08', { allowLater: false })).toBeNull();
  });

  test('keys that are not dates and entries that are not prices are ignored', () => {
    expect(lookupSpotInEntries({ '2026-01-10': 30 }, '__proto__')).toBeNull();
    expect(lookupSpotInEntries({}, 'constructor')).toBeNull();
    expect(lookupSpotInEntries({ '2026-01-10': '30', '2026-01-09': 28 }, '2026-01-10')).toBe(28);
    expect(lookupSpotInEntries({ '2026-01-10': NaN, '2026-01-09': -1 }, '2026-01-10')).toBeNull();
    expect(lookupSpotInEntries(Object.create({ '2026-01-10': 30 }), '2026-01-10')).toBeNull();
  });

  test('createSpotIndex gives the same answers with the dates sorted once', () => {
    const index = createSpotIndex(entries, { maxGapDays: 7 });
    expect(index('2026-01-15')).toBe(30);
    expect(index('2026-01-25')).toBe(32);
    expect(index('2026-01-15', { maxGapDays: 1 })).toBeNull();
    expect(createSpotIndex(undefined)('2026-01-10')).toBeNull();
  });
});

function comps(title, price, day, count) {
  return Array.from({ length: count }, (_, i) => ({ title: `${title} ${i}`, totalUsd: price, soldDate: `${day}T00:00:00.000Z` }));
}

describe('buildLineCandidates', () => {
  const titles = [
    ...Array.from({ length: 6 }, () => '1 oz Scottsdale Vortex Silver Bar'),
    ...Array.from({ length: 2 }, () => '1 oz Scottsdale Rare Silver Bar'),
    ...Array.from({ length: 6 }, () => '1 oz Scottsdale Stacker Silver Bar'),
    ...Array.from({ length: 6 }, () => '1 oz Silver Bar Vortex Generic'),
  ].map(title => ({ title }));

  test('lists recurring words per maker, without catalogued series, stopwords, the maker name or generic bars', () => {
    const out = buildLineCandidates(titles);
    expect(out).toEqual([{ brand: 'Scottsdale', candidates: [{ phrase: 'vortex', count: 6 }] }]);
  });

  test('minCount and top bound the list; nothing recurring gives an empty report', () => {
    expect(buildLineCandidates(titles, { minCount: 7 })).toEqual([]);
    expect(buildLineCandidates([{ title: '1 oz Scottsdale Vortex Silver Bar' }, { title: '1 oz Scottsdale Vortex Silver Bar' }], { minCount: 1, top: 1 })[0].candidates).toHaveLength(1);
    expect(buildLineCandidates([])).toEqual([]);
  });
});

describe('buildBarPremiumReport', () => {
  // Spot triples over three months; the same 10% / 20% premiums are paid in each.
  const spotHistory = { XAG: { '2026-01-10': 30, '2026-02-10': 60, '2026-03-10': 90 } };
  const pool = [
    ...comps('1 oz Silver Bar Generic', 33, '2026-01-10', 12),
    ...comps('1 oz Silver Bar Generic', 66, '2026-02-10', 12),
    ...comps('1 oz Silver Bar Generic', 99, '2026-03-10', 12),
    ...comps('1 oz PAMP Suisse Silver Bar', 36, '2026-01-10', 12),
    ...comps('1 oz PAMP Suisse Silver Bar', 72, '2026-02-10', 12),
    ...comps('1 oz PAMP Suisse Silver Bar', 108, '2026-03-10', 12),
    ...comps('1 oz PAMP Suisse Lady Fortuna Silver Bar', 39, '2026-01-10', 12),
  ];

  test('the premium is the same at different spot prices (spot normalization)', () => {
    const { segments } = buildBarPremiumReport(pool, { spotHistory });
    const generic = segments.find(s => s.key === 'silver|1 oz|generic||');
    expect(generic.premium).toEqual(expect.objectContaining({ median: 0.1 }));
    expect(generic.n).toBe(36);
    expect(generic.spotDays).toBe(3);
    expect(generic.reliable).toBe(true);
    expect(generic.firstSold).toBe('2026-01-10');
    expect(generic.lastSold).toBe('2026-03-10');
  });

  test('a series comp counts for its series and for its maker; generic comps only for generic', () => {
    const { segments } = buildBarPremiumReport(pool, { spotHistory });
    const brand = segments.find(s => s.key === 'silver|1 oz|brand|PAMP|');
    const series = segments.find(s => s.key === 'silver|1 oz|series|PAMP|Fortuna');
    expect(brand.n).toBe(48);
    expect(series.n).toBe(12);
    expect(series.premium.median).toBe(0.3);
    expect(segments.filter(s => s.class === 'generic')).toHaveLength(1);
  });

  test('brand over generic is the same-month price ratio of the maker roll-up, with counts and no spot history', () => {
    const { uplift } = buildBarPremiumReport(pool);
    // Jan: median(36 x12, 39 x12) 37.5 / 33; Feb 72 / 66; Mar 108 / 99; the median of the three.
    expect(uplift).toEqual([{ metal: 'silver', weightBucket: '1 oz', brand: 'PAMP', months: 3, nBrand: 48, nGeneric: 36, priceRatio: 1.091 }]);
  });

  test('a ratio needs at least two months, each with three comps on both sides', () => {
    const oneMonth = [
      ...comps('1 oz Silver Bar Generic', 33, '2026-01-10', 12),
      ...comps('1 oz PAMP Suisse Silver Bar', 36, '2026-01-10', 12),
      ...comps('1 oz Silver Bar Generic', 33, '2026-02-10', 12),
      ...comps('1 oz PAMP Suisse Silver Bar', 36, '2026-02-10', 2),
    ];
    expect(buildBarPremiumReport(oneMonth).uplift).toEqual([]);
    const twoMonths = [...oneMonth, ...comps('1 oz PAMP Suisse Silver Bar', 36, '2026-02-12', 3)];
    expect(buildBarPremiumReport(twoMonths).uplift).toEqual([expect.objectContaining({ months: 2, nBrand: 17, nGeneric: 24 })]);
  });

  test('without spot history premiums are null and nothing is reliable', () => {
    const report = buildBarPremiumReport(pool);
    expect(report.spotCoverage).toBeNull();
    expect(report.segments.every(s => s.premium === null && s.reliable === false && s.nWithSpot === 0)).toBe(true);
  });

  test('comps with no spot within 3 days before the sale are left out of the premium and counted', () => {
    const late = [...pool, ...comps('1 oz Silver Bar Generic', 40, '2026-06-01', 3), ...comps('1 oz Silver Bar Generic', 99, '2026-03-14', 1)];
    const report = buildBarPremiumReport(late, { spotHistory });
    const generic = report.segments.find(s => s.key === 'silver|1 oz|generic||');
    // 2026-03-14 is 4 days after the last spot day, 2026-06-01 months after.
    expect(report.spotCoverage).toEqual({ compsWithSpot: 84, compsWithoutSpot: 4 });
    expect(generic.n).toBe(40);
    expect(generic.nWithSpot).toBe(36);
  });

  test('a spot price from a later day is never used', () => {
    const early = comps('1 oz Silver Bar Generic', 33, '2026-01-08', 12);
    const report = buildBarPremiumReport(early, { spotHistory });
    expect(report.spotCoverage).toEqual({ compsWithSpot: 0, compsWithoutSpot: 12 });
  });

  test('a segment below the minimum sample is not reliable', () => {
    const report = buildBarPremiumReport(comps('1 oz Silver Bar Generic', 33, '2026-01-10', 4), { spotHistory });
    expect(report.segments[0]).toEqual(expect.objectContaining({ nWithSpot: 4, reliable: false }));
    expect(report.segments[0].premium).not.toBeNull();
  });

  test('enough comps from fewer than three sale days is not reliable', () => {
    const oneDay = comps('1 oz Silver Bar Generic', 33, '2026-01-10', 30);
    expect(buildBarPremiumReport(oneDay, { spotHistory }).segments[0]).toEqual(expect.objectContaining({ nWithSpot: 30, spotDays: 1, reliable: false }));
  });

  test('a price far from the month and bucket median is dropped as a wrong-weight listing', () => {
    const month = [...comps('1 oz Silver Bar Generic', 100, '2026-03-05', 6), ...comps('1 oz Silver Bar Wrong Weight', 10, '2026-03-05', 1)];
    const report = buildBarPremiumReport(month);
    expect(report.source.excluded['price-outlier']).toBe(1);
    expect(report.source.classified).toBe(6);
  });

  test('a 2:1 weight mislabel is dropped in both directions', () => {
    const month = [...comps('1 oz Silver Bar Generic', 100, '2026-03-05', 8), ...comps('1 oz Silver Bar Dear', 200, '2026-03-05', 1), ...comps('1 oz Silver Bar Cheap', 50, '2026-03-05', 1)];
    const report = buildBarPremiumReport(month);
    expect(report.source.excluded['price-outlier']).toBe(2);
    expect(report.source.classified).toBe(8);
  });

  test('the band needs five comps in the month, or eight with its neighbours; undated comps get none', () => {
    const four = [...comps('1 oz Silver Bar Generic', 100, '2026-03-05', 3), ...comps('1 oz Silver Bar Wrong', 10, '2026-03-05', 1)];
    expect(buildBarPremiumReport(four).source.classified).toBe(4);
    const five = [...comps('1 oz Silver Bar Generic', 100, '2026-03-05', 4), ...comps('1 oz Silver Bar Wrong', 10, '2026-03-05', 1)];
    expect(buildBarPremiumReport(five).source.classified).toBe(4);
    const thinWithNeighbours = [
      ...comps('1 oz Silver Bar Generic', 100, '2026-02-05', 5), ...comps('1 oz Silver Bar Generic', 100, '2026-04-05', 5),
      ...comps('1 oz Silver Bar Wrong', 10, '2026-03-05', 1),
    ];
    expect(buildBarPremiumReport(thinWithNeighbours).source.excluded['price-outlier']).toBe(1);
    const undated = [...comps('1 oz Silver Bar Generic', 100, '2026-03-05', 8), { title: '1 oz Silver Bar Undated', totalUsd: 10, soldDate: null }];
    expect(buildBarPremiumReport(undated).source.classified).toBe(9);
  });

  test('metal price moves between months are not outliers', () => {
    const moved = [...comps('1 oz Silver Bar Generic', 33, '2026-01-05', 6), ...comps('1 oz Silver Bar Generic', 100, '2026-04-05', 6)];
    expect(buildBarPremiumReport(moved).source.classified).toBe(12);
  });

  test('with spot history a month priced far from spot is dropped even when the median band cannot catch it', () => {
    // Every comp agrees with the month's median, so only the premium band can see the problem.
    const dear = buildBarPremiumReport(comps('1 oz Silver Bar Generic', 80, '2026-01-10', 8), { spotHistory });
    expect(dear.source.excluded['premium-outlier']).toBe(8);
    expect(dear.source.classified).toBe(0);
    const cheap = buildBarPremiumReport(comps('1 oz Silver Bar Generic', 20, '2026-01-10', 8), { spotHistory });
    expect(cheap.source.excluded['premium-outlier']).toBe(8);
    const fair = buildBarPremiumReport(comps('1 oz Silver Bar Generic', 33, '2026-01-10', 8), { spotHistory });
    expect(fair.source.classified).toBe(8);
  });

  test('exclusion reasons are counted and the report is deterministic', () => {
    const mixed = [...pool, { title: '1 oz Silver Round', totalUsd: 30, soldDate: '2026-01-10' }, { title: '1 oz Silver Bar Free', totalUsd: 0, soldDate: '2026-01-10' }];
    const a = buildBarPremiumReport(mixed, { spotHistory });
    expect(a.source.excluded).toEqual({ 'no-price': 1, 'not-a-bar': 1 });
    expect(JSON.stringify(buildBarPremiumReport(mixed, { spotHistory }))).toBe(JSON.stringify(a));
  });
});