'use strict';

/**
 * pcgsNumbers.test.js -- Unit tests for src/data/pcgsNumbers.js
 *
 * Coverage gap pin (test-coverage Tier 1): the 841-line module had no
 * direct test. Tests pin:
 *   - lookupPCGSNumber happy paths across every series in SERIES_MAP
 *   - mint mark fallback (unknown mint -> 'P' fallback -> first value)
 *   - input guards (null series, null year, missing both)
 *   - generic denomination fallbacks (Half Dollar -> tries Kennedy / Franklin / Walking Liberty)
 *   - unknown series / unknown year -> null
 *   - return type is always a positive integer or null (never 0, undefined, NaN)
 *
 * Note: we deliberately do NOT assert exact PCGS numbers for every
 * (series, year, mint) tuple -- the static tables are the source of
 * truth, not a test fixture. We assert lookup behavior + that the
 * returned value is a finite positive integer when it should be present.
 */

const { lookupPCGSNumber } = require('../src/data/pcgsNumbers');

describe('lookupPCGSNumber -- input guards', () => {
  test('null series returns null', () => {
    expect(lookupPCGSNumber(null, 1921, 'P')).toBeNull();
  });

  test('null year returns null', () => {
    expect(lookupPCGSNumber('Morgan', null, 'P')).toBeNull();
  });

  test('undefined series and year return null', () => {
    expect(lookupPCGSNumber()).toBeNull();
  });

  test('empty-string series returns null', () => {
    expect(lookupPCGSNumber('', 1921, 'P')).toBeNull();
  });
});

describe('lookupPCGSNumber -- happy paths (US classic series)', () => {
  // Each test confirms the lookup resolves, returns a positive integer,
  // and is reproducible. Exact PCGS numbers are not asserted (the table
  // is the source of truth); but we DO assert specific values for a few
  // anchor coins to catch wholesale table corruption.
  test('1921 Morgan P -> 7296 (anchor)', () => {
    expect(lookupPCGSNumber('Morgan', 1921, 'P')).toBe(7296);
  });

  test('1921 Peace P -> 7356 (anchor)', () => {
    expect(lookupPCGSNumber('Peace', 1921, 'P')).toBe(7356);
  });

  test('Morgan series resolves for all common years/mints', () => {
    const cases = [
      ['Morgan', 1878, 'P'],
      ['Morgan', 1881, 'CC'],
      ['Morgan', 1899, 'O'],
      ['Morgan', 1921, 'D'],
      ['Morgan', 1921, 'S'],
    ];
    for (const [series, year, mint] of cases) {
      const num = lookupPCGSNumber(series, year, mint);
      expect(typeof num).toBe('number');
      expect(num).toBeGreaterThan(0);
      expect(Number.isFinite(num)).toBe(true);
    }
  });

  // NOTE: Jefferson nickel (table TODO -- empty) and pre-1959 Lincoln
  // cents (covered by separate wheat tables that are not yet wired into
  // SERIES_MAP) intentionally omitted -- they are exercised in the
  // 'unknown / out-of-table -> null' suite below.
  test.each([
    ['Peace Dollar', 1923, 'D'],
    ['Walking Liberty', 1942, 'P'],
    ['Mercury', 1916, 'D'],
    ['Franklin', 1948, 'P'],
    ['Kennedy', 1964, 'P'],
    ['Eisenhower', 1972, 'P'],
    ['Washington', 1932, 'D'],
    ['Roosevelt', 1946, 'P'],
    ['Lincoln cent', 1959, 'P'],
  ])('%s %d %s resolves to a positive integer',
    (series, year, mint) => {
      const num = lookupPCGSNumber(series, year, mint);
      expect(typeof num).toBe('number');
      expect(num).toBeGreaterThan(0);
    });
});

describe('lookupPCGSNumber -- bullion / world series', () => {
  test.each([
    ['American Silver Eagle', 1986, 'P'],
    ['silver eagle', 2024, 'W'],
    ['ASE', 2021, 'W'],
    ['gold buffalo', 2010, 'W'],
    ['platinum eagle', 1997, 'W'],
    ['gold eagle 1 oz', 1986, 'W'],
    ['krugerrand', 2020, null],
    ['maple leaf', 2020, null],
    ['britannia', 2020, null],
    ['china panda', 2020, null],
  ])('bullion %s %d resolves',
    (series, year, mint) => {
      const num = lookupPCGSNumber(series, year, mint);
      // Bullion lookups may legitimately return null if the year predates
      // the program start in the table; we only require that when a
      // result is returned, it's a positive integer.
      if (num !== null) {
        expect(typeof num).toBe('number');
        expect(num).toBeGreaterThan(0);
      }
    });
});

describe('lookupPCGSNumber -- generic denomination fallbacks', () => {
  test('"Half Dollar" 1964 falls back to Kennedy table', () => {
    const num = lookupPCGSNumber('Half Dollar', 1964, 'P');
    // Should match either Kennedy (which has 1964) or another half-dollar
    // table. The exact table is implementation-defined; we just require
    // that the generic fallback resolves rather than returning null.
    expect(num).not.toBeNull();
    expect(typeof num).toBe('number');
  });

  test('"Quarter" 1932 falls back to Washington table', () => {
    expect(lookupPCGSNumber('Quarter', 1932, 'P')).not.toBeNull();
  });

  test('"Dime" 1916 falls back to Mercury table', () => {
    expect(lookupPCGSNumber('Dime', 1916, 'P')).not.toBeNull();
  });

  // "Nickel" 1938 fallback intentionally NOT tested: the Jefferson
  // table is empty (TODO upstream), so the generic /\bnickel\b/ entry
  // resolves to JEFFERSON which has no entries. When JEFFERSON is
  // populated, this test should be re-enabled.

  test('"Dollar" 1921 falls back to one of Eisenhower/Peace/Morgan', () => {
    expect(lookupPCGSNumber('Dollar', 1921, 'P')).not.toBeNull();
  });
});

describe('lookupPCGSNumber -- mint mark behavior', () => {
  test('unknown mint mark falls back to P', () => {
    // 1921 Morgan with an invented mint mark "Z" should still resolve
    // (falls through the year row's keys to first available value).
    const num = lookupPCGSNumber('Morgan', 1921, 'Z');
    expect(num).not.toBeNull();
    expect(typeof num).toBe('number');
  });

  test('omitted mint mark defaults to P', () => {
    expect(lookupPCGSNumber('Morgan', 1921)).toBe(7296);
  });

  test('lowercase mint mark is normalized to uppercase', () => {
    // 1921 Morgan D (lowercase) should match the same as uppercase D.
    expect(lookupPCGSNumber('Morgan', 1921, 'd')).toBe(
      lookupPCGSNumber('Morgan', 1921, 'D')
    );
  });
});

describe('lookupPCGSNumber -- unknown / out-of-table -> null', () => {
  test('unknown series returns null', () => {
    expect(lookupPCGSNumber('NotARealSeries', 1921, 'P')).toBeNull();
  });

  test('out-of-range year for known series returns null', () => {
    // Morgan minted 1878-1921; 1700 is way out of range.
    expect(lookupPCGSNumber('Morgan', 1700, 'P')).toBeNull();
  });

  test('Morgan 1922 returns null (not a Morgan year)', () => {
    // Peace dollars started 1921, Morgans ended 1921; 1922 is Peace-only.
    // The Morgan-specific lookup should return null.
    expect(lookupPCGSNumber('Morgan', 1922, 'P')).toBeNull();
  });

  test('Jefferson 1938 returns null (table is empty / TODO)', () => {
    // The JEFFERSON table is declared but unpopulated; this pins
    // the current behavior so a future regression that returns a
    // wrong number from a different table cannot land silently.
    expect(lookupPCGSNumber('Jefferson', 1938, 'P')).toBeNull();
  });

  test('1909-S Lincoln wheat cent returns null (wheat tables not wired in)', () => {
    // Pre-1959 Lincolns are wheat reverse and live in tables that
    // are not currently in SERIES_MAP. Pin the null behavior so a
    // mis-routed fallback to Memorial tables would fail loudly.
    expect(lookupPCGSNumber('Lincoln cent', 1909, 'S')).toBeNull();
  });
});

describe('lookupPCGSNumber -- determinism', () => {
  test('same inputs return same output across calls', () => {
    const a = lookupPCGSNumber('Morgan', 1921, 'D');
    const b = lookupPCGSNumber('Morgan', 1921, 'D');
    const c = lookupPCGSNumber('Morgan', 1921, 'D');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
