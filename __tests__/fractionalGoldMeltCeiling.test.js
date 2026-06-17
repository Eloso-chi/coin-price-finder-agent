/**
 * fractionalGoldMeltCeiling.test.js -- Regression tests for #261W.
 *
 * BUG: The melt-sanity filter ceiling in src/services/ebayService.js
 * (and the parallel check in scoreMatch) used a flat full-oz multiplier
 * (meltPerOz * 1.8 for the filter, meltPerOz * 2 for the scorer), which
 * effectively allowed 36x the EXPECTED-WEIGHT melt for 1/20 oz queries
 * (1.8 / 0.05 = 36). At June 2026 gold spot (~$5k/oz), this let 1-oz
 * Maple Leaf comps at ~$5k slip through 1/20 oz queries, producing the
 * pathological FMV $4986.93 for both 1/10 and 1/20 oz Gold Maple Leaf.
 *
 * FIX: Scale the ceiling by expected.weight (5x of expected-weight melt
 * for both filter and scorer), with a $50 floor for cheap fractionals.
 *
 * These tests pin the new behavior so the regression cannot recur silently.
 */

'use strict';

const { applyFilters, scoreMatch } = require('../src/services/ebayService');

function makeComp(overrides = {}) {
  return {
    itemId: overrides.itemId || 'test-' + Math.random().toString(36).slice(2),
    title: overrides.title || 'Gold Maple Leaf',
    totalUsd: overrides.totalUsd ?? 400,
    matchScore: overrides.matchScore ?? 70,
    matchNotes: overrides.matchNotes || [],
    matchQuality: overrides.matchQuality || 'close',
    gradeType: overrides.gradeType || 'raw',
    _detectedMetal: overrides._detectedMetal || 'gold',
    _source: overrides._source || 'finding',
    soldDate: overrides.soldDate || new Date().toISOString(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Filter: melt-sanity ceiling scaled by expected.weight (#261W)
// ═══════════════════════════════════════════════════════════════

describe('applyFilters -- #261W fractional gold melt ceiling', () => {
  const GOLD_SPOT = 5000; // approx June 2026 gold spot in USD/oz

  test('1/20 oz query: filters 1-oz-priced comp with no weight in title', () => {
    // The exact bug: 1-oz Gold Maple comp at $5k leaks into 1/20 oz query
    // because the title has no weight token.  Ceiling = max(5000 * 0.05 * 5, 50)
    // = $1250.  $5000 > $1250 -> filtered.
    const comps = [
      makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 5000 }),
      makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 400 }), // plausible 1/20 retail
    ];
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: GOLD_SPOT, weight: 0.05 });
    expect(removed.meltSanity).toBe(1);
    expect(kept.length).toBe(1);
    expect(kept[0].totalUsd).toBe(400);
  });

  test('1/10 oz query: filters 1-oz-priced comp with no weight in title', () => {
    // Ceiling = max(5000 * 0.1 * 5, 50) = $2500.  $5000 > $2500 -> filtered.
    const comps = [
      makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 5000 }),
      makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 650 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: GOLD_SPOT, weight: 0.1 });
    expect(removed.meltSanity).toBe(1);
    expect(kept.length).toBe(1);
  });

  test('1/4 oz query: filters 1-oz-priced comp with no weight in title', () => {
    // Ceiling = max(5000 * 0.25 * 5, 50) = $6250.  $5000 < $6250 -> KEPT.
    // 1/4 oz at $5k is plausible (e.g. graded slab with premium) so we don't
    // claim this case as a regression.  This test pins the boundary behavior.
    const comps = [
      makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 5000 }),
      makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 1500 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: GOLD_SPOT, weight: 0.25 });
    expect(removed.meltSanity).toBe(0);
    expect(kept.length).toBe(2);
  });

  test('1/20 oz query: keeps plausible fractional-priced comp with no weight', () => {
    const comps = [
      makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 400 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: GOLD_SPOT, weight: 0.05 });
    expect(removed.meltSanity).toBe(0);
    expect(kept.length).toBe(1);
  });

  test('1/20 oz query: comps WITH weight in title are not gated by meltSanity', () => {
    // detW !== null -> meltSanity filter passes; weight-mismatch filter handles them.
    const comps = [
      makeComp({ title: '2024 Canada 1 oz Gold Maple Leaf BU', totalUsd: 5000 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: GOLD_SPOT, weight: 0.05 });
    expect(removed.meltSanity).toBe(0);
    // Caught by weight-mismatch filter (1.0 oz vs 0.05 oz expected -> wtRatio 0.95)
    expect(removed.weightMismatch).toBe(1);
    expect(kept.length).toBe(0);
  });

  test('boundary: comp at exactly the ceiling is kept (> not >=)', () => {
    // Ceiling = max(5000 * 0.05 * 5, 50) = $1250 exactly.
    const comps = [
      makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 1250 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: GOLD_SPOT, weight: 0.05 });
    expect(removed.meltSanity).toBe(0);
    expect(kept.length).toBe(1);
  });

  test('$50 floor: cheap silver fractional ceiling does not collapse to ~$0', () => {
    // Silver at $30/oz, 1/20 oz weight: bare arithmetic gives $30 * 0.05 * 5 = $7.50.
    // Floor at $50 keeps the filter tolerant.  $40 comp kept; $51 comp removed.
    const comps = [
      makeComp({ title: '2024 Silver Maple Leaf BU', totalUsd: 40, _detectedMetal: 'silver' }),
      makeComp({ title: '2024 Silver Maple Leaf BU', totalUsd: 51, _detectedMetal: 'silver' }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: 30, weight: 0.05 });
    expect(removed.meltSanity).toBe(1);
    expect(kept.length).toBe(1);
    expect(kept[0].totalUsd).toBe(40);
  });

  test('does not apply when expected.weight is 1 (full oz uses meltFloor instead)', () => {
    // Outer guard `expected.weight < 1` skips this branch entirely for 1 oz queries.
    // The melt-floor filter handles 1 oz+ queries.
    const comps = [
      makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 5100 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: GOLD_SPOT, weight: 1 });
    expect(removed.meltSanity).toBeUndefined();
    expect(kept.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scorer: price-exceeds-melt threshold scaled by expected.weight (#261W)
// ═══════════════════════════════════════════════════════════════

describe('scoreMatch -- #261W price-exceeds-melt threshold', () => {
  const GOLD_SPOT = 5000;

  test('1/20 oz: 1-oz-priced comp with no weight in title -> price-exceeds-melt deduction', () => {
    // Threshold = 5000 * 0.05 * 5 = $1250.  $5000 > $1250 -> -20 pts.
    const comp = makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 5000 });
    const scored = scoreMatch(comp, { meltPerOz: GOLD_SPOT, weight: 0.05 });
    expect(scored.matchNotes).toContain('price-exceeds-melt');
  });

  test('1/20 oz: plausible fractional price -> no price-exceeds-melt deduction', () => {
    const comp = makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 400 });
    const scored = scoreMatch(comp, { meltPerOz: GOLD_SPOT, weight: 0.05 });
    expect(scored.matchNotes).not.toContain('price-exceeds-melt');
  });

  test('1/4 oz: $5k comp does NOT trigger (within 5x boundary)', () => {
    // Threshold = 5000 * 0.25 * 5 = $6250.  $5000 < $6250 -> kept clean.
    const comp = makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 5000 });
    const scored = scoreMatch(comp, { meltPerOz: GOLD_SPOT, weight: 0.25 });
    expect(scored.matchNotes).not.toContain('price-exceeds-melt');
  });

  test('comps WITH weight in title are exempt (weight-match path handles them)', () => {
    // detectWeightFromTitle returns 1.0 -> outer guard skips price-exceeds-melt branch.
    const comp = makeComp({ title: '2024 Canada 1 oz Gold Maple Leaf BU', totalUsd: 5000 });
    const scored = scoreMatch(comp, { meltPerOz: GOLD_SPOT, weight: 0.05 });
    expect(scored.matchNotes).not.toContain('price-exceeds-melt');
    // Weight mismatch is the dominant signal here
    expect(scored.matchNotes).toContain('weight-mismatch');
  });

  test('does not apply for 1 oz queries (outer guard requires expected.weight < 1)', () => {
    const comp = makeComp({ title: '2024 Canada Gold Maple Leaf BU', totalUsd: 5100 });
    const scored = scoreMatch(comp, { meltPerOz: GOLD_SPOT, weight: 1 });
    expect(scored.matchNotes).not.toContain('price-exceeds-melt');
  });
});
