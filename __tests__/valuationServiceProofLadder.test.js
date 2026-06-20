'use strict';

/**
 * valuationServiceProofLadder.test.js -- Pins the #282H proof / fallback
 * ladder changes in computeValuation:
 *
 *   1. Fix 1 (skipSpotMath): proof / reverse-proof intent must NEVER hit
 *      the `bullion-spot-premium` branch -- it silently truncates real
 *      collector premiums to (silver_spot * 2) or (gold_spot * 1.4) and
 *      collapses dozens of distinct proof dates to the same FMV.  Even
 *      with strong eBay proof comps, FMV must come from the proof comp
 *      median, not from spot + a clamped premium.
 *
 *   2. Fix 1 (skipSpotMath): proof intent must also skip the bullion
 *      fallback ladder (bullion-spot-only / bullion-greysheet-anchor) --
 *      substituting BU bullion math for an empty proof query gives the
 *      wrong number, not a missing one.  The engine returns null FMV
 *      with an explicit explanation citing "no proof comps; BU not
 *      substituted".
 *
 *   3. Fix 3 (Greysheet anchor): for non-proof bullion queries where
 *      eBay yielded no usable comps but Greysheet wholesale is at least
 *      80% of spot, FMV blends 70% Greysheet + 30% spot under method
 *      `bullion-greysheet-anchor`, rather than collapsing to bare spot.
 *      When Greysheet is missing or below 80% of spot, the legacy
 *      bullion-spot-only behavior is preserved.
 *
 * Non-regression: BU bullion queries with comps still hit
 * `bullion-spot-premium` exactly as before.
 */

const { computeValuation } = require('../src/services/valuationService');

// ── Mock helpers (copied from computeValuation.test.js for isolation) ──
function mockPcgs(overrides = {}) {
  return {
    verified: overrides.verified ?? false,
    pcgsNo: overrides.pcgsNo || null,
    series: overrides.series || 'Silver Libertad',
    year: overrides.year || 2023,
    mint: overrides.mint || null,
    grade: overrides.grade || null,
    designation: overrides.designation || null,
    priceGuide: overrides.priceGuide || null,
    population: overrides.population || null,
    auction: overrides.auction || null,
    _isBar: overrides._isBar || false,
    ...overrides,
  };
}

function mockEbay(overrides = {}) {
  const usComps = overrides.usComps || [];
  const glComps = overrides.glComps || [];
  return {
    us: { comps: usComps, stats: { count: usComps.length } },
    global: { comps: glComps, stats: { count: glComps.length } },
    usedFallback: overrides.usedFallback || false,
  };
}

function makeComp(price, opts = {}) {
  return {
    itemId: opts.itemId || 'c-' + Math.random().toString(36).slice(2),
    title: opts.title || 'Test Comp',
    totalUsd: price,
    matchScore: opts.matchScore ?? 70,
    gradeType: opts.gradeType || 'raw',
    soldDate: opts.soldDate || new Date().toISOString(),
    _source: opts._source || 'finding',
  };
}

function makeComps(prices, opts = {}) {
  return prices.map(p => makeComp(p, opts));
}

// ════════════════════════════════════════════════════════════════
//  #282H Fix 1 -- proof intent skips bullion-spot-premium
// ════════════════════════════════════════════════════════════════

describe('#282H Fix 1 -- proof intent skips bullion-spot-premium', () => {
  const silverSpot = 30;

  test('proof bullion with 10+ proof comps uses comp median, NOT spot+premium', () => {
    // Silver Libertad Proof comp pool ~$200 each; silver spot $30.
    // Without the skip guard, FMV would clamp to spot * 2 = $60.
    const proof = makeComps([190, 200, 210, 195, 205, 215, 190, 200, 210, 205, 220, 195],
                            { gradeType: 'proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: proof }),
      null,
      'Proof',
      { isBullion: true, spotPrice: silverSpot }
    );
    expect(result.valuation.method).not.toBe('bullion-spot-premium');
    expect(result.valuation.method).not.toBe('bullion-spot-only');
    expect(result.valuation.method).not.toBe('bullion-greysheet-anchor');
    expect(result.valuation.fmvCore).toBeGreaterThan(150);
    expect(result.valuation.fmvCore).toBeLessThan(260);
    expect(result.valuation.gradePool.wantsProof).toBe(true);
  });

  test('reverse-proof bullion with 5+ RP comps uses RP median, NOT spot+premium', () => {
    // RP Silver coin trades ~$400; silver spot $30. Without skip guard,
    // bullion-spot-premium would clamp to $60.
    const rp = makeComps([380, 400, 420, 390, 410], { gradeType: 'reverse-proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: rp }),
      null,
      'Proof',
      { isBullion: true, isProof: true, isReverseProof: true, spotPrice: silverSpot }
    );
    expect(result.valuation.method).not.toBe('bullion-spot-premium');
    expect(result.valuation.method).not.toBe('bullion-spot-only');
    expect(result.valuation.method).not.toBe('bullion-greysheet-anchor');
    expect(result.valuation.fmvCore).toBeGreaterThan(300);
    expect(result.valuation.gradePool.wantsReverseProof).toBe(true);
  });

  test('proof bullion with thin (<3) proof pool still avoids spot+premium', () => {
    // With only 2 proof comps, ebayMedian is computed from the (tiny) proof
    // pool; the previous bug would still hit bullion-spot-premium because
    // isBullion=true and ebayMedian > spotPrice * 0.5.  With the guard,
    // the engine routes through the comp-blend path with a lowData warning.
    const proof = makeComps([200, 210], { gradeType: 'proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: proof }),
      null,
      'Proof',
      { isBullion: true, spotPrice: silverSpot }
    );
    expect(result.valuation.method).not.toBe('bullion-spot-premium');
    expect(result.valuation.gradePool.wantsProof).toBe(true);
    // lowData should be set (we have a thin proof pool)
    expect(result.valuation.lowData).toBe(true);
  });

  test('proof bullion with NO proof comps returns null FMV with explicit proof-no-fallback explanation', () => {
    // BU comps are present and would otherwise dominate, but proof intent
    // means BU is structurally excluded.  No PCGS guide, no Greysheet.
    // Engine must NOT fall back to spot+premium or spot-only on BU comps.
    const bu = makeComps([35, 36, 37, 38, 39, 40], { gradeType: 'raw' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: bu }),
      null,
      'Proof',
      { isBullion: true, spotPrice: silverSpot }
    );
    expect(result.valuation.fmvCore).toBeNull();
    expect(result.valuation.confidence).toBe(0);
    const exp = result.valuation.explanation.join(' ').toLowerCase();
    expect(exp).toMatch(/no proof comps/);
    expect(exp).toMatch(/not substituted|bu .*not substituted|wrong number/);
  });

  test('non-regression: BU bullion (no proof intent) still hits bullion-spot-premium', () => {
    // Silver Eagle BU, 10+ raw sold comps at $35-$40, silver spot $30.
    // wantsProof / wantsReverseProof both false -- guard must NOT fire.
    const bu = makeComps([35, 36, 37, 38, 39, 40, 35, 36, 37, 38], { gradeType: 'raw' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: bu }),
      null,
      null,
      { isBullion: true, spotPrice: silverSpot }
    );
    expect(result.valuation.method).toBe('bullion-spot-premium');
    expect(result.valuation.gradePool.wantsProof).toBe(false);
    expect(result.valuation.gradePool.wantsReverseProof).toBe(false);
  });

  test('reverse-proof bullion with thin (<3) RP pool still avoids spot+premium', () => {
    // Mirror of the proof-thin-pool test above for RP intent.  With only 2 RP
    // comps, the previous bug would still hit bullion-spot-premium because
    // isBullion=true and ebayMedian (from the 2-comp RP pool) > spotPrice * 0.5.
    // With the skipSpotMath guard, the engine routes through the comp-blend
    // path with a lowData warning, never clamping to silver_spot * 2.
    const rp = makeComps([380, 410], { gradeType: 'reverse-proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: rp }),
      null,
      'Proof',
      { isBullion: true, isProof: true, isReverseProof: true, spotPrice: silverSpot }
    );
    expect(result.valuation.method).not.toBe('bullion-spot-premium');
    expect(result.valuation.method).not.toBe('bullion-spot-only');
    expect(result.valuation.method).not.toBe('bullion-greysheet-anchor');
    expect(result.valuation.gradePool.wantsReverseProof).toBe(true);
    expect(result.valuation.lowData).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════
//  #282H Fix 3 -- Greysheet anchor fallback for BU bullion
// ════════════════════════════════════════════════════════════════

describe('#282H Fix 3 -- bullion-greysheet-anchor fallback', () => {
  const silverSpot = 30;

  test('no eBay + Greysheet >= 80% of spot -> bullion-greysheet-anchor (70/30 blend)', () => {
    // Silver Eagle BU: no comps survived filtering, but Greysheet sits at
    // $35 (above spot $30, comfortably above the 80% guard).  FMV should
    // blend 0.7 * 35 + 0.3 * 30 = 24.5 + 9 = $33.50.
    const greysheet = { greyVal: 35, cpgVal: 38 };
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: [] }),
      null,
      null,
      { isBullion: true, spotPrice: silverSpot, greysheet }
    );
    expect(result.valuation.method).toBe('bullion-greysheet-anchor');
    expect(result.valuation.fmvCore).toBeCloseTo(33.5, 1);
  });

  test('no eBay + Greysheet below 80% of spot -> bullion-spot-only (legacy behavior)', () => {
    // Stale / nominal Greysheet at $20 vs silver spot $30 (Greysheet only
    // 67% of spot).  Engine must reject the anchor and fall back to bare
    // spot rather than dragging FMV well below current metal value.
    const greysheet = { greyVal: 20, cpgVal: 22 };
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: [] }),
      null,
      null,
      { isBullion: true, spotPrice: silverSpot, greysheet }
    );
    expect(result.valuation.method).toBe('bullion-spot-only');
    expect(result.valuation.fmvCore).toBe(silverSpot);
  });

  test('Greysheet exactly at 80% of spot -> bullion-greysheet-anchor (>= boundary inclusive)', () => {
    // Pin the boundary: guard is `greysheetVal >= spotPrice * 0.8`, so an
    // exact-80% Greysheet must still trigger the anchor, not fall through
    // to bullion-spot-only. Silver spot $30, Greysheet $24 (exactly 80%).
    // FMV = 0.7 * 24 + 0.3 * 30 = 16.8 + 9 = $25.80.
    const greysheet = { greyVal: 24, cpgVal: 26 };
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: [] }),
      null,
      null,
      { isBullion: true, spotPrice: silverSpot, greysheet }
    );
    expect(result.valuation.method).toBe('bullion-greysheet-anchor');
    expect(result.valuation.fmvCore).toBeCloseTo(25.8, 1);
  });

  test('no eBay + no Greysheet -> bullion-spot-only (legacy behavior)', () => {
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: [] }),
      null,
      null,
      { isBullion: true, spotPrice: silverSpot }
    );
    expect(result.valuation.method).toBe('bullion-spot-only');
    expect(result.valuation.fmvCore).toBe(silverSpot);
  });

  test('proof intent never hits the Greysheet-anchor BLEND (skipSpotMath gate applies)', () => {
    // Greysheet wholesale for a proof coin IS a legitimate proof anchor
    // (the route passes the proof-specific guide value).  What we must NOT
    // do is run the `bullion-greysheet-anchor` BLEND (70% Greysheet + 30%
    // spot) -- spot is the BU bullion price, not the proof price, so the
    // 30% spot weight would silently drag the FMV down.  Proof Greysheet
    // must be consumed via the standard raw-blend / certified-blend path,
    // which uses it neat (no spot mixing).
    const greysheet = { greyVal: 200, cpgVal: 220 };
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: [] }),
      null,
      'Proof',
      { isBullion: true, spotPrice: silverSpot, greysheet }
    );
    expect(result.valuation.method).not.toBe('bullion-greysheet-anchor');
    expect(result.valuation.method).not.toBe('bullion-spot-only');
    expect(result.valuation.method).not.toBe('bullion-spot-premium');
    // raw-blend with only Greysheet available -> FMV equals the Greysheet
    // value (no spot dilution).
    expect(result.valuation.fmvCore).toBeCloseTo(200, 0);
  });

  test('proof intent with NO comps AND no Greysheet AND no PCGS guide -> null FMV', () => {
    // The strict no-fallback contract: proof intent + nothing else to
    // anchor on must return null.  This is the case where the new
    // explanation text fires.
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: [] }),
      null,
      'Proof',
      { isBullion: true, spotPrice: silverSpot }
    );
    expect(result.valuation.fmvCore).toBeNull();
    expect(result.valuation.method).not.toBe('bullion-greysheet-anchor');
    expect(result.valuation.method).not.toBe('bullion-spot-only');
  });

  test('bullion-greysheet-anchor exposes diagnostic shape on valuation.bullionSpot', () => {
    // #282H -- new method must serialize alongside the other two bullion
    // modes so admin clients can see how FMV was composed.
    const greysheet = { greyVal: 35, cpgVal: 38 };
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: [] }),
      null,
      null,
      { isBullion: true, spotPrice: silverSpot, greysheet }
    );
    expect(result.valuation.method).toBe('bullion-greysheet-anchor');
    const bs = result.valuation.bullionSpot;
    expect(bs).not.toBeNull();
    expect(bs.spotPrice).toBeCloseTo(silverSpot, 1);
    expect(bs.greysheetVal).toBeCloseTo(35, 1);
    expect(bs.greysheetWeight).toBe(0.7);
    expect(bs.spotWeight).toBe(0.3);
    expect(bs.ebayMedian).toBeNull();
    // FMV = 0.7 * 35 + 0.3 * 30 = 33.5 -> premiumPct vs spot = (33.5/30 - 1)*100 = 11.7
    expect(bs.premiumPct).toBeCloseTo(11.7, 1);
  });
});
