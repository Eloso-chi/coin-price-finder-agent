'use strict';

/**
 * coinMetalProfileOnza.test.js -- Pins the Spanish "onza" / "onzas"
 * synonym added in #283W for `detectWeightFromTitle`.
 *
 * Background: Casa de Moneda Libertad titles frequently use the Spanish
 * word "onza" (ounce) instead of, or in addition to, the English "oz".
 * The previous regex only matched `oz | ozt | ounce | ounces | troy oz`
 * so titles like "1/4 Onza" or "1/20 ONZA" returned null. In the eBay
 * filter chain, a null weight is treated as "no weight stated -- benefit
 * of doubt" and the comp is kept, which caused fractional-oz Libertad
 * Proof listings to leak into 1 oz Libertad Proof pools (both the Live
 * eBay Tracker and the Terapeak import-time reclassifier).
 *
 * The fix extends the OZ token regex to include `onzas?` so onza titles
 * are parsed identically to their oz equivalents.
 */

const { detectWeightFromTitle } = require('../src/utils/coinMetalProfile');

describe('detectWeightFromTitle -- #283W onza / onzas synonym', () => {
  // Fractional onza forms (Casa de Moneda mint packaging)
  test('"1/4 Onza" -> 0.25', () => {
    expect(detectWeightFromTitle('2023 Mexico Libertad 1/4 Onza Proof Silver Coin')).toBe(0.25);
  });

  test('"1/2 Onza" -> 0.5', () => {
    expect(detectWeightFromTitle('2011 Proof DCAM Mexico Libertad 1/2 Onza Silver Coin')).toBe(0.5);
  });

  test('"1/10 Onza" -> 0.1', () => {
    expect(detectWeightFromTitle('2015 Mexico Libertad 1/10 Onza Silver Proof')).toBe(0.1);
  });

  test('"1/20 ONZA" (uppercase, no plain oz) -> 0.05', () => {
    expect(detectWeightFromTitle('2011 MO SILVER PROOF MEXICO 1/20 ONZA LIBERTAD NGC PF 69 UC')).toBe(0.05);
  });

  // Integer onza forms
  test('"1 Onza" -> 1', () => {
    expect(detectWeightFromTitle('2011 Mo Proof Mexico Libertad 1 Onza Silver 999')).toBe(1);
  });

  test('"2 Onzas" (plural) -> 2', () => {
    expect(detectWeightFromTitle('2011 Mexico Libertad 2 Onzas Silver Proof')).toBe(2);
  });

  // Mixed onza + oz -- earliest match wins, both should resolve to the same value
  test('"1 oz ... Un Onza" (both tokens present) -> 1', () => {
    expect(detectWeightFromTitle('2011 Mo PCGS PR69 DCAM - MEXICO - 1 oz Silver Libertad Un Onza #44556A')).toBe(1);
  });

  test('"1/20 Oz Onza" (both fractional + Spanish) -> 0.05', () => {
    expect(detectWeightFromTitle('Lot (2) 1/20 Oz Onza Silver Mexico Proof Libertad')).toBe(0.05);
  });

  // Guardrails -- oz behavior should be unchanged by the onza addition
  test('"1/4 oz" (plain oz) -> 0.25 (unchanged)', () => {
    expect(detectWeightFromTitle('2023 Mexico Libertad 1/4 oz Proof Silver Coin')).toBe(0.25);
  });

  test('"1 oz silver eagle" -> 1 (unchanged, no onza in title)', () => {
    expect(detectWeightFromTitle('1 oz silver eagle')).toBe(1);
  });

  // Sanity cap from #282H still applies to onza forms
  test('"1000 Onzas" -> null (above the #282H sanity cap of 200)', () => {
    expect(detectWeightFromTitle('1000 Onzas Silver Libertad')).toBeNull();
  });

  // Substring false-positive guard (#283W): the `onzas?` token is
  // word-boundary anchored (`\b...\b`), so tokens that merely contain
  // "onza" as an internal substring must not be picked up as an
  // ounce reference.  If this test ever fails, the OZ regex has lost
  // its `\b` anchor and needs to be tightened.
  test('"Bonza" (brand/slang, "onza" is only a substring) -> falls back to numeric weight or null', () => {
    // No standalone weight token -> null (no fractional prefix, no
    // integer-oz match because "Bonza" is a word not a number).
    expect(detectWeightFromTitle('Bonza coin collection lot')).toBeNull();
  });

  test('"Bonza 1 oz Silver" (substring "onza" AND a real "1 oz") -> 1 (the real oz wins, not the substring)', () => {
    expect(detectWeightFromTitle('Bonza 1 oz Silver Round')).toBe(1);
  });
});
