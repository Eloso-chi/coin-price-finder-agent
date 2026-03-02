/**
 * applyFiltersRegression.test.js — Regression tests for filter pipeline gaps
 *
 * These tests cover fix-commit regressions that are NOT already in
 * applyFilters.test.js:
 *   1. Composition mismatch (silver/clad) integration through applyFilters
 *   2. Year mismatch integration through applyFilters
 *   3. Default 1 oz bullion weight assumption (commit 4a05b2f)
 *
 * Uses the same makeComp() pattern as applyFilters.test.js.
 */

'use strict';

const { applyFilters } = require('../src/services/ebayService');

function makeComp(overrides = {}) {
  return {
    itemId: overrides.itemId || 'test-' + Math.random().toString(36).slice(2),
    title: overrides.title || '1964 Kennedy Half Dollar',
    totalUsd: overrides.totalUsd ?? 12.50,
    matchScore: overrides.matchScore ?? 70,
    matchNotes: overrides.matchNotes || [],
    matchQuality: overrides.matchQuality || 'close',
    gradeType: overrides.gradeType || 'raw',
    _detectedMetal: overrides._detectedMetal || null,
    _source: overrides._source || 'finding',
    soldDate: overrides.soldDate || new Date().toISOString(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Composition mismatch — integration through applyFilters
//  (Regression for commit 243df13)
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — composition mismatch (silver/clad)', () => {
  test('clad-era quarter: rejects "silver" comps', () => {
    const comps = [
      makeComp({ title: '1978 Washington Quarter Silver BU', matchScore: 80 }),
      makeComp({ title: '1978-D Washington Quarter BU', matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 1978,
      series: 'Washington Quarter',
      _rawQuery: '1978 D Washington Quarter',
    });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/1978-D/);
    expect(removed.compositionMismatch).toBe(1);
  });

  test('clad-era quarter: rejects "90%" comps', () => {
    const comps = [
      makeComp({ title: '1978 Washington Quarter 90% Silver', matchScore: 80 }),
      makeComp({ title: '1978 Washington Quarter', matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 1978,
      series: 'Washington Quarter',
      _rawQuery: '1978 Washington Quarter',
    });
    expect(removed.compositionMismatch).toBe(1);
    expect(kept.length).toBe(1);
  });

  test('silver-era quarter: rejects "clad" comps', () => {
    const comps = [
      makeComp({ title: '1964 Washington Quarter Clad', matchScore: 80 }),
      makeComp({ title: '1964 Washington Quarter Silver BU', matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 1964,
      series: 'Washington Quarter',
      _rawQuery: '1964 Washington Quarter',
    });
    expect(removed.compositionMismatch).toBe(1);
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Silver/);
  });

  test('user explicitly searching "silver" in clad era: allows silver comps', () => {
    const comps = [
      makeComp({ title: '1976 S Washington Quarter Silver Proof', matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 1976,
      series: 'Washington Quarter',
      _rawQuery: '1976 S silver quarter proof',
    });
    // User asked for silver — don't filter it out
    expect(kept.length).toBe(1);
    expect(removed.compositionMismatch).toBe(0);
  });

  test('Kennedy half: 1970 is still silver era (40%), 1971 is clad era', () => {
    const silverComp = makeComp({ title: '1970 Kennedy Half Dollar 40% Silver', matchScore: 80 });
    const cladComp = makeComp({ title: '1971 Kennedy Half Dollar', matchScore: 80 });

    // 1970 search should keep silver comp
    const r1 = applyFilters([silverComp], {}, {
      year: 1970, series: 'Kennedy Half', _rawQuery: '1970 Kennedy Half',
    });
    expect(r1.kept.length).toBe(1);

    // 1971 search should reject silver comp
    const silverInClad = makeComp({ title: '1971 Kennedy Half Dollar Silver', matchScore: 80 });
    const r2 = applyFilters([silverInClad], {}, {
      year: 1971, series: 'Kennedy Half Dollar', _rawQuery: '1971 Kennedy Half Dollar',
    });
    expect(r2.removed.compositionMismatch).toBe(1);
  });

  test('non-denomination coin (e.g. bullion) is unaffected by composition filter', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle 1 oz Silver BU', matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 2024,
      series: 'Silver Eagle',
      _rawQuery: '2024 Silver Eagle 1 oz',
    });
    // Silver Eagle has no denomination mismatch concern — no transition year
    expect(kept.length).toBe(1);
    expect(removed.compositionMismatch).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Year mismatch — integration through applyFilters
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — year mismatch', () => {
  test('drops comp with wrong year in title', () => {
    const comps = [
      makeComp({ title: '2005 Perth Lunar Rooster 1 oz Silver', matchScore: 80 }),
      makeComp({ title: '2017 Perth Lunar Rooster 1 oz Silver', matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 2017,
      weight: 1, // bullion → exact year
      _rawQuery: '2017 Perth Lunar Rooster 1 oz',
    });
    expect(removed.yearMismatch).toBe(1);
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/2017/);
  });

  test('keeps comp with no year in title (benefit of the doubt)', () => {
    const comps = [
      makeComp({ title: 'Perth Lunar Rooster 1 oz Silver BU', matchScore: 80 }),
    ];
    const { kept } = applyFilters(comps, {}, {
      year: 2017,
      weight: 1,
      _rawQuery: '2017 Perth Lunar Rooster',
    });
    expect(kept.length).toBe(1);
  });

  test('bullion: exact year match (no ±1 tolerance)', () => {
    const comps = [
      makeComp({ title: '2016 Perth Lunar Monkey 1 oz Silver', matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 2017,
      weight: 1, // bullion → 0 tolerance
      _rawQuery: '2017 Perth Lunar Rooster 1 oz',
    });
    expect(removed.yearMismatch).toBe(1);
    expect(kept.length).toBe(0);
  });

  test('non-bullion: ±1 year tolerance allowed', () => {
    const comps = [
      makeComp({ title: '1965 Kennedy Half Dollar BU', matchScore: 80 }),
      makeComp({ title: '1963 Kennedy Half Dollar BU', matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 1964,
      // No weight → non-bullion → ±1 tolerance
      series: 'Kennedy Half Dollar',
      _rawQuery: '1964 Kennedy Half Dollar',
    });
    // 1965 is within ±1, should be kept; 1963 is within ±1 too
    expect(kept.length).toBe(2);
    expect(removed.yearMismatch).toBe(0);
  });

  test('non-bullion: ±2 year is rejected', () => {
    const comps = [
      makeComp({ title: '1962 Kennedy Half Dollar BU', matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 1964,
      series: 'Kennedy Half Dollar',
      _rawQuery: '1964 Kennedy Half Dollar',
    });
    expect(removed.yearMismatch).toBe(1);
    expect(kept.length).toBe(0);
  });

  test('multi-year title: keeps if expected year is among them', () => {
    const comps = [
      makeComp({ title: '1964-1965 Kennedy Half Dollar Set', matchScore: 80 }),
    ];
    const { kept } = applyFilters(comps, {}, {
      year: 1964,
      series: 'Kennedy Half Dollar',
      _rawQuery: '1964 Kennedy Half Dollar',
    });
    expect(kept.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Default 1oz bullion regression (commit 4a05b2f)
//  When weight is set, the melt-floor filter should be active
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — melt-floor for bullion', () => {
  test('drops suspiciously cheap comp when weight=1 and melt known', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle BU', totalUsd: 5.00, matchScore: 80 }),  // way below melt
      makeComp({ title: '2024 Silver Eagle BU', totalUsd: 32.00, matchScore: 80 }), // reasonable
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 2024,
      weight: 1,
      meltPerOz: 30, // ~$30 silver per oz
      series: 'Silver Eagle',
      _rawQuery: '2024 Silver Eagle 1 oz',
    });
    // $5 is below 40% of $30 (=$12) → should be dropped
    expect(removed.meltFloor).toBe(1);
    expect(kept.length).toBe(1);
    expect(kept[0].totalUsd).toBe(32);
  });

  test('melt-floor skips comps with detected weight in title', () => {
    const comps = [
      makeComp({ title: '2024 1/10 oz Silver Eagle', totalUsd: 5.00, matchScore: 80 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 2024,
      weight: 1,
      meltPerOz: 30,
      series: 'Silver Eagle',
      _rawQuery: '2024 Silver Eagle 1 oz',
    });
    // Has "1/10 oz" in title → weight-mismatch filter handles it, meltFloor skips
    // (it will be caught by weight-mismatch instead)
    expect(removed.meltFloor).toBe(0);
  });
});
