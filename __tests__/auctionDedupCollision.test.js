// __tests__/auctionDedupCollision.test.js -- dedup key collision semantics
// for src/services/auctionPriceService.js#dedupeRecords (test-exposed as
// `_dedupeRecords`).
//
// Contract under test:
//   The key is LotNo|Auctioneer|Date|Price. Records with the same key are
//   field-merged (#274H option 3): non-null/non-undefined fields from the
//   incoming record overwrite the existing values; null/undefined incoming
//   fields do NOT clobber existing non-null values. This preserves the
//   richest payload across multiple scrapes and lets corrected metadata
//   (e.g., a re-published Heritage grade MS65 -> MS66) propagate while
//   protecting against thin/partial re-scrapes overwriting full payloads.
//
//   Boundaries:
//     - empty existing + empty incoming -> []
//     - empty existing + N incoming -> N (all new)
//     - same record present in both -> dedup'd to 1, no merge effect
//     - records differing only in non-key fields BUT sharing the key ->
//       merged: incoming non-null fields win, null/undefined fields preserved
//     - records with undefined LotNo / Auctioneer / Date / Price still produce
//       a deterministic key (string interpolation)
//     - caller's `existing` array elements are NOT mutated in place
//
// We mock the heavy dependencies that auctionPriceService loads at require time
// (axios, fs file I/O for manifest, env vars).
'use strict';

jest.mock('axios');
// WARNING: fs is mocked GLOBALLY for this file. auctionPriceService reads its
// per-PCGS-number JSON manifest at first call via fs.readFileSync. dedupeRecords
// itself is pure (no I/O), so this mock is only here to keep module load quiet.
// If you add a test that imports anything else that reads real files at module
// load time, you will get '{}' for every read -- narrow this mock or split the
// file before doing so.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(() => false),
    mkdirSync: jest.fn(),
    readFileSync: jest.fn(() => '{}'),
    writeFileSync: jest.fn(),
  };
});

process.env.PCGS_API_KEY = 'test-apr-key';

const { _dedupeRecords } = require('../src/services/auctionPriceService');

function rec(LotNo, Auctioneer, Date, Price, extra = {}) {
  return { LotNo, Auctioneer, Date, Price, ...extra };
}

describe('_dedupeRecords -- empty inputs', () => {
  test('empty existing + empty incoming -> empty merged, 0 added', () => {
    const { merged, added } = _dedupeRecords([], []);
    expect(merged).toEqual([]);
    expect(added).toBe(0);
  });

  test('empty existing + N incoming -> all added', () => {
    const incoming = [
      rec('L1', 'Heritage', '2026-01-01', 100),
      rec('L2', 'Heritage', '2026-01-02', 200),
      rec('L3', 'Stacks', '2026-01-03', 300),
    ];
    const { merged, added } = _dedupeRecords([], incoming);
    expect(added).toBe(3);
    expect(merged).toHaveLength(3);
  });

  test('N existing + empty incoming -> existing preserved, 0 added', () => {
    const existing = [rec('L1', 'A', '2026-01-01', 50)];
    const { merged, added } = _dedupeRecords(existing, []);
    expect(merged).toEqual(existing);
    expect(added).toBe(0);
  });
});

describe('_dedupeRecords -- collision behavior', () => {
  test('identical records in both lists collapse to 1', () => {
    const r = rec('L1', 'Heritage', '2026-01-01', 100);
    const { merged, added } = _dedupeRecords([r], [r]);
    expect(merged).toHaveLength(1);
    expect(added).toBe(0);
  });

  test('records sharing the key but differing in non-key fields field-merge (#274H option 3)', () => {
    // Concrete example: Heritage re-publishes the same lot with a corrected
    // grade (MS65 -> MS66) and an additional note. The corrected fields must
    // win; the existing record's added fields stay; counts as 0 added (key
    // already present).
    const existing = [rec('L1', 'Heritage', '2026-01-01', 100, {
      grade: 'MS65',
      holder: 'PCGS',
    })];
    const incoming = [rec('L1', 'Heritage', '2026-01-01', 100, {
      grade: 'MS66',
      note: 'late update',
    })];
    const { merged, added } = _dedupeRecords(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(added).toBe(0);
    // Incoming non-null fields win
    expect(merged[0].grade).toBe('MS66');
    // Existing fields not touched by incoming stay
    expect(merged[0].holder).toBe('PCGS');
    // New incoming fields are added
    expect(merged[0].note).toBe('late update');
  });

  test('field-merge: null/undefined incoming fields do NOT clobber existing non-null', () => {
    // Defends against thin re-scrapes: an incoming record that is missing
    // `grade` or has it set to null must NOT erase the existing grade.
    const existing = [rec('L1', 'Heritage', '2026-01-01', 100, {
      grade: 'MS66',
      holder: 'PCGS',
      note: 'original',
    })];
    const incoming = [rec('L1', 'Heritage', '2026-01-01', 100, {
      grade: null,         // null -> do NOT clobber
      holder: undefined,   // undefined -> do NOT clobber
      note: 'updated',     // truthy -> wins
    })];
    const { merged, added } = _dedupeRecords(existing, incoming);
    expect(added).toBe(0);
    expect(merged[0].grade).toBe('MS66');
    expect(merged[0].holder).toBe('PCGS');
    expect(merged[0].note).toBe('updated');
  });

  test('field-merge: falsy-but-defined incoming values (0, "", false) DO win', () => {
    // Edge case: a zero, empty string, or false IS a valid value -- only
    // null/undefined should be treated as "absent" for merge purposes.
    const existing = [rec('L1', 'Heritage', '2026-01-01', 100, {
      premium: 1.25,
      flagged: true,
      note: 'note',
    })];
    const incoming = [rec('L1', 'Heritage', '2026-01-01', 100, {
      premium: 0,
      flagged: false,
      note: '',
    })];
    const { merged } = _dedupeRecords(existing, incoming);
    expect(merged[0].premium).toBe(0);
    expect(merged[0].flagged).toBe(false);
    expect(merged[0].note).toBe('');
  });

  test('field-merge: caller-supplied `existing` array elements are NOT mutated in place', () => {
    // The function must shallow-clone existing records before merging, so
    // callers holding a separate reference to the input array see no change.
    const originalExisting = rec('L1', 'Heritage', '2026-01-01', 100, { grade: 'MS65' });
    const existing = [originalExisting];
    const incoming = [rec('L1', 'Heritage', '2026-01-01', 100, { grade: 'MS66' })];
    _dedupeRecords(existing, incoming);
    // Caller's original record is unchanged
    expect(originalExisting.grade).toBe('MS65');
    expect(existing[0]).toBe(originalExisting);
  });

  test('field-merge applies to intra-incoming key collisions as well', () => {
    // Two incoming records with the same key: the second field-merges into
    // the first. Added stays at 1 (one new key introduced).
    const incoming = [
      rec('L1', 'Heritage', '2026-01-01', 100, { grade: 'MS65', note: 'first' }),
      rec('L1', 'Heritage', '2026-01-01', 100, { grade: 'MS66' }),
    ];
    const { merged, added } = _dedupeRecords([], incoming);
    expect(merged).toHaveLength(1);
    expect(added).toBe(1);
    expect(merged[0].grade).toBe('MS66');
    expect(merged[0].note).toBe('first');
  });

  test('different Price under same LotNo+Auctioneer+Date is treated as a different record', () => {
    const existing = [rec('L1', 'Heritage', '2026-01-01', 100)];
    const incoming = [rec('L1', 'Heritage', '2026-01-01', 150)];
    const { merged, added } = _dedupeRecords(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
  });

  test('different Auctioneer under same LotNo+Date+Price is treated as a different record', () => {
    const existing = [rec('L1', 'Heritage', '2026-01-01', 100)];
    const incoming = [rec('L1', 'Stacks', '2026-01-01', 100)];
    const { merged, added } = _dedupeRecords(existing, incoming);
    expect(merged).toHaveLength(2);
    expect(added).toBe(1);
  });

  test('intra-incoming duplicates are also dedup\'d', () => {
    const incoming = [
      rec('L1', 'Heritage', '2026-01-01', 100),
      rec('L1', 'Heritage', '2026-01-01', 100), // duplicate
      rec('L2', 'Heritage', '2026-01-02', 200),
    ];
    const { merged, added } = _dedupeRecords([], incoming);
    expect(added).toBe(2);
    expect(merged).toHaveLength(2);
  });
});

describe('_dedupeRecords -- undefined/null key components (defensive)', () => {
  test('records with all undefined key fields collapse to 1', () => {
    const incoming = [
      rec(undefined, undefined, undefined, undefined),
      rec(undefined, undefined, undefined, undefined),
    ];
    const { merged, added } = _dedupeRecords([], incoming);
    expect(added).toBe(1);
    expect(merged).toHaveLength(1);
  });

  test('null and undefined produce different keys (literally different strings)', () => {
    const r1 = rec(null, 'A', '2026-01-01', 100);
    const r2 = rec(undefined, 'A', '2026-01-01', 100);
    const { merged, added } = _dedupeRecords([], [r1, r2]);
    // `${null}` !== `${undefined}` -- documenting actual JS behavior.
    expect(added).toBe(2);
    expect(merged).toHaveLength(2);
  });

  test('records with mixed defined/undefined fields key off the defined ones', () => {
    const r1 = rec('L1', undefined, '2026-01-01', 100);
    const r2 = rec('L1', undefined, '2026-01-01', 100);
    const r3 = rec('L1', 'Heritage', '2026-01-01', 100);
    const { merged, added } = _dedupeRecords([], [r1, r2, r3]);
    expect(added).toBe(2); // r2 dedup'd vs r1; r3 is distinct
    expect(merged).toHaveLength(2);
  });
});

describe('_dedupeRecords -- order preservation', () => {
  test('existing records appear FIRST in merged, incoming new records appended', () => {
    const existing = [rec('E1', 'A', '2026-01-01', 1), rec('E2', 'A', '2026-01-02', 2)];
    const incoming = [rec('I1', 'A', '2026-01-03', 3)];
    const { merged } = _dedupeRecords(existing, incoming);
    expect(merged[0].LotNo).toBe('E1');
    expect(merged[1].LotNo).toBe('E2');
    expect(merged[2].LotNo).toBe('I1');
  });

  test('incoming records preserve their relative order', () => {
    const incoming = [
      rec('I1', 'A', '2026-01-01', 1),
      rec('I2', 'A', '2026-01-02', 2),
      rec('I3', 'A', '2026-01-03', 3),
    ];
    const { merged } = _dedupeRecords([], incoming);
    expect(merged.map(r => r.LotNo)).toEqual(['I1', 'I2', 'I3']);
  });
});
