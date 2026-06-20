'use strict';

/**
 * valuationServiceProofHalfLife.test.js -- #283H
 *
 * Pins the proof / RP bullion recency half-life dispatch in
 * `computeWeightedMedian`:
 *
 *   - BU bullion: 30-day half-life (rapid metal price tracking).
 *   - Proof bullion: 90-day half-life (collector-paced, not metal-paced).
 *   - Reverse-proof bullion: 90-day half-life (same rationale as proof).
 *   - Numismatic (non-bullion): 90-day half-life (unchanged from before).
 *
 * Scenario shape:
 *   4 stable comps at $200, each sold 200 days ago.
 *   1 fresh outlier at $400, sold today.
 *
 * Under 30-day half-life the fresh outlier dominates the weighted median
 * (each old comp weight ~0.13 vs fresh ~0.97 -- median pulled to $400).
 *
 * Under 90-day half-life the older comps push back (each old comp weight
 * ~0.31 vs fresh ~0.99 -- median stays at $200).
 *
 * The shape was chosen to produce a clean 200 vs 400 result depending on
 * which half-life is in use, so the test is deterministic and doesn't
 * depend on rounding.
 */

const {
  computeValuation,
  computeWeightedMedian,
} = require('../src/services/valuationService');

const TWO_HUNDRED_DAYS_AGO = new Date(Date.now() - 200 * 86_400_000).toISOString();
const TODAY = new Date().toISOString();

function makeComp(price, opts = {}) {
  return {
    itemId: opts.itemId || 'c-' + Math.random().toString(36).slice(2),
    title: opts.title || 'Test Comp',
    totalUsd: price,
    matchScore: opts.matchScore ?? 70,
    gradeType: opts.gradeType || 'raw',
    soldDate: opts.soldDate || TODAY,
    _source: opts._source || 'finding',
  };
}

function fourStablePlusOneFresh(gradeType) {
  const stable = Array.from({ length: 4 }, (_, i) =>
    makeComp(200, { soldDate: TWO_HUNDRED_DAYS_AGO, gradeType, itemId: `s${i}` })
  );
  const fresh = makeComp(400, { soldDate: TODAY, gradeType, itemId: 'fresh' });
  return [...stable, fresh];
}

function mockPcgs(overrides = {}) {
  return {
    verified: false,
    pcgsNo: null,
    series: 'Silver Libertad',
    year: 2023,
    mint: null,
    grade: null,
    designation: null,
    priceGuide: null,
    population: null,
    auction: null,
    _isBar: false,
    ...overrides,
  };
}

function mockEbay(usComps) {
  return {
    us: { comps: usComps, stats: { count: usComps.length } },
    global: { comps: [], stats: { count: 0 } },
    usedFallback: false,
  };
}

// ════════════════════════════════════════════════════════════════
//  Direct helper tests -- computeWeightedMedian dispatch
// ════════════════════════════════════════════════════════════════

describe('#283H computeWeightedMedian half-life dispatch', () => {
  test('isBullion + no proof flag -> 30-day half-life (fresh outlier wins, median = 400)', () => {
    const comps = fourStablePlusOneFresh('raw');
    const wm = computeWeightedMedian(comps, { isBullion: true });
    expect(wm).toBe(400);
  });

  test('isBullion + wantsProof -> 90-day half-life (older comps win, median = 200)', () => {
    const comps = fourStablePlusOneFresh('proof');
    const wm = computeWeightedMedian(comps, { isBullion: true, wantsProof: true });
    expect(wm).toBe(200);
  });

  test('isBullion + wantsReverseProof -> 90-day half-life (RP behaves like proof)', () => {
    const comps = fourStablePlusOneFresh('reverse-proof');
    const wm = computeWeightedMedian(comps, { isBullion: true, wantsReverseProof: true });
    expect(wm).toBe(200);
  });

  test('non-bullion (numismatic) -> 90-day half-life (non-regression, median = 200)', () => {
    const comps = fourStablePlusOneFresh('raw');
    const wm = computeWeightedMedian(comps, { isBullion: false });
    expect(wm).toBe(200);
  });

  test('non-bullion + wantsProof -> still 90-day (no double-narrowing for proof numismatics)', () => {
    const comps = fourStablePlusOneFresh('proof');
    const wm = computeWeightedMedian(comps, { isBullion: false, wantsProof: true });
    expect(wm).toBe(200);
  });

  test('empty pool -> null (signature change does not break empty-input contract)', () => {
    expect(computeWeightedMedian([], { isBullion: true, wantsProof: true })).toBeNull();
    expect(computeWeightedMedian([{ totalUsd: null }], { isBullion: true })).toBeNull();
  });

  test('default args (back-compat) -> behaves like non-proof', () => {
    // Old call sites that pass no options or only { isBullion } must keep
    // working.  Under the default the function should treat the input as
    // non-proof and use the BU 30-day curve when isBullion=true.
    const comps = fourStablePlusOneFresh('raw');
    expect(computeWeightedMedian(comps)).toBe(200);            // numismatic
    expect(computeWeightedMedian(comps, {})).toBe(200);        // numismatic
    expect(computeWeightedMedian(comps, { isBullion: true })).toBe(400); // BU
  });
});

// ════════════════════════════════════════════════════════════════
//  End-to-end via computeValuation -- ensure the dispatch is wired
// ════════════════════════════════════════════════════════════════

describe('#283H computeValuation routes proof/RP intent through 90-day half-life', () => {
  test('proof bullion query -> ebayMedian reflects 90-day curve (200, not 400)', () => {
    const comps = fourStablePlusOneFresh('proof');
    const result = computeValuation(
      mockPcgs(),
      mockEbay(comps),
      null,
      'Proof',
      { isBullion: true, isProof: true, spotPrice: 30 }
    );
    // FMV may go through raw-blend / proof-blend with no PCGS guide; the
    // signal we care about is the weighted-median of the proof pool, which
    // drives fmvCore in this no-guide scenario.
    expect(result.valuation.fmvCore).toBe(200);
  });

  test('BU bullion query (raw pool, same comp shape) -> ebayMedian reflects 30-day curve (400)', () => {
    const comps = fourStablePlusOneFresh('raw');
    const result = computeValuation(
      mockPcgs(),
      mockEbay(comps),
      null,
      null,
      { isBullion: true, spotPrice: 30 }
    );
    // BU pool with isBullion=true triggers bullion-spot-premium path which
    // serializes the weighted median onto bullionSpot.ebayMedian.
    expect(result.valuation.method).toBe('bullion-spot-premium');
    expect(result.valuation.bullionSpot).not.toBeNull();
    expect(result.valuation.bullionSpot.ebayMedian).toBe(400);
  });

  test('reverse-proof bullion query -> ebayMedian reflects 90-day curve (200)', () => {
    const comps = fourStablePlusOneFresh('reverse-proof');
    const result = computeValuation(
      mockPcgs(),
      mockEbay(comps),
      null,
      'Reverse Proof',
      { isBullion: true, isProof: true, isReverseProof: true, spotPrice: 30 }
    );
    expect(result.valuation.fmvCore).toBe(200);
  });

  test('weighted-median delta: proof pool yields 200, BU pool yields 400, for identical comp shape', () => {
    // Same outlier scenario, same pool size; only intent differs.  We
    // cannot compare fmvCore directly because the BU side is clamped by
    // the bullion-spot-premium ceiling (spot * 2 for silver), while the
    // proof side goes through raw-blend / proof-blend with no clamp.
    // So we compare the underlying weighted median: BU reports it via
    // bullionSpot.ebayMedian (400), proof reports it via fmvCore (200,
    // since there's no PCGS guide to dilute it).  The delta proves the
    // half-life dispatch is wired through computeValuation correctly.
    const proofComps = fourStablePlusOneFresh('proof');
    const buComps = fourStablePlusOneFresh('raw');
    const proofResult = computeValuation(
      mockPcgs(), mockEbay(proofComps),
      null, 'Proof',
      { isBullion: true, isProof: true, spotPrice: 30 }
    );
    const buResult = computeValuation(
      mockPcgs(), mockEbay(buComps),
      null, null,
      { isBullion: true, spotPrice: 30 }
    );
    expect(proofResult.valuation.fmvCore).toBe(200);
    expect(buResult.valuation.bullionSpot.ebayMedian).toBe(400);
  });
});
