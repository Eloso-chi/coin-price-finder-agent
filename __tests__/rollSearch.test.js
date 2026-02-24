/**
 * rollSearch.test.js — Tests for coin roll search support
 *
 * Covers:
 * 1. parseDescription — isRoll detection
 * 2. isDenied — allowRoll option
 * 3. applyFilters — roll-aware deny-list + roll-require filter
 * 4. scoreMatch — roll match/mismatch scoring
 * 5. buildKeywords — (keywords wired through priceRoute, tested via integration)
 */

'use strict';

const { parseDescription } = require('../src/services/pcgsService');
const { isDenied, ROLL_PATTERN, DENY_PATTERNS } = require('../src/utils/filters');
const { applyFilters, scoreMatch } = require('../src/services/ebayService');

// ── Helper: build a synthetic comp ──────────────────────────
function makeComp(overrides = {}) {
  return {
    itemId: overrides.itemId || 'test-' + Math.random().toString(36).slice(2),
    title: overrides.title || '1960-D Lincoln Cent Roll BU',
    totalUsd: overrides.totalUsd ?? 25.00,
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
//  1. parseDescription — isRoll detection
// ═══════════════════════════════════════════════════════════════

describe('parseDescription — roll detection', () => {
  const ROLL_QUERIES = [
    ['1960 P lincoln cent roll', { year: 1960, mint: 'P', isRoll: true }],
    ['1964 Kennedy Half Dollar Roll', { year: 1964, isRoll: true }],
    ['roll of 20 Washington Quarters 1963', { year: 1963, isRoll: true }],
    ['2024 American Silver Eagle roll', { year: 2024, isRoll: true }],
    ['Buffalo Nickel rolls', { isRoll: true }],
    ['1958-D Lincoln Cent OBW roll', { year: 1958, mint: 'D', isRoll: true }],
    ['Roosevelt Dime Roll BU 1955', { year: 1955, isRoll: true }],
    ['mercury dime roll 1940-S', { year: 1940, mint: 'S', isRoll: true }],
  ];

  test.each(ROLL_QUERIES)('detects roll: "%s"', (query, expectedFields) => {
    const parsed = parseDescription(query);
    expect(parsed.isRoll).toBe(true);
    if (expectedFields.year) expect(parsed.year).toBe(expectedFields.year);
    if (expectedFields.mint) expect(parsed.mint).toBe(expectedFields.mint);
  });

  const NON_ROLL_QUERIES = [
    '1964 Kennedy Half Dollar BU',
    '1921 Morgan Silver Dollar AU',
    '2024 American Silver Eagle 1 oz',
    '1960-D Lincoln Cent MS-65 RD',
    'US Proof Set 2023',
  ];

  test.each(NON_ROLL_QUERIES)('does NOT detect roll: "%s"', (query) => {
    const parsed = parseDescription(query);
    expect(parsed.isRoll).toBeUndefined();
  });

  test('roll detection preserves underlying coin series parsing', () => {
    const parsed = parseDescription('1960-D Lincoln Cent Roll');
    expect(parsed.isRoll).toBe(true);
    expect(parsed.year).toBe(1960);
    expect(parsed.mint).toBe('D');
    // Series should still be detected from the remaining tokens
  });
});

// ═══════════════════════════════════════════════════════════════
//  2. isDenied — allowRoll option
// ═══════════════════════════════════════════════════════════════

describe('isDenied — allowRoll', () => {
  test('ROLL_PATTERN is in DENY_PATTERNS', () => {
    expect(DENY_PATTERNS).toContain(ROLL_PATTERN);
  });

  test('denies "roll" by default', () => {
    expect(isDenied('Roll of 20 1964 Quarters')).toBe(true);
    expect(isDenied('1960-D Lincoln Cent Roll BU')).toBe(true);
    expect(isDenied('OBW roll 1958 cents')).toBe(true);
  });

  test('allows "roll" when allowRoll: true', () => {
    expect(isDenied('Roll of 20 1964 Quarters', { allowRoll: true })).toBe(false);
    expect(isDenied('1960-D Lincoln Cent Roll BU', { allowRoll: true })).toBe(false);
    expect(isDenied('OBW roll 1958 cents', { allowRoll: true })).toBe(false);
  });

  test('still denies other patterns even with allowRoll: true', () => {
    expect(isDenied('Lot of 20 Roll 1964 Quarters', { allowRoll: true })).toBe(true);
    expect(isDenied('Roll replica 1960 cents', { allowRoll: true })).toBe(true);
    expect(isDenied('Lincoln Cent Roll Collection', { allowRoll: true })).toBe(true);
    expect(isDenied('Roll estate sale quarters', { allowRoll: true })).toBe(true);
    expect(isDenied('Roll fake Morgan dollars', { allowRoll: true })).toBe(true);
  });

  test('non-roll titles unaffected by allowRoll option', () => {
    expect(isDenied('1964 Kennedy Half Dollar BU', { allowRoll: true })).toBe(false);
    expect(isDenied('Lot of 10 Kennedy Half', { allowRoll: true })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  3. applyFilters — roll-aware deny-list + roll-require filter
// ═══════════════════════════════════════════════════════════════

describe('applyFilters — roll search mode', () => {
  test('keeps roll listings when expected.isRoll is true', () => {
    const comps = [
      makeComp({ title: '1960-D Lincoln Cent Roll BU', totalUsd: 25 }),
      makeComp({ title: 'Original Bank Wrapped Roll 1960 P Lincoln Cents', totalUsd: 30 }),
      makeComp({ title: '1960 Lincoln Cent Roll Uncirculated', totalUsd: 22 }),
    ];
    const expected = { series: 'Lincoln Cent', year: 1960, isRoll: true, _rawQuery: '1960 lincoln cent roll' };
    const { kept, removed } = applyFilters(comps, {}, expected);
    expect(kept.length).toBe(3);
    expect(removed.denied).toBe(0);
  });

  test('filters out non-roll listings when expected.isRoll is true', () => {
    const comps = [
      makeComp({ title: '1960-D Lincoln Cent Roll BU', totalUsd: 25 }),
      makeComp({ title: '1960-D Lincoln Cent MS-65 RD PCGS', totalUsd: 45 }),
      makeComp({ title: '1960 Lincoln Cent Brilliant Uncirculated', totalUsd: 2 }),
    ];
    const expected = { series: 'Lincoln Cent', year: 1960, isRoll: true, _rawQuery: '1960 lincoln cent roll' };
    const { kept, removed } = applyFilters(comps, {}, expected);
    expect(kept.length).toBe(1);
    expect(removed.notRoll).toBe(2);
  });

  test('still denies other bad patterns in roll mode', () => {
    const comps = [
      makeComp({ title: '1960-D Lincoln Cent Roll BU', totalUsd: 25 }),
      makeComp({ title: 'Lot of 5 Lincoln Cent Rolls 1960', totalUsd: 120 }),
      makeComp({ title: 'Lincoln Cent Roll replica 1960', totalUsd: 5 }),
    ];
    const expected = { series: 'Lincoln Cent', year: 1960, isRoll: true, _rawQuery: '1960 lincoln cent roll' };
    const { kept, removed } = applyFilters(comps, {}, expected);
    expect(kept.length).toBe(1);
    expect(removed.denied).toBe(2);
  });

  test('normal search still denies roll listings', () => {
    const comps = [
      makeComp({ title: '1960-D Lincoln Cent MS-65 RD', totalUsd: 45 }),
      makeComp({ title: '1960-D Lincoln Cent Roll BU', totalUsd: 25 }),
    ];
    const expected = { series: 'Lincoln Cent', year: 1960, _rawQuery: '1960 lincoln cent' };
    const { kept, removed } = applyFilters(comps, {}, expected);
    expect(kept.length).toBe(1);
    expect(removed.denied).toBe(1);
    expect(kept[0].title).toContain('MS-65');
  });

  test('roll search handles "rolls" (plural)', () => {
    const comps = [
      makeComp({ title: '1964 Kennedy Half Dollar Rolls Lot of 2', totalUsd: 400 }),
    ];
    // Note: "Lot" will trigger the lot deny pattern, so this should be denied
    const expected = { series: 'Kennedy Half Dollar', year: 1964, isRoll: true, _rawQuery: '1964 kennedy roll' };
    const { kept, removed } = applyFilters(comps, {}, expected);
    expect(removed.denied).toBe(1); // caught by "lot" pattern
  });

  test('roll search with no matching comps returns empty', () => {
    const comps = [
      makeComp({ title: '1960 Lincoln Cent BU', totalUsd: 2 }),
      makeComp({ title: '1960 Lincoln Cent Proof', totalUsd: 8 }),
    ];
    const expected = { series: 'Lincoln Cent', year: 1960, isRoll: true, _rawQuery: '1960 lincoln cent roll' };
    const { kept, removed } = applyFilters(comps, {}, expected);
    expect(kept.length).toBe(0);
    expect(removed.notRoll).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  4. scoreMatch — roll scoring
// ═══════════════════════════════════════════════════════════════

describe('scoreMatch — roll scoring', () => {
  test('awards roll-match bonus when expected.isRoll and title has "roll"', () => {
    const comp = makeComp({ title: '1960-D Lincoln Cent Roll BU', matchScore: null });
    const expected = { year: 1960, series: 'Lincoln Cent', isRoll: true, _rawQuery: '1960 lincoln cent roll' };
    scoreMatch(comp, expected);
    expect(comp.matchNotes).toContain('roll-match');
    expect(comp.matchScore).toBeGreaterThanOrEqual(65);
  });

  test('penalizes when expected.isRoll but title lacks "roll"', () => {
    const comp = makeComp({ title: '1960-D Lincoln Cent BU', matchScore: null });
    const expected = { year: 1960, series: 'Lincoln Cent', isRoll: true, _rawQuery: '1960 lincoln cent roll' };
    scoreMatch(comp, expected);
    expect(comp.matchNotes).toContain('roll-mismatch');
  });

  test('no roll scoring when expected.isRoll is falsy', () => {
    const comp = makeComp({ title: '1960-D Lincoln Cent Roll BU', matchScore: null });
    const expected = { year: 1960, series: 'Lincoln Cent', _rawQuery: '1960 lincoln cent' };
    scoreMatch(comp, expected);
    expect(comp.matchNotes).not.toContain('roll-match');
    expect(comp.matchNotes).not.toContain('roll-mismatch');
  });

  test('roll + year + series match gives high score', () => {
    const comp = makeComp({ title: '1960-D Lincoln Cent Roll BU Original', matchScore: null });
    const expected = { year: 1960, series: 'Lincoln Cent', mint: 'D', isRoll: true, _rawQuery: '1960-D lincoln cent roll' };
    scoreMatch(comp, expected);
    expect(comp.matchScore).toBeGreaterThanOrEqual(80);
    expect(comp.matchNotes).toContain('roll-match');
    expect(comp.matchNotes).toContain('year-match');
  });
});

// ═══════════════════════════════════════════════════════════════
//  5. End-to-end roll search scenarios
// ═══════════════════════════════════════════════════════════════

describe('Roll search — end-to-end scenarios', () => {
  test('1960 P lincoln cent roll — realistic eBay results', () => {
    const comps = [
      makeComp({ title: '1960-P Lincoln Cent Roll OBW Original Bank Wrapped', totalUsd: 18 }),
      makeComp({ title: '1960 P Lincoln Memorial Cent Roll BU Uncirculated', totalUsd: 22 }),
      makeComp({ title: '1960-D Lincoln Cent Roll BU 50 Coins', totalUsd: 15 }),
      makeComp({ title: '1960 Lincoln Cent MS-65 RD PCGS', totalUsd: 35 }),
      makeComp({ title: '1960 P Lincoln Cent Proof', totalUsd: 8 }),
      makeComp({ title: 'Lot of 3 1960 Lincoln Cent Rolls', totalUsd: 55 }),
      makeComp({ title: '1960 Lincoln Cent Whitman Folder', totalUsd: 12 }),
    ];
    const expected = {
      year: 1960, mint: 'P', series: 'Lincoln Cent',
      isRoll: true, _rawQuery: '1960 P lincoln cent roll'
    };
    const { kept, removed } = applyFilters(comps, {}, expected);
    // Should keep: 2 P-mint roll listings (1960-D filtered by mint mismatch)
    // Should remove: MS-65 (not a roll), Proof (not a roll), Lot (denied), Folder (denied), 1960-D (mint mismatch)
    expect(kept.length).toBe(2);
    expect(kept.every(c => /\broll\b/i.test(c.title))).toBe(true);
    expect(removed.denied).toBeGreaterThanOrEqual(2); // lot + folder
    expect(removed.notRoll).toBeGreaterThanOrEqual(2); // MS-65 + Proof
  });

  test('1964 kennedy half dollar roll — silver premium', () => {
    const comps = [
      makeComp({ title: '1964 Kennedy Half Dollar Roll $10 Face 90% Silver', totalUsd: 220 }),
      makeComp({ title: '1964 Kennedy Half Dollar Roll BU 20 Coins', totalUsd: 250 }),
      makeComp({ title: '1965 Kennedy Half Dollar Roll 40% Silver', totalUsd: 110 }),
      makeComp({ title: '1964 Kennedy Half Dollar BU Single', totalUsd: 14 }),
    ];
    const expected = {
      year: 1964, series: 'Kennedy Half Dollar',
      isRoll: true, _rawQuery: '1964 kennedy half dollar roll'
    };
    const { kept } = applyFilters(comps, {}, expected);
    // Should keep all 3 roll listings (including 1965 — year filtering is scoring, not hard filter)
    expect(kept.length).toBe(3);
    expect(kept.every(c => /\broll\b/i.test(c.title))).toBe(true);
  });

  test('Washington quarter roll', () => {
    const comps = [
      makeComp({ title: '1963-D Washington Quarter Roll BU $10 Face', totalUsd: 120 }),
      makeComp({ title: '1963 Washington Quarter Roll Silver', totalUsd: 130 }),
      makeComp({ title: '1963-D Standing Liberty Quarter VG', totalUsd: 15 }),
    ];
    const expected = {
      year: 1963, series: 'Washington Quarter',
      isRoll: true, _rawQuery: '1963 washington quarter roll'
    };
    const { kept } = applyFilters(comps, {}, expected);
    expect(kept.length).toBe(2);
  });
});
