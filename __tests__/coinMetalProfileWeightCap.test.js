'use strict';

/**
 * coinMetalProfileWeightCap.test.js -- Pins the sanity cap added in #282H
 * for `detectWeightFromTitle`.
 *
 * Background: the integer-oz match in `detectWeightFromTitle` previously
 * accepted any positive number (e.g. "1000oz" -> 1000), which caused the
 * "1000oz gold libertad" Terapeak dataset to spot-price at $4.15M.  Casa
 * de Moneda has never struck a 1000oz Libertad; the comp titles for that
 * dataset were "L#NNNN 1/1000oz Gold ... Niue novelty" pieces selling
 * for $21-$60.  Silently rewriting user input ("1000oz" -> 1/1000oz) is
 * risky -- the safer behavior is to refuse, returning null and letting
 * callers fall through to other detection paths or treat weight as unknown.
 *
 * The cap is 200 oz, generous enough to accept any legitimate retail bar
 * (100oz silver is the largest commonly listed; the 1-tonne Perth Mint
 * gold coin is one-of-a-kind, not retail).
 */

const { detectWeightFromTitle } = require('../src/utils/coinMetalProfile');

describe('detectWeightFromTitle -- #282H sanity cap (200 oz)', () => {
  test('"1000oz gold libertad" -> null (typo / phantom dataset)', () => {
    expect(detectWeightFromTitle('1000oz gold libertad')).toBeNull();
  });

  test('"500 oz silver bar" -> null (above retail ceiling)', () => {
    expect(detectWeightFromTitle('500 oz silver bar')).toBeNull();
  });

  test('"201 oz" -> null (just above the cap)', () => {
    expect(detectWeightFromTitle('201 oz')).toBeNull();
  });

  test('"200 oz silver" -> 200 (at the cap, allowed)', () => {
    expect(detectWeightFromTitle('200 oz silver')).toBe(200);
  });

  test('"100 oz silver bar" -> 100 (large retail bar, unchanged)', () => {
    expect(detectWeightFromTitle('100 oz silver bar')).toBe(100);
  });

  test('"10 oz silver bar" -> 10 (unchanged)', () => {
    expect(detectWeightFromTitle('10 oz silver bar')).toBe(10);
  });

  test('"1 oz silver eagle" -> 1 (unchanged)', () => {
    expect(detectWeightFromTitle('1 oz silver eagle')).toBe(1);
  });

  test('fractional "1/10 oz gold eagle" -> 0.1 (unchanged, handled before the integer match)', () => {
    expect(detectWeightFromTitle('1/10 oz gold eagle')).toBe(0.1);
  });

  test('"1 kilo silver bar" -> ~32.15 (handled by kilo branch, not capped)', () => {
    const w = detectWeightFromTitle('1 kilo silver bar');
    expect(w).toBeGreaterThan(32);
    expect(w).toBeLessThan(33);
  });
});
