/**
 * constants.test.js — Unit tests for src/data/constants.js
 *
 * Covers: zodiacForYear() cycle correctness, boundary years,
 * perthLunarSeries() ranges, and edge cases.
 */

'use strict';

const { ZODIAC, zodiacForYear, perthLunarSeries, BULLION_1OZ_DEFAULT, ALLOWED_LABELS } = require('../src/data/constants');

// ═══════════════════════════════════════════════════════════════
//  zodiacForYear()
// ═══════════════════════════════════════════════════════════════

describe('zodiacForYear()', () => {
  test('2020 = Rat (anchor year)', () => {
    expect(zodiacForYear(2020)).toBe('Rat');
  });

  test('complete 12-year cycle from 2020', () => {
    const expected = ['Rat','Ox','Tiger','Rabbit','Dragon','Snake','Horse','Goat','Monkey','Rooster','Dog','Pig'];
    for (let i = 0; i < 12; i++) {
      expect(zodiacForYear(2020 + i)).toBe(expected[i]);
    }
  });

  test('wraps correctly into next cycle (2032 = Rat)', () => {
    expect(zodiacForYear(2032)).toBe('Rat');
  });

  test('backward cycle (Perth Series II: 2008-2019)', () => {
    expect(zodiacForYear(2008)).toBe('Rat');
    expect(zodiacForYear(2017)).toBe('Rooster');
    expect(zodiacForYear(2019)).toBe('Pig');
  });

  test('Perth Series I: 1996 Rat through 2007 Pig', () => {
    expect(zodiacForYear(1996)).toBe('Rat');
    expect(zodiacForYear(2007)).toBe('Pig');
  });

  test('returns null for year < 1996', () => {
    expect(zodiacForYear(1995)).toBeNull();
    expect(zodiacForYear(1900)).toBeNull();
  });

  test('returns null for falsy input', () => {
    expect(zodiacForYear(0)).toBeNull();
    expect(zodiacForYear(null)).toBeNull();
    expect(zodiacForYear(undefined)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  perthLunarSeries()
// ═══════════════════════════════════════════════════════════════

describe('perthLunarSeries()', () => {
  test('Series I: 1996-2007', () => {
    expect(perthLunarSeries(1996)).toEqual({ label: 'Series I', num: 'I' });
    expect(perthLunarSeries(2007)).toEqual({ label: 'Series I', num: 'I' });
  });

  test('Series II: 2008-2019', () => {
    expect(perthLunarSeries(2008)).toEqual({ label: 'Series II', num: 'II' });
    expect(perthLunarSeries(2019)).toEqual({ label: 'Series II', num: 'II' });
  });

  test('Series III: 2020-2031', () => {
    expect(perthLunarSeries(2020)).toEqual({ label: 'Series III', num: 'III' });
    expect(perthLunarSeries(2031)).toEqual({ label: 'Series III', num: 'III' });
  });

  test('year outside all series returns nulls', () => {
    expect(perthLunarSeries(1990)).toEqual({ label: null, num: null });
    expect(perthLunarSeries(2040)).toEqual({ label: null, num: null });
  });

  test('falsy year returns nulls', () => {
    expect(perthLunarSeries(0)).toEqual({ label: null, num: null });
    expect(perthLunarSeries(null)).toEqual({ label: null, num: null });
    expect(perthLunarSeries(undefined)).toEqual({ label: null, num: null });
  });
});

// ═══════════════════════════════════════════════════════════════
//  ZODIAC array
// ═══════════════════════════════════════════════════════════════

describe('ZODIAC constant', () => {
  test('has exactly 12 animals', () => {
    expect(ZODIAC).toHaveLength(12);
  });

  test('starts with Rat, ends with Pig', () => {
    expect(ZODIAC[0]).toBe('Rat');
    expect(ZODIAC[11]).toBe('Pig');
  });
});

// ═══════════════════════════════════════════════════════════════
//  BULLION_1OZ_DEFAULT
// ═══════════════════════════════════════════════════════════════

describe('BULLION_1OZ_DEFAULT', () => {
  test('is an array with 15 entries', () => {
    expect(Array.isArray(BULLION_1OZ_DEFAULT)).toBe(true);
    expect(BULLION_1OZ_DEFAULT).toHaveLength(15);
  });

  test('contains expected core bullion series', () => {
    expect(BULLION_1OZ_DEFAULT).toContain('silver eagle');
    expect(BULLION_1OZ_DEFAULT).toContain('maple leaf');
    expect(BULLION_1OZ_DEFAULT).toContain('krugerrand');
    expect(BULLION_1OZ_DEFAULT).toContain('britannia');
  });

  test('all entries are lowercase strings', () => {
    for (const entry of BULLION_1OZ_DEFAULT) {
      expect(typeof entry).toBe('string');
      expect(entry).toBe(entry.toLowerCase());
    }
  });
});

// ═══════════════════════════════════════════════════════════════
//  ALLOWED_LABELS
// ═══════════════════════════════════════════════════════════════

describe('ALLOWED_LABELS', () => {
  test('is a Set with 26 entries', () => {
    expect(ALLOWED_LABELS).toBeInstanceOf(Set);
    expect(ALLOWED_LABELS.size).toBe(26);
  });

  test('contains expected label values', () => {
    expect(ALLOWED_LABELS.has('First Strike')).toBe(true);
    expect(ALLOWED_LABELS.has('Burnished')).toBe(true);
    expect(ALLOWED_LABELS.has('Reverse Proof')).toBe(true);
    expect(ALLOWED_LABELS.has('Type 2')).toBe(true);
  });

  test('rejects unlisted labels', () => {
    expect(ALLOWED_LABELS.has('Random Label')).toBe(false);
    expect(ALLOWED_LABELS.has('')).toBe(false);
    expect(ALLOWED_LABELS.has('first strike')).toBe(false); // case-sensitive
  });
});
