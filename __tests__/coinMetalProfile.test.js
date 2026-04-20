// __tests__/coinMetalProfile.test.js — Unit tests for src/utils/coinMetalProfile.js
'use strict';

const { getCoinMetalProfile, BULLION_SERIES, SILVER_US_COIN_SERIES, GOLD_US_COIN_SERIES } = require('../src/utils/coinMetalProfile');

// ════════════════════════════════════════════════════════════
//  getCoinMetalProfile
// ════════════════════════════════════════════════════════════
describe('getCoinMetalProfile', () => {

  // ── Edge cases ────────────────────────────────────────────
  test('returns { isMetalBased: false, metal: null } for falsy input', () => {
    expect(getCoinMetalProfile(null)).toEqual({ isMetalBased: false, metal: null });
    expect(getCoinMetalProfile('')).toEqual({ isMetalBased: false, metal: null });
    expect(getCoinMetalProfile(undefined)).toEqual({ isMetalBased: false, metal: null });
  });

  test('returns not-metal for generic non-coin text', () => {
    expect(getCoinMetalProfile('baseball card')).toEqual({ isMetalBased: false, metal: null });
  });

  // ── Bullion series (explicit metal) ───────────────────────
  test('silver eagle → silver', () => {
    const r = getCoinMetalProfile('2024 Silver Eagle MS70');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  test('gold eagle → gold', () => {
    const r = getCoinMetalProfile('1 oz Gold Eagle 2023');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  test('gold buffalo → gold (inferred from series)', () => {
    const r = getCoinMetalProfile('2024 Gold Buffalo BU');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  test('krugerrand → gold (inferred from series)', () => {
    const r = getCoinMetalProfile('1 oz Krugerrand 1980');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  test('libertad defaults to silver when metal not explicit', () => {
    const r = getCoinMetalProfile('2023 Libertad 1 oz BU');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  test('maple leaf with gold keyword → gold', () => {
    const r = getCoinMetalProfile('Gold Maple Leaf 1 oz');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  test('kookaburra defaults to silver', () => {
    const r = getCoinMetalProfile('2021 Kookaburra 1 oz');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  test('platinum eagle with gold keyword → gold (gold keyword wins)', () => {
    // "platinum eagle" is a bullion series; explicit "gold" keyword overrides
    const r = getCoinMetalProfile('Gold Platinum Eagle');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  // ── US gold coin series ───────────────────────────────────
  test('saint-gaudens → gold', () => {
    const r = getCoinMetalProfile('1924 Saint-Gaudens $20 MS65');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  test('liberty gold → gold', () => {
    const r = getCoinMetalProfile('1906 Liberty Gold $10');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  test('double eagle → gold', () => {
    const r = getCoinMetalProfile('1850 Double Eagle');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  test('gold dollar → gold', () => {
    const r = getCoinMetalProfile('1854 Gold Dollar Type II');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  // ── US silver coin series ─────────────────────────────────
  test('morgan dollar → silver', () => {
    const r = getCoinMetalProfile('1881-S Morgan Dollar MS65');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  test('walking liberty half → silver', () => {
    const r = getCoinMetalProfile('1942 Walking Liberty Half Dollar');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  test('mercury dime → silver', () => {
    const r = getCoinMetalProfile('1944 Mercury Dime AU58');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  test('franklin half → silver', () => {
    const r = getCoinMetalProfile('1963 Franklin Half Dollar');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  test('trade dollar → silver', () => {
    const r = getCoinMetalProfile('1877 Trade Dollar VF');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  test('kennedy half → silver', () => {
    const r = getCoinMetalProfile('1964 Kennedy Half Dollar');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  // ── Explicit metal keyword (no series match) ─────────────
  test('"1 oz silver round" → silver via keyword', () => {
    const r = getCoinMetalProfile('1 oz silver round');
    expect(r).toEqual({ isMetalBased: true, metal: 'silver' });
  });

  test('"gold bar 10g" → gold via keyword', () => {
    const r = getCoinMetalProfile('gold bar 10g PAMP');
    expect(r).toEqual({ isMetalBased: true, metal: 'gold' });
  });

  // ── Non-metal coins ───────────────────────────────────────
  test('modern clad coins are not metal-based', () => {
    expect(getCoinMetalProfile('2020 National Park Quarter')).toEqual({ isMetalBased: false, metal: null });
    expect(getCoinMetalProfile('Lincoln Cent 1982')).toEqual({ isMetalBased: false, metal: null });
  });

  // ── Case insensitivity ────────────────────────────────────
  test('case insensitive matching', () => {
    expect(getCoinMetalProfile('MORGAN DOLLAR 1921')).toEqual({ isMetalBased: true, metal: 'silver' });
    expect(getCoinMetalProfile('GOLD EAGLE 2024')).toEqual({ isMetalBased: true, metal: 'gold' });
  });
});

// ════════════════════════════════════════════════════════════
//  Exported constants are non-empty arrays
// ════════════════════════════════════════════════════════════
describe('exported constants', () => {
  test('BULLION_SERIES is a non-empty array of strings', () => {
    expect(Array.isArray(BULLION_SERIES)).toBe(true);
    expect(BULLION_SERIES.length).toBeGreaterThan(0);
    BULLION_SERIES.forEach(s => expect(typeof s).toBe('string'));
  });

  test('SILVER_US_COIN_SERIES is a non-empty array of strings', () => {
    expect(Array.isArray(SILVER_US_COIN_SERIES)).toBe(true);
    expect(SILVER_US_COIN_SERIES.length).toBeGreaterThan(0);
  });

  test('GOLD_US_COIN_SERIES is a non-empty array of strings', () => {
    expect(Array.isArray(GOLD_US_COIN_SERIES)).toBe(true);
    expect(GOLD_US_COIN_SERIES.length).toBeGreaterThan(0);
  });
});
