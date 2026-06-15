// __tests__/terapeakEmptyDatasetSkip.test.js
// Regression test for backlog #267H -- empty Terapeak datasets must be
// skipped during lookupComps() so a populated parallel-key dataset wins.
//
// The bug: a Terapeak store can accumulate two entries for the same coin
// keyed differently by normalizeSearchKey (e.g. an empty stub
// "perth lunar 2010 tiger silver half oz" coexisting with a populated
// "2010 lunar tiger half oz silver" that holds 21 real sold comps).
// The fuzzy matcher scored both purely on token overlap, so a query
// containing "perth" would prefer the empty stub and collapse to zero
// comps even though the real data was sitting right next to it. That
// caused valuation to fall back to bullion-spot-premium for a 2010 Perth
// Lunar Tiger Silver 1/2 oz query on production Azure.
'use strict';

const {
  importComps,
  lookupComps,
  clearAll,
  _resetStoreCache,
  _cancelPendingSaves,
} = require('../src/services/terapeakService');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
});
afterAll(() => {
  console.log.mockRestore();
  console.warn.mockRestore();
  console.error.mockRestore();
  _cancelPendingSaves && _cancelPendingSaves();
});

beforeEach(() => { _resetStoreCache(); clearAll(); });
afterEach(() => { clearAll(); _resetStoreCache(); });

describe('lookupComps -- empty-dataset skip (#267H)', () => {
  test('skips an empty parallel-key dataset and returns the populated one', () => {
    // Populated dataset (key derived from "2010 Lunar Tiger 1/2 oz Silver")
    const populatedComps = Array.from({ length: 21 }, (_, i) => ({
      itemId: `P${i}`,
      title: `Australia 50 cents Year of the Tiger 1/2 Oz Lunar Series II coin 2010 year ${i}`,
      totalUsd: 50 + i,
      soldDate: '2026-04-01',
    }));
    importComps('2010 Lunar Tiger 1/2 oz Silver', populatedComps);

    // Empty parallel-key stub (e.g. created by an aggregator run that found
    // 0 results under a different phrasing). Same coin, different storage key.
    importComps('Perth Lunar 2010 Tiger Silver 1/2 oz', []);

    // Verbose user query that contains "perth" -- previously matched the
    // empty stub on token overlap and returned zero comps.
    const result = lookupComps('2010 Perth Mint Lunar Tiger Series II in 1/2 oz', {
      metal: 'silver',
      grade: null,
    });

    expect(result).not.toBeNull();
    expect(Array.isArray(result.comps)).toBe(true);
    expect(result.comps.length).toBeGreaterThan(0);
    // Should resolve to the populated dataset, not the empty stub.
    expect(result.comps.length).toBe(21);
  });

  test('empty-only store still returns null (no false-positive match)', () => {
    importComps('Perth Lunar 2010 Tiger Silver 1/2 oz', []);
    const result = lookupComps('2010 Perth Mint Lunar Tiger Series II in 1/2 oz', {
      metal: 'silver',
    });
    expect(result).toBeNull();
  });

  test('exact-match path falls through when the matched dataset is empty', () => {
    // Empty stub keyed exactly the same as what normalizeSearchKey produces
    // for the user's query.  Without the fix, the exact-match branch would
    // short-circuit and return the empty stub.  With the fix it falls
    // through to fuzzy, which finds the populated parallel key.
    importComps('Perth Lunar 2010 Tiger Silver 1/2 oz', []);
    importComps('2010 Lunar Tiger 1/2 oz Silver', [
      { itemId: 'X1', title: '2010 Tiger half oz silver', totalUsd: 55, soldDate: '2026-03-15' },
      { itemId: 'X2', title: '2010 Tiger half oz silver', totalUsd: 60, soldDate: '2026-03-20' },
    ]);

    // Use a query that normalizes to the empty stub's key exactly.
    const result = lookupComps('Perth Lunar 2010 Tiger Silver 1/2 oz', { metal: 'silver' });

    expect(result).not.toBeNull();
    expect(result.comps.length).toBe(2);
  });

  test('populated exact-match path is unchanged (no regression)', () => {
    const comps = [
      { itemId: 'A', title: 'Morgan dollar', totalUsd: 30, soldDate: '2026-01-01' },
      { itemId: 'B', title: 'Morgan dollar', totalUsd: 35, soldDate: '2026-01-02' },
    ];
    importComps('1883-O Morgan Silver Dollar', comps);

    const result = lookupComps('1883-O Morgan Silver Dollar');
    expect(result).not.toBeNull();
    expect(result.comps.length).toBe(2);
  });
});
