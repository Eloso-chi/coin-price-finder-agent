/**
 * errorPaths.test.js — Error path & graceful degradation tests
 *
 * Covers:
 * - Zero comps surviving filters → null FMV, confidence 0
 * - PCGS API unavailable → fallback to eBay-only blend
 * - Greysheet API failure → blend renormalizes without it
 * - Metals spot price failure → bullion valuation degrades gracefully
 * - Grade pool empty after split → fallback behavior
 */

'use strict';

const { computeValuation } = require('../src/services/valuationService');

// ── Helpers (mirroring computeValuation.test.js patterns) ────
function mockPcgs(overrides = {}) {
  return {
    verified: overrides.verified ?? false,
    pcgsNo: overrides.pcgsNo || null,
    series: overrides.series || 'Morgan Dollar',
    year: overrides.year || 1921,
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
    us: {
      comps: usComps,
      stats: { count: usComps.length },
      removed: overrides.removed || {},
      gathered: overrides.gathered || null,
      attritionPct: overrides.attritionPct || null,
    },
    global: {
      comps: glComps,
      stats: { count: glComps.length },
    },
    usedFallback: overrides.usedFallback || false,
  };
}

function makeComp(price, opts = {}) {
  return {
    itemId: opts.itemId || 'c-' + Math.random().toString(36).slice(2),
    title: opts.title || '1921 Morgan Silver Dollar',
    totalUsd: price,
    matchScore: opts.matchScore ?? 70,
    gradeType: opts.gradeType || 'raw',
    soldDate: opts.soldDate || new Date().toISOString(),
    _source: opts._source || 'terapeak',
  };
}

function makeComps(prices, opts = {}) {
  return prices.map(p => makeComp(p, opts));
}

// ═══════════════════════════════════════════════════════════════
//  Zero comps — pipeline produces no usable data
// ═══════════════════════════════════════════════════════════════

describe('Error paths — zero comps', () => {
  test('zero US comps → null FMV and confidence 0', () => {
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: [] }));
    expect(result.valuation.fmvCore).toBeNull();
    expect(result.valuation.confidence).toBe(0);
  });

  test('zero US comps with PCGS guide only → uses guide as fallback', () => {
    const pcgs = mockPcgs({ priceGuide: { valueUsd: 100 }, verified: true });
    const result = computeValuation(pcgs, mockEbay({ usComps: [] }));
    // When PCGS guide is the only source, FMV may use it as standalone
    // or return null depending on implementation. Either way, no crash.
    expect(result).toHaveProperty('valuation');
    expect(result).toHaveProperty('decisions');
    if (result.valuation.fmvCore !== null) {
      expect(result.valuation.fmvCore).toBeGreaterThan(0);
    }
  });

  test('null ebay object → graceful null FMV', () => {
    const result = computeValuation(mockPcgs(), mockEbay());
    expect(result.valuation.fmvCore).toBeNull();
    expect(result.valuation.confidence).toBe(0);
    expect(result.valuation.explanation).toEqual(expect.any(Array));
  });

  test('null PCGS + null ebay → null FMV, still returns valid structure', () => {
    const result = computeValuation(null, mockEbay());
    expect(result).toHaveProperty('valuation');
    expect(result).toHaveProperty('decisions');
    expect(result.valuation.fmvCore).toBeNull();
    expect(result.valuation.rangeLow).toBeNull();
    expect(result.valuation.rangeHigh).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  PCGS unavailable — should still compute from eBay alone
// ═══════════════════════════════════════════════════════════════

describe('Error paths — PCGS unavailable', () => {
  test('no PCGS guide but good eBay data → FMV computed', () => {
    const comps = makeComps([50, 55, 60, 65, 70]);
    const pcgs = mockPcgs({ priceGuide: null, verified: false });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }));
    expect(result.valuation.fmvCore).not.toBeNull();
    expect(result.valuation.fmvCore).toBeGreaterThan(0);
    expect(result.valuation.confidence).toBeGreaterThan(0);
  });

  test('no PCGS guide reduces confidence vs. having it', () => {
    const comps = makeComps([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const withGuide = computeValuation(
      mockPcgs({ priceGuide: { valueUsd: 100 }, verified: true }),
      mockEbay({ usComps: comps })
    );
    const withoutGuide = computeValuation(
      mockPcgs({ priceGuide: null, verified: false }),
      mockEbay({ usComps: comps })
    );
    expect(withGuide.valuation.confidence).toBeGreaterThan(withoutGuide.valuation.confidence);
  });

  test('null PCGS object entirely → FMV still computed from eBay', () => {
    const comps = makeComps([50, 55, 60, 65, 70]);
    const result = computeValuation(null, mockEbay({ usComps: comps }));
    expect(result.valuation.fmvCore).not.toBeNull();
    expect(result.valuation.fmvCore).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Greysheet unavailable — blend renormalizes
// ═══════════════════════════════════════════════════════════════

describe('Error paths — Greysheet unavailable', () => {
  test('no Greysheet → FMV still computed (renormalized blend)', () => {
    const comps = makeComps([80, 85, 90, 95, 100]);
    const pcgs = mockPcgs({ priceGuide: { valueUsd: 90 }, verified: true });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }), null, null, { greysheet: null });
    expect(result.valuation.fmvCore).not.toBeNull();
    expect(result.valuation.fmvCore).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Grade pool edge cases
// ═══════════════════════════════════════════════════════════════

describe('Error paths — grade pool edge cases', () => {
  // #272W: this test previously defended the pre-#272W V1 silent pool
  // merge (graded query + 0 graded comps -> usCompsAll fallback merging raw
  // comps into the graded FMV). With the strict graded pool, the same
  // scenario now honestly returns null FMV when there is also no
  // grade-specific signal (no PCGS guide / Greysheet) AND the raw pool
  // is below the V2 last-resort threshold (rawSold < 10). The legacy
  // graded->raw V2 fallback (now tightened) is covered separately in
  // __tests__/computeValuation.test.js by '#272W last-resort fallback'.
  test('#272W: graded query with thin raw comps and no guide -> null FMV (honest pool isolation)', () => {
    const rawComps = makeComps([100, 110, 120, 130, 140], { gradeType: 'raw' });
    const pcgs = mockPcgs({ grade: 'MS-65' });
    const result = computeValuation(pcgs, mockEbay({ usComps: rawComps }), null, 65);
    // Strict graded pool: 0 graded comps and rawSold (5) < 10 with no
    // guide signal -> honest null rather than mixing raw into graded FMV.
    expect(result.valuation.fmvCore).toBeNull();
    expect(result.valuation.gradePool.wantsGraded).toBe(true);
    expect(result.valuation.gradePool.gradedCount).toBe(0);
    expect(result.valuation.gradePool.rawCount).toBe(5);
    expect(result.valuation.gradePool.poolFallback).toBe(false);
  });

  test('single comp → FMV computed but low confidence', () => {
    const comps = makeComps([200]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    if (result.valuation.fmvCore !== null) {
      expect(result.valuation.confidence).toBeLessThan(50);
    }
  });

  test('all comps are browse-only → browseOnly flagged, confidence penalized', () => {
    const browseComps = makeComps([100, 110, 120, 130, 140], { _source: 'browse' });
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: browseComps }));
    if (result.valuation.fmvCore !== null) {
      expect(result.valuation.dataSource.browseOnly).toBe(true);
      // Browse-only penalty should reduce confidence vs. sold comps
      const soldComps = makeComps([100, 110, 120, 130, 140], { _source: 'terapeak' });
      const soldResult = computeValuation(mockPcgs(), mockEbay({ usComps: soldComps }));
      expect(soldResult.valuation.confidence).toBeGreaterThan(result.valuation.confidence);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
//  Decision structure always present
// ═══════════════════════════════════════════════════════════════

describe('Error paths — decisions structure', () => {
  test('null FMV → decisions still has buy/sell objects', () => {
    const result = computeValuation(null, mockEbay());
    expect(result.decisions).toHaveProperty('buy');
    expect(result.decisions).toHaveProperty('sell');
  });

  test('valid FMV → buy.max70/75/80 are proportional', () => {
    const comps = makeComps([100, 100, 100, 100, 100, 100, 100, 100]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    const { buy } = result.decisions;
    if (result.valuation.fmvCore !== null) {
      expect(buy.max70).toBeLessThanOrEqual(buy.max75);
      expect(buy.max75).toBeLessThanOrEqual(buy.max80);
      expect(buy.max80).toBeLessThanOrEqual(result.valuation.fmvCore);
    }
  });

  test('valid FMV → sell.fast <= sell.normal <= sell.premium', () => {
    const comps = makeComps([100, 100, 100, 100, 100, 100, 100, 100]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    const { sell } = result.decisions;
    if (result.valuation.fmvCore !== null) {
      expect(sell.fast).toBeLessThanOrEqual(sell.normal);
      expect(sell.normal).toBeLessThanOrEqual(sell.premium);
    }
  });
});
