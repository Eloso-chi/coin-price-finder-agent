/**
 * metalMismatchFilter.test.js — Metal-mismatch scoring & filtering
 *
 * Covers gaps not addressed by applyFilters.test.js:
 *   1. scoreMatch -30 penalty for metal mismatch (and +10 for match)
 *   2. applyFilters secondary regex check (#178) — catches "gold plated silver"
 *      and "silver with gold" titles that bypass basic _detectedMetal
 *   3. Confidence scaling at intermediate soldRatio thresholds (0.3, 0.6)
 *   4. Range expansion under high comp price dispersion
 *
 * Uses shared helpers from coinTestConstants.js.
 */

'use strict';

const { applyFilters, scoreMatch, detectMetalFromTitle } = require('../src/services/ebayService');
const { computeValuation } = require('../src/services/valuationService');
const { makeComp, makeComps, seedRandom, pickRandom } = require('./helpers/coinTestConstants');

// ═══════════════════════════════════════════════════════════════
//  1. scoreMatch — metal match/mismatch scoring
// ═══════════════════════════════════════════════════════════════

describe('scoreMatch — metal scoring', () => {
  const silverExpected = { metal: 'silver', series: 'Silver Eagle', year: 2024 };
  const goldExpected = { metal: 'gold', series: 'Gold Eagle', year: 2024 };

  test('+10 when comp metal matches expected', () => {
    const comp = { title: '2024 American Silver Eagle 1 oz', totalUsd: 35, _detectedMetal: 'silver' };
    const scored = scoreMatch(comp, silverExpected);
    expect(scored.matchNotes).toContain('metal-match');
    expect(scored.matchScore).toBeGreaterThanOrEqual(60);
  });

  test('-30 when comp metal contradicts expected', () => {
    const comp = { title: '2024 Gold Eagle 1 oz', totalUsd: 2100, _detectedMetal: 'gold' };
    const scored = scoreMatch(comp, silverExpected);
    expect(scored.matchNotes).toContain('metal-mismatch');
  });

  test('no penalty when comp has no detected metal', () => {
    const comp = { title: '2024 American Eagle 1 oz', totalUsd: 35, _detectedMetal: null };
    const scored = scoreMatch(comp, silverExpected);
    expect(scored.matchNotes).not.toContain('metal-mismatch');
    expect(scored.matchNotes).not.toContain('metal-match');
  });

  test('no penalty when expected has no metal', () => {
    const comp = { title: '2024 Kennedy Half Dollar', totalUsd: 12, _detectedMetal: 'silver' };
    const scored = scoreMatch(comp, { series: 'Kennedy', year: 2024 });
    expect(scored.matchNotes).not.toContain('metal-mismatch');
    expect(scored.matchNotes).not.toContain('metal-match');
  });

  test('gold comp scores lower than silver comp for silver search', () => {
    const silverComp = { title: '2024 Silver Eagle BU', totalUsd: 35, _detectedMetal: 'silver' };
    const goldComp = { title: '2024 Gold Eagle BU', totalUsd: 2100, _detectedMetal: 'gold' };
    const silverScore = scoreMatch(silverComp, silverExpected);
    const goldScore = scoreMatch(goldComp, silverExpected);
    expect(silverScore.matchScore).toBeGreaterThan(goldScore.matchScore);
  });
});

// ═══════════════════════════════════════════════════════════════
//  2. applyFilters — #178 secondary regex disambiguation
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — #178 metal mismatch secondary regex', () => {

  test('rejects ".999 silver" comp when searching for gold', () => {
    const comps = [
      makeComp({ title: '2024 American .999 Silver Eagle 1 oz BU', totalUsd: 35, matchScore: 70 }),
      makeComp({ title: '2024 American Gold Eagle 1 oz BU', totalUsd: 2100, matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { metal: 'gold' });
    expect(removed.metalMismatch).toBeGreaterThanOrEqual(1);
    const titles = kept.map(c => c.title.toLowerCase());
    expect(titles.some(t => t.includes('.999 silver'))).toBe(false);
  });

  test('rejects "silver coin" comp when searching for gold', () => {
    const comps = [
      makeComp({ title: '2024 Chinese Silver Coin Panda 30g', totalUsd: 40, matchScore: 70 }),
      makeComp({ title: '2024 Chinese Gold Panda 1 oz', totalUsd: 2200, matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { metal: 'gold' });
    expect(removed.metalMismatch).toBeGreaterThanOrEqual(1);
    expect(kept.every(c => !/\bsilver coin\b/i.test(c.title))).toBe(true);
  });

  test('rejects ".999 gold" comp when searching for silver', () => {
    const comps = [
      makeComp({ title: '2024 Perth Mint .999 Gold Bar 1 oz', totalUsd: 2200, matchScore: 70 }),
      makeComp({ title: '2024 Silver Britannia 1 oz', totalUsd: 35, matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { metal: 'silver' });
    expect(removed.metalMismatch).toBeGreaterThanOrEqual(1);
    expect(kept.every(c => !/\.999\s*gold/i.test(c.title))).toBe(true);
  });

  test('keeps comp with no metal indicators (benefit of doubt)', () => {
    const comps = [
      makeComp({ title: '2024 American Eagle 1 oz BU', totalUsd: 35, matchScore: 70, _detectedMetal: null }),
      makeComp({ title: '2024 Silver Eagle 1 oz', totalUsd: 35, matchScore: 70, _detectedMetal: 'silver' }),
    ];
    const { kept } = applyFilters(comps, {}, { metal: 'silver' });
    // Both should survive — one matches, one has no metal detected
    expect(kept.length).toBe(2);
  });

  test('re-detects metal from title when _detectedMetal is stale', () => {
    // Comp has _detectedMetal: 'silver' (stale) but title says gold
    const comps = [
      makeComp({ title: '2024 Gold Eagle 1 oz BU', totalUsd: 2100, matchScore: 70, _detectedMetal: 'silver' }),
      makeComp({ title: '2024 Silver Eagle 1 oz', totalUsd: 35, matchScore: 70, _detectedMetal: 'silver' }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { metal: 'silver' });
    // The gold eagle should be rejected even though _detectedMetal says silver
    expect(removed.metalMismatch).toBeGreaterThanOrEqual(1);
    expect(kept.length).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  3. Confidence scaling — intermediate soldRatio thresholds
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — soldRatio confidence thresholds', () => {

  function mockEbay(usComps) {
    return {
      us: { comps: usComps, stats: { count: usComps.length } },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    };
  }

  function mockPcgs(overrides = {}) {
    return { verified: true, pcgsNo: 7070, priceGuide: { valueUsd: 100 }, ...overrides };
  }

  function buildComps(soldCount, browseCount, price) {
    // #272W: graded query (userGrade='MS-64' below) requires graded comps;
    // otherwise the strict graded pool yields 0 comps and the soldRatio
    // threshold logic these tests pin can't be exercised.
    const sold = Array.from({ length: soldCount }, () =>
      makeComp({ totalUsd: price, matchScore: 70, _source: 'finding', gradeType: 'graded' })
    );
    const browse = Array.from({ length: browseCount }, () =>
      makeComp({ totalUsd: price, matchScore: 70, _source: 'browse', gradeType: 'graded' })
    );
    return [...sold, ...browse];
  }

  test('100% sold comps has highest confidence', () => {
    const comps = buildComps(10, 0, 100);
    const result = computeValuation(mockPcgs(), mockEbay(comps), null, 'MS-64');
    expect(result.valuation.dataSource.soldRatio).toBe(1);
    expect(result.valuation.confidence).toBeGreaterThan(50);
  });

  test('soldRatio < 0.3 gets -20 penalty vs 100% sold', () => {
    // 2 sold + 8 browse = 20% soldRatio
    const mixedComps = buildComps(2, 8, 100);
    const soldComps = buildComps(10, 0, 100);

    const mixed = computeValuation(mockPcgs(), mockEbay(mixedComps), null, 'MS-64');
    const allSold = computeValuation(mockPcgs(), mockEbay(soldComps), null, 'MS-64');

    expect(mixed.valuation.dataSource.soldRatio).toBeLessThan(0.3);
    expect(allSold.valuation.confidence - mixed.valuation.confidence).toBeGreaterThanOrEqual(15);
  });

  test('soldRatio 0.3-0.6 gets -10 penalty vs 100% sold', () => {
    // 4 sold + 6 browse = 40% soldRatio
    const midComps = buildComps(4, 6, 100);
    const soldComps = buildComps(10, 0, 100);

    const mid = computeValuation(mockPcgs(), mockEbay(midComps), null, 'MS-64');
    const allSold = computeValuation(mockPcgs(), mockEbay(soldComps), null, 'MS-64');

    expect(mid.valuation.dataSource.soldRatio).toBeGreaterThanOrEqual(0.3);
    expect(mid.valuation.dataSource.soldRatio).toBeLessThan(0.6);
    expect(allSold.valuation.confidence - mid.valuation.confidence).toBeGreaterThanOrEqual(5);
  });

  test('soldRatio >= 0.6 gets no browse penalty', () => {
    // 7 sold + 3 browse = 70% soldRatio
    const highComps = buildComps(7, 3, 100);
    const fullComps = buildComps(10, 0, 100);

    const high = computeValuation(mockPcgs(), mockEbay(highComps), null, 'MS-64');
    const full = computeValuation(mockPcgs(), mockEbay(fullComps), null, 'MS-64');

    expect(high.valuation.dataSource.soldRatio).toBeGreaterThanOrEqual(0.6);
    // No browse-based penalty at soldRatio >= 0.6 (other factors may still differ slightly)
    expect(full.valuation.confidence - high.valuation.confidence).toBeLessThanOrEqual(5);
  });
});

// ═══════════════════════════════════════════════════════════════
//  4. Range expansion under high dispersion
// ═══════════════════════════════════════════════════════════════

describe('computeValuation — range sanity under dispersion', () => {

  function mockEbay(usComps) {
    return {
      us: { comps: usComps, stats: { count: usComps.length } },
      global: { comps: [], stats: { count: 0 } },
      usedFallback: false,
    };
  }

  test('tight comps produce narrow range', () => {
    const comps = makeComps([100, 101, 102, 103, 104, 100, 101, 102]);
    const result = computeValuation(null, mockEbay(comps));
    const { rangeLow, rangeHigh, fmvCore } = result.valuation;
    const spread = rangeHigh - rangeLow;
    // Tight dispersion → small range (but at least 5% of FMV)
    expect(spread).toBeGreaterThanOrEqual(fmvCore * 0.08);
    expect(spread).toBeLessThan(fmvCore * 0.40);
  });

  test('dispersed comps produce wider range', () => {
    const tightComps = [100, 100, 100, 100, 100, 100, 100, 100].map(p => makeComp({ totalUsd: p, matchScore: 70 }));
    const wideComps = [20, 60, 100, 140, 180, 30, 150, 120].map(p => makeComp({ totalUsd: p, matchScore: 70 }));

    const tight = computeValuation(null, mockEbay(tightComps));
    const wide = computeValuation(null, mockEbay(wideComps));

    const tightSpread = tight.valuation.rangeHigh - tight.valuation.rangeLow;
    const wideSpread = wide.valuation.rangeHigh - wide.valuation.rangeLow;

    expect(wideSpread).toBeGreaterThan(tightSpread);
  });

  test('range always encompasses FMV', () => {
    const rng = seedRandom('rangeSanity');
    // Generate 5 random comp sets
    for (let i = 0; i < 5; i++) {
      const base = 50 + Math.floor(rng() * 200);
      const prices = Array.from({ length: 8 }, () => base + Math.floor(rng() * 60) - 30);
      const comps = makeComps(prices.map(p => ({ totalUsd: p, matchScore: 70 })));
      const result = computeValuation(null, mockEbay(comps));
      if (result.valuation.fmvCore) {
        expect(result.valuation.rangeLow).toBeLessThanOrEqual(result.valuation.fmvCore);
        expect(result.valuation.rangeHigh).toBeGreaterThanOrEqual(result.valuation.fmvCore);
      }
    }
  });

  test('rangeLow is never negative even with extreme dispersion', () => {
    const comps = makeComps([1, 2, 50, 100, 200, 1, 3, 5]);
    const result = computeValuation(null, mockEbay(comps));
    expect(result.valuation.rangeLow).toBeGreaterThanOrEqual(0);
  });
});
