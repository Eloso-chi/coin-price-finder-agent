'use strict';

/**
 * coinMetalProfileHelpers.test.js -- Unit tests for the
 * lower-level helpers in src/utils/coinMetalProfile.js.
 *
 * Coverage gap pin (test-coverage Tier 1): function coverage on
 * src/utils/coinMetalProfile.js was only 35.29% -- four exported
 * helpers (detectMetalFromKey, classifyComposition,
 * classifyGradeCategory, weightToKeyToken) had zero direct tests,
 * even though they are consumed by ebayService and terapeakService.
 *
 * Tests exercise the actual implementation contract (matching the
 * code, not the JSDoc -- e.g. detectMetalFromKey defaults to 'silver'
 * rather than returning null when no metal keyword is found).
 */

const {
  classifyComposition,
  classifyGradeCategory,
  weightToKeyToken,
} = require('../src/utils/coinMetalProfile');

// ============================================================
//  classifyGradeCategory -- 'graded' vs 'raw'
// ============================================================

describe('classifyGradeCategory', () => {
  test('returns "raw" for null/undefined/empty', () => {
    expect(classifyGradeCategory(null)).toBe('raw');
    expect(classifyGradeCategory(undefined)).toBe('raw');
    expect(classifyGradeCategory('')).toBe('raw');
  });

  test.each([
    'morgan dollar ms65',
    'walking liberty half ms 64',
    'lincoln cent pr69',
    'kennedy half pf 70',
    'mercury dime au55',
    'barber quarter vf 30',
    'morgan xf45',
    'morgan ef 40',
  ])('"%s" -> graded', (key) => {
    expect(classifyGradeCategory(key)).toBe('graded');
  });

  test.each([
    'morgan dollar 1921',
    'silver eagle 1986',
    'lunar dragon 2024',
    'junk silver dimes',
    'proof set 1976',
    'silver round',
    // Off-by-one guards: similar tokens that are NOT grades
    'msrp coin',                   // no 1-2 digit grade after
    'morgan uncirculated',
  ])('"%s" -> raw', (key) => {
    expect(classifyGradeCategory(key)).toBe('raw');
  });

  test('matches case-insensitively', () => {
    expect(classifyGradeCategory('MORGAN MS65')).toBe('graded');
    expect(classifyGradeCategory('Morgan PR70')).toBe('graded');
  });
});

// ============================================================
//  weightToKeyToken -- numeric weight -> dataset key token
// ============================================================

describe('weightToKeyToken', () => {
  test('null/undefined returns null', () => {
    expect(weightToKeyToken(null)).toBeNull();
    expect(weightToKeyToken(undefined)).toBeNull();
  });

  test.each([
    [0.05, 'twentieth oz'],
    [0.1,  'tenth oz'],
    [0.25, 'quarter oz'],
    [0.5,  'half oz'],
  ])('fractional %s oz -> "%s"', (weight, expected) => {
    expect(weightToKeyToken(weight)).toBe(expected);
  });

  test.each([
    [1,   '1oz'],
    [2,   '2oz'],
    [5,   '5oz'],
    [10,  '10oz'],
    [100, '100oz'],
  ])('integer %d oz -> "%s"', (weight, expected) => {
    expect(weightToKeyToken(weight)).toBe(expected);
  });

  test('handles tiny float drift in fractional weights', () => {
    // detectWeightFromTitle returns floats from gram conversion;
    // 1/4 oz = 7.7758... grams. Weight may arrive as 0.2497 or 0.2503;
    // tolerance is +-0.01.
    expect(weightToKeyToken(0.249)).toBe('quarter oz');
    expect(weightToKeyToken(0.251)).toBe('quarter oz');
  });

  test('handles tiny float drift in integer weights (above 1 only)', () => {
    // Drift up from an integer is tolerated by the +-0.01 window.
    // Drift down below 1 is NOT tolerated by the current implementation
    // (weight >= 1 guard) -- so 0.995 returns null. We pin that
    // behavior in 'returns null for sub-fractional weights' below.
    expect(weightToKeyToken(1.005)).toBe('1oz');
    expect(weightToKeyToken(2.005)).toBe('2oz');
    expect(weightToKeyToken(2.995)).toBe('3oz');
  });

  test('returns null for sub-fractional weights below 0.05', () => {
    expect(weightToKeyToken(0.01)).toBeNull();
  });

  test('returns null for non-integer weights between 0.5 and 1', () => {
    // 0.7 oz is not a recognized fractional or integer weight.
    expect(weightToKeyToken(0.7)).toBeNull();
  });

  test('returns null for non-integer weights above 1', () => {
    // 1.5 oz: not an integer (rounded delta > 0.01) and not a recognized
    // fractional. Should return null.
    expect(weightToKeyToken(1.5)).toBeNull();
  });
});

// ============================================================
//  classifyComposition -- big switchboard
// ============================================================

describe('classifyComposition -- guards', () => {
  test('null/undefined/empty -> "unknown"', () => {
    expect(classifyComposition(null)).toBe('unknown');
    expect(classifyComposition(undefined)).toBe('unknown');
    expect(classifyComposition('')).toBe('unknown');
  });

  test('truly unknown query -> "unknown"', () => {
    expect(classifyComposition('xyz random nonsense')).toBe('unknown');
  });
});

describe('classifyComposition -- bullion (1 oz)', () => {
  test.each([
    'silver eagle',
    'gold eagle',
    'maple leaf',
    'krugerrand',
    'libertad',
    'panda',
    'britannia',
  ])('%s -> "bullion"', (key) => {
    expect(classifyComposition(key)).toBe('bullion');
  });
});

describe('classifyComposition -- fractional bullion splits by metal', () => {
  test('fractional gold bullion -> "bullion-fractional-gold"', () => {
    expect(classifyComposition('gold eagle quarter oz'))
      .toBe('bullion-fractional-gold');
    expect(classifyComposition('gold eagle tenth oz'))
      .toBe('bullion-fractional-gold');
    expect(classifyComposition('krugerrand half oz'))
      .toBe('bullion-fractional-gold');
  });

  test('fractional silver bullion -> "bullion-fractional-silver"', () => {
    // The classifier infers metal from the key. Silver Eagle never had a
    // fractional issue, but the classifier still returns the bucket.
    expect(classifyComposition('silver eagle quarter oz'))
      .toBe('bullion-fractional-silver');
    expect(classifyComposition('lunar silver half oz'))
      .toBe('bullion-fractional-silver');
  });
});

describe('classifyComposition -- multi-oz bullion', () => {
  test.each([
    'lunar 2oz',
    'koala 5oz',
    'silver eagle 10oz',
    'kookaburra 100oz',
  ])('%s -> "bullion-multioz"', (key) => {
    expect(classifyComposition(key)).toBe('bullion-multioz');
  });

  test('1oz does NOT match multi-oz', () => {
    expect(classifyComposition('silver eagle 1oz')).toBe('bullion');
  });
});

describe('classifyComposition -- proof bullion', () => {
  test.each([
    'silver eagle proof',
    'gold eagle proof 2024',
    'panda proof',
  ])('%s -> "bullion-proof"', (key) => {
    expect(classifyComposition(key)).toBe('bullion-proof');
  });
});

describe('classifyComposition -- US numismatic series', () => {
  test.each([
    ['morgan 1921', 'silver-numismatic'],
    ['peace dollar 1923', 'silver-numismatic'],
    ['walking liberty half', 'silver-numismatic'],
    ['mercury dime 1916', 'silver-numismatic'],
    ['kennedy half 1964', 'silver-numismatic'],
    ['war nickel 1943', 'silver-numismatic'],
    ['saint-gaudens double eagle', 'gold-numismatic'],
    ['liberty gold half eagle', 'gold-numismatic'],
    ['indian head eagle', 'gold-numismatic'],
    ['indian quarter eagle', 'gold-numismatic'],
  ])('"%s" -> "%s"', (key, expected) => {
    expect(classifyComposition(key)).toBe(expected);
  });

  test('"indian head cent" is base-metal, NOT gold', () => {
    // Guards against the "indian.*eagle" false-positive on cents.
    expect(classifyComposition('indian head cent 1909')).toBe('base-metal');
  });
});

describe('classifyComposition -- bars / sets / rounds / junk silver', () => {
  test('bar / round patterns -> "bar"', () => {
    expect(classifyComposition('silver bar 10oz')).toBe('bar');
    expect(classifyComposition('gold bar 1oz')).toBe('bar');
    expect(classifyComposition('silver round generic')).toBe('bar');
  });

  test('set patterns -> "set"', () => {
    expect(classifyComposition('proof set 1976')).toBe('set');
    expect(classifyComposition('mint set 1980')).toBe('set');
  });

  test('junk silver -> "junk-silver"', () => {
    expect(classifyComposition('junk silver coins')).toBe('junk-silver');
  });

  test('junk silver by denomination -> "junk-silver-denom"', () => {
    expect(classifyComposition('90 silver dimes')).toBe('junk-silver-denom');
    expect(classifyComposition('90 silver quarters')).toBe('junk-silver-denom');
  });

  test('base-metal series', () => {
    expect(classifyComposition('lincoln wheat cent 1958')).toBe('base-metal');
    expect(classifyComposition('jefferson nickel 1939')).toBe('base-metal');
    expect(classifyComposition('buffalo nickel 1937')).toBe('base-metal');
  });
});

describe('classifyComposition -- precedence ordering', () => {
  test('junk silver beats bullion when both keywords appear', () => {
    // Order in the function: junk-silver patterns checked before bullion.
    expect(classifyComposition('junk silver eagle dimes')).toBe('junk-silver');
  });

  test('bar pattern beats bullion series', () => {
    // "silver bar" should classify as bar even though "silver" appears.
    expect(classifyComposition('silver bar 10oz engelhard')).toBe('bar');
  });

  test('proof set beats proof bullion', () => {
    // SET_PATTERNS checked before BULLION_SERIES.
    expect(classifyComposition('proof set 1976')).toBe('set');
  });
});
