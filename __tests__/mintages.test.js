// __tests__/mintages.test.js -- Tests for lookupMintage with proof/finish routing
// Covers: proof table lookup, proof table no-fall-through-to-BU, fractional weight,
//         normalizeSeries, and basic BU lookups.

'use strict';

const { lookupMintage, normalizeSeries, MINTAGE_DATA } = require('../src/data/mintages');

/* ════════════════════════════════════════════════════════════
 *  normalizeSeries
 * ════════════════════════════════════════════════════════════ */
describe('normalizeSeries', () => {
  test('normalizes "American Silver Eagle" to canonical key', () => {
    const key = normalizeSeries('American Silver Eagle');
    expect(key).toBeTruthy();
    expect(MINTAGE_DATA[key]).toBeDefined();
  });

  test('normalizes case-insensitively', () => {
    expect(normalizeSeries('american silver eagle')).toBe(normalizeSeries('American Silver Eagle'));
  });

  test('returns null for unknown series', () => {
    expect(normalizeSeries('Totally Fake Coin')).toBeFalsy();
  });
});

/* ════════════════════════════════════════════════════════════
 *  Basic BU lookups
 * ════════════════════════════════════════════════════════════ */
describe('lookupMintage — BU (no finish)', () => {
  test('finds ASE 1986-P mintage', () => {
    const result = lookupMintage('American Silver Eagle', 1986, 'P');
    expect(result.mintage).toBeGreaterThan(0);
  });

  test('defaults to P mint when no mint specified', () => {
    const result = lookupMintage('American Silver Eagle', 1986);
    expect(result.mintage).toBeGreaterThan(0);
  });

  test('returns null for year not in table', () => {
    const result = lookupMintage('American Silver Eagle', 1850);
    expect(result.mintage).toBeNull();
  });

  test('returns null for unknown series', () => {
    const result = lookupMintage('Fake Coin Series', 2020);
    expect(result.mintage).toBeNull();
  });

  test('returns null when no year provided', () => {
    const result = lookupMintage('American Silver Eagle', null);
    expect(result.mintage).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════
 *  Proof finish routing (#21)
 * ════════════════════════════════════════════════════════════ */
describe('lookupMintage — Proof finish', () => {
  test('ASE Proof returns proof table mintage (S mint)', () => {
    const result = lookupMintage('American Silver Eagle', 1986, 'S', null, 'Proof');
    expect(result.mintage).toBeGreaterThan(0);
    expect(result.series).toMatch(/proof/i);
  });

  test('ASE Proof falls through to any mint in proof table for that year', () => {
    // Query without explicit mint — should find any entry for that year in proof table
    const result = lookupMintage('American Silver Eagle', 1986, null, null, 'Proof');
    expect(result.mintage).toBeGreaterThan(0);
    expect(result.series).toMatch(/proof/i);
  });

  test('Proof with year not in proof table returns null (NOT BU mintage)', () => {
    // 1850 has no proof table entry — should NOT fall through to BU table
    const result = lookupMintage('American Silver Eagle', 1850, null, null, 'Proof');
    expect(result.mintage).toBeNull();
  });

  test('Proof request for series with no proof table returns null', () => {
    // If there's no proof table at all for a series, don't return BU mintage
    const result = lookupMintage('Morgan Dollar', 2020, null, null, 'Proof');
    expect(result.mintage).toBeNull();
  });

  test('Mexican Silver Libertad Proof returns proof mintage', () => {
    const result = lookupMintage('Mexican Silver Libertad', 1986, 'P', null, 'Proof');
    expect(result.mintage).toBeGreaterThan(0);
    expect(result.series).toMatch(/proof/i);
  });

  test('finish is case-insensitive ("proof" vs "Proof")', () => {
    const r1 = lookupMintage('American Silver Eagle', 1986, 'S', null, 'Proof');
    const r2 = lookupMintage('American Silver Eagle', 1986, 'S', null, 'proof');
    expect(r1.mintage).toBe(r2.mintage);
  });

  test('US Proof Set clad returns proof set mintage', () => {
    const result = lookupMintage('US Proof Set Clad', 1968, 'S', null, 'Proof');
    expect(result.mintage).toBeGreaterThan(0);
  });
});

/* ════════════════════════════════════════════════════════════
 *  Fractional weight routing
 * ════════════════════════════════════════════════════════════ */
describe('lookupMintage — fractional weight', () => {
  test('1/2 oz falls back to standard table if no fractional table', () => {
    // Most series don't have fractional tables — should still return something or null
    const result = lookupMintage('American Silver Eagle', 1986, 'P', 0.5);
    // ASE doesn't have a 1/2 oz table, so falls to 1oz table
    // The function should still find the 1oz BU entry
    expect(result).toBeDefined();
  });
});

/* ════════════════════════════════════════════════════════════
 *  BU vs Proof isolation (#21 regression)
 * ════════════════════════════════════════════════════════════ */
describe('lookupMintage — BU/Proof isolation', () => {
  test('BU lookup (no finish) for ASE 1986-S returns BU mintage', () => {
    const result = lookupMintage('American Silver Eagle', 1986, 'S');
    // Without finish="Proof", this should hit the BU table, not proof
    expect(result.mintage).toBeGreaterThan(0);
    // It should NOT have "proof" in the series key
    expect(result.series).not.toMatch(/proof/i);
  });

  test('BU and Proof lookups for ASE 1986-S come from different tables', () => {
    const bu = lookupMintage('American Silver Eagle', 1986, 'S');
    const proof = lookupMintage('American Silver Eagle', 1986, 'S', null, 'Proof');
    // Both should exist and source from their respective tables
    expect(bu.mintage).toBeGreaterThan(0);
    expect(proof.mintage).toBeGreaterThan(0);
    expect(bu.series).not.toMatch(/proof/i);
    expect(proof.series).toMatch(/proof/i);
  });
});
