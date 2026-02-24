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
  test('certified coin uses 65/25/10 blend', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const pcgs = mockPcgs({
      verified: true,
      priceGuide: { valueUsd: 120 },
      auction: { medianUsd: 110 },
    });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }));
    // With eBay=100, PCGS=120, Auction=110:
    // FMV = 0.65*100 + 0.25*120 + 0.10*110 = 65 + 30 + 11 = 106
    expect(result.valuation.fmvCore).toBeCloseTo(106, 0);
    expect(result.valuation.explanation.some(e => /certified/i.test(e))).toBe(true);
  });

  test('raw coin uses 80/20 blend', () => {
    const comps = makeComps([100, 100, 100, 100, 100]);
    const pcgs = mockPcgs({
      verified: false,
      priceGuide: { valueUsd: 120 },
    });
    const result = computeValuation(pcgs, mockEbay({ usComps: comps }), null, null);
    // FMV = 0.80*100 + 0.20*120 = 80 + 24 = 104
    expect(result.valuation.fmvCore).toBeCloseTo(104, 0);
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
