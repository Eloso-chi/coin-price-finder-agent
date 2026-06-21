/**
 * applyFilters.test.js — Unit tests for the 14-step filter pipeline
 * in src/services/ebayService.js → applyFilters()
 *
 * Each filter step is exercised independently using synthetic comps.
 */

'use strict';

const { applyFilters, scoreMatch, detectWeightFromTitle, classifyGradeType, detectMetalFromTitle } = require('../src/services/ebayService');

// ── Helper: build a synthetic comp ──────────────────────────
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

function makeComps(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) =>
    makeComp({ itemId: `item-${i}`, totalUsd: 10 + i, ...overrides })
  );
}

// ═══════════════════════════════════════════════════════════════
//  Step 1: Low Relevance Gate (matchScore < 20)
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — low relevance gate', () => {
  test('removes comps with matchScore < 20', () => {
    const comps = [
      makeComp({ matchScore: 5, title: 'Irrelevant item' }),
      makeComp({ matchScore: 19, title: 'Barely irrelevant' }),
      makeComp({ matchScore: 20, title: '1964 Kennedy Half Dollar' }),
      makeComp({ matchScore: 70, title: '1964 Kennedy Half Dollar BU' }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { series: 'Kennedy Half Dollar' });
    expect(kept.length).toBe(2);
    expect(removed.lowRelevance).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 2: Deny-list
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — deny-list', () => {
  const DENIED_TITLES = [
    'Lot of 10 Kennedy Half Dollars',
    'Kennedy Half Dollar Collection Book',
    'Estate Sale Mixed Coins',
    'Replica 1964 Half Dollar',
    'Cleaned 1964 Kennedy Half BU',
    'Whitman Kennedy Half Dollar Album',
    'Dansco Half Dollar Folder',
    'Littleton Coin Map Push-Pin',
  ];

  test.each(DENIED_TITLES)('denies: "%s"', (title) => {
    const comps = [makeComp({ title, matchScore: 80 })];
    const { kept, removed } = applyFilters(comps, {}, { series: 'Kennedy Half Dollar' });
    expect(kept.length).toBe(0);
    expect(removed.denied).toBe(1);
  });

  test('allows legitimate listings', () => {
    const comps = [
      makeComp({ title: '1964 Kennedy Half Dollar BU Silver', matchScore: 80 }),
      makeComp({ title: '1964-D Kennedy Half Dollar PCGS MS-64', matchScore: 90 }),
    ];
    const { kept } = applyFilters(comps, {}, { series: 'Kennedy Half Dollar' });
    expect(kept.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 3: Non-USD filter
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — non-USD', () => {
  test('removes null totalUsd', () => {
    const comps = [
      makeComp({ totalUsd: null, matchScore: 70 }),
      makeComp({ totalUsd: 12.50, matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {});
    expect(kept.length).toBe(1);
    expect(removed.nonUsd).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 4: Metal mismatch
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — metal mismatch', () => {
  test('removes gold comp when searching for silver', () => {
    const comps = [
      makeComp({ _detectedMetal: 'gold', matchScore: 70 }),
      makeComp({ _detectedMetal: 'silver', matchScore: 70 }),
      makeComp({ _detectedMetal: null, matchScore: 70 }), // benefit of doubt
    ];
    const { kept, removed } = applyFilters(comps, {}, { metal: 'silver' });
    expect(kept.length).toBe(2); // silver + null
    expect(removed.metalMismatch).toBe(1);
  });

  test('no filtering when no expected metal', () => {
    const comps = [
      makeComp({ _detectedMetal: 'gold', matchScore: 70 }),
      makeComp({ _detectedMetal: 'silver', matchScore: 70 }),
    ];
    const { kept } = applyFilters(comps, {}, {});
    expect(kept.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 5: Weight mismatch
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — weight mismatch', () => {
  test('removes 1 oz comp when searching for 1/4 oz', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle 1 oz BU', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle 1/4 oz BU', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle BU', matchScore: 70 }), // no weight → kept
    ];
    const { kept, removed } = applyFilters(comps, {}, { weight: 0.25 });
    expect(removed.weightMismatch).toBe(1);
    expect(kept.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 6 & 7: Melt ceiling and floor
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — melt ceiling (fractional)', () => {
  test('removes overpriced comp for fractional coin', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle BU', totalUsd: 100, matchScore: 70 }),  // too expensive for 1/4 oz
      makeComp({ title: '2024 Silver Eagle BU', totalUsd: 10, matchScore: 70 }),   // reasonable for 1/4 oz
    ];
    // meltPerOz = $30, weight = 0.25, so melt ceiling = 30 * 1.8 = 54
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: 30, weight: 0.25 });
    expect(removed.meltSanity).toBe(1);
    expect(kept.length).toBe(1);
  });
});

describe('applyFilters — melt floor (1oz+)', () => {
  test('removes underpriced comp for 1oz coin', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle BU', totalUsd: 5, matchScore: 70 }),   // too cheap for 1 oz silver
      makeComp({ title: '2024 Silver Eagle BU', totalUsd: 35, matchScore: 70 }),  // reasonable
    ];
    // meltPerOz = $30, weight = 1, floor = 30 * 1 * 0.40 = 12
    const { kept, removed } = applyFilters(comps, {}, { meltPerOz: 30, weight: 1 });
    expect(removed.meltFloor).toBe(1);
    expect(kept.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 8: Variant mismatch
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — variant mismatch', () => {
  test('removes colorized variant for plain BU query', () => {
    const title = '2024 Silver Eagle Colorized';
    const comps = [makeComp({ title, matchScore: 70 })];
    const { kept, removed } = applyFilters(comps, {}, { _rawQuery: '2024 Silver Eagle BU' });
    expect(kept.length).toBe(0);
    expect(removed.variantMismatch).toBe(1);
  });

  test('plain BU query removes specialty variants except privy', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle Gilded BU', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle Reverse Proof', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle Privy Mark', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle High Relief', matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { _rawQuery: '2024 Silver Eagle BU' });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Privy/i);
    expect(removed.variantMismatch).toBe(3);
  });

  test('allows variant when query requests it', () => {
    const comps = [makeComp({ title: '2024 Silver Eagle Reverse Proof', matchScore: 70 })];
    const { kept } = applyFilters(comps, {}, { _rawQuery: '2024 Silver Eagle Reverse Proof' });
    expect(kept.length).toBe(1);
  });

  test('reverse-proof query keeps reverse-proof and rejects colorized', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle Reverse Proof', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle Colorized', matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { _rawQuery: '2024 Silver Eagle Reverse Proof' });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Reverse Proof/i);
    expect(removed.variantMismatch).toBe(1);
  });

  test('colorized query keeps colorized and plain BU, removes other specialty families', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle Colorized Perth Mint with COA', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle BU', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle Gilded', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle Reverse Proof', matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { _rawQuery: '2024 Silver Eagle Colorized' });
    expect(kept.length).toBe(2);
    expect(kept.some(c => /Colorized/i.test(c.title))).toBe(true);
    expect(kept.some(c => /\bBU\b/i.test(c.title))).toBe(true);
    expect(removed.variantWrongColor).toBe(2);
  });

  test('label-only family intent applies family-aware filtering', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle Colorized', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle Privy Mark', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle Gilded', matchScore: 70 }),
      makeComp({ title: '2024 Silver Eagle BU', matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { label: 'Colorized' });
    expect(kept.length).toBe(2);
    expect(removed.variantWrongColor).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 9: Mint mark mismatch
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — mint mark mismatch', () => {
  test('removes 1892-O when searching for 1892-S', () => {
    const comps = [
      makeComp({ title: '1892-O Morgan Silver Dollar', matchScore: 70 }),
      makeComp({ title: '1892-S Morgan Silver Dollar', matchScore: 70 }),
      makeComp({ title: '1892 Morgan Silver Dollar', matchScore: 70 }), // no mint → kept
    ];
    const { kept, removed } = applyFilters(comps, {}, { mint: 'S', series: 'Morgan Dollar' });
    expect(removed.mintMismatch).toBe(1);
    expect(kept.length).toBe(2);
  });

  test('keeps over-mintmark variety "1882-O/S" when searching for S mint', () => {
    const comps = [
      makeComp({ title: '1882-O/S Strong Morgan Silver Dollar AU++', matchScore: 70 }),
      makeComp({ title: '1882 O/S Morgan Silver Dollar', matchScore: 70 }),
      makeComp({ title: '1882-O/S Morgan Dollar PCGS AU50', matchScore: 70 }),
      makeComp({ title: '1882-O Morgan Silver Dollar PCGS MS64', matchScore: 70 }), // pure O → removed
    ];
    const { kept, removed } = applyFilters(comps, {}, { mint: 'S', series: 'Morgan Dollar' });
    expect(removed.mintMismatch).toBe(1);
    expect(kept.length).toBe(3);
  });

  test('keeps "O over S" text variant when searching for S mint', () => {
    const comps = [
      makeComp({ title: '1882 O over S Morgan Silver Dollar', matchScore: 70 }),
    ];
    const { kept } = applyFilters(comps, {}, { mint: 'S', series: 'Morgan Dollar' });
    expect(kept.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 10: Denomination mismatch
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — denomination mismatch', () => {
  test('removes dollar comp when searching for quarter', () => {
    const comps = [
      makeComp({ title: '1964-D Washington Quarter BU Silver', matchScore: 70 }),
      makeComp({ title: 'US Mint Commemorative Dollar 1964', matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { series: 'Washington Quarter', _rawQuery: '1964 D Washington Quarter' });
    expect(removed.denomMismatch).toBe(1);
    expect(kept.length).toBe(1);
  });

  test('removes nickel comp when searching for half dollar', () => {
    const comps = [
      makeComp({ title: '1964 Kennedy Half Dollar BU', matchScore: 70 }),
      makeComp({ title: '1964 Jefferson Nickel', matchScore: 70 }),
    ];
    const { kept } = applyFilters(comps, {}, { series: 'Kennedy Half Dollar' });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Kennedy/);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 11: Series conflict
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — series conflict', () => {
  test('removes Buffalo comps for Jefferson search', () => {
    const comps = [
      makeComp({ title: '1950 D Jefferson Nickel BU', matchScore: 70 }),
      makeComp({ title: '1937 D Buffalo Nickel VF', matchScore: 60 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { series: 'Jefferson Nickel' });
    expect(removed.seriesConflict).toBe(1);
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Jefferson/);
  });

  test('removes Franklin comps for Kennedy search', () => {
    const comps = [
      makeComp({ title: '1964 Kennedy Half Dollar', matchScore: 70 }),
      makeComp({ title: '1963 Franklin Half Dollar BU', matchScore: 60 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, { series: 'Kennedy Half Dollar' });
    expect(removed.seriesConflict).toBe(1);
    expect(kept[0].title).toMatch(/Kennedy/);
  });

  test('removes Walking Liberty for Kennedy search', () => {
    const comps = [
      makeComp({ title: '1964 Kennedy Half Dollar', matchScore: 70 }),
      makeComp({ title: '1945 Walking Liberty Half Dollar', matchScore: 60 }),
    ];
    const { kept } = applyFilters(comps, {}, { series: 'Kennedy Half Dollar' });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Kennedy/);
  });

  test('removes Mercury dimes for Roosevelt search', () => {
    const comps = [
      makeComp({ title: '2020 Roosevelt Dime BU', matchScore: 70 }),
      makeComp({ title: '1944 Mercury Dime VF Silver', matchScore: 60 }),
    ];
    const { kept } = applyFilters(comps, {}, { series: 'Roosevelt Dime' });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Roosevelt/);
  });

  test('removes Peace dollar for Morgan search', () => {
    const comps = [
      makeComp({ title: '1921 Morgan Silver Dollar BU', matchScore: 70 }),
      makeComp({ title: '1922 Peace Silver Dollar BU', matchScore: 60 }),
    ];
    const { kept } = applyFilters(comps, {}, { series: 'Morgan Dollar' });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Morgan/);
  });

  test('removes Indian Head cents for Lincoln search', () => {
    const comps = [
      makeComp({ title: '1959 Lincoln Penny BU', matchScore: 70 }),
      makeComp({ title: '1907 Indian Head Cent VF', matchScore: 60 }),
    ];
    const { kept } = applyFilters(comps, {}, { series: 'Lincoln Penny' });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Lincoln/);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 12 & 13: PCGS only + exact grade
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — requirePCGSOnly', () => {
  test('removes non-PCGS comps when required', () => {
    const comps = [
      makeComp({ title: '1964 Kennedy Half PCGS MS-64', matchScore: 70 }),
      makeComp({ title: '1964 Kennedy Half NGC MS-64', matchScore: 70 }),
      makeComp({ title: '1964 Kennedy Half Dollar BU', matchScore: 70 }),
    ];
    const { kept } = applyFilters(comps, { requirePCGSOnly: true }, {});
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/PCGS/);
  });
});

describe('applyFilters — exactGradeOnly', () => {
  test('removes comps without exact grade when required', () => {
    const comps = [
      makeComp({ title: '1964 Kennedy Half PCGS MS-64', matchScore: 70 }),
      makeComp({ title: '1964 Kennedy Half PCGS MS-65', matchScore: 70 }),
      makeComp({ title: '1964 Kennedy Half BU', matchScore: 70 }),
    ];
    const { kept } = applyFilters(comps, { exactGradeOnly: true }, { grade: 'MS-64' });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/MS-64/);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Step 14: MAD outlier removal
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — MAD outlier removal', () => {
  test('removes extreme price outlier', () => {
    const comps = makeComps(8, { title: '1964 Kennedy Half Dollar BU' });
    // Add an extreme outlier
    comps.push(makeComp({
      title: '1964 Kennedy Half Dollar BU',
      totalUsd: 5000,
      matchScore: 70
    }));
    const { kept, removed } = applyFilters(comps, {}, {});
    expect(removed.outlier).toBeGreaterThanOrEqual(1);
    expect(kept.every(c => c.totalUsd < 1000)).toBe(true);
  });

  test('does not remove from small sample (< 4)', () => {
    const comps = [
      makeComp({ totalUsd: 10, matchScore: 70 }),
      makeComp({ totalUsd: 12, matchScore: 70 }),
      makeComp({ totalUsd: 1000, matchScore: 70 }),
    ];
    const { kept } = applyFilters(comps, {}, {});
    // With only 3 comps, MAD skips — all kept
    expect(kept.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Composite: multiple filters together
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — composite real-world scenario', () => {
  test('1964-D Washington Quarter filters out dollar, album, and wrong series', () => {
    const comps = [
      makeComp({ title: '1964-D Washington Quarter BU Silver', totalUsd: 8, matchScore: 80 }),
      makeComp({ title: '1964 US Commemorative Dollar Silver', totalUsd: 25, matchScore: 40 }),
      makeComp({ title: 'Whitman Washington Quarter Album', totalUsd: 15, matchScore: 30 }),
      makeComp({ title: '1964-D Standing Liberty Quarter (repro)', totalUsd: 5, matchScore: 50 }),
    ];
    const { kept } = applyFilters(comps, {}, {
      series: 'Washington Quarter',
      _rawQuery: '1964 D Washington Quarter',
      mint: 'D',
    });
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Washington Quarter BU/);
  });

  test('1950-D Jefferson Nickel filters out Buffalo Nickel comps', () => {
    const comps = [
      makeComp({ title: '1950-D Jefferson Nickel BU', totalUsd: 35, matchScore: 85 }),
      makeComp({ title: '1918-D Buffalo Five Cents VF', totalUsd: 32247, matchScore: 30 }),
      makeComp({ title: '1937-D Buffalo Nickel VG', totalUsd: 55, matchScore: 50 }),
    ];
    const { kept } = applyFilters(comps, {}, {
      series: 'Jefferson Nickel',
      _rawQuery: '1950 D Jefferson Nickel MS-64',
      mint: 'D',
    });
    // Only the Jefferson should survive
    expect(kept.length).toBe(1);
    expect(kept[0].title).toMatch(/Jefferson/);
  });
});

// ═══════════════════════════════════════════════════════════════
//  scoreMatch direct tests
// ═══════════════════════════════════════════════════════════════

describe('scoreMatch()', () => {
  test('exact match scores highest', () => {
    const comp = makeComp({ title: '1964-D Kennedy Half Dollar PCGS MS-64' });
    scoreMatch(comp, {
      year: 1964, mint: 'D', series: 'Kennedy Half Dollar',
      grade: 'MS-64', _rawQuery: '1964 D Kennedy Half Dollar MS-64'
    });
    expect(comp.matchScore).toBeGreaterThanOrEqual(80);
    expect(comp.matchQuality).toBe('exact');
  });

  test('series conflict gets heavy penalty', () => {
    const comp = makeComp({ title: '1937 Buffalo Nickel VF' });
    scoreMatch(comp, {
      year: 1950, series: 'Jefferson Nickel',
      _rawQuery: '1950 D Jefferson Nickel'
    });
    expect(comp.matchScore).toBeLessThan(20);
    expect(comp.matchNotes).toContain('series-conflict');
  });

  test('denomination mismatch gets penalty', () => {
    const comp = makeComp({ title: '2024 Commemorative Silver Dollar' });
    scoreMatch(comp, {
      year: 1964, series: 'Washington Quarter',
      _rawQuery: '1964 D Washington Quarter'
    });
    expect(comp.matchNotes).toContain('denom-mismatch');
  });

  test('mint mismatch gets penalty', () => {
    const comp = makeComp({ title: '1892-O Morgan Silver Dollar' });
    scoreMatch(comp, {
      year: 1892, mint: 'S', series: 'Morgan Dollar',
      _rawQuery: '1892-S Morgan Dollar'
    });
    expect(comp.matchNotes).toContain('mint-mismatch');
    expect(comp.matchScore).toBeLessThan(50);
  });

  test('weight match gives bonus', () => {
    const comp = makeComp({ title: '2024 Silver Eagle 1 oz BU' });
    scoreMatch(comp, {
      year: 2024, weight: 1.0, series: 'Silver Eagle',
      _rawQuery: '2024 Silver Eagle 1 oz'
    });
    expect(comp.matchNotes).toContain('weight-match');
  });

  test('weight mismatch gives penalty', () => {
    const comp = makeComp({ title: '2024 Silver Eagle 1/4 oz BU' });
    scoreMatch(comp, {
      year: 2024, weight: 1.0, series: 'Silver Eagle',
      _rawQuery: '2024 Silver Eagle 1 oz'
    });
    expect(comp.matchNotes).toContain('weight-mismatch');
  });

  test('colorized mint-issued scores above aftermarket colorized', () => {
    const mintIssued = makeComp({ title: '2024 Silver Eagle Colorized Perth Mint with COA' });
    const aftermarket = makeComp({ title: '2024 Silver Eagle Colorized hand painted custom art coin' });
    const expected = {
      year: 2024,
      series: 'Silver Eagle',
      _rawQuery: '2024 Silver Eagle Colorized'
    };

    scoreMatch(mintIssued, expected);
    scoreMatch(aftermarket, expected);

    expect(mintIssued.matchNotes).toContain('colorized-mint-issued');
    expect(aftermarket.matchNotes).toContain('colorized-aftermarket');
    expect(mintIssued.matchScore).toBeGreaterThan(aftermarket.matchScore);
  });

  test('privy is informational-only (no mismatch penalty)', () => {
    const privyComp = makeComp({ title: '2024 Silver Eagle Privy Mark BU' });
    scoreMatch(privyComp, {
      year: 2024,
      series: 'Silver Eagle',
      _rawQuery: '2024 Silver Eagle BU'
    });
    expect(privyComp.matchNotes).toContain('privy-info');
    expect(privyComp.matchNotes).not.toContain('variant-mismatch');
  });
});

// ═══════════════════════════════════════════════════════════════
//  detectWeightFromTitle
// ═══════════════════════════════════════════════════════════════

describe('detectWeightFromTitle()', () => {
  test.each([
    ['1 oz Silver Eagle', 1],
    ['1/2 oz Gold Eagle', 0.5],
    ['1/4 oz Platinum Eagle', 0.25],
    ['1/10 oz Gold Eagle', 0.1],
    ['5 oz ATB Quarter', 5],
    ['10 oz Silver Bar', 10],
  ])('detects "%s" as %f oz', (title, expectedOz) => {
    expect(detectWeightFromTitle(title)).toBeCloseTo(expectedOz, 2);
  });

  test('returns null when no weight stated', () => {
    expect(detectWeightFromTitle('1964 Kennedy Half Dollar BU')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  classifyGradeType
// ═══════════════════════════════════════════════════════════════

describe('classifyGradeType()', () => {
  test('conditionId 2000 → graded', () => {
    expect(classifyGradeType({ conditionId: '2000', title: '' })).toBe('graded');
  });

  test('conditionId 3000 → raw', () => {
    expect(classifyGradeType({ conditionId: '3000', title: '' })).toBe('raw');
  });

  test('title with PCGS → graded', () => {
    expect(classifyGradeType({ title: '1964 Kennedy PCGS MS-64' })).toBe('graded');
  });

  test('title with NGC → graded', () => {
    expect(classifyGradeType({ title: '1964 Kennedy NGC MS-64' })).toBe('graded');
  });

  test('plain BU title → raw', () => {
    expect(classifyGradeType({ title: '1964 Kennedy Half Dollar BU' })).toBe('raw');
  });
});

// ═══════════════════════════════════════════════════════════════
//  detectMetalFromTitle — mixed-metal disambiguation (#178)
// ═══════════════════════════════════════════════════════════════

describe('detectMetalFromTitle — mixed-metal disambiguation', () => {
  test('silver coin with "24k Gold Gilded" returns silver', () => {
    expect(detectMetalFromTitle('2024 Mexico Libertad Aztec Jaguar 24k Gold Gilded 1 oz Silver Art Coin')).toBe('silver');
  });

  test('silver coin with "Gold-Finish" returns silver', () => {
    expect(detectMetalFromTitle('2024 Colorized Mexico Libertad 24kt Gold-Finish BU 999 1 oz Silver Coin')).toBe('silver');
  });

  test('silver coin with "Gold Diamond Dust" returns silver', () => {
    expect(detectMetalFromTitle('2024 1 Oz Silver Mexico Libertad Sun & Moon: Yin Yang 24k Gold Diamond Dust Coin')).toBe('silver');
  });

  test('silver coin with "Gold & Platinum Edition" returns silver', () => {
    expect(detectMetalFromTitle('2024 Mexico Libertad Holo Diamond Dust Gold & Platinum Edition 1 oz Silver Coin')).toBe('silver');
  });

  test('silver coin with ".999 silver" and decorative gold returns silver', () => {
    expect(detectMetalFromTitle('2024 Mexico Libertad Black Platinum & Gold and Silver 1 oz .999 Fine')).toBe('silver');
  });

  test('silver coin with gold color returns silver', () => {
    expect(detectMetalFromTitle('2024 Libertad Aztec Eagle Warrior 24k Gold Color Silver Coin')).toBe('silver');
  });

  test('genuine gold coin returns gold', () => {
    expect(detectMetalFromTitle('2024 1 oz Mexico Libertad .999 Fine Gold 1 Onza Coin BU')).toBe('gold');
  });

  test('genuine silver coin returns silver', () => {
    expect(detectMetalFromTitle('2024 Mexico 1 oz Silver Libertad BU')).toBe('silver');
  });

  test('genuine platinum coin returns platinum', () => {
    expect(detectMetalFromTitle('2024 American Platinum Eagle 1 oz')).toBe('platinum');
  });

  test('gold-only title (no silver) returns gold', () => {
    expect(detectMetalFromTitle('2024 1/10 oz Gold Libertad Onza')).toBe('gold');
  });

  test('silver-only title (no gold) returns silver', () => {
    expect(detectMetalFromTitle('2024 Silver Eagle 1 oz BU')).toBe('silver');
  });

  test('no metal words returns null', () => {
    expect(detectMetalFromTitle('1964 Kennedy Half Dollar BU')).toBeNull();
  });

  test('null/empty returns null', () => {
    expect(detectMetalFromTitle(null)).toBeNull();
    expect(detectMetalFromTitle('')).toBeNull();
  });

  test('weight-adjacent silver overrides earlier gold mention', () => {
    // "Gold" appears first but "1 oz Silver" is the weight-adjacent metal
    expect(detectMetalFromTitle('Gold Plated 2024 Mexico 1 oz Silver Libertad')).toBe('silver');
  });

  test('weight-adjacent gold overrides earlier silver mention', () => {
    // "Silver" appears first but "1 oz Gold" is the weight-adjacent metal
    expect(detectMetalFromTitle('Silver Toned 2024 Mexico 1 oz Gold Libertad')).toBe('gold');
  });

  test('multi-metal decorative edition returns silver', () => {
    expect(detectMetalFromTitle('2024 Mexico 1-oz Silver Libertad Multi-Metal Gold & Black Ruthenium BU')).toBe('silver');
  });

  test('black platinum & gold decorative returns silver', () => {
    expect(detectMetalFromTitle('2024 Mexico 1 Ounce Silver Libertad Black Platinum & Gold - OGP COA')).toBe('silver');
  });

  test('fine silver with gold decoration returns silver', () => {
    expect(detectMetalFromTitle('Black Platinum & Gold and Silver Libertad 2024 1 oz Fine Silver Coin Mexico')).toBe('silver');
  });

  test('rhodium + gold decorative returns silver', () => {
    expect(detectMetalFromTitle('Yellow Gold and White Rhodium Libertad 2024 1 oz Fine Silver Coin')).toBe('silver');
  });
});

// ═══════════════════════════════════════════════════════════════
//  yearMismatch — generic dataset skip logic (#165, #168)
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — yearMismatch', () => {
  test('strict year filter on year-specific datasets for bullion (tolerance=0)', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle 1 oz BU', matchScore: 70 }),
      makeComp({ title: '2023 Silver Eagle 1 oz BU', matchScore: 70 }),
      makeComp({ title: '2021 Silver Eagle 1 oz BU', matchScore: 70 }),
    ];
    // Not a generic dataset (no _fromGenericDataset flag)
    const { kept, removed } = applyFilters(comps, {}, { year: 2024, weight: 1 });
    expect(kept.length).toBe(1); // only 2024
    expect(removed.yearMismatch).toBe(2);
  });

  test('skips year filter on generic datasets for bullion (#165)', () => {
    const comps = [
      makeComp({ title: '2024 Silver Eagle 1 oz BU', matchScore: 70 }),
      makeComp({ title: '2023 Silver Eagle 1 oz BU', matchScore: 70 }),
      makeComp({ title: '2021 Silver Eagle 1 oz BU', matchScore: 70 }),
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 2024, weight: 1, _fromGenericDataset: true,
    });
    expect(kept.length).toBe(3); // all kept -- year filter skipped
    expect(removed.yearMismatch).toBeUndefined();
  });

  test('non-bullion generic dataset uses wider tolerance (+-3 years)', () => {
    const comps = [
      makeComp({ title: '2024 Kennedy Half Dollar', matchScore: 70 }),
      makeComp({ title: '2021 Kennedy Half Dollar', matchScore: 70 }),  // within 3
      makeComp({ title: '2019 Kennedy Half Dollar', matchScore: 70 }),  // outside 3
    ];
    const { kept, removed } = applyFilters(comps, {}, {
      year: 2024, _fromGenericDataset: true,  // no weight = not bullion
    });
    expect(kept.length).toBe(2);
    expect(removed.yearMismatch).toBe(1);
  });

  test('numismatic year-specific dataset uses tolerance +-1', () => {
    const comps = [
      makeComp({ title: '1921 Morgan Silver Dollar', matchScore: 70 }),
      makeComp({ title: '1922 Peace Dollar', matchScore: 70 }),       // within 1
      makeComp({ title: '1918 Morgan Silver Dollar', matchScore: 70 }), // outside 1
    ];
    const { kept, removed } = applyFilters(comps, {}, { year: 1921 });
    expect(kept.length).toBe(2);
    expect(removed.yearMismatch).toBe(1);
  });
});
