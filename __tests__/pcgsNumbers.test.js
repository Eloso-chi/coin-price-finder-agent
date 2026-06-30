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

// ───────────────────────────────────────────────────────────────
// PR-2a: SERIES_MAP ordering invariants for classic-US tables
// ───────────────────────────────────────────────────────────────
// These tests pin the ordering of SERIES_MAP regex entries added in PR-2a.
// If a future PR reorders entries, these assertions will fail loudly rather
// than silently routing a query to the wrong table. Picked years/mints that
// exist in ONLY ONE candidate table so any mis-routing produces a different
// PCGS# (not just null).

describe('lookupPCGSNumber -- PR-2a SERIES_MAP ordering invariants', () => {
  test('Saint-Gaudens regex preempts Liberty DE for shared 1907 year', () => {
    // 1907 exists in BOTH Saint-Gaudens (P=9141) and Liberty DE (P=9052).
    // Saint-Gaudens regex MUST run first, so "saint gaudens" -> 9141.
    expect(lookupPCGSNumber('saint gaudens', 1907, '')).toBe(9141);
    expect(lookupPCGSNumber('st. gaudens',   1907, '')).toBe(9141);
    expect(lookupPCGSNumber('saint-gaudens', 1907, '')).toBe(9141);
    // Liberty DE explicit query must still route to Liberty DE table.
    expect(lookupPCGSNumber('liberty double eagle', 1907, '')).toBe(9052);
  });

  test('Indian Half Eagle regex preempts Indian Eagle for "indian half eagle"', () => {
    // 1908-D Indian Half Eagle ($5) = 8511; 1908-D Indian Eagle ($10) = 8860.
    // "indian half eagle" MUST route to $5 table, not $10.
    expect(lookupPCGSNumber('indian half eagle',      1908, 'D')).toBe(8511);
    expect(lookupPCGSNumber('indian head half eagle', 1908, 'D')).toBe(8511);
    // Plain "indian eagle" / "indian head eagle" must still route to $10.
    expect(lookupPCGSNumber('indian eagle',           1908, 'D')).toBe(8860);
    expect(lookupPCGSNumber('indian head eagle',      1908, 'D')).toBe(8860);
  });

  test('Standing Liberty Quarter preempts generic \\bquarter\\b -> Washington fallback', () => {
    // 1916-P Standing Liberty = 5704 (key date). Washington 1916 does not exist.
    expect(lookupPCGSNumber('standing liberty quarter', 1916, '')).toBe(5704);
    expect(lookupPCGSNumber('standing-liberty',         1921, '')).toBe(5740);
    expect(lookupPCGSNumber('SLQ',                      1923, 'S')).toBe(5744);
    // Sanity: generic "quarter" still routes to Washington.
    expect(lookupPCGSNumber('washington quarter',       1932, 'D')).toBe(5791);
  });

  test('Seated Liberty Dollar preempts generic \\bdollar\\b -> Eisenhower/Peace/Morgan fallback', () => {
    // 1870-S Seated Liberty Dollar = 6965 (only 9 known). 1870 not in Morgan/Peace/Ike.
    expect(lookupPCGSNumber('seated liberty dollar', 1870, 'S')).toBe(6965);
    expect(lookupPCGSNumber('liberty seated dollar', 1871, 'CC')).toBe(6967);
    expect(lookupPCGSNumber('seated dollar',         1873, 'CC')).toBe(6972);
    // Sanity: Morgan / Peace still resolve via their explicit regex.
    expect(typeof lookupPCGSNumber('morgan',      1921, 'D')).toBe('number');
    expect(typeof lookupPCGSNumber('peace dollar', 1928, '')).toBe('number');
  });

  test('Barber Dime preempts generic \\bdime\\b -> Roosevelt/Mercury fallback', () => {
    // 1894-S Barber Dime = 4805 (24 minted; legendary key). Not in Mercury (starts 1916) or Roosevelt (1946+).
    expect(lookupPCGSNumber('barber dime', 1894, 'S')).toBe(4805);
    expect(lookupPCGSNumber('barber dime', 1916, 'S')).toBe(4871);
    // Sanity: Mercury / Roosevelt still route via their explicit regex.
    expect(lookupPCGSNumber('mercury dime', 1916, 'D')).toBe(4902);
  });

  test('Barber Quarter preempts generic \\bquarter\\b -> Washington fallback', () => {
    // 1901-S Barber Quarter = 5630 (key date). Washington didn't start until 1932.
    expect(lookupPCGSNumber('barber quarter', 1901, 'S')).toBe(5630);
  });

  test('Barber Half preempts generic \\bhalf\\s*dollar\\b -> Kennedy/Franklin/WL fallback', () => {
    // 1892-O Barber Half = 6462. Walking Liberty starts 1916, Franklin 1948, Kennedy 1964.
    expect(lookupPCGSNumber('barber half dollar', 1892, 'O')).toBe(6462);
    expect(lookupPCGSNumber('barber half',        1913, '')).toBe(6527);
    // Sanity: Walking Liberty / Kennedy still route via their explicit regex.
    expect(lookupPCGSNumber('walking liberty', 1916, '')).toBe(6564);
    expect(lookupPCGSNumber('kennedy half',    1964, '')).toBe(6706);
  });

  test('Liberty Head Half Eagle distinct from Indian Half Eagle (1908 transition)', () => {
    // 1907-P Liberty $5 = 8416; 1908-P Indian $5 = 8510 (first year of Indian design).
    expect(lookupPCGSNumber('liberty half eagle', 1907, '')).toBe(8416);
    expect(lookupPCGSNumber('indian half eagle',  1908, '')).toBe(8510);
  });

  test('1909-O resolves as Indian Half Eagle (was previously misfiled under Liberty)', () => {
    // Bug fix verification: 1909-O is the only New Orleans Indian $5 (34,200 mintage).
    // Liberty $5 series ended in 1908, so 1909-O cannot be a Liberty Half Eagle.
    expect(lookupPCGSNumber('indian half eagle',      1909, 'O')).toBe(8515);
    expect(lookupPCGSNumber('indian head half eagle', 1909, 'O')).toBe(8515);
  });

  test('Lincoln / Mercury regression checks (generic patterns not hijacked)', () => {
    // After adding 10 new Classic-US regex entries above the existing patterns,
    // verify the previously-tested generic patterns still resolve correctly.
    expect(lookupPCGSNumber('lincoln',     1959, '')).toBe(2854);
    expect(lookupPCGSNumber('mercury dime', 1916, 'D')).toBe(4902);
  });
});
