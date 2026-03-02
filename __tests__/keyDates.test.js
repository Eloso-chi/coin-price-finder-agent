/**
 * keyDates.test.js — Unit tests for src/data/keyDates.js
 *
 * Covers: lookupKeyDate 4-tier fallback (exact → wildcard-mint →
 * wildcard-year → fuzzy-series), case insensitivity, non-existent coins,
 * and data integrity of the KEY_DATES table.
 */

'use strict';

const { lookupKeyDate, KEY_DATES } = require('../src/data/keyDates');

// ═══════════════════════════════════════════════════════════════
//  Tier 1: Exact match (series + year + mint)
// ═══════════════════════════════════════════════════════════════

describe('lookupKeyDate — exact match', () => {
  test('1893-S Morgan Dollar is key date', () => {
    const r = lookupKeyDate('Morgan Dollar', 1893, 'S');
    expect(r.isKeyDate).toBe(true);
    expect(r.tier).toBe('key');
    expect(r.note).toMatch(/King of Morgans/i);
  });

  test('1916-D Mercury Dime is key date', () => {
    const r = lookupKeyDate('Mercury Dime', 1916, 'D');
    expect(r.isKeyDate).toBe(true);
    expect(r.tier).toBe('key');
  });

  test('1928 Peace Dollar (Philly) is key date', () => {
    const r = lookupKeyDate('Peace Dollar', 1928, '');
    expect(r.isKeyDate).toBe(true);
    expect(r.tier).toBe('key');
  });

  test('case-insensitive series matching', () => {
    const r = lookupKeyDate('MORGAN DOLLAR', 1893, 'S');
    expect(r.isKeyDate).toBe(true);
  });

  test('case-insensitive mint matching', () => {
    const r = lookupKeyDate('Morgan Dollar', 1889, 'cc');
    expect(r.isKeyDate).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Tier 2: Wildcard mint (year=0 means "any year", mint="*")
// ═══════════════════════════════════════════════════════════════

describe('lookupKeyDate — wildcard mint', () => {
  // Franklin Half: year=0, mint='*' → condition rarity for FBL
  test('any Franklin half triggers condition-rarity (FBL)', () => {
    const r = lookupKeyDate('Franklin Half', 1952, 'D');
    expect(r.isKeyDate).toBe(true);
    expect(r.tier).toBe('condition-rarity');
    expect(r.note).toMatch(/Full Bell Lines/i);
  });

  test('Franklin half with no mint mark still matches wildcard', () => {
    const r = lookupKeyDate('Franklin Half', 1960, '');
    expect(r.isKeyDate).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Tier 4: Fuzzy series matching
// ═══════════════════════════════════════════════════════════════

describe('lookupKeyDate — fuzzy series matching', () => {
  test('"standing liberty" matches "standing liberty quarter"', () => {
    const r = lookupKeyDate('Standing Liberty', 1916, '');
    expect(r.isKeyDate).toBe(true);
    expect(r.tier).toBe('key');
  });

  test('"walking liberty" matches "walking liberty half"', () => {
    const r = lookupKeyDate('Walking Liberty', 1921, '');
    expect(r.isKeyDate).toBe(true);
    expect(r.tier).toBe('key');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Non-existent / no match
// ═══════════════════════════════════════════════════════════════

describe('lookupKeyDate — no match', () => {
  test('common date returns isKeyDate: false', () => {
    const r = lookupKeyDate('Morgan Dollar', 1881, '');
    expect(r.isKeyDate).toBe(false);
  });

  test('unknown series returns isKeyDate: false', () => {
    const r = lookupKeyDate('Fictional Coin', 2000, '');
    expect(r.isKeyDate).toBe(false);
  });

  test('null series returns isKeyDate: false', () => {
    const r = lookupKeyDate(null, 1893, 'S');
    expect(r.isKeyDate).toBe(false);
  });

  test('empty string series returns isKeyDate: false', () => {
    const r = lookupKeyDate('', 1893, 'S');
    expect(r.isKeyDate).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Data integrity
// ═══════════════════════════════════════════════════════════════

describe('KEY_DATES table integrity', () => {
  test('every entry has required fields', () => {
    for (const e of KEY_DATES) {
      expect(typeof e.series).toBe('string');
      expect(e.series.length).toBeGreaterThan(0);
      expect(typeof e.year).toBe('number');
      expect(typeof e.mint).toBe('string');
      expect(['key', 'semi-key', 'condition-rarity', 'variety', 'low-mintage']).toContain(e.tier);
      expect(typeof e.note).toBe('string');
    }
  });

  test('table has at least 100 entries', () => {
    expect(KEY_DATES.length).toBeGreaterThanOrEqual(100);
  });

  test('no duplicate exact keys', () => {
    const seen = new Set();
    for (const e of KEY_DATES) {
      const k = `${e.series.toLowerCase()}|${e.year}|${e.mint.toLowerCase()}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});
