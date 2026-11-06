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
    n: 40, nWithSpot: 40, spotDays: 10, reliable: true, premium: { n: 40, p25: 0.10, median: 0.15, p75: 0.20 }, ...over,
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

describe('lookupBarSegmentRange does not trust the file', () => {
  const parsed = { metal: 'silver', weightOz: 1, barSegment: { class: 'generic' } };

  test.each([
    ['NaN quartiles (written as null)', { premium: { n: 40, p25: null, median: 0.1, p75: 0.2 } }],
    ['unordered quartiles', { premium: { n: 40, p25: 0.3, median: 0.2, p75: 0.1 } }],
    ['a premium sample below the minimum', { premium: { n: 4, p25: 0.1, median: 0.15, p75: 0.2 } }],
    ['too few spot-matched comps although flagged reliable', { nWithSpot: 4, reliable: true }],
    ['spot comps from fewer than three sale days although flagged reliable', { spotDays: 2, reliable: true }],
  ])('%s is not used', (_label, over) => {
    expect(lookupBarSegmentRange(parsed, { file: dataFile([seg(over)]) })).toBeNull();
  });

  test('the data file sets the sample minimum', () => {
    const file = path.join(dir, `min-sample-${n++}.json`);
    fs.writeFileSync(file, JSON.stringify({ version: 1, minSample: 50, segments: [seg({})] }));
    expect(lookupBarSegmentRange(parsed, { file })).toBeNull();
  });

  test('a range is clamped to -50% and +500%', () => {
    const file = dataFile([seg({ premium: { n: 40, p25: -0.4, median: 1, p75: 9 } })]);
    expect(lookupBarSegmentRange(parsed, { file })).toEqual(expect.objectContaining({ min: -0.5, max: 5 }));
  });
});

describe('the data file is re-read when it changes and a failed read is not remembered', () => {
  const parsed = { metal: 'silver', weightOz: 1, barSegment: { class: 'generic' } };

  test('regenerating the file changes the answer without a restart', () => {
    const file = dataFile([seg({})]);
    expect(lookupBarSegmentRange(parsed, { file }).min).toBe(-0.05);
    fs.writeFileSync(file, JSON.stringify({ version: 1, segments: [seg({ premium: { n: 40, p25: 0.2, median: 0.3, p75: 0.4 } })] }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(lookupBarSegmentRange(parsed, { file }).min).toBe(-0.1);
  });

  test('a half-written file gives null now and a good answer once it is complete', () => {
    const file = path.join(dir, `half-${n++}.json`);
    fs.writeFileSync(file, '{"segments": [');
    // The file keeps the same modification time: a remembered failure would hide the completed file.
    const realStat = fs.statSync;
    const spy = jest.spyOn(fs, 'statSync').mockImplementation((p, ...rest) => (p === file ? { mtimeMs: 1 } : realStat(p, ...rest)));
    try {
      expect(lookupBarSegmentRange(parsed, { file })).toBeNull();
      fs.writeFileSync(file, JSON.stringify({ version: 1, segments: [seg({})] }));
      expect(lookupBarSegmentRange(parsed, { file }).segment).toBe('generic');
    } finally {
      spy.mockRestore();
    }
  });

  test('a file that appears after a miss is picked up', () => {
    const file = path.join(dir, `late-${n++}.json`);
    expect(lookupBarSegmentRange(parsed, { file })).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ version: 1, segments: [seg({})] }));
    expect(lookupBarSegmentRange(parsed, { file }).segment).toBe('generic');
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

  test('bars with a segment use the static range when the data has no premiums', () => {
    const file = dataFile([seg({ premium: null, reliable: false, nWithSpot: 0 })]);
    const range = lookupPremiumRange({ metal: 'silver', weightOz: 1, form: 'bar', barSegment: { class: 'generic' } }, { barPremiumsFile: file });
    expect(range).toEqual({ key: 'silver-bar-1oz', min: 0.08, max: 0.30 });
  });

  test('callers that pass no segment, and coins, are unchanged', () => {
    expect(lookupPremiumRange({ metal: 'silver', weightOz: 1, form: 'bar' })).toEqual({ key: 'silver-bar-1oz', min: 0.08, max: 0.30 });
    expect(lookupPremiumRange({ metal: 'gold', weightOz: 1, series: 'American Gold Eagle', barSegment: { class: 'generic' } }).key).toBe('gold-eagle-1oz');
  });

  test('platinum and palladium bars have no static range', () => {
    const file = dataFile([]);
    expect(lookupPremiumRange({ metal: 'platinum', weightOz: 1, form: 'bar', barSegment: { class: 'generic' } }, { barPremiumsFile: file }).key).toBe('platinum-coin-1oz-other');
  });
});
