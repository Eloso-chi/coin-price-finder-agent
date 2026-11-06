// __tests__/dealerPremiums.barSegment.test.js -- #333H phase 3: data-driven bar premium ranges
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { lookupBarSegmentRange, lookupPremiumRange } = require('../src/data/dealerPremiums');

let dir;
let n = 0;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dealer-premiums-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function dataFile(segments) {
  const file = path.join(dir, `bar-premiums-${n++}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, segments }));
  return file;
}

const seg = (over) => {
  const s = {
    metal: 'silver', weightBucket: '1 oz', class: 'generic', brand: null, series: null,
    n: 40, nWithSpot: 40, reliable: true, premium: { n: 40, p25: 0.10, median: 0.15, p75: 0.20 }, ...over,
  };
  return { key: [s.metal, s.weightBucket, s.class, s.brand || '', s.series || ''].join('|'), ...s };
};

describe('lookupBarSegmentRange', () => {
  test('uses the generic segment for a bar with no maker, widened by 1.5 IQR', () => {
    const file = dataFile([seg({})]);
    const range = lookupBarSegmentRange({ metal: 'silver', weightOz: 1, barSegment: { class: 'generic' } }, { file });
    expect(range).toEqual({ key: 'bar-segment:silver|1 oz|generic||', min: -0.05, max: 0.35, source: 'bar-premiums', segment: 'generic', n: 40 });
  });

  test('prefers the series segment, then the maker, and never falls to generic for a branded bar', () => {
    const file = dataFile([
      seg({}),
      seg({ class: 'brand', brand: 'PAMP', premium: { n: 40, p25: 0.3, median: 0.4, p75: 0.5 } }),
      seg({ class: 'series', brand: 'PAMP', series: 'Fortuna', premium: { n: 40, p25: 0.5, median: 0.6, p75: 0.7 } }),
    ]);
    const barSegment = { class: 'series', brand: 'PAMP', series: 'Fortuna' };
    expect(lookupBarSegmentRange({ metal: 'silver', weightOz: 1, barSegment }, { file }).segment).toBe('series');
    const brandOnly = lookupBarSegmentRange({ metal: 'silver', weightOz: 1, barSegment: { class: 'brand', brand: 'PAMP' } }, { file });
    expect(brandOnly.segment).toBe('brand');
    expect(brandOnly.min).toBeCloseTo(0, 4);
    expect(lookupBarSegmentRange({ metal: 'silver', weightOz: 1, barSegment: { class: 'brand', brand: 'Valcambi' } }, { file })).toBeNull();
  });

  test('an unreliable series segment falls back to the reliable maker segment', () => {
    const file = dataFile([
      seg({ class: 'brand', brand: 'PAMP' }),
      seg({ class: 'series', brand: 'PAMP', series: 'Fortuna', reliable: false, nWithSpot: 3 }),
    ]);
    const range = lookupBarSegmentRange({ metal: 'silver', weightOz: 1, barSegment: { class: 'series', brand: 'PAMP', series: 'Fortuna' } }, { file });
    expect(range.segment).toBe('brand');
  });

  test('segments without premiums or reliability, other weights and other metals give null', () => {
    const file = dataFile([seg({ premium: null, reliable: false, nWithSpot: 0 }), seg({ metal: 'gold', weightBucket: '1 g' })]);
    const generic = { class: 'generic' };
    expect(lookupBarSegmentRange({ metal: 'silver', weightOz: 1, barSegment: generic }, { file })).toBeNull();
    expect(lookupBarSegmentRange({ metal: 'silver', weightOz: 10, barSegment: generic }, { file })).toBeNull();
    expect(lookupBarSegmentRange({ metal: 'gold', weightOz: 1, barSegment: generic }, { file })).toBeNull();
  });

  test('platinum and palladium bars have a range only when the data has one', () => {
    const file = dataFile([seg({ metal: 'platinum', weightBucket: '1 oz' })]);
    expect(lookupBarSegmentRange({ metal: 'platinum', weightOz: 1, barSegment: { class: 'generic' } }, { file }).segment).toBe('generic');
    expect(lookupBarSegmentRange({ metal: 'palladium', weightOz: 1, barSegment: { class: 'generic' } }, { file })).toBeNull();
  });

  test('a missing, unreadable or malformed file is null, not an error', () => {
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    const noSegments = path.join(dir, 'empty.json');
    fs.writeFileSync(noSegments, '{}');
    const parsed = { metal: 'silver', weightOz: 1, barSegment: { class: 'generic' } };
    for (const file of [bad, noSegments, path.join(dir, 'missing.json')]) expect(lookupBarSegmentRange(parsed, { file })).toBeNull();
  });

  test('input without a segment, metal or a bucketed weight is null', () => {
    const file = dataFile([seg({})]);
    expect(lookupBarSegmentRange({ metal: 'silver', weightOz: 1 }, { file })).toBeNull();
    expect(lookupBarSegmentRange({ weightOz: 1, barSegment: { class: 'generic' } }, { file })).toBeNull();
    expect(lookupBarSegmentRange({ metal: 'silver', weightOz: 3.5, barSegment: { class: 'generic' } }, { file })).toBeNull();
    expect(lookupBarSegmentRange(null, { file })).toBeNull();
  });
});

describe('lookupPremiumRange keeps the static table when there is no reliable segment data', () => {
  test('a bar with a segment uses reliable segment data, and a coin with the same input does not', () => {
    const file = dataFile([seg({})]);
    const bar = lookupPremiumRange({ metal: 'silver', weightOz: 1, form: 'bar', barSegment: { class: 'generic' } }, { barPremiumsFile: file });
    expect(bar.source).toBe('bar-premiums');
    const coin = lookupPremiumRange({ metal: 'silver', weightOz: 1, form: 'coin', barSegment: { class: 'generic' } }, { barPremiumsFile: file });
    expect(coin.key).toBe('silver-coin-1oz-other');
    expect(coin.source).toBeUndefined();
  });

  test('bars with a segment use the static range while the committed data has no spot history', () => {
    const range = lookupPremiumRange({ metal: 'silver', weightOz: 1, form: 'bar', barSegment: { class: 'generic' } });
    expect(range).toEqual({ key: 'silver-bar-1oz', min: 0.08, max: 0.30 });
  });

  test('callers that pass no segment, and coins, are unchanged', () => {
    expect(lookupPremiumRange({ metal: 'silver', weightOz: 1, form: 'bar' })).toEqual({ key: 'silver-bar-1oz', min: 0.08, max: 0.30 });
    expect(lookupPremiumRange({ metal: 'gold', weightOz: 1, series: 'American Gold Eagle', barSegment: { class: 'generic' } }).key).toBe('gold-eagle-1oz');
  });

  test('platinum and palladium bars have no static range', () => {
    expect(lookupPremiumRange({ metal: 'platinum', weightOz: 1, form: 'bar', barSegment: { class: 'generic' } }).key).toBe('platinum-coin-1oz-other');
  });
});
