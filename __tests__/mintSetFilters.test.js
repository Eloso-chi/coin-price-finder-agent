/**
 * mintSetFilters.test.js — Tests for mint/proof set relevance scoring
 * and filtering in scoreMatch() and applyFilters().
 *
 * Covers:
 *  1. scoreMatch set-specific scoring (set-match, set-missing, wrong-set-type,
 *     individual-coin-in-set-search, mint city name detection)
 *  2. applyFilters set-type hard filter (require "set" in title)
 *  3. applyFilters raised relevance gate for set searches (30 vs 20)
 *  4. Mint mark detection via city names for set listings
 */

'use strict';

const { applyFilters, scoreMatch } = require('../src/services/ebayService');

// ── Helper: build a synthetic comp ──────────────────────────
function makeComp(overrides = {}) {
  return {
    itemId: overrides.itemId || 'test-' + Math.random().toString(36).slice(2),
    title: overrides.title || '2009 US Mint Uncirculated Coin Set Denver',
    totalUsd: overrides.totalUsd ?? 25.00,
    matchScore: overrides.matchScore ?? null,
    matchNotes: overrides.matchNotes || [],
    matchQuality: overrides.matchQuality || null,
    gradeType: overrides.gradeType || 'raw',
    _detectedMetal: overrides._detectedMetal || null,
    _source: overrides._source || 'finding',
    soldDate: overrides.soldDate || new Date().toISOString(),
    ...overrides,
  };
}

const SET_EXPECTED = {
  year: 2009,
  mint: 'D',
  series: 'US Mint Set',
  grade: null,
  isSet: true,
  setType: 'mint-uncirculated',
  _rawQuery: '2009 D US mint set',
};

const NON_SET_EXPECTED = {
  year: 2009,
  mint: 'D',
  series: 'Lincoln Cent',
  grade: null,
  isSet: false,
  _rawQuery: '2009 D Lincoln cent',
};

// ═══════════════════════════════════════════════════════════════
//  scoreMatch — set-specific scoring
// ═══════════════════════════════════════════════════════════════

describe('scoreMatch — set-type scoring', () => {
  test('rewards "set" keyword in title for set searches', () => {
    const comp = makeComp({ title: '2009 US Mint Uncirculated Coin Set Denver' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).toContain('set-match');
    expect(comp.matchScore).toBeGreaterThanOrEqual(60);
  });

  test('penalizes missing "set" keyword for set searches', () => {
    const comp = makeComp({ title: '2009 D Lincoln Penny BU' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).toContain('set-missing');
    expect(comp.matchScore).toBeLessThan(40);
  });

  test('does NOT apply set scoring for non-set searches', () => {
    const comp = makeComp({ title: '2009 D Lincoln Cent BU' });
    scoreMatch(comp, NON_SET_EXPECTED);
    expect(comp.matchNotes).not.toContain('set-match');
    expect(comp.matchNotes).not.toContain('set-missing');
  });

  test('penalizes individual-coin denominations in set search', () => {
    const comp = makeComp({ title: '2009 D Jefferson Nickel BU from mint' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).toContain('individual-coin-in-set-search');
  });

  test('does NOT penalize denominations when title also says "set"', () => {
    const comp = makeComp({ title: '2009 US Mint Set - Includes Penny Quarter Dime Nickel' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).not.toContain('individual-coin-in-set-search');
  });

  test('penalizes wrong set type: proof set when searching mint set', () => {
    const comp = makeComp({ title: '2009 US Proof Set' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).toContain('wrong-set-type');
  });

  test('penalizes wrong set type: mint set when searching proof set', () => {
    const proofExpected = { ...SET_EXPECTED, setType: 'proof-clad' };
    const comp = makeComp({ title: '2009 US Mint Set Uncirculated' });
    scoreMatch(comp, proofExpected);
    expect(comp.matchNotes).toContain('wrong-set-type');
  });

  test('does NOT penalize correct set type: mint set title for mint set search', () => {
    const comp = makeComp({ title: '2009 US Mint Set Uncirculated Denver' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).not.toContain('wrong-set-type');
  });
});

// ═══════════════════════════════════════════════════════════════
//  scoreMatch — mint mark via city name for sets
// ═══════════════════════════════════════════════════════════════

describe('scoreMatch — mint city name detection for sets', () => {
  test('detects "denver" → D mint mark and awards mint-match', () => {
    const comp = makeComp({ title: '2009 US Mint Set Denver' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).toContain('mint-match');
  });

  test('detects "philadelphia" → P and penalizes when searching for D', () => {
    const comp = makeComp({ title: '2009 US Mint Set Philadelphia' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).toContain('mint-mismatch');
  });

  test('detects "san francisco" → S and penalizes when searching for D', () => {
    const comp = makeComp({ title: '2009 US Mint Set San Francisco' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).toContain('mint-mismatch');
  });

  test('no city name and no year-adjacent mint mark → benefit of the doubt', () => {
    const comp = makeComp({ title: '2009 US Mint Set Uncirculated' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).not.toContain('mint-match');
    expect(comp.matchNotes).not.toContain('mint-mismatch');
  });

  test('city name detection fires for all searches (not just sets)', () => {
    const comp = makeComp({ title: '2009 Denver Quarter' });
    scoreMatch(comp, NON_SET_EXPECTED);
    // City name should detect mint mark D for Denver
    expect(comp.matchNotes).toContain('mint-match');
  });
});

// ═══════════════════════════════════════════════════════════════
//  applyFilters — set-type hard filter
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — set-type hard filter', () => {
  test('drops listings without "set" in title for set searches', () => {
    const comps = [
      makeComp({ title: '2009 US Mint Set Denver', matchScore: 70 }),
      makeComp({ title: '2009 D Lincoln Penny BU', matchScore: 50 }),
      makeComp({ title: '2009 US Proof Set', matchScore: 60 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, SET_EXPECTED);
    expect(kept.every(c => /\bset\b/i.test(c.title))).toBe(true);
    expect(removed.notSet).toBe(1);
  });

  test('does NOT apply set filter for non-set searches', () => {
    const comps = [
      makeComp({ title: '2009 D Lincoln Cent BU', matchScore: 70, totalUsd: 5 }),
      makeComp({ title: '2009 D Lincoln Cent MS65', matchScore: 65, totalUsd: 6 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, NON_SET_EXPECTED);
    expect(removed.notSet).toBeUndefined();
    expect(kept.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  applyFilters — raised relevance gate for sets (30 vs 20)
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — set relevance gate', () => {
  test('uses gate of 30 for set searches (rejects 20–29)', () => {
    const comps = [
      makeComp({ title: '2009 US Mint Set', matchScore: 25 }),
      makeComp({ title: '2009 US Mint Set Denver', matchScore: 35 }),
      makeComp({ title: '2009 US Mint Set Uncirculated', matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, SET_EXPECTED);
    expect(removed.lowRelevance).toBe(1); // score 25 rejected
    // score 35 keeps (above 30 gate)
    expect(kept.some(c => c.matchScore === 35)).toBe(true);
  });

  test('uses gate of 20 for non-set searches', () => {
    const comps = [
      makeComp({ title: '2009 D Lincoln Cent', matchScore: 25, totalUsd: 5 }),
      makeComp({ title: '2009 D Lincoln Cent BU', matchScore: 70, totalUsd: 6 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, NON_SET_EXPECTED);
    expect(removed.lowRelevance).toBe(0); // score 25 still passes non-set gate
    expect(kept.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  applyFilters — mint mark filter with city names for sets
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — mint city name filter for sets', () => {
  test('drops comps with wrong mint city (Philadelphia) when searching for D', () => {
    const comps = [
      makeComp({ title: '2009 US Mint Set Denver', matchScore: 70 }),
      makeComp({ title: '2009 US Mint Set Philadelphia', matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, SET_EXPECTED);
    expect(removed.mintMismatch).toBe(1);
    expect(kept.length).toBe(1);
    expect(kept[0].title).toContain('Denver');
  });

  test('keeps comps with no city/mint mark (benefit of doubt)', () => {
    const comps = [
      makeComp({ title: '2009 US Mint Set Uncirculated', matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, SET_EXPECTED);
    expect(removed.mintMismatch).toBe(0);
    expect(kept.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Integration: end-to-end scoring + filtering for "2009 D US mint set"
// ═══════════════════════════════════════════════════════════════

describe('integration — 2009 D US mint set search', () => {
  test('good comp: "2009 US Mint Set Denver" scores high and survives filters', () => {
    const comp = makeComp({ title: '2009 US Mint Uncirculated Coin Set Denver' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchScore).toBeGreaterThanOrEqual(60);
    const { kept } = applyFilters([comp], {}, SET_EXPECTED);
    expect(kept.length).toBe(1);
  });

  test('bad comp: individual "2009 D Lincoln Penny" is rejected', () => {
    const comp = makeComp({ title: '2009 D Lincoln Penny Brilliant Uncirculated' });
    scoreMatch(comp, SET_EXPECTED);
    // Should get set-missing penalty (-35) and individual-coin penalty (-25)
    expect(comp.matchScore).toBeLessThan(30);
    const { kept } = applyFilters([comp], {}, SET_EXPECTED);
    expect(kept.length).toBe(0);
  });

  test('bad comp: wrong mint "2009 US Mint Set Philadelphia" is rejected', () => {
    const comp = makeComp({ title: '2009 US Mint Set Philadelphia' });
    scoreMatch(comp, SET_EXPECTED);
    expect(comp.matchNotes).toContain('mint-mismatch');
    const { kept } = applyFilters([comp], {}, SET_EXPECTED);
    expect(kept.length).toBe(0);
  });

  test('bad comp: eBay product page (generic title, no set keyword) is rejected', () => {
    const comp = makeComp({ title: '2009 United States Mint Penny Collection' });
    scoreMatch(comp, SET_EXPECTED);
    // Missing "set" → set-missing penalty
    expect(comp.matchNotes).toContain('set-missing');
    const { kept } = applyFilters([comp], {}, SET_EXPECTED);
    expect(kept.length).toBe(0);
  });

  test('proof set comp is scored lower than mint set comp', () => {
    const mintComp = makeComp({ title: '2009 US Mint Uncirculated Coin Set Denver' });
    const proofComp = makeComp({ title: '2009 US Proof Set' });
    scoreMatch(mintComp, SET_EXPECTED);
    scoreMatch(proofComp, SET_EXPECTED);
    expect(mintComp.matchScore).toBeGreaterThan(proofComp.matchScore);
  });
});
