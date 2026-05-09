// __tests__/barSeries.test.js — Unit tests for bar series data and detection
'use strict';

const {
  BAR_SERIES,
  getSeriesForBrand,
  detectBarSeries,
  detectSeriesFromTitle,
} = require('../src/data/barSeries');

// ════════════════════════════════════════════════════════════
//  Data structure integrity
// ════════════════════════════════════════════════════════════
describe('BAR_SERIES data integrity', () => {
  test('every brand has at least one series', () => {
    for (const [brand, entries] of Object.entries(BAR_SERIES)) {
      expect(entries.length).toBeGreaterThan(0);
    }
  });

  test('every entry has required fields', () => {
    for (const [brand, entries] of Object.entries(BAR_SERIES)) {
      for (const e of entries) {
        expect(e).toHaveProperty('series');
        expect(e).toHaveProperty('re');
        expect(e).toHaveProperty('keywords');
        expect(e).toHaveProperty('aliases');
        expect(typeof e.series).toBe('string');
        expect(e.re).toBeInstanceOf(RegExp);
        expect(typeof e.keywords).toBe('string');
        expect(Array.isArray(e.aliases)).toBe(true);
      }
    }
  });

  test('no duplicate series names within a brand', () => {
    for (const [brand, entries] of Object.entries(BAR_SERIES)) {
      const names = entries.map(e => e.series.toLowerCase());
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

// ════════════════════════════════════════════════════════════
//  getSeriesForBrand
// ════════════════════════════════════════════════════════════
describe('getSeriesForBrand', () => {
  test('Geiger returns entries', () => {
    expect(getSeriesForBrand('Geiger').length).toBeGreaterThan(0);
  });
  test('PAMP returns entries (strips "Suisse")', () => {
    expect(getSeriesForBrand('PAMP Suisse').length).toBeGreaterThan(0);
    expect(getSeriesForBrand('PAMP').length).toBeGreaterThan(0);
  });
  test('Perth Mint returns entries', () => {
    expect(getSeriesForBrand('Perth Mint').length).toBeGreaterThan(0);
  });
  test('Scottsdale returns entries', () => {
    expect(getSeriesForBrand('Scottsdale').length).toBeGreaterThan(0);
  });
  test('Valcambi returns entries', () => {
    expect(getSeriesForBrand('Valcambi').length).toBeGreaterThan(0);
  });
  test('unknown brand returns empty array', () => {
    expect(getSeriesForBrand('RandomBrand')).toEqual([]);
  });
  test('null/undefined returns empty array', () => {
    expect(getSeriesForBrand(null)).toEqual([]);
    expect(getSeriesForBrand(undefined)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
//  detectBarSeries
// ════════════════════════════════════════════════════════════
describe('detectBarSeries', () => {
  // Geiger
  test('Geiger + edelmetalle → Edelmetalle', () => {
    const r = detectBarSeries('Geiger', 'edelmetalle');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Edelmetalle');
  });
  test('Geiger + square → Square', () => {
    const r = detectBarSeries('Geiger', 'square');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Square');
  });
  test('Geiger + schloss → Schloss Guldengossa', () => {
    const r = detectBarSeries('Geiger', 'schloss');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Schloss Guldengossa');
  });

  // PAMP
  test('PAMP + fortuna → Fortuna', () => {
    const r = detectBarSeries('PAMP', 'fortuna');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Fortuna');
  });
  test('PAMP Suisse + lady fortuna → Fortuna (alias)', () => {
    const r = detectBarSeries('PAMP Suisse', 'lady fortuna');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Fortuna');
  });
  test('PAMP + rosa → Rosa', () => {
    const r = detectBarSeries('PAMP', 'rosa');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Rosa');
  });
  test('PAMP + multigram → Multigram', () => {
    const r = detectBarSeries('PAMP', 'multigram');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Multigram');
  });

  // Perth Mint
  test('Perth Mint + cast → Cast', () => {
    const r = detectBarSeries('Perth Mint', 'cast');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Cast');
  });
  test('Perth Mint + lakshmi → Lakshmi', () => {
    const r = detectBarSeries('Perth Mint', 'lakshmi');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Lakshmi');
  });

  // Scottsdale
  test('Scottsdale + stacker → Stacker', () => {
    const r = detectBarSeries('Scottsdale', 'stacker');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Stacker');
  });
  test('Scottsdale + tombstone → Tombstone', () => {
    const r = detectBarSeries('Scottsdale', 'tombstone');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Tombstone');
  });

  // Valcambi
  test('Valcambi + combibar → CombiBar', () => {
    const r = detectBarSeries('Valcambi', 'combibar');
    expect(r).not.toBeNull();
    expect(r.series).toBe('CombiBar');
  });

  // Heraeus
  test('Heraeus + kinebar → Kinebar', () => {
    const r = detectBarSeries('Heraeus', 'kinebar');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Kinebar');
  });

  // Edge cases
  test('null brand returns null', () => {
    expect(detectBarSeries(null, 'fortuna')).toBeNull();
  });
  test('null series returns null', () => {
    expect(detectBarSeries('PAMP', null)).toBeNull();
  });
  test('unknown series for known brand returns null', () => {
    expect(detectBarSeries('PAMP', 'xyznonexistent')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
//  detectSeriesFromTitle
// ════════════════════════════════════════════════════════════
describe('detectSeriesFromTitle', () => {
  test('detects Edelmetalle in eBay title', () => {
    const r = detectSeriesFromTitle('Geiger', 'Geiger Edelmetalle 1 gram Gold Bar Sealed');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Edelmetalle');
  });

  test('detects Fortuna in eBay title', () => {
    const r = detectSeriesFromTitle('PAMP', 'PAMP Suisse 1 oz Gold Bar Lady Fortuna Veriscan');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Fortuna');
  });

  test('detects Cast in Perth Mint title', () => {
    const r = detectSeriesFromTitle('Perth Mint', '1 oz Perth Mint Gold Cast Bar');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Cast');
  });

  test('detects Stacker in Scottsdale title', () => {
    const r = detectSeriesFromTitle('Scottsdale', 'Scottsdale 10 oz Silver Stacker Bar');
    expect(r).not.toBeNull();
    expect(r.series).toBe('Stacker');
  });

  test('returns null for title without series keyword', () => {
    const r = detectSeriesFromTitle('PAMP', 'PAMP Suisse 1 oz Gold Bar Plain');
    expect(r).toBeNull();
  });

  test('returns null for unknown brand', () => {
    const r = detectSeriesFromTitle('RandomBrand', 'Some Gold Bar Fortuna');
    expect(r).toBeNull();
  });
});
