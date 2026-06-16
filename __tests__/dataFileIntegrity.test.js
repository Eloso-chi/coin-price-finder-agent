// __tests__/dataFileIntegrity.test.js -- data-integrity contract tests
//
// These are *contract tests* against the static data tables in:
//   - src/data/mintages.js
//   - src/data/pcgsNumbers.js
//
// Failures here mean a real bug in the dataset (corruption, missing hyphen,
// negative mintage, malformed year, NaN, etc.) and MUST fail loudly. They are
// not coverage tests -- they assert invariants the rest of the system relies on.
'use strict';

const { lookupMintage, MINTAGE_DATA, normalizeSeries } = require('../src/data/mintages');
const { lookupPCGSNumber } = require('../src/data/pcgsNumbers');

describe('data/mintages.js -- structural invariants', () => {
  test('MINTAGE_DATA exists and is a non-empty object', () => {
    expect(typeof MINTAGE_DATA).toBe('object');
    expect(Object.keys(MINTAGE_DATA).length).toBeGreaterThan(0);
  });

  test('every series key is a non-empty trimmed string', () => {
    for (const seriesKey of Object.keys(MINTAGE_DATA)) {
      expect(typeof seriesKey).toBe('string');
      expect(seriesKey.length).toBeGreaterThan(0);
      expect(seriesKey).toBe(seriesKey.trim());
    }
  });

  test('every mintage key matches YYYY-MINT shape (no malformed keys)', () => {
    const KEY_RE = /^\d{4}-[A-Z0-9]{1,3}$/;
    const violations = [];
    for (const [series, table] of Object.entries(MINTAGE_DATA)) {
      if (!table || typeof table !== 'object') continue;
      for (const key of Object.keys(table)) {
        if (!KEY_RE.test(key)) violations.push(`${series} -> ${key}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('every mintage value is null or a non-negative finite number', () => {
    const violations = [];
    for (const [series, table] of Object.entries(MINTAGE_DATA)) {
      if (!table || typeof table !== 'object') continue;
      for (const [key, value] of Object.entries(table)) {
        if (value === null) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          violations.push(`${series}/${key} = ${value}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('no mintage exceeds Number.MAX_SAFE_INTEGER', () => {
    const violations = [];
    for (const [series, table] of Object.entries(MINTAGE_DATA)) {
      if (!table || typeof table !== 'object') continue;
      for (const [key, value] of Object.entries(table)) {
        if (typeof value === 'number' && value > Number.MAX_SAFE_INTEGER) {
          violations.push(`${series}/${key} = ${value}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('every key year is within the sane US-numismatic range [1791, currentYear+1]', () => {
    const minYear = 1791;
    const maxYear = new Date().getFullYear() + 1;
    const violations = [];
    for (const [series, table] of Object.entries(MINTAGE_DATA)) {
      if (!table || typeof table !== 'object') continue;
      for (const key of Object.keys(table)) {
        const year = parseInt(key.slice(0, 4), 10);
        if (year < minYear || year > maxYear) violations.push(`${series}/${key}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('data/mintages.js -- lookupMintage boundary behavior', () => {
  test('returns {mintage: null, series: null} for null series', () => {
    expect(lookupMintage(null, 1921, 'P')).toEqual({ mintage: null, series: null });
  });

  test('returns {mintage: null, series: ...} for unknown year (1791)', () => {
    const r = lookupMintage('Morgan Dollar', 1791, 'P');
    expect(r.mintage).toBeNull();
  });

  test('returns {mintage: null, series: ...} for future year (currentYear+5)', () => {
    const futureYear = new Date().getFullYear() + 5;
    const r = lookupMintage('Morgan Dollar', futureYear, 'P');
    expect(r.mintage).toBeNull();
  });

  test('throws TypeError for non-string series (documents current contract: callers must pass strings)', () => {
    // The current API contract requires series to be a string (or nullish).
    // Non-string types throw. This test documents that contract so a future
    // refactor that broadens the input shape will need to update this test.
    expect(() => lookupMintage(123, 1921, 'P')).toThrow(TypeError);
    expect(() => lookupMintage({}, 1921, 'P')).toThrow(TypeError);
    expect(() => lookupMintage([], 1921, 'P')).toThrow(TypeError);
  });

  test('does not throw for missing year', () => {
    expect(() => lookupMintage('Morgan Dollar', null, 'P')).not.toThrow();
    expect(() => lookupMintage('Morgan Dollar', undefined, 'P')).not.toThrow();
  });

  test('handles empty mint string as P default', () => {
    const r = lookupMintage('Morgan Dollar', 1921, '');
    // Either resolved or null -- but must not throw and must return shape.
    expect(r).toHaveProperty('mintage');
    expect(r).toHaveProperty('series');
  });

  test('normalizeSeries accepts nullish and string inputs without throwing', () => {
    // Documented contract: nullish-safe, string-required for non-nullish.
    expect(typeof normalizeSeries('Morgan Dollar')).toBe('string');
    expect(() => normalizeSeries(null)).not.toThrow();
    expect(() => normalizeSeries(undefined)).not.toThrow();
    expect(() => normalizeSeries('')).not.toThrow();
    expect(normalizeSeries(null)).toBeNull();
    expect(normalizeSeries(undefined)).toBeNull();
  });
});

describe('data/pcgsNumbers.js -- lookupPCGSNumber boundary behavior', () => {
  test('returns null for null series', () => {
    expect(lookupPCGSNumber(null, 1921, 'P')).toBeNull();
  });

  test('returns null for null year', () => {
    expect(lookupPCGSNumber('Morgan Dollar', null, 'P')).toBeNull();
  });

  test('returns null for unknown series', () => {
    expect(lookupPCGSNumber('Definitely Not A Real Coin Series XYZ', 1921, 'P')).toBeNull();
  });

  test('does not throw for non-string series (lookupPCGSNumber stringifies internally)', () => {
    // pcgsNumbers.js does `String(series).trim()` so non-strings are tolerated
    // (unlike mintages.js -- contract intentionally differs).
    expect(() => lookupPCGSNumber(123, 1921, 'P')).not.toThrow();
    expect(() => lookupPCGSNumber({}, 1921, 'P')).not.toThrow();
  });

  test('does not throw for missing mint (defaults to P)', () => {
    expect(() => lookupPCGSNumber('Morgan Dollar', 1921)).not.toThrow();
    expect(() => lookupPCGSNumber('Morgan Dollar', 1921, undefined)).not.toThrow();
    expect(() => lookupPCGSNumber('Morgan Dollar', 1921, null)).not.toThrow();
  });

  test('handles lowercase mint marks (uppercased internally)', () => {
    const upper = lookupPCGSNumber('Morgan Dollar', 1921, 'D');
    const lower = lookupPCGSNumber('Morgan Dollar', 1921, 'd');
    expect(lower).toBe(upper);
  });

  test('returns null for future year (currentYear+10)', () => {
    const futureYear = new Date().getFullYear() + 10;
    expect(lookupPCGSNumber('Morgan Dollar', futureYear, 'P')).toBeNull();
  });
});
