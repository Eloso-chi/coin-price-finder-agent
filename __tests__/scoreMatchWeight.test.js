/**
 * scoreMatchWeight.test.js
 *
 * Tests for the weight-match path inside scoreMatch (#266W).
 *
 * Context: PR #33 (`fix/weight-mismatch-30g-tolerance`) replaced the comp-filter
 * weight check from a 0.01 oz absolute tolerance to a 5% relative tolerance so
 * 2016+ Chinese Silver Pandas (30g actual = 0.9646 oz vs 1.0 oz nominal = 3.5%
 * off) pass.  The scorer path still used the 0.01 oz check, scoring correct
 * comps as weight-mismatch (-35) instead of weight-match (+25) -- a 60-point
 * swing that could demote them out of the top-K window.  #266W ports the same
 * 5% relative tolerance into scoreMatch.
 *
 *   npm test -- __tests__/scoreMatchWeight.test.js
 */

'use strict';

const { scoreMatch } = require('../src/services/ebayService');

// Note: expected.weight is in troy oz throughout the codebase; detectWeightFromTitle
// also returns troy oz (gram weights are converted via /31.1035).  A "30g" title
// detects as 30/31.1035 = 0.9646 oz, which is ~3.54% off the 1 oz nominal -- the
// exact gap PR #33 / #266W targets.
describe('scoreMatch -- weight tolerance (#266W)', () => {

  test('2016+ Chinese Silver Panda (30g actual, 1 oz nominal) -> weight-match', () => {
    const comp = { title: '2024 China Silver Panda 30g BU', price: 35 };
    scoreMatch(comp, { weight: 1, year: 2024 });
    expect(comp.matchNotes).toContain('weight-match');
    expect(comp.matchNotes).not.toContain('weight-mismatch');
  });

  test('exact 1 oz title vs 1 oz expected -> weight-match', () => {
    const comp = { title: '2024 American Silver Eagle 1 oz BU', price: 35 };
    scoreMatch(comp, { weight: 1, year: 2024 });
    expect(comp.matchNotes).toContain('weight-match');
  });

  test('1/4 oz title in a 1 oz search (75% gap) -> weight-mismatch', () => {
    const comp = { title: '2024 American Silver Eagle 1/4 oz BU', price: 12 };
    scoreMatch(comp, { weight: 1, year: 2024 });
    expect(comp.matchNotes).toContain('weight-mismatch');
    expect(comp.matchNotes).not.toContain('weight-match');
  });

  test('no weight in title -> weight-not-stated penalty', () => {
    const comp = { title: '2024 American Silver Eagle BU', price: 35 };
    scoreMatch(comp, { weight: 1, year: 2024 });
    expect(comp.matchNotes).toContain('weight-not-stated');
  });

  test('no expected.weight -> no weight note added', () => {
    const comp = { title: '1964 Kennedy Half Dollar BU', price: 10 };
    scoreMatch(comp, { year: 1964 });
    expect(comp.matchNotes).not.toContain('weight-match');
    expect(comp.matchNotes).not.toContain('weight-mismatch');
    expect(comp.matchNotes).not.toContain('weight-not-stated');
  });

  // ── Edge cases requested in PR #143 review ──

  test('boundary: exactly 5% gap (0.95 oz vs 1.0 oz) -> weight-mismatch (strict <)', () => {
    // 0.95 oz vs 1.0 oz expected: ratio = 0.05 / 1.0 = 0.05, NOT strictly < 0.05.
    // Confirms the threshold is exclusive on the upper bound.
    const comp = { title: '2024 Some Bullion 0.95 oz', price: 30 };
    scoreMatch(comp, { weight: 1, year: 2024 });
    expect(comp.matchNotes).toContain('weight-mismatch');
    expect(comp.matchNotes).not.toContain('weight-match');
  });

  test('1/20 oz Gold Maple Leaf (exact 0.05 vs 0.05 expected) -> weight-match', () => {
    // Smallest common fractional bullion size. Confirms the relative-ratio
    // formula stays numerically stable at the low end of the weight range.
    // (Note: #261W tracks a separate root cause -- missing 1/20 oz entry in
    // data/greysheetTypeMap.js -- not addressed by the scorer fix.)
    const comp = { title: '2023 Canada 1/20 oz Gold Maple Leaf BU', price: 200 };
    scoreMatch(comp, { weight: 0.05, year: 2023 });
    expect(comp.matchNotes).toContain('weight-match');
    expect(comp.matchNotes).not.toContain('weight-mismatch');
  });

  test('just inside tolerance (0.96 oz vs 1.0 oz = 4% gap) -> weight-match', () => {
    // Sanity check: the acceptance zone is symmetric around the Panda's 3.54%.
    const comp = { title: '2024 Some Bullion 0.96 oz', price: 30 };
    scoreMatch(comp, { weight: 1, year: 2024 });
    expect(comp.matchNotes).toContain('weight-match');
    expect(comp.matchNotes).not.toContain('weight-mismatch');
  });

  test('defensive: expected.weight = 0 -> no NaN, no weight notes, no throw', () => {
    // expected.weight = 0 is falsy, so the outer `if (expected.weight)` guard at
    // line 686 of ebayService.js prevents the weight-tolerance block from
    // running. This test asserts that behavior remains stable and that no
    // weight notes are added (no division-by-zero, no NaN propagation).
    const comp = { title: '2024 American Silver Eagle 1 oz BU', price: 35 };
    expect(() => scoreMatch(comp, { weight: 0, year: 2024 })).not.toThrow();
    expect(comp.matchNotes).not.toContain('weight-match');
    expect(comp.matchNotes).not.toContain('weight-mismatch');
    expect(comp.matchNotes).not.toContain('weight-not-stated');
    expect(comp.matchScore).not.toBeNaN();
  });
});
