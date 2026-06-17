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
});
