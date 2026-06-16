// __tests__/parallelKeyDriftScanner.test.js
// Wave 2 / Batch G of the QA test plan -- regression detector for the
// #267H failure class ("lookupComps returns empty parallel-key dataset
// over populated one") AT SCALE. The scanner walks the full meta store
// and asserts the runtime invariant:
//
//   For every dataset with compCount > 0, lookupComps(searchTerm) must
//   return a populated result. Otherwise we have silent data drift --
//   the dataset exists but the runtime can't find it.
//
// This test exercises the scanner's classifier + aggregator against
// SYNTHETIC fixture stores so the scanner itself can't regress silently.
// The real-data scan is invoked via `npm run scan:parallel-key-drift`.

'use strict';

const {
  classifyLookup,
  runScan,
} = require('../scripts/scan-parallel-key-drift');

// ── Test doubles ─────────────────────────────────────────────────────
// A stub lookupComps that returns a configurable response per searchTerm.
// Mirrors the shape of terapeakService.lookupComps.
function makeLookupStub(responses) {
  return function lookupComps(searchTerm) {
    if (!(searchTerm in responses)) return null;
    const r = responses[searchTerm];
    if (r instanceof Error) throw r;
    return r; // null, or { key, comps: [...], searchTerm }
  };
}

// ═════════════════════════════════════════════════════════════════════
//  classifyLookup -- pure classifier
// ═════════════════════════════════════════════════════════════════════
describe('classifyLookup -- per-dataset drift classifier', () => {
  test('returns "ok" when lookupComps returns the same key with comps', () => {
    const lookup = makeLookupStub({
      '1997 American Gold Eagle 1oz': {
        key: '1997 american gold eagle 1oz',
        searchTerm: '1997 American Gold Eagle 1oz',
        comps: [{ price: 1800 }, { price: 1850 }],
      },
    });
    const result = classifyLookup({
      searchTerm: '1997 American Gold Eagle 1oz',
      expectedKey: '1997 american gold eagle 1oz',
      expectedCompCount: 2,
    }, lookup);
    expect(result.status).toBe('ok');
    expect(result.actualKey).toBe('1997 american gold eagle 1oz');
    expect(result.actualCompCount).toBe(2);
  });

  test('returns "drift-empty" when lookupComps returns null (#267H class)', () => {
    const lookup = makeLookupStub({
      '2010 Perth Lunar Tiger Silver Half Oz': null,
    });
    const result = classifyLookup({
      searchTerm: '2010 Perth Lunar Tiger Silver Half Oz',
      expectedKey: '2010 perth lunar tiger silver half oz',
      expectedCompCount: 12,
    }, lookup);
    expect(result.status).toBe('drift-empty');
    expect(result.actualKey).toBeNull();
    expect(result.actualCompCount).toBe(0);
  });

  test('returns "drift-empty" when lookupComps returns an empty stub', () => {
    const lookup = makeLookupStub({
      '2010 Perth Lunar Tiger Silver Half Oz': {
        key: 'perth lunar 2010 tiger silver half oz', // parallel-key stub
        searchTerm: '2010 Perth Lunar Tiger Silver Half Oz',
        comps: [], // empty -- the #267H regression class
      },
    });
    const result = classifyLookup({
      searchTerm: '2010 Perth Lunar Tiger Silver Half Oz',
      expectedKey: '2010 perth lunar tiger silver half oz',
      expectedCompCount: 12,
    }, lookup);
    expect(result.status).toBe('drift-empty');
    expect(result.actualCompCount).toBe(0);
  });

  test('returns "drift-different" when lookupComps returns a DIFFERENT populated key', () => {
    const lookup = makeLookupStub({
      '1996 South Africa 1oz Gold Krugerrand': {
        key: '1996 gold krugerrand 1oz', // alias-map sibling, fully populated
        searchTerm: '1996 Gold Krugerrand 1oz',
        comps: [{ price: 1900 }, { price: 1920 }, { price: 1910 }],
      },
    });
    const result = classifyLookup({
      searchTerm: '1996 South Africa 1oz Gold Krugerrand',
      expectedKey: '1996 south africa 1oz gold krugerrand',
      expectedCompCount: 5,
    }, lookup);
    expect(result.status).toBe('drift-different');
    expect(result.actualKey).toBe('1996 gold krugerrand 1oz');
    expect(result.actualCompCount).toBe(3);
  });

  test('returns "skip" when expected searchTerm is missing/empty', () => {
    const lookup = makeLookupStub({});
    const result = classifyLookup({
      searchTerm: '',
      expectedKey: 'orphan key',
      expectedCompCount: 7,
    }, lookup);
    expect(result.status).toBe('skip');
  });

  test('returns "skip" when expectedCompCount is 0 (empty entries are not the invariant we are testing)', () => {
    const lookup = makeLookupStub({});
    const result = classifyLookup({
      searchTerm: 'some empty dataset',
      expectedKey: 'some empty dataset',
      expectedCompCount: 0,
    }, lookup);
    expect(result.status).toBe('skip');
  });

  test('treats lookupComps throw as drift-empty (failure mode, not crash)', () => {
    const lookup = makeLookupStub({
      'crashing query': new Error('boom'),
    });
    const result = classifyLookup({
      searchTerm: 'crashing query',
      expectedKey: 'crashing query',
      expectedCompCount: 5,
    }, lookup);
    expect(result.status).toBe('drift-empty');
    expect(result.error).toMatch(/boom/);
  });
});

// ═════════════════════════════════════════════════════════════════════
//  runScan -- aggregator over an entire store snapshot
// ═════════════════════════════════════════════════════════════════════
describe('runScan -- whole-store invariant scan', () => {
  test('healthy store with all matches yields 0 drifts', () => {
    const store = {
      '1997 american gold eagle 1oz': {
        searchTerm: '1997 American Gold Eagle 1oz',
        comps: [{ price: 1800 }],
      },
      '2024 american silver eagle': {
        searchTerm: '2024 American Silver Eagle',
        comps: [{ price: 50 }, { price: 52 }],
      },
    };
    const lookup = makeLookupStub({
      '1997 American Gold Eagle 1oz': {
        key: '1997 american gold eagle 1oz',
        searchTerm: '1997 American Gold Eagle 1oz',
        comps: [{ price: 1800 }],
      },
      '2024 American Silver Eagle': {
        key: '2024 american silver eagle',
        searchTerm: '2024 American Silver Eagle',
        comps: [{ price: 50 }, { price: 52 }],
      },
    });

    const report = runScan({ store, lookupComps: lookup });
    expect(report.datasetsScanned).toBe(2);
    expect(report.byStatus.ok).toBe(2);
    expect(report.byStatus['drift-empty']).toBe(0);
    expect(report.byStatus['drift-different']).toBe(0);
    expect(report.byStatus.skip).toBe(0);
    expect(report.drifts).toHaveLength(0);
  });

  test('mixed store reports the #267H class as drift-empty', () => {
    const store = {
      // Populated dataset that should resolve to itself
      '1997 american gold eagle 1oz': {
        searchTerm: '1997 American Gold Eagle 1oz',
        comps: [{ price: 1800 }],
      },
      // Populated dataset whose lookupComps returns an empty stub (#267H)
      '2010 perth lunar tiger silver half oz': {
        searchTerm: '2010 Perth Lunar Tiger Silver Half Oz',
        comps: [{ price: 80 }, { price: 85 }, { price: 90 }],
      },
      // Empty dataset -- correctly skipped (not part of the invariant)
      'some empty stub': {
        searchTerm: 'Some Empty Stub',
        comps: [],
      },
    };
    const lookup = makeLookupStub({
      '1997 American Gold Eagle 1oz': {
        key: '1997 american gold eagle 1oz',
        searchTerm: '1997 American Gold Eagle 1oz',
        comps: [{ price: 1800 }],
      },
      '2010 Perth Lunar Tiger Silver Half Oz': null, // <-- the bug
      // 'Some Empty Stub' would be skipped before lookup
    });

    const report = runScan({ store, lookupComps: lookup });
    expect(report.datasetsScanned).toBe(3);
    expect(report.byStatus.ok).toBe(1);
    expect(report.byStatus['drift-empty']).toBe(1);
    expect(report.byStatus.skip).toBe(1);
    expect(report.drifts).toHaveLength(1);
    expect(report.drifts[0]).toMatchObject({
      status: 'drift-empty',
      expectedKey: '2010 perth lunar tiger silver half oz',
      expectedCompCount: 3,
    });
  });

  test('store with populated alias-map siblings reports drift-different', () => {
    const store = {
      '1996 south africa 1oz gold krugerrand': {
        searchTerm: '1996 South Africa 1oz Gold Krugerrand',
        comps: [{ price: 1900 }, { price: 1920 }],
      },
      '1996 gold krugerrand 1oz': {
        searchTerm: '1996 Gold Krugerrand 1oz',
        comps: [{ price: 1905 }, { price: 1915 }, { price: 1910 }],
      },
    };
    const lookup = makeLookupStub({
      '1996 South Africa 1oz Gold Krugerrand': {
        key: '1996 gold krugerrand 1oz', // fuzzy match wins on shorter key
        searchTerm: '1996 Gold Krugerrand 1oz',
        comps: [{ price: 1905 }, { price: 1915 }, { price: 1910 }],
      },
      '1996 Gold Krugerrand 1oz': {
        key: '1996 gold krugerrand 1oz',
        searchTerm: '1996 Gold Krugerrand 1oz',
        comps: [{ price: 1905 }, { price: 1915 }, { price: 1910 }],
      },
    });

    const report = runScan({ store, lookupComps: lookup });
    expect(report.datasetsScanned).toBe(2);
    expect(report.byStatus['drift-different']).toBe(1);
    expect(report.byStatus.ok).toBe(1);
    expect(report.drifts).toHaveLength(1);
    expect(report.drifts[0].status).toBe('drift-different');
  });

  test('report includes generatedAt, scannedAt timing, and totals', () => {
    const store = {
      'a': { searchTerm: 'A', comps: [{ price: 1 }] },
    };
    const lookup = makeLookupStub({
      'A': { key: 'a', searchTerm: 'A', comps: [{ price: 1 }] },
    });
    const report = runScan({ store, lookupComps: lookup });
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(report.totalDatasets).toBe(1);
    expect(report.populatedDatasets).toBe(1);
    expect(report.emptyDatasets).toBe(0);
  });

  test('drifts array preserves enough context for triage (key, expected vs actual)', () => {
    const store = {
      'broken key': {
        searchTerm: 'Broken Key Query',
        comps: [{ price: 1 }, { price: 2 }],
      },
    };
    const lookup = makeLookupStub({
      'Broken Key Query': null,
    });
    const report = runScan({ store, lookupComps: lookup });
    expect(report.drifts[0]).toMatchObject({
      status: 'drift-empty',
      expectedKey: 'broken key',
      expectedCompCount: 2,
      searchTerm: 'Broken Key Query',
      actualKey: null,
      actualCompCount: 0,
    });
  });

  test('empty store produces a well-formed zero report', () => {
    const report = runScan({ store: {}, lookupComps: makeLookupStub({}) });
    expect(report.totalDatasets).toBe(0);
    expect(report.populatedDatasets).toBe(0);
    expect(report.datasetsScanned).toBe(0);
    expect(report.drifts).toHaveLength(0);
    expect(report.byStatus).toMatchObject({
      ok: 0,
      'drift-empty': 0,
      'drift-different': 0,
      skip: 0,
    });
  });
});
