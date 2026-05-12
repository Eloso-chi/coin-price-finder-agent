// __tests__/reclassification.test.js — Tests for comp reclassification feature
'use strict';

const path = require('path');
const { detectWeightFromTitle, weightToKeyToken } = require('../src/utils/coinMetalProfile');

// ── detectWeightFromTitle ───────────────────────────────────

describe('detectWeightFromTitle', () => {
  test('detects 1 oz from "1 oz"', () => {
    expect(detectWeightFromTitle('2024 Gold Libertad 1 oz BU')).toBe(1);
  });

  test('detects 1/4 oz fraction', () => {
    expect(detectWeightFromTitle('2024 Mexico 1/4 oz Gold Libertad')).toBe(0.25);
  });

  test('detects 1/2 oz fraction', () => {
    expect(detectWeightFromTitle('2024 Mexico 1/2 oz Gold Libertad')).toBe(0.5);
  });

  test('detects 1/10 oz fraction', () => {
    expect(detectWeightFromTitle('2024 1/10 oz Gold Libertad BU')).toBe(0.1);
  });

  test('detects 1/20 oz fraction', () => {
    expect(detectWeightFromTitle('2024 Mexico 1/20 oz Gold Libertad')).toBe(0.05);
  });

  test('detects "quarter oz" word form', () => {
    expect(detectWeightFromTitle('Gold Eagle Quarter Ounce 2024')).toBe(0.25);
  });

  test('detects "half oz" word form', () => {
    expect(detectWeightFromTitle('2024 Half oz Gold Maple Leaf')).toBe(0.5);
  });

  test('detects gram-based weight', () => {
    const w = detectWeightFromTitle('1 gram Gold Bar PAMP Suisse');
    expect(w).toBeCloseTo(1 / 31.1035, 4);
  });

  test('detects kilo', () => {
    expect(detectWeightFromTitle('1 Kilo Silver Bar .999')).toBe(32.1507);
  });

  test('returns null for undetectable weight', () => {
    expect(detectWeightFromTitle('2024 Morgan Silver Dollar MS65')).toBeNull();
  });

  test('returns null for null/empty input', () => {
    expect(detectWeightFromTitle(null)).toBeNull();
    expect(detectWeightFromTitle('')).toBeNull();
  });
});

// ── weightToKeyToken ────────────────────────────────────────

describe('weightToKeyToken', () => {
  test('maps fractional weights to word tokens', () => {
    expect(weightToKeyToken(0.05)).toBe('twentieth oz');
    expect(weightToKeyToken(0.1)).toBe('tenth oz');
    expect(weightToKeyToken(0.25)).toBe('quarter oz');
    expect(weightToKeyToken(0.5)).toBe('half oz');
  });

  test('maps integer weights to Noz tokens', () => {
    expect(weightToKeyToken(1)).toBe('1oz');
    expect(weightToKeyToken(5)).toBe('5oz');
    expect(weightToKeyToken(10)).toBe('10oz');
  });

  test('returns null for unmappable weights', () => {
    expect(weightToKeyToken(null)).toBeNull();
    expect(weightToKeyToken(0.75)).toBeNull();
  });
});

// ── Import-time reclassification ────────────────────────────

describe('importComps reclassification', () => {
  const terapeakService = require('../src/services/terapeakService');

  beforeEach(() => {
    terapeakService._resetStoreCache();
  });

  test('reclassifies comp with wrong weight to correct dataset', () => {
    // Import a 1/4 oz comp into a 1oz dataset
    const comps = [
      { title: '2024 Mexico 1/4 oz Gold Libertad BU', totalUsd: 600, soldDate: '2024-06-01', itemId: 'test-reclass-1' },
      { title: '2024 Mexico 1 oz Gold Libertad BU', totalUsd: 2500, soldDate: '2024-06-02', itemId: 'test-reclass-2' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);

    // The 1oz comp should stay, the 1/4 oz should be reclassified
    expect(result.newComps).toBe(1);
    expect(result.reclassified).toBe(1);

    // Check the reclassified comp landed in the correct dataset
    const quarterDs = terapeakService.lookupComps('2024 Mexican Gold Libertad quarter oz');
    expect(quarterDs).not.toBeNull();
    expect(quarterDs.comps.length).toBe(1);
    expect(quarterDs.comps[0].itemId).toBe('test-reclass-1');
  });

  test('does not reclassify when weight matches', () => {
    const comps = [
      { title: '2024 Mexico 1 oz Gold Libertad BU', totalUsd: 2500, soldDate: '2024-06-01', itemId: 'test-match-1' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);
    expect(result.newComps).toBe(1);
    expect(result.reclassified).toBe(0);
  });

  test('does not reclassify when weight is undetectable', () => {
    const comps = [
      { title: '2024 Mexico Gold Libertad BU Sealed', totalUsd: 2500, soldDate: '2024-06-01', itemId: 'test-noweight-1' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);
    expect(result.newComps).toBe(1);
    expect(result.reclassified).toBe(0);
  });

  test('leaves metal-mismatched comps in place', () => {
    // Silver comp in gold dataset -- should NOT be reclassified (meltFloor handles it)
    const comps = [
      { title: '2024 Mexico 1/4 oz Silver Libertad', totalUsd: 30, soldDate: '2024-06-01', itemId: 'test-metal-1' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);
    expect(result.newComps).toBe(1);
    expect(result.reclassified).toBe(0);
  });
});
