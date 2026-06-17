'use strict';

/**
 * lunarReference.test.js -- Unit tests for src/data/lunarReference.js
 *
 * Coverage gap pin (test-coverage Tier 1): no test existed for this
 * module. Tests pin:
 *   - zodiacAnimalForYear: the 12-year zodiac cycle (off-by-one is the
 *     classic failure mode here)
 *   - perthSeriesForYear: the three Perth Mint series brackets
 *     (1996-2007=I, 2008-2019=II, 2020-2031=III)
 *   - buildLunarComparison: top-level shape, all three mints present,
 *     metal normalization, year guards
 *   - LUNAR_MINTS table integrity invariants (every mint has the keys
 *     downstream code reads)
 */

const {
  buildLunarComparison,
  LUNAR_MINTS,
} = require('../src/data/lunarReference');

// zodiacAnimalForYear is not exported but is exercised through
// buildLunarComparison.animal. We test its behavior via that surface.

describe('LUNAR_MINTS table integrity', () => {
  const REQUIRED_KEYS = [
    'label', 'country', 'seriesLabel',
    'puritySilver', 'purityGold',
    'premiumTier', 'premiumNote',
    'sizes', 'series', 'mintageKey',
  ];

  test('exposes the three expected mint keys', () => {
    expect(Object.keys(LUNAR_MINTS).sort()).toEqual(
      ['perth', 'royalAustralianMint', 'royalMint'].sort()
    );
  });

  test.each(Object.entries(LUNAR_MINTS))(
    '%s mint has all required structural fields',
    (_key, mint) => {
      for (const k of REQUIRED_KEYS) {
        expect(mint).toHaveProperty(k);
      }
      expect(typeof mint.label).toBe('string');
      expect(typeof mint.country).toBe('string');
      expect(['high', 'medium', 'low']).toContain(mint.premiumTier);
    }
  );

  test.each(Object.entries(LUNAR_MINTS))(
    '%s.mintageKey has both silver and gold lookup keys',
    (_key, mint) => {
      expect(mint.mintageKey).toHaveProperty('silver');
      expect(mint.mintageKey).toHaveProperty('gold');
      expect(typeof mint.mintageKey.silver).toBe('string');
      expect(typeof mint.mintageKey.gold).toBe('string');
    }
  );

  test('Perth Mint has three series brackets covering 1996-2031', () => {
    const perthSeries = LUNAR_MINTS.perth.series;
    expect(perthSeries).toHaveLength(3);
    expect(perthSeries.map(s => s.num)).toEqual(['I', 'II', 'III']);
  });
});

describe('buildLunarComparison -- top-level shape', () => {
  test('returns null for years before the program start (1996)', () => {
    expect(buildLunarComparison(1995, 'silver')).toBeNull();
    expect(buildLunarComparison(0, 'silver')).toBeNull();
  });

  test('returns null for missing year', () => {
    expect(buildLunarComparison(null, 'silver')).toBeNull();
    expect(buildLunarComparison(undefined, 'silver')).toBeNull();
  });

  test('returns object with required top-level keys for valid year', () => {
    const result = buildLunarComparison(2020, 'silver');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('animal');
    expect(result).toHaveProperty('year', 2020);
    expect(result).toHaveProperty('metal', 'silver');
    expect(result).toHaveProperty('perthSeries');
    expect(result).toHaveProperty('mints');
    expect(Array.isArray(result.mints)).toBe(true);
    expect(result.mints).toHaveLength(3);
  });

  test('coerces string year to number', () => {
    const result = buildLunarComparison('2020', 'silver');
    expect(result.year).toBe(2020);
  });
});

describe('buildLunarComparison -- zodiac math', () => {
  // The 12-year zodiac cycle anchored on 2020 = Rat. Off-by-one in the
  // modular arithmetic is the classic failure mode here. Pin three full
  // cycles (1996, 2008, 2020) on the same animal.
  const ZODIAC_CASES = [
    [2020, 'Rat'],
    [2021, 'Ox'],
    [2022, 'Tiger'],
    [2023, 'Rabbit'],
    [2024, 'Dragon'],
    [2025, 'Snake'],
    [2026, 'Horse'],
    [2027, 'Goat'],
    [2028, 'Monkey'],
    [2029, 'Rooster'],
    [2030, 'Dog'],
    [2031, 'Pig'],
    // Three full cycles back to 1996 should land on the same animal:
    [2008, 'Rat'],
    [1996, 'Rat'],
    // Off-cycle anchors:
    [1997, 'Ox'],
    [2007, 'Pig'],
  ];

  test.each(ZODIAC_CASES)(
    'year %d -> %s',
    (year, expected) => {
      const result = buildLunarComparison(year, 'silver');
      expect(result).not.toBeNull();
      expect(result.animal).toBe(expected);
    }
  );
});

describe('buildLunarComparison -- Perth series brackets', () => {
  test.each([
    [1996, 'I'],
    [2007, 'I'],
    [2008, 'II'],
    [2019, 'II'],
    [2020, 'III'],
    [2031, 'III'],
  ])('year %d -> Perth series %s', (year, expected) => {
    const result = buildLunarComparison(year, 'silver');
    expect(result.perthSeries).toBe(expected);
  });

  test('returns null perthSeries for years past 2031', () => {
    // Perth Series III ends 2031; 2032 has no defined bracket.
    // (zodiacAnimalForYear still resolves, so result is non-null but
    // perthSeries is null.)
    const result = buildLunarComparison(2032, 'silver');
    if (result !== null) {
      expect(result.perthSeries).toBeNull();
    }
  });
});

describe('buildLunarComparison -- metal normalization', () => {
  test('default metal is silver when omitted', () => {
    const result = buildLunarComparison(2020);
    expect(result.metal).toBe('silver');
  });

  test('"gold" string normalizes to gold', () => {
    const result = buildLunarComparison(2020, 'gold');
    expect(result.metal).toBe('gold');
  });

  test('"GOLD" uppercase normalizes to gold', () => {
    const result = buildLunarComparison(2020, 'GOLD');
    expect(result.metal).toBe('gold');
  });

  test('any non-"gold" metal collapses to silver', () => {
    expect(buildLunarComparison(2020, 'platinum').metal).toBe('silver');
    expect(buildLunarComparison(2020, 'unknown').metal).toBe('silver');
  });

  test('purity reflects metal selection', () => {
    const silver = buildLunarComparison(2020, 'silver');
    const gold = buildLunarComparison(2020, 'gold');
    const perthSilver = silver.mints.find(m => m.key === 'perth');
    const perthGold = gold.mints.find(m => m.key === 'perth');
    // Purity strings differ between silver and gold for Perth (.9999 III/.999 I-II vs .9999)
    expect(perthSilver.purity).not.toBe(perthGold.purity);
  });
});

describe('buildLunarComparison -- mint entries', () => {
  test('every mint entry has the keys downstream UIs read', () => {
    const result = buildLunarComparison(2020, 'silver');
    for (const mint of result.mints) {
      expect(mint).toHaveProperty('key');
      expect(mint).toHaveProperty('label');
      expect(mint).toHaveProperty('country');
      expect(mint).toHaveProperty('purity');
      expect(mint).toHaveProperty('premiumTier');
      expect(mint).toHaveProperty('premiumNote');
      expect(mint).toHaveProperty('sizes');
      expect(mint).toHaveProperty('mintage'); // number or null
      expect(mint).toHaveProperty('activeSeries'); // string or null
      expect(mint).toHaveProperty('available'); // boolean
    }
  });

  test('Perth is marked available across the full 1996-2031 range', () => {
    for (const year of [1996, 2010, 2020, 2031]) {
      const result = buildLunarComparison(year, 'silver');
      const perth = result.mints.find(m => m.key === 'perth');
      expect(perth.available).toBe(true);
    }
  });
});
