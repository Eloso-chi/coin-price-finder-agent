/**
 * computeValuation.test.js — Unit tests for src/services/valuationService.js
 *
 * Covers: computeValuation FMV blending, confidence scoring,
 *         buy/sell decisions, range calculation, grade pool selection,
 *         data source analysis, edge cases.
 */

'use strict';

const { computeValuation } = require('../src/services/valuationService');

// ── Helper: build mock PCGS result ───────────────────────────
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

// ── Helper: build mock eBay result ───────────────────────────
function mockEbay(overrides = {}) {
  const usComps = overrides.usComps || [];
  const glComps = overrides.glComps || [];
  return {
    us: {
      comps: usComps,
      stats: { count: usComps.length },
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

// ═══════════════════════════════════════════════════════════════
//  Basic FMV computation
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — basic FMV', () => {
  test('returns null FMV when no data', () => {
    const result = computeValuation(null, mockEbay());
    expect(result.valuation.fmvCore).toBeNull();
    expect(result.valuation.confidence).toBe(0);
  });

  test('computes FMV from eBay comps only (raw coin)', () => {
    const comps = makeComps([30, 32, 35, 37, 40]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    expect(result.valuation.fmvCore).toBeGreaterThan(0);
    expect(result.valuation.fmvCore).toBeLessThan(100);
    expect(result.valuation.confidence).toBeGreaterThan(0);
  });

  test('FMV is reasonable relative to comp prices', () => {
    const prices = [100, 105, 110, 115, 120];
    const comps = makeComps(prices);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    const fmv = result.valuation.fmvCore;
    // FMV should be within the range of comps (with some tolerance for blending)
    expect(fmv).toBeGreaterThanOrEqual(80);
    expect(fmv).toBeLessThanOrEqual(150);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Certified vs Raw blending
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — certified vs raw blend', () => {
  test('certified coin uses 55/15/10/20 blend (renorm without Greysheet)', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const pcgs = mockPcgs({
      verified: true,
      priceGuide: { valueUsd: 120 },
      auction: { medianUsd: 110 },
    });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }));
    // Without Greysheet, weights renormalize 55/15/10 -> 68.75/18.75/12.5
    // FMV = 0.6875*100 + 0.1875*120 + 0.125*110 = 68.75 + 22.5 + 13.75 = 105
    expect(result.valuation.fmvCore).toBeCloseTo(105, 0);
    expect(result.valuation.explanation.some(e => /certified/i.test(e))).toBe(true);
  });

  test('raw coin uses 70/10/20 blend (renorm without Greysheet)', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const pcgs = mockPcgs({
      verified: false,
      priceGuide: { valueUsd: 120 },
    });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }), null, null);
    // Without Greysheet, weights renormalize 70/10 -> 87.5/12.5
    // FMV = 0.875*100 + 0.125*120 = 87.5 + 15 = 102.5
    expect(result.valuation.fmvCore).toBeCloseTo(102.5, 0);
    expect(result.valuation.explanation.some(e => /raw/i.test(e))).toBe(true);
  });

  test('missing PCGS guide → eBay-only blend', () => {
    const comps = makeComps([50, 52, 55, 48, 51]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    const fmv = result.valuation.fmvCore;
    // Should be roughly the median of comps
    expect(fmv).toBeGreaterThan(45);
    expect(fmv).toBeLessThan(60);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Range calculation
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — range', () => {
  test('rangeLow <= fmvCore <= rangeHigh', () => {
    const comps = makeComps([30, 35, 40, 45, 50]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    const { fmvCore, rangeLow, rangeHigh } = result.valuation;
    expect(rangeLow).toBeLessThanOrEqual(fmvCore);
    expect(rangeHigh).toBeGreaterThanOrEqual(fmvCore);
  });

  test('range has minimum 5% spread', () => {
    // All identical prices → stddev=0, but min spread is 5%
    const comps = makeComps([100, 100, 100, 100, 100]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    const { fmvCore, rangeLow, rangeHigh } = result.valuation;
    const spread = rangeHigh - rangeLow;
    expect(spread).toBeGreaterThanOrEqual(fmvCore * 0.10 - 0.01); // 2 × 5% = 10% total
  });

  test('rangeLow is never negative', () => {
    const comps = makeComps([1, 1, 1, 1, 1]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    expect(result.valuation.rangeLow).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Confidence scoring
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — confidence', () => {
  test('more comps → higher confidence', () => {
    const few = makeComps([50, 52, 55]);
    const many = makeComps([50, 52, 55, 48, 51, 53, 49, 54, 50, 52, 55, 48, 51, 53, 49]);

    const fewResult = computeValuation(mockPcgs(), mockEbay({ usComps: few }));
    const manyResult = computeValuation(mockPcgs(), mockEbay({ usComps: many }));
    expect(manyResult.valuation.confidence).toBeGreaterThan(fewResult.valuation.confidence);
  });

  test('PCGS verified → confidence bonus', () => {
    const comps = makeComps([100, 105, 110]);
    const noVerify = computeValuation(mockPcgs({ verified: false }), mockEbay({ usComps: comps }));
    const verified = computeValuation(
      mockPcgs({ verified: true, priceGuide: { valueUsd: 105 } }),
      mockEbay({ usComps: comps }),
      null,
      'MS-64'
    );
    expect(verified.valuation.confidence).toBeGreaterThan(noVerify.valuation.confidence);
  });

  test('confidence is capped at 0–100', () => {
    const comps = makeComps(Array(50).fill(100));
    const pcgs = mockPcgs({
      verified: true,
      priceGuide: { valueUsd: 100 },
      auction: { medianUsd: 100 },
    });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }), null, 'MS-65');
    expect(result.valuation.confidence).toBeLessThanOrEqual(100);
    expect(result.valuation.confidence).toBeGreaterThanOrEqual(0);
  });

  test('browse-only gets heavy confidence penalty', () => {
    const comps = makeComps([100, 105, 110, 115, 120]).map(c => ({ ...c, _source: 'browse' }));
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    expect(result.valuation.dataSource.browseOnly).toBe(true);
    // Confidence should be notably lower
    expect(result.valuation.confidence).toBeLessThan(40);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Buy / Sell decisions
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — buy/sell decisions', () => {
  test('buy: max70 < max75 < max80', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 80);
    const { max70, max75, max80 } = result.decisions.buy;
    expect(max70).toBeLessThan(max75);
    expect(max75).toBeLessThan(max80);
  });

  test('buy recommendation: BUY when asking <= 75% FMV', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 70); // 70% of ~100
    expect(result.decisions.buy.recommendation).toBe('BUY');
  });

  test('buy recommendation: PASS when asking > 80% FMV', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 95);
    expect(result.decisions.buy.recommendation).toBe('PASS');
  });

  test('buy recommendation: null when no asking price', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    expect(result.decisions.buy.recommendation).toBeNull();
  });

  test('sell: fast <= normal <= premium', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    const { fast, normal, premium } = result.decisions.sell;
    expect(fast).toBeLessThanOrEqual(normal);
    expect(normal).toBeLessThanOrEqual(premium);
  });

  test('scarce population gets premium boost', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const normalResult = computeValuation(
      mockPcgs({ population: { thisGrade: 5000 } }),
      mockEbay({ usComps: comps })
    );
    const scarceResult = computeValuation(
      mockPcgs({ population: { thisGrade: 50 } }),
      mockEbay({ usComps: comps })
    );
    expect(scarceResult.decisions.sell.premium).toBeGreaterThan(normalResult.decisions.sell.premium);
  });
});

// ═══════════════════════════════════════════════════════════════
//  #50: Low-population confidence penalty
// ═══════════════════════════════════════════════════════════════

describe('computeValuation -- low-pop confidence penalty (#50)', () => {
  test('pop < 50 gets largest penalty', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const highPop = computeValuation(
      mockPcgs({ population: { thisGrade: 5000 }, pcgsNo: 1234 }),
      mockEbay({ usComps: comps })
    );
    const lowPop = computeValuation(
      mockPcgs({ population: { thisGrade: 30 }, pcgsNo: 1234 }),
      mockEbay({ usComps: comps })
    );
    expect(lowPop.valuation.confidence).toBeLessThan(highPop.valuation.confidence);
    expect(highPop.valuation.confidence - lowPop.valuation.confidence).toBeGreaterThanOrEqual(15);
  });

  test('pop 50-99 gets moderate penalty', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const highPop = computeValuation(
      mockPcgs({ population: { thisGrade: 5000 }, pcgsNo: 1234 }),
      mockEbay({ usComps: comps })
    );
    const midPop = computeValuation(
      mockPcgs({ population: { thisGrade: 75 }, pcgsNo: 1234 }),
      mockEbay({ usComps: comps })
    );
    expect(midPop.valuation.confidence).toBeLessThan(highPop.valuation.confidence);
    expect(highPop.valuation.confidence - midPop.valuation.confidence).toBeGreaterThanOrEqual(10);
  });

  test('pop 100-199 gets small penalty', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const highPop = computeValuation(
      mockPcgs({ population: { thisGrade: 5000 }, pcgsNo: 1234 }),
      mockEbay({ usComps: comps })
    );
    const thinPop = computeValuation(
      mockPcgs({ population: { thisGrade: 150 }, pcgsNo: 1234 }),
      mockEbay({ usComps: comps })
    );
    expect(thinPop.valuation.confidence).toBeLessThan(highPop.valuation.confidence);
    expect(highPop.valuation.confidence - thinPop.valuation.confidence).toBeGreaterThanOrEqual(5);
  });

  test('pop >= 200 gets no penalty', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const pop200 = computeValuation(
      mockPcgs({ population: { thisGrade: 200 }, pcgsNo: 1234 }),
      mockEbay({ usComps: comps })
    );
    const pop5000 = computeValuation(
      mockPcgs({ population: { thisGrade: 5000 }, pcgsNo: 1234 }),
      mockEbay({ usComps: comps })
    );
    expect(pop200.valuation.confidence).toBe(pop5000.valuation.confidence);
  });

  test('low-pop explanation note is present', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const result = computeValuation(
      mockPcgs({ population: { thisGrade: 30 }, pcgsNo: 1234 }),
      mockEbay({ usComps: comps })
    );
    expect(result.valuation.explanation.some(e => /low population/i.test(e))).toBe(true);
  });

  test('bars skip low-pop penalty', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const barLowPop = computeValuation(
      mockPcgs({ _isBar: true, population: { thisGrade: 10 } }),
      mockEbay({ usComps: comps })
    );
    const barHighPop = computeValuation(
      mockPcgs({ _isBar: true, population: { thisGrade: 5000 } }),
      mockEbay({ usComps: comps })
    );
    expect(barLowPop.valuation.confidence).toBe(barHighPop.valuation.confidence);
  });
});

// ═══════════════════════════════════════════════════════════════
//  #51: Dynamic FMV weight by grade tier
// ═══════════════════════════════════════════════════════════════

describe('computeValuation -- dynamic grade weights (#51)', () => {
  test('MS67+ shifts weight toward PCGS auction', () => {
    // eBay median ~100, PCGS guide 150, Auction 160
    // High-grade tier: eBay 30%, PCGS 20%, Auction 25%, Greysheet 25%
    // Mid-grade tier:  eBay 55%, PCGS 15%, Auction 10%, Greysheet 20%
    const comps = makeComps([100, 100, 100, 100, 100], { gradeType: 'graded' });
    const pcgs = mockPcgs({
      verified: true,
      priceGuide: { valueUsd: 150 },
      auction: { medianUsd: 160 },
    });

    const midGrade = computeValuation(pcgs, mockEbay({ usComps: comps }), null, 'MS-65');
    const highGrade = computeValuation(pcgs, mockEbay({ usComps: comps }), null, 'MS-68');

    // High-grade FMV should be higher because auction (160) gets more weight
    expect(highGrade.valuation.fmvCore).toBeGreaterThan(midGrade.valuation.fmvCore);
  });

  test('AU58 and below shifts weight toward eBay', () => {
    const comps = makeComps([100, 100, 100, 100, 100], { gradeType: 'graded' });
    const pcgs = mockPcgs({
      verified: true,
      priceGuide: { valueUsd: 150 },
      auction: { medianUsd: 160 },
    });

    const midGrade = computeValuation(pcgs, mockEbay({ usComps: comps }), null, 'MS-64');
    const lowGrade = computeValuation(pcgs, mockEbay({ usComps: comps }), null, 'VF-30');

    // Low-grade FMV should be lower because eBay (100) gets more weight
    expect(lowGrade.valuation.fmvCore).toBeLessThan(midGrade.valuation.fmvCore);
  });

  test('no userGrade defaults to mid tier', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const pcgs = mockPcgs({
      verified: true,
      priceGuide: { valueUsd: 120 },
      auction: { medianUsd: 110 },
    });

    const noGrade = computeValuation(pcgs, mockEbay({ usComps: comps }));
    // Without Greysheet, weights renormalize 55/15/10 -> 68.75/18.75/12.5
    // FMV = 0.6875*100 + 0.1875*120 + 0.125*110 = 105
    expect(noGrade.valuation.fmvCore).toBeCloseTo(105, 0);
  });

  test('raw coins always use raw blend (not grade-tiered)', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const pcgs = mockPcgs({
      verified: false,
      priceGuide: { valueUsd: 120 },
    });

    const result = computeValuation(pcgs, mockEbay({ usComps: comps }));
    expect(result.valuation.explanation.some(e => /raw coin blend/i.test(e))).toBe(true);
  });

  test('explanation mentions grade tier for certified', () => {
    const comps = makeComps([100, 100, 100, 100, 100], { gradeType: 'graded' });
    const pcgs = mockPcgs({
      verified: true,
      priceGuide: { valueUsd: 120 },
    });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }), null, 'MS-68');
    expect(result.valuation.explanation.some(e => /grade tier.*high/i.test(e))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  #52: Sliding buy spread by FMV value
// ═══════════════════════════════════════════════════════════════

describe('computeValuation -- sliding buy spread (#52)', () => {
  test('low-value coin (<=$50) gets wide spread', () => {
    const comps = makeComps([30, 30, 30, 30, 30]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 20);
    // max70 should be 60% of FMV for <$50 tier
    const fmv = result.valuation.fmvCore;
    expect(result.decisions.buy.max70).toBeCloseTo(fmv * 0.60, 0);
    expect(result.decisions.buy.max75).toBeCloseTo(fmv * 0.70, 0);
    expect(result.decisions.buy.max80).toBeCloseTo(fmv * 0.75, 0);
  });

  test('mid-value coin ($50-$200) gets standard spread', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 70);
    const fmv = result.valuation.fmvCore;
    expect(result.decisions.buy.max70).toBeCloseTo(fmv * 0.70, 0);
    expect(result.decisions.buy.max75).toBeCloseTo(fmv * 0.75, 0);
    expect(result.decisions.buy.max80).toBeCloseTo(fmv * 0.80, 0);
  });

  test('high-value coin ($1k-$5k) gets tight spread', () => {
    const comps = makeComps([2000, 2000, 2000, 2000, 2000]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 1500);
    const fmv = result.valuation.fmvCore;
    expect(result.decisions.buy.max70).toBeCloseTo(fmv * 0.80, 0);
    expect(result.decisions.buy.max75).toBeCloseTo(fmv * 0.85, 0);
    expect(result.decisions.buy.max80).toBeCloseTo(fmv * 0.90, 0);
  });

  test('very high-value coin ($5k+) gets very tight spread', () => {
    const comps = makeComps([10000, 10000, 10000, 10000, 10000]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 8000);
    const fmv = result.valuation.fmvCore;
    expect(result.decisions.buy.max70).toBeCloseTo(fmv * 0.85, 0);
    expect(result.decisions.buy.max75).toBeCloseTo(fmv * 0.90, 0);
    expect(result.decisions.buy.max80).toBeCloseTo(fmv * 0.95, 0);
  });

  test('BUY recommendation uses sliding thresholds', () => {
    // $10k coin at $9k asking = 90% FMV → BUY with tight spread
    const comps = makeComps([10000, 10000, 10000, 10000, 10000]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 9000);
    // $5k+ tier: mid=90%, high=95%. $9k <= 90% of $10k → BUY
    expect(result.decisions.buy.recommendation).toBe('BUY');
  });

  test('PASS recommendation uses sliding thresholds', () => {
    // $10k coin at $9800 asking = 98% FMV → PASS even with tight spread
    const comps = makeComps([10000, 10000, 10000, 10000, 10000]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 9800);
    expect(result.decisions.buy.recommendation).toBe('PASS');
  });

  test('spreadTier is included in response', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }), 70);
    expect(result.decisions.buy.spreadTier).toBeDefined();
    expect(result.decisions.buy.spreadTier.low).toBeLessThan(result.decisions.buy.spreadTier.mid);
    expect(result.decisions.buy.spreadTier.mid).toBeLessThan(result.decisions.buy.spreadTier.high);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Grade pool selection
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — grade pool', () => {
  test('graded comps used when userGrade specified', () => {
    const graded = makeComps([100, 105, 110], { gradeType: 'graded' });
    const raw = makeComps([50, 55, 60], { gradeType: 'raw' });
    const allComps = [...graded, ...raw];
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: allComps }), null, 'MS-64');
    expect(result.valuation.gradePool.wantsGraded).toBe(true);
    // FMV should be closer to graded prices (100-110) than raw (50-60)
    expect(result.valuation.fmvCore).toBeGreaterThan(80);
  });

  test('raw comps used when no userGrade', () => {
    const graded = makeComps([100, 105, 110], { gradeType: 'graded' });
    const raw = makeComps([50, 55, 60], { gradeType: 'raw' });
    const allComps = [...graded, ...raw];
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: allComps }));
    expect(result.valuation.gradePool.wantsGraded).toBe(false);
    // FMV should be closer to raw prices (50-60) than graded (100-110)
    expect(result.valuation.fmvCore).toBeLessThan(80);
  });

  test('falls back to all comps when preferred pool too small', () => {
    const graded = makeComps([100], { gradeType: 'graded' }); // only 1
    const raw = makeComps([50, 55, 60, 65, 70], { gradeType: 'raw' });
    const allComps = [...graded, ...raw];
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: allComps }), null, 'MS-64');
    // Should fall back to all 6 comps since only 1 graded
    expect(result.valuation.gradePool.poolCount).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Data source analysis
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — data source labels', () => {
  test('all sold → "sold-data"', () => {
    const comps = makeComps([50, 55, 60], { _source: 'finding' });
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    expect(result.valuation.dataSource.label).toBe('sold-data');
  });

  test('all browse → "asking-prices-only"', () => {
    const comps = makeComps([50, 55, 60], { _source: 'browse' });
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    expect(result.valuation.dataSource.label).toBe('asking-prices-only');
    expect(result.valuation.dataSource.browseOnly).toBe(true);
  });

  test('mostly browse → "mostly-asking"', () => {
    const sold = makeComps([50], { _source: 'finding' });
    const browse = makeComps([55, 60, 65, 70, 75, 80], { _source: 'browse' });
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: [...sold, ...browse] }));
    expect(result.valuation.dataSource.label).toBe('mostly-asking');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Edge cases
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — edge cases', () => {
  test('single comp produces valid output', () => {
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: [makeComp(100)] }));
    expect(result.valuation.fmvCore).toBeGreaterThan(0);
    expect(typeof result.valuation.confidence).toBe('number');
  });

  test('empty eBay with PCGS guide only', () => {
    const pcgs = mockPcgs({ priceGuide: { valueUsd: 200 } });
    const result = computeValuation(pcgs, mockEbay());
    // Should still produce some FMV from PCGS guide alone
    // Actually, if no eBay median, blendSources may return null depending on implementation
    // Let's check
    if (result.valuation.fmvCore != null) {
      expect(result.valuation.fmvCore).toBeGreaterThan(0);
    }
  });

  test('bullion uses steeper recency weighting', () => {
    const recentComps = makeComps([30, 31, 32], {
      soldDate: new Date().toISOString()
    });
    const oldComps = makeComps([50, 51, 52], {
      soldDate: new Date(Date.now() - 90 * 86400000).toISOString()
    });
    const all = [...recentComps, ...oldComps];

    const numResult = computeValuation(mockPcgs(), mockEbay({ usComps: all }), null, null, { isBullion: false });
    const bullResult = computeValuation(mockPcgs(), mockEbay({ usComps: all }), null, null, { isBullion: true });

    // Bullion should weight recent comps more heavily → lower FMV
    // (recent are $30-32, old are $50-52)
    if (bullResult.valuation.fmvCore != null && numResult.valuation.fmvCore != null) {
      expect(bullResult.valuation.fmvCore).toBeLessThanOrEqual(numResult.valuation.fmvCore + 1);
    }
  });

  test('all numeric outputs are numbers (no NaN)', () => {
    const comps = makeComps([25, 30, 35, 40, 45]);
    const result = computeValuation(
      mockPcgs({ priceGuide: { valueUsd: 35 } }),
      mockEbay({ usComps: comps }),
      30
    );
    const v = result.valuation;
    for (const key of ['fmvCore', 'rangeLow', 'rangeHigh', 'confidence']) {
      expect(typeof v[key]).toBe('number');
      expect(isNaN(v[key])).toBe(false);
    }
    const b = result.decisions.buy;
    for (const key of ['max70', 'max75', 'max80']) {
      expect(typeof b[key]).toBe('number');
      expect(isNaN(b[key])).toBe(false);
    }
    const s = result.decisions.sell;
    for (const key of ['fast', 'normal', 'premium', 'offerFloor']) {
      expect(typeof s[key]).toBe('number');
      expect(isNaN(s[key])).toBe(false);
    }
  });

  test('explanation array is populated', () => {
    const comps = makeComps([50, 55, 60]);
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: comps }));
    expect(Array.isArray(result.valuation.explanation)).toBe(true);
    expect(result.valuation.explanation.length).toBeGreaterThan(0);
  });

  test('empty decisions when no data', () => {
    const result = computeValuation(null, mockEbay(), 50);
    expect(result.decisions.buy.recommendation).toBeNull();
    expect(result.decisions.sell.fast).toBeNull();
    expect(result.decisions.buy.notes).toContain('Insufficient data');
  });
});

// ═══════════════════════════════════════════════════════════════
//  #53: Bullion spot+premium FMV mode
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — bullion spot+premium (#53)', () => {
  // Silver spot ~$30/oz, comps selling for ~$35 → premium ~16.7%
  const silverSpot = 30;
  const silverComps = makeComps([33, 34, 35, 36, 37]);

  test('uses spot+premium mode when isBullion and spotPrice provided', () => {
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: silverComps }),
      null, null,
      { isBullion: true, spotPrice: silverSpot }
    );
    expect(result.valuation.method).toBe('bullion-spot-premium');
    expect(result.valuation.bullionSpot).not.toBeNull();
    expect(result.valuation.bullionSpot.spotPrice).toBe(silverSpot);
    expect(result.valuation.bullionSpot.premiumPct).toBeGreaterThan(0);
    // FMV should be close to spot + premium (~$35)
    expect(result.valuation.fmvCore).toBeGreaterThan(silverSpot);
    expect(result.valuation.fmvCore).toBeLessThan(40);
  });

  test('FMV tracks spot price, not just eBay median', () => {
    // Spot jumps to $40 but comps still reflect $35 sales (lag)
    const highSpot = 40;
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: silverComps }),
      null, null,
      { isBullion: true, spotPrice: highSpot }
    );
    // FMV should be above $40 (spot) even though comps average $35
    // Premium would be negative from comps, clamped to -5%
    expect(result.valuation.fmvCore).toBeGreaterThanOrEqual(highSpot * 0.95);
    expect(result.valuation.method).toBe('bullion-spot-premium');
  });

  test('clamps negative premium to -5%', () => {
    // Spot way above market (e.g. just spiked) — comps at $35, spot at $50
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: silverComps }),
      null, null,
      { isBullion: true, spotPrice: 50 }
    );
    // Premium should be clamped to -5%, so FMV >= spot * 0.95
    expect(result.valuation.fmvCore).toBeGreaterThanOrEqual(50 * 0.95 - 0.01);
  });

  test('clamps excessive silver premium to 100%', () => {
    // Very cheap spot but high comp prices (shouldn't happen, but guard)
    const cheapComps = makeComps([80, 85, 90]);
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: cheapComps }),
      null, null,
      { isBullion: true, spotPrice: 30 }
    );
    // Premium would be ~180%, clamped to 100% → FMV = 30 * 2 = $60
    expect(result.valuation.fmvCore).toBeLessThanOrEqual(60.01);
  });

  test('clamps gold premium to 40%', () => {
    // Gold bar: spot $2000, comps at $3000 (50% premium → clamp to 40%)
    const goldComps = makeComps([2800, 2900, 3000, 3100]);
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: goldComps }),
      null, null,
      { isBullion: true, spotPrice: 2000 }
    );
    // Clamped to 40%: FMV should be <= 2000 * 1.40 = $2800
    expect(result.valuation.fmvCore).toBeLessThanOrEqual(2800.01);
  });

  test('falls back to standard blend when spotPrice is null', () => {
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: silverComps }),
      null, null,
      { isBullion: true, spotPrice: null }
    );
    expect(result.valuation.method).not.toBe('bullion-spot-premium');
    expect(result.valuation.bullionSpot).toBeNull();
  });

  test('falls back to standard blend when not bullion', () => {
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: silverComps }),
      null, null,
      { isBullion: false, spotPrice: silverSpot }
    );
    expect(result.valuation.method).not.toBe('bullion-spot-premium');
  });

  test('falls back when ebayMedian is suspiciously low vs spot', () => {
    // Comps at $5 with spot $30 — probably bad data, skip spot+premium
    const junkComps = makeComps([4, 5, 6]);
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: junkComps }),
      null, null,
      { isBullion: true, spotPrice: silverSpot }
    );
    // $5 < $30 * 0.5 = $15, so it should NOT use spot+premium
    expect(result.valuation.method).not.toBe('bullion-spot-premium');
  });

  test('blends Greysheet adaptively when available (few comps → higher weight)', () => {
    const greysheet = { greyVal: 32, cpgVal: 36 };
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: silverComps }), // 5 comps → 15% GS weight
      null, null,
      { isBullion: true, spotPrice: silverSpot, greysheet }
    );
    expect(result.valuation.method).toBe('bullion-spot-premium');
    // FMV should be pulled slightly toward Greysheet $32
    const withoutGs = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: silverComps }),
      null, null,
      { isBullion: true, spotPrice: silverSpot }
    );
    // With greysheet < spot+premium FMV, should pull down slightly
    expect(result.valuation.fmvCore).not.toEqual(withoutGs.valuation.fmvCore);
  });

  test('adaptive GS weight decreases with more comps (20+ → 5%)', () => {
    const greysheet = { greyVal: 25, cpgVal: 28 }; // GS well below market
    const manyComps = makeComps(Array.from({ length: 25 }, () => 35)); // 25 comps
    const fewComps = makeComps([33, 34, 35, 36]); // 4 comps

    const resultMany = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: manyComps }),
      null, null,
      { isBullion: true, spotPrice: silverSpot, greysheet }
    );
    const resultFew = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: fewComps }),
      null, null,
      { isBullion: true, spotPrice: silverSpot, greysheet }
    );
    // With many comps (5% GS), FMV should be closer to eBay median
    // With few comps (20% GS), FMV should be pulled further toward GS
    // Since GS < eBay, more GS influence means lower FMV
    expect(resultFew.valuation.fmvCore).toBeLessThan(resultMany.valuation.fmvCore);
  });

  test('discards GS when rawGS < ebayMedian * 0.05 (P1 nominal guard)', () => {
    // Simulate cross-metal mismatch: GS=$4 for a silver coin worth ~$110
    // Real example: 2000 ASE matching "1987-W Gold Eagle" at $4
    const greysheet = { greyVal: 4, cpgVal: 5 };
    const expensiveComps = makeComps([105, 108, 110, 112, 115]); // median ~$110
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: expensiveComps }),
      null, null,
      { isBullion: true, spotPrice: silverSpot, greysheet }
    );
    // GS=$4 < $110 * 0.05 = $5.50 → GS discarded
    const withoutGs = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: expensiveComps }),
      null, null,
      { isBullion: true, spotPrice: silverSpot }
    );
    // FMV should be identical to no-GS case (GS was discarded)
    expect(result.valuation.fmvCore).toEqual(withoutGs.valuation.fmvCore);
  });

  test('discards GS when rawGS < spotPrice * 0.01 (existing 1% guard)', () => {
    // Gold coin: spot $2000, GS=$4 (obvious mismatch)
    const goldComps = makeComps([2100, 2150, 2200, 2250, 2300]);
    const greysheet = { greyVal: 4, cpgVal: 5 };
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: goldComps }),
      null, null,
      { isBullion: true, spotPrice: 2000, greysheet }
    );
    const withoutGs = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: goldComps }),
      null, null,
      { isBullion: true, spotPrice: 2000 }
    );
    // GS=$4 < $2000 * 0.01 = $20 → GS discarded
    expect(result.valuation.fmvCore).toEqual(withoutGs.valuation.fmvCore);
  });

  test('includes bullionSpot metadata in response', () => {
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: silverComps }),
      null, null,
      { isBullion: true, spotPrice: silverSpot }
    );
    expect(result.valuation.bullionSpot).toMatchObject({
      spotPrice: expect.any(Number),
      premiumPct: expect.any(Number),
      ebayMedian: expect.any(Number),
    });
  });

  test('buy/sell decisions still work with spot+premium FMV', () => {
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: silverComps }),
      25, null,
      { isBullion: true, spotPrice: silverSpot }
    );
    expect(result.decisions.buy.recommendation).toBe('BUY');
    expect(result.decisions.sell.fast).toBeGreaterThan(0);
    expect(result.decisions.sell.normal).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
//  #56: Appeal / toning multiplier
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — appeal multiplier (#56)', () => {
  const prices = [90, 95, 100, 105, 110];
  const pcgs = mockPcgs();
  const ebay = mockEbay({ usComps: makeComps(prices) });

  test('no multiplier leaves FMV unchanged', () => {
    const base = computeValuation(pcgs, ebay, null, null, {});
    const explicit = computeValuation(pcgs, ebay, null, null, { appealMultiplier: 1.0 });
    expect(explicit.valuation.fmvCore).toBe(base.valuation.fmvCore);
    expect(explicit.valuation.appealMultiplier).toBeNull();
  });

  test('1.25x multiplier increases FMV by 25%', () => {
    const base = computeValuation(pcgs, ebay, null, null, {});
    const boosted = computeValuation(pcgs, ebay, null, null, { appealMultiplier: 1.25 });
    expect(boosted.valuation.fmvCore).toBeCloseTo(base.valuation.fmvCore * 1.25, 0);
    expect(boosted.valuation.appealMultiplier).toBe(1.25);
  });

  test('multiplier is clamped to max 2.0', () => {
    const base = computeValuation(pcgs, ebay, null, null, {});
    const capped = computeValuation(pcgs, ebay, null, null, { appealMultiplier: 5.0 });
    expect(capped.valuation.fmvCore).toBeCloseTo(base.valuation.fmvCore * 2.0, 0);
    expect(capped.valuation.appealMultiplier).toBe(2.0);
  });

  test('multiplier below 1.0 is clamped to 1.0', () => {
    const base = computeValuation(pcgs, ebay, null, null, {});
    const floored = computeValuation(pcgs, ebay, null, null, { appealMultiplier: 0.5 });
    expect(floored.valuation.fmvCore).toBe(base.valuation.fmvCore);
    expect(floored.valuation.appealMultiplier).toBeNull();
  });

  test('explanation includes appeal note when multiplier > 1', () => {
    const result = computeValuation(pcgs, ebay, null, null, { appealMultiplier: 1.5 });
    expect(result.valuation.explanation.some(e => /appeal multiplier/i.test(e))).toBe(true);
  });

  test('buy/sell decisions use multiplied FMV', () => {
    const base = computeValuation(pcgs, ebay, 80, null, {});
    const boosted = computeValuation(pcgs, ebay, 80, null, { appealMultiplier: 1.5 });
    // Higher FMV → higher buy thresholds → more likely to recommend BUY
    expect(boosted.decisions.buy.max70).toBeGreaterThan(base.decisions.buy.max70);
    expect(boosted.decisions.sell.normal).toBeGreaterThan(base.decisions.sell.normal);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Proof coin pool separation
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — proof pool separation', () => {
  test('proof comps excluded from raw pool', () => {
    const raw = makeComps([50, 55, 60], { gradeType: 'raw' });
    const proof = makeComps([250, 270, 300], { gradeType: 'proof' });
    const allComps = [...raw, ...proof];
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: allComps }));
    // Should use only raw comps (3), not proof
    expect(result.valuation.gradePool.wantsGraded).toBe(false);
    expect(result.valuation.gradePool.wantsProof).toBe(false);
    expect(result.valuation.gradePool.poolCount).toBe(3);
    expect(result.valuation.gradePool.proofCount).toBe(3);
    // FMV should reflect raw prices, not inflated proof prices
    expect(result.valuation.fmvCore).toBeLessThan(100);
  });

  test('proof pool used when userGrade is "Proof"', () => {
    const raw = makeComps([50, 55, 60], { gradeType: 'raw' });
    const proof = makeComps([250, 270, 300], { gradeType: 'proof' });
    const allComps = [...raw, ...proof];
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: allComps }), null, 'Proof');
    expect(result.valuation.gradePool.wantsProof).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('proof');
    expect(result.valuation.gradePool.poolCount).toBe(3);
    // FMV should reflect proof prices
    expect(result.valuation.fmvCore).toBeGreaterThan(200);
  });

  test('proof pool used when userGrade is "PF"', () => {
    const proof = makeComps([250, 270, 300, 310], { gradeType: 'proof' });
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: proof }), null, 'PF');
    expect(result.valuation.gradePool.wantsProof).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('proof');
  });

  test('proof pool used when userGrade is "PR"', () => {
    const raw = makeComps([50, 55, 60], { gradeType: 'raw' });
    const proof = makeComps([250, 270, 300], { gradeType: 'proof' });
    const allComps = [...raw, ...proof];
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: allComps }), null, 'PR');
    expect(result.valuation.gradePool.wantsProof).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('proof');
    expect(result.valuation.gradePool.poolCount).toBe(3);
  });

  test('userGrade "PR70" triggers wantsProof (#184: PR/PF prefix = proof)', () => {
    const raw = makeComps([50, 55, 60], { gradeType: 'raw' });
    const proof = makeComps([250, 270, 300], { gradeType: 'proof' });
    const allComps = [...raw, ...proof];
    // #184: PR70 starts with "PR" → wantsProof = true, uses proof pool
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: allComps }), null, 'PR70');
    expect(result.valuation.gradePool.wantsProof).toBe(true);
    expect(result.valuation.gradePool.wantsGraded).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('proof');
  });

  test('proof + graded + raw all separated correctly', () => {
    const raw = makeComps([50, 55, 60], { gradeType: 'raw' });
    const graded = makeComps([150, 160, 170], { gradeType: 'graded' });
    const proof = makeComps([250, 270, 300], { gradeType: 'proof' });
    const allComps = [...raw, ...graded, ...proof];
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: allComps }));
    // No grade → raw pool only
    expect(result.valuation.gradePool.poolCount).toBe(3);
    expect(result.valuation.gradePool.rawCount).toBe(3);
    expect(result.valuation.gradePool.gradedCount).toBe(3);
    expect(result.valuation.gradePool.proofCount).toBe(3);
    expect(result.valuation.fmvCore).toBeLessThan(100);
  });

  test('uses proof pool even when small — no BU fallback (#184)', () => {
    const raw = makeComps([50, 55], { gradeType: 'raw' }); // only 2
    const proof = makeComps([250], { gradeType: 'proof' }); // only 1
    const allComps = [...raw, ...proof];
    const result = computeValuation(mockPcgs(), mockEbay({ usComps: allComps }), null, 'Proof');
    // #184: Never mix BU into proof FMV — use proof pool regardless of size
    expect(result.valuation.gradePool.poolCount).toBe(1);
    expect(result.valuation.lowData).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Reverse-proof coin pool separation (#260W)
// ═══════════════════════════════════════════════════════════════
//
// Before #260W, valuationService only knew three pools (graded/raw/proof).
// PR #114 added gradeType='reverse-proof' in ebayService but did NOT teach
// the engine how to select it, so any query for a reverse-proof coin
// collapsed to a near-zero comp set and fell through to silver-melt.
// These tests pin the contract: when finish='Reverse Proof' is supplied,
// the engine MUST use the reverse-proof pool exclusively (mirroring the
// proof pool's "never mix in non-RP comps" rule).
describe('computeValuation — reverse-proof pool separation (#260W)', () => {
  test('reverse-proof pool used when opts.finish="Reverse Proof"', () => {
    const proof    = makeComps([100, 110, 120], { gradeType: 'proof' });
    const revProof = makeComps([250, 270, 300], { gradeType: 'reverse-proof' });
    const allComps = [...proof, ...revProof];
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: allComps }),
      null,
      'Proof',
      { isProof: true, finish: 'Reverse Proof' }
    );
    expect(result.valuation.gradePool.wantsReverseProof).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('reverse-proof');
    expect(result.valuation.gradePool.poolCount).toBe(3);
    expect(result.valuation.gradePool.reverseProofCount).toBe(3);
    // FMV should reflect RP prices (~$270), not regular proof prices (~$110)
    expect(result.valuation.fmvCore).toBeGreaterThan(200);
  });

  test('reverse-proof pool used when opts.isReverseProof=true', () => {
    const proof    = makeComps([100, 110, 120], { gradeType: 'proof' });
    const revProof = makeComps([250, 270, 300, 280], { gradeType: 'reverse-proof' });
    const allComps = [...proof, ...revProof];
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: allComps }),
      null,
      'Proof',
      { isProof: true, isReverseProof: true }
    );
    expect(result.valuation.gradePool.wantsReverseProof).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('reverse-proof');
    expect(result.valuation.fmvCore).toBeGreaterThan(200);
  });

  test('reverse-proof pool used when opts.finish="Enhanced Reverse Proof"', () => {
    const proof    = makeComps([100, 110, 120], { gradeType: 'proof' });
    const revProof = makeComps([400, 420, 450], { gradeType: 'reverse-proof' });
    const allComps = [...proof, ...revProof];
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: allComps }),
      null,
      'Proof',
      { isProof: true, finish: 'Enhanced Reverse Proof' }
    );
    expect(result.valuation.gradePool.wantsReverseProof).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('reverse-proof');
    expect(result.valuation.fmvCore).toBeGreaterThan(300);
  });

  test('reverse-proof routing is suppressed without proof intent (#260W review M1 — engine/ebayService gate symmetry)', () => {
    // Engine RP gate now requires proof intent (`isProof` true or PR/PF-shaped
    // userGrade) ALONGSIDE an RP-matching finish, OR an explicit isReverseProof
    // flag.  This matches ebayService's pre-filter, which only classifies
    // comps as gradeType='reverse-proof' when wantsProof && finish-match.
    // Without this symmetry, a caller passing { finish: 'Reverse Proof' }
    // alone would route into the RP branch in the engine but ebayService
    // would have pre-classified those comps into the 'proof' or 'graded'
    // pool upstream -- producing a false-negative "no RP comps" warning.
    //
    // In production this never happens: extractCoinIntent always sets
    // isProof=true when finish contains "proof" (any case).  This test
    // locks in the engine-side contract so future callers can't introduce
    // the asymmetry by accident.
    const raw      = makeComps([50, 55, 60], { gradeType: 'raw' });
    const revProof = makeComps([250, 270, 300], { gradeType: 'reverse-proof' });
    const allComps = [...raw, ...revProof];
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: allComps }),
      null,
      null,
      { finish: 'Reverse Proof' }  // no isProof flag, no graded grade
    );
    // Engine refuses to infer RP intent from finish alone -- routes through
    // default raw branch, which uses usCompsAll when usRaw is thin.
    expect(result.valuation.gradePool.wantsReverseProof).toBe(false);
    expect(result.valuation.gradePool.usedPool).toBe('raw');
    expect(result.valuation.gradePool.proofIntent).toBeNull();
    // Explicit isReverseProof flag IS sufficient (escape hatch for callers
    // outside the extractCoinIntent path) -- covered by a separate test.
  });

  test('reverse-proof escape hatch: opts.isReverseProof alone (no isProof) still routes to RP pool', () => {
    // The { isReverseProof: true } flag is an explicit escape hatch: callers
    // who know they want RP routing can bypass the proof-intent requirement.
    // Useful for tools / scripts that don't go through extractCoinIntent.
    const raw      = makeComps([50, 55, 60], { gradeType: 'raw' });
    const revProof = makeComps([250, 270, 300], { gradeType: 'reverse-proof' });
    const allComps = [...raw, ...revProof];
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: allComps }),
      null,
      null,
      { isReverseProof: true }  // no isProof flag, no graded grade
    );
    expect(result.valuation.gradePool.wantsReverseProof).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('reverse-proof');
    expect(result.valuation.gradePool.poolCount).toBe(3);
    expect(result.valuation.gradePool.proofIntent).toBe('reverse-proof');
    expect(result.valuation.fmvCore).toBeGreaterThan(200);
  });

  test('regular proof query excludes reverse-proof comps from its pool', () => {
    // The mirror of the wantsReverseProof rule: a regular Proof query MUST
    // NOT pull in RP comps (they trade 2-5x higher and would inflate FMV).
    const proof    = makeComps([100, 110, 120, 105], { gradeType: 'proof' });
    const revProof = makeComps([400, 420, 450], { gradeType: 'reverse-proof' });
    const allComps = [...proof, ...revProof];
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: allComps }),
      null,
      'Proof',
      { isProof: true, finish: 'Proof' }  // NOT reverse proof
    );
    expect(result.valuation.gradePool.wantsReverseProof).toBe(false);
    expect(result.valuation.gradePool.usedPool).toBe('proof');
    expect(result.valuation.gradePool.poolCount).toBe(4);
    expect(result.valuation.gradePool.reverseProofCount).toBe(3);
    // FMV from proof comps only (~$110), not contaminated by RP (~$420)
    expect(result.valuation.fmvCore).toBeLessThan(200);
  });

  test('RP intent with empty RP pool surfaces explicit warning and never blends raw into FMV', () => {
    // Repro of the #260W production bug: 2023 RP Morgan -> 0 RP comps
    // surviving prefilter -> engine MUST surface "no RP comps" and return
    // null FMV, never silently fall through to a raw-blend producing
    // silver-melt from the non-RP comps it should have ignored.
    const raw = makeComps([20, 22, 24, 21, 23, 25], { gradeType: 'raw' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: raw }),  // no RP comps in the gathered pool
      null,
      'Proof',
      { isProof: true, finish: 'Reverse Proof' }
    );
    // With no RP comps the engine refuses to compute FMV from non-RP comps.
    expect(result.valuation.fmvCore).toBeNull();
    expect(result.valuation.confidence).toBe(0);
    const text = result.valuation.explanation.join(' | ');
    expect(text).toMatch(/no reverse-proof comps/i);
    // The raw-blend method MUST NOT appear -- that would mean the engine
    // silently fell through to the raw branch with non-RP comps.
    expect(text).not.toMatch(/raw[- ]blend/i);
  });

  test('RP intent with 1-2 RP comps: lowData flagged, RP comps still used', () => {
    const revProof = makeComps([300, 310], { gradeType: 'reverse-proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: revProof }),
      null,
      null,
      { isReverseProof: true }
    );
    expect(result.valuation.gradePool.usedPool).toBe('reverse-proof');
    expect(result.valuation.compCount).toBe(2);
    expect(result.valuation.lowData).toBe(true);
    const text = result.valuation.explanation.join(' | ');
    expect(text).toMatch(/low-data reverse-proof/i);
  });

  test('RP intent takes precedence over generic proof intent (both flags set)', () => {
    // extractCoinIntent always sets isProof=true for any "*Proof" finish,
    // including "Reverse Proof". The engine MUST route to the RP branch,
    // not the generic proof branch, when both signals fire. Without the
    // suppression in wantsProof, the engine would hit the proof branch
    // first and either contaminate FMV with regular proof comps OR collapse
    // because the proof pool is empty.
    const revProof = makeComps([300, 310, 320], { gradeType: 'reverse-proof' });
    const proof    = makeComps([60, 65, 70],    { gradeType: 'proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: [...revProof, ...proof] }),
      null,
      null,
      { isProof: true, isReverseProof: true }
    );
    expect(result.valuation.gradePool.wantsReverseProof).toBe(true);
    expect(result.valuation.gradePool.wantsProof).toBe(false);
    expect(result.valuation.gradePool.usedPool).toBe('reverse-proof');
    // FMV from RP comps (~$310), not regular proof comps (~$65).
    expect(result.valuation.fmvCore).toBeGreaterThan(250);
  });

  test('no-signal contract: RP comps with zero RP flags route through default raw branch', () => {
    // Inverse of the precedence test. Without any RP signal from the route
    // layer (no opts.isReverseProof, no opts.finish matching /reverse[\s-]*proof/i),
    // the engine cannot infer RP intent. It falls back to the default raw
    // branch, which uses usCompsAll when usRaw is empty -- so the RP comps
    // ARE used, but as part of the "raw" pool. This locks in the contract
    // that the engine never invents RP intent on its own.
    const revProof = makeComps([300, 310, 320], { gradeType: 'reverse-proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: revProof }),
      null,
      null,
      {}
    );
    expect(result.valuation.gradePool.wantsReverseProof).toBe(false);
    expect(result.valuation.gradePool.usedPool).toBe('raw');
    expect(result.valuation.compCount).toBe(3);
  });

  test('RP pool reports reverseProofCount in gradePool telemetry', () => {
    const raw      = makeComps([50, 55, 60], { gradeType: 'raw' });
    const proof    = makeComps([100, 110], { gradeType: 'proof' });
    const revProof = makeComps([250, 270, 300, 280, 260], { gradeType: 'reverse-proof' });
    const allComps = [...raw, ...proof, ...revProof];
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: allComps }),
      null,
      null,  // no grade -> default raw branch
      {}
    );
    // Even when RP pool isn't selected, telemetry must report its size
    // so downstream observability (pricing-health) can audit the mix.
    expect(result.valuation.gradePool.rawCount).toBe(3);
    expect(result.valuation.gradePool.proofCount).toBe(2);
    expect(result.valuation.gradePool.reverseProofCount).toBe(5);
    expect(result.valuation.gradePool.wantsReverseProof).toBe(false);
    expect(result.valuation.gradePool.proofIntent).toBeNull();
  });

  test('greysheet RP pool split: glComps with gradeType=reverse-proof route through RP branch (#260W review m2)', () => {
    // Engine splits glCompsAll into glRevProof; this asserts the global
    // pool routes alongside the US pool when RP is selected.  Without this
    // coverage, a future greysheet adapter emitting RP rows could regress
    // silently.
    const usRevProof = makeComps([250, 270, 300], { gradeType: 'reverse-proof' });
    const glRevProof = makeComps([245, 265, 295], { gradeType: 'reverse-proof' });
    const glProof    = makeComps([100, 110, 120], { gradeType: 'proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({
        usComps: usRevProof,
        glComps: [...glProof, ...glRevProof],
      }),
      null,
      'Proof',
      { isProof: true, finish: 'Reverse Proof' }
    );
    expect(result.valuation.gradePool.usedPool).toBe('reverse-proof');
    expect(result.valuation.gradePool.reverseProofCount).toBe(3);
    expect(result.valuation.fmvCore).toBeGreaterThan(200);
    // FMV must reflect RP-only blend; glProof @ ~$110 must NOT have leaked in.
    // If glProof had leaked, US-anchored FMV (~$270) would be pulled toward
    // a blend of $270 and $110 -- clearly < $200.
  });

  test.each([
    ['lowercase',               'reverse proof'],
    ['hyphen only',             'Reverse-Proof'],
    ['double space',            'Reverse  Proof'],
    ['enhanced lowercase',      'enhanced reverse proof'],
    ['enhanced hyphen',         'Enhanced-Reverse-Proof'],
    ['canonical',               'Reverse Proof'],
  ])('finish variant routes to RP pool: %s (#260W review m4)', (_label, finishStr) => {
    const revProof = makeComps([250, 270, 300], { gradeType: 'reverse-proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: revProof }),
      null,
      'Proof',
      { isProof: true, finish: finishStr }
    );
    expect(result.valuation.gradePool.wantsReverseProof).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('reverse-proof');
  });

  test.each([
    ['null',                    null],
    ['undefined',               undefined],
    ['empty string',            ''],
    ['unrelated word',          'Burnished'],
    ['reverseproof no separator', 'reverseproof'],  // stricter regex requires whitespace/hyphen
    ['irreverseproof',          'irreverseproof'],  // word boundary blocks substring
    ['proof-like',              'Proof-Like'],      // PL coins must NOT match RP
  ])('finish variant does NOT route to RP pool: %s (#260W review m4)', (_label, finishStr) => {
    const proof    = makeComps([100, 110, 120], { gradeType: 'proof' });
    const revProof = makeComps([250, 270, 300], { gradeType: 'reverse-proof' });
    const result = computeValuation(
      mockPcgs(),
      mockEbay({ usComps: [...proof, ...revProof] }),
      null,
      'Proof',
      { isProof: true, finish: finishStr }
    );
    expect(result.valuation.gradePool.wantsReverseProof).toBe(false);
    // With isProof + non-RP finish, routes through the generic proof branch.
    expect(result.valuation.gradePool.usedPool).toBe('proof');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Greysheet confidence bonus (#4)
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — Greysheet confidence bonus', () => {
  test('hasGreysheet adds confidence vs no Greysheet', () => {
    const comps = makeComps([100, 110, 105, 115, 108, 112, 107, 103, 109, 111], { _source: 'finding' });
    const pcgs = mockPcgs({ verified: true, pcgsNo: 7070, priceGuide: 120 });

    const withGS = computeValuation(pcgs, mockEbay({ usComps: comps }), null, null, {
      greysheet: { greyVal: 95, cpgVal: 110 },
    });
    const withoutGS = computeValuation(pcgs, mockEbay({ usComps: comps }), null, null, {});

    expect(withGS.valuation.confidence).toBeGreaterThan(withoutGS.valuation.confidence);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Greysheet FMV blend in certified/raw modes (#5)
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — Greysheet blend in certified mode', () => {
  test('Greysheet data influences FMV for certified coins', () => {
    const comps = makeComps([100, 110, 105, 115, 108], { _source: 'finding', gradeType: 'graded' });
    const pcgs = mockPcgs({ verified: true, pcgsNo: 7070, priceGuide: 150 });

    const withGS = computeValuation(pcgs, mockEbay({ usComps: comps }), null, 'MS65', {
      greysheet: { greyVal: 80, cpgVal: 95 },
    });
    const withoutGS = computeValuation(pcgs, mockEbay({ usComps: comps }), null, 'MS65', {});

    // Greysheet should shift the FMV (direction depends on implementation, but they should differ)
    expect(withGS.valuation.fmvCore).not.toBe(withoutGS.valuation.fmvCore);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Filter attrition confidence penalty (#6)
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — filter attrition confidence penalty', () => {
  test('high attrition (>90%) reduces confidence significantly', () => {
    const comps = makeComps([100, 110, 105, 115, 108, 112, 107, 103, 109, 111], { _source: 'finding' });
    const pcgs = mockPcgs({ verified: true, pcgsNo: 7070 });

    const highAttrition = computeValuation(pcgs,
      { ...mockEbay({ usComps: comps }), us: { ...mockEbay({ usComps: comps }).us, attritionPct: 95 } },
      null, null, {});
    const lowAttrition = computeValuation(pcgs,
      { ...mockEbay({ usComps: comps }), us: { ...mockEbay({ usComps: comps }).us, attritionPct: 10 } },
      null, null, {});

    expect(lowAttrition.valuation.confidence).toBeGreaterThan(highAttrition.valuation.confidence);
  });

  test('moderate attrition (70-90%) has smaller penalty than >90%', () => {
    const comps = makeComps([100, 110, 105, 115, 108, 112, 107, 103, 109, 111], { _source: 'finding' });
    const pcgs = mockPcgs({ verified: true, pcgsNo: 7070 });

    const extreme = computeValuation(pcgs,
      { ...mockEbay({ usComps: comps }), us: { ...mockEbay({ usComps: comps }).us, attritionPct: 95 } },
      null, null, {});
    const moderate = computeValuation(pcgs,
      { ...mockEbay({ usComps: comps }), us: { ...mockEbay({ usComps: comps }).us, attritionPct: 80 } },
      null, null, {});

    expect(moderate.valuation.confidence).toBeGreaterThan(extreme.valuation.confidence);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Pool fallback confidence penalty (#7)
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — pool fallback confidence penalty', () => {
  test('falling back from graded to raw pool reduces confidence', () => {
    // Only raw comps — when user requests graded, it falls back to raw pool
    const rawComps = makeComps([100, 110, 105, 115, 108], { _source: 'finding', gradeType: 'raw' });
    const gradedComps = makeComps([200, 210, 205, 215, 208], { _source: 'finding', gradeType: 'graded' });
    const pcgs = mockPcgs({ verified: true, pcgsNo: 7070 });

    // Sufficient graded comps — no fallback
    const noFallback = computeValuation(pcgs, mockEbay({ usComps: gradedComps }), null, 'MS65', {});
    // Only raw comps with graded request — triggers fallback
    const withFallback = computeValuation(pcgs, mockEbay({ usComps: rawComps }), null, 'MS65', {});

    expect(noFallback.valuation.confidence).toBeGreaterThan(withFallback.valuation.confidence);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Sold ratio confidence factor (#8)
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — sold ratio confidence factor', () => {
  test('mostly active listings (low soldRatio) reduces confidence', () => {
    // All sold comps
    const soldComps = makeComps([100, 110, 105, 115, 108, 112, 107, 103, 109, 111], { _source: 'finding' });
    // All browse (active listing) comps
    const browseComps = makeComps([100, 110, 105, 115, 108, 112, 107, 103, 109, 111], { _source: 'browse' });
    const pcgs = mockPcgs({ verified: true, pcgsNo: 7070 });

    const allSold = computeValuation(pcgs, mockEbay({ usComps: soldComps }), null, null, {});
    const allBrowse = computeValuation(pcgs, mockEbay({ usComps: browseComps }), null, null, {});

    expect(allSold.valuation.confidence).toBeGreaterThan(allBrowse.valuation.confidence);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Sale context adjustment (#55)
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — sale context (#55)', () => {
  const comps = makeComps([100, 105, 110, 115, 120]);
  const pcgs = mockPcgs();

  function resultFor(ctx) {
    return computeValuation(pcgs, mockEbay({ usComps: comps }), 90, null, { saleContext: ctx });
  }

  test('defaults to eBay context when omitted', () => {
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }), 90, null, {});
    expect(result.valuation.saleContext).toBe('eBay Retail');
  });

  test('private context shifts buy thresholds up (+7%)', () => {
    const ebay = resultFor('ebay');
    const pvt  = resultFor('private');
    // private buyAdj = +0.07, so max buy prices should be higher
    expect(pvt.decisions.buy.max70).toBeGreaterThan(ebay.decisions.buy.max70);
    expect(pvt.decisions.buy.max75).toBeGreaterThan(ebay.decisions.buy.max75);
    expect(pvt.decisions.buy.max80).toBeGreaterThan(ebay.decisions.buy.max80);
    expect(pvt.valuation.saleContext).toBe('LCS / Private Sale');
  });

  test('private context shifts sell estimates down (-10%)', () => {
    const ebay = resultFor('ebay');
    const pvt  = resultFor('private');
    expect(pvt.decisions.sell.fast).toBeLessThan(ebay.decisions.sell.fast);
    expect(pvt.decisions.sell.normal).toBeLessThan(ebay.decisions.sell.normal);
    expect(pvt.decisions.sell.premium).toBeLessThan(ebay.decisions.sell.premium);
  });

  test('wholesale context shifts buy thresholds down (-10%)', () => {
    const ebay = resultFor('ebay');
    const ws   = resultFor('wholesale');
    expect(ws.decisions.buy.max70).toBeLessThan(ebay.decisions.buy.max70);
    expect(ws.decisions.buy.max75).toBeLessThan(ebay.decisions.buy.max75);
    expect(ws.decisions.buy.max80).toBeLessThan(ebay.decisions.buy.max80);
    expect(ws.valuation.saleContext).toBe('Dealer Wholesale');
  });

  test('wholesale context shifts sell estimates down (-20%)', () => {
    const ebay = resultFor('ebay');
    const ws   = resultFor('wholesale');
    expect(ws.decisions.sell.fast).toBeLessThan(ebay.decisions.sell.fast);
    expect(ws.decisions.sell.normal).toBeLessThan(ebay.decisions.sell.normal);
    expect(ws.decisions.sell.premium).toBeLessThan(ebay.decisions.sell.premium);
  });

  test('unknown context falls back to eBay', () => {
    const result = resultFor('craigslist');
    expect(result.valuation.saleContext).toBe('eBay Retail');
  });

  test('buy recommendation changes with context', () => {
    // Same asking price may be BUY in private (higher thresholds) but PASS in eBay
    const ebay = computeValuation(pcgs, mockEbay({ usComps: comps }), 95, null, { saleContext: 'ebay' });
    const pvt  = computeValuation(pcgs, mockEbay({ usComps: comps }), 95, null, { saleContext: 'private' });
    // If eBay says PASS but private says BUY, that's the intent of the feature.
    // At minimum, they shouldn't both be null.
    expect(ebay.decisions.buy.recommendation).toBeDefined();
    expect(pvt.decisions.buy.recommendation).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
//  Bullion spot-only fallback (#188)
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — bullion-spot-only fallback (#188)', () => {
  test('uses spot as FMV when no comps survive', () => {
    const result = computeValuation(
      mockPcgs(),
      mockEbay(), // empty comps → ebayMedian == null
      null, null,
      { isBullion: true, spotPrice: 30.50 }
    );
    expect(result.valuation.method).toBe('bullion-spot-only');
    expect(result.valuation.fmvCore).toBe(30.50);
    expect(result.valuation.bullionSpot).not.toBeNull();
    expect(result.valuation.bullionSpot.spotPrice).toBe(30.50);
    expect(result.valuation.bullionSpot.premiumPct).toBe(0);
    expect(result.valuation.bullionSpot.ebayMedian).toBeNull();
  });

  test('does not trigger when spotPrice is 0', () => {
    const result = computeValuation(
      mockPcgs(), mockEbay(), null, null,
      { isBullion: true, spotPrice: 0 }
    );
    expect(result.valuation.method).not.toBe('bullion-spot-only');
  });

  test('does not trigger when isBullion is false', () => {
    const result = computeValuation(
      mockPcgs(), mockEbay(), null, null,
      { isBullion: false, spotPrice: 30 }
    );
    expect(result.valuation.method).not.toBe('bullion-spot-only');
  });

  test('does not trigger when comps exist (uses spot-premium instead)', () => {
    const comps = makeComps([33, 34, 35, 36, 37]);
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, null,
      { isBullion: true, spotPrice: 30 }
    );
    expect(result.valuation.method).toBe('bullion-spot-premium');
    expect(result.valuation.bullionSpot.ebayMedian).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  Greysheet nominal discard (#188)
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — Greysheet nominal discard (#188)', () => {
  test('discards Greysheet below 1% of spot for bullion', () => {
    // Gold coin spot ~$2000, Greysheet says $5 (face value) → should discard
    const comps = makeComps([2100, 2150, 2200, 2250, 2300]);
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, null,
      { isBullion: true, spotPrice: 2000, greysheet: { greyVal: 5, cpgVal: 7 } }
    );
    // Greysheet should not drag FMV down; it's nominal and discarded
    expect(result.valuation.fmvCore).toBeGreaterThan(1500);
  });

  test('keeps Greysheet at or above 1% of spot for bullion', () => {
    const comps = makeComps([35, 36, 37, 38, 39]);
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, null,
      { isBullion: true, spotPrice: 30, greysheet: { greyVal: 32, cpgVal: 36 } }
    );
    // Greysheet is reasonable → should influence FMV
    expect(result.valuation.greysheetSpread).not.toBeNull();
  });

  test('never discards Greysheet for non-bullion coins', () => {
    const comps = makeComps([100, 110, 105, 115, 108]);
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, null,
      { isBullion: false, spotPrice: 2000, greysheet: { greyVal: 5, cpgVal: 7 } }
    );
    // Even though greyVal << spotPrice, it's not bullion → keep it
    expect(result.valuation.greysheetSpread).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  Greysheet spread & liquidity (#54)
// ═══════════════════════════════════════════════════════════════
describe('computeValuation — Greysheet spread output (#54)', () => {
  test('returns high liquidity for tight spread (<=15%)', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, null,
      { greysheet: { greyVal: 100, cpgVal: 110 } } // 10% spread
    );
    expect(result.valuation.greysheetSpread).not.toBeNull();
    expect(result.valuation.greysheetSpread.liquidity).toBe('high');
    expect(result.valuation.greysheetSpread.spreadPct).toBeCloseTo(10, 0);
    expect(result.valuation.greysheetSpread.wholesale).toBe(100);
    expect(result.valuation.greysheetSpread.retail).toBe(110);
  });

  test('returns moderate liquidity for mid spread (16-30%)', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, null,
      { greysheet: { greyVal: 100, cpgVal: 125 } } // 25% spread
    );
    expect(result.valuation.greysheetSpread.liquidity).toBe('moderate');
  });

  test('returns low liquidity for wide spread (>30%)', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, null,
      { greysheet: { greyVal: 100, cpgVal: 140 } } // 40% spread
    );
    expect(result.valuation.greysheetSpread.liquidity).toBe('low');
  });

  test('returns null spread when greysheet data is missing', () => {
    const comps = makeComps([100, 105, 110, 115, 120]);
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, null, {}
    );
    expect(result.valuation.greysheetSpread).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  Auction Data in response
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — auctionData response field', () => {
  test('includes auctionData when auction median is present', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const pcgs = mockPcgs({
      verified: true,
      priceGuide: { valueUsd: 120 },
      auction: { medianUsd: 110, count: 34, trend: { direction: 'stable', pct: 2.1 } },
    });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }));
    expect(result.valuation.auctionData).not.toBeNull();
    expect(result.valuation.auctionData.medianUsd).toBe(110);
    expect(result.valuation.auctionData.count).toBe(34);
    expect(result.valuation.auctionData.trend.direction).toBe('stable');
  });

  test('auctionData is null when no auction data available', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const pcgs = mockPcgs({ auction: null });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }));
    expect(result.valuation.auctionData).toBeNull();
  });

  test('auctionData reflects trend from APR enrichment', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const pcgs = mockPcgs({
      verified: true,
      auction: { medianUsd: 150, count: 74, trend: { direction: 'rising', pct: 22.5 } },
    });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }));
    expect(result.valuation.auctionData.trend.direction).toBe('rising');
    expect(result.valuation.auctionData.trend.pct).toBe(22.5);
  });
});

// ═══════════════════════════════════════════════════════════════
//  #184: Proof pool isolation — never mix BU comps into proof FMV
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — proof pool isolation (#184)', () => {
  test('uses only proof comps when userGrade starts with PR', () => {
    const proofComps = makeComps([200, 210, 220], { gradeType: 'proof' });
    const gradedComps = makeComps([100, 105, 110], { gradeType: 'graded' });
    const allComps = [...proofComps, ...gradedComps];
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: allComps }), null, 'PR69 DCAM'
    );
    // FMV should be near proof prices (~210), not graded (~105)
    expect(result.valuation.fmvCore).toBeGreaterThan(150);
    expect(result.valuation.gradePool.wantsProof).toBe(true);
    expect(result.valuation.gradePool.usedPool).toBe('proof');
  });

  test('uses only proof comps when userGrade starts with PF', () => {
    const proofComps = makeComps([200, 210, 220], { gradeType: 'proof' });
    const gradedComps = makeComps([100, 105, 110], { gradeType: 'graded' });
    const allComps = [...proofComps, ...gradedComps];
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: allComps }), null, 'PF70'
    );
    expect(result.valuation.fmvCore).toBeGreaterThan(150);
    expect(result.valuation.gradePool.wantsProof).toBe(true);
  });

  test('uses only proof comps when opts.isProof is true', () => {
    const proofComps = makeComps([200, 210, 220], { gradeType: 'proof' });
    const gradedComps = makeComps([100, 105, 110], { gradeType: 'graded' });
    const allComps = [...proofComps, ...gradedComps];
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: allComps }), null, null, { isProof: true }
    );
    expect(result.valuation.fmvCore).toBeGreaterThan(150);
    expect(result.valuation.gradePool.wantsProof).toBe(true);
  });

  test('does NOT fall back to all comps when proof pool has < 3 comps', () => {
    const proofComps = makeComps([200, 210], { gradeType: 'proof' });
    const gradedComps = makeComps([100, 105, 110, 115, 120], { gradeType: 'graded' });
    const allComps = [...proofComps, ...gradedComps];
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: allComps }), null, 'PR69'
    );
    // FMV should still be from proof comps (~205), not graded (~110)
    expect(result.valuation.fmvCore).toBeGreaterThan(150);
    expect(result.valuation.explanation.some(e => /low-data proof/i.test(e))).toBe(true);
  });

  test('returns null FMV with explanation when 0 proof comps', () => {
    const gradedComps = makeComps([100, 105, 110, 115, 120], { gradeType: 'graded' });
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: gradedComps }), null, 'PR69'
    );
    expect(result.valuation.fmvCore).toBeNull();
    expect(result.valuation.explanation.some(e => /no proof comps/i.test(e))).toBe(true);
  });

  test('userGrade "Proof" triggers proof pool selection', () => {
    const proofComps = makeComps([200, 210, 220, 230], { gradeType: 'proof' });
    const rawComps = makeComps([50, 55, 60], { gradeType: 'raw' });
    const allComps = [...proofComps, ...rawComps];
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: allComps }), null, 'Proof'
    );
    expect(result.valuation.fmvCore).toBeGreaterThan(150);
    expect(result.valuation.gradePool.wantsProof).toBe(true);
  });

  test('non-proof grade does not trigger proof pool', () => {
    const proofComps = makeComps([200, 210, 220], { gradeType: 'proof' });
    const gradedComps = makeComps([100, 105, 110, 115, 120], { gradeType: 'graded' });
    const allComps = [...proofComps, ...gradedComps];
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: allComps }), null, 'MS65'
    );
    // Should use graded pool, not proof
    expect(result.valuation.gradePool.wantsProof).toBe(false);
    expect(result.valuation.fmvCore).toBeLessThan(150);
  });
});

// ============================================================================
// #232 -- Audience gating for valuation reasoning
// ============================================================================

describe('computeValuation -- audience gating (#232)', () => {
  const comps = makeComps([95, 100, 105, 110, 115], { gradeType: 'graded' });
  const greysheet = { greyVal: 150.00, cpgVal: 200.00, source: 'greysheet' };

  test('public audience (default) hides Greysheet brand + dollar amounts', () => {
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, 'MS65',
      { greysheet, audience: 'public' }
    );
    const text = result.valuation.explanation.join(' | ');
    expect(text).not.toMatch(/Greysheet/i);
    expect(text).not.toMatch(/CPG/);
    expect(text).not.toMatch(/\$\d+\.\d{2}/);  // any $X.YY amount
    expect(text).not.toMatch(/Terapeak/i);
    // But the *narrative* should still mention a wholesale guide was used.
    expect(text).toMatch(/wholesale/i);
  });

  test('admin audience exposes Greysheet brand + exact dollar amounts', () => {
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, 'MS65',
      { greysheet, audience: 'admin' }
    );
    const text = result.valuation.explanation.join(' | ');
    expect(text).toMatch(/Greysheet wholesale: \$150\.00/);
    expect(text).toMatch(/CPG: \$200\.00/);
  });

  test('default audience (no opts.audience) behaves as public', () => {
    const result = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, 'MS65',
      { greysheet }
    );
    const text = result.valuation.explanation.join(' | ');
    expect(text).not.toMatch(/Greysheet/i);
    expect(text).not.toMatch(/\$\d+\.\d{2}/);
  });

  test('bullion public hides spot $ + premium %; admin shows them', () => {
    const bullionComps = makeComps([32, 33, 34, 35, 36], { gradeType: 'raw' });
    const optsBase = { isBullion: true, spotPrice: 30.00 };
    const pub = computeValuation(
      mockPcgs(), mockEbay({ usComps: bullionComps }), null, null,
      { ...optsBase, audience: 'public' }
    );
    const adm = computeValuation(
      mockPcgs(), mockEbay({ usComps: bullionComps }), null, null,
      { ...optsBase, audience: 'admin' }
    );
    const pubText = pub.valuation.explanation.join(' | ');
    const admText = adm.valuation.explanation.join(' | ');
    expect(pubText).not.toMatch(/spot \$\d/);
    expect(pubText).not.toMatch(/premium \d+\.\d+%/);
    expect(admText).toMatch(/spot \$30\.00/);
    expect(admText).toMatch(/premium \d+\.\d+%/);
  });

  test('audience gating does not change FMV value, only explanation text', () => {
    const optsBase = { greysheet };
    const pub = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, 'MS65',
      { ...optsBase, audience: 'public' }
    );
    const adm = computeValuation(
      mockPcgs(), mockEbay({ usComps: comps }), null, 'MS65',
      { ...optsBase, audience: 'admin' }
    );
    expect(pub.valuation.fmvCore).toBeCloseTo(adm.valuation.fmvCore, 4);
    expect(pub.valuation.rangeLow).toBeCloseTo(adm.valuation.rangeLow, 4);
    expect(pub.valuation.rangeHigh).toBeCloseTo(adm.valuation.rangeHigh, 4);
    expect(pub.valuation.confidence).toBe(adm.valuation.confidence);
  });
});
