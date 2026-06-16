// __tests__/auctionDedupCollision.test.js -- dedup key collision semantics
// for src/services/auctionPriceService.js#dedupeRecords (test-exposed as
// `_dedupeRecords`).
//
// Contract under test:
//   The key is LotNo|Auctioneer|Date|Price. Records with the same key are
//   treated as duplicates; the FIRST occurrence wins (existing > incoming).
//
//   Boundaries:
//     - empty existing + empty incoming -> []
//     - empty existing + N incoming -> N (all new)
//     - same record present in both -> dedup'd to 1
//     - records differing only in non-key fields BUT sharing the key -> dedup'd
//       (this is a contract test that documents the collision behavior)
//     - records with undefined LotNo / Auctioneer / Date / Price still produce
//       a deterministic key (string interpolation)
//
// We mock the heavy dependencies that auctionPriceService loads at require time
// (axios, fs file I/O for manifest, env vars).
'use strict';

jest.mock('axios');
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

  test('records sharing the key but differing in non-key fields are dedup\'d', () => {
    const existing = [rec('L1', 'Heritage', '2026-01-01', 100, { grade: 'MS65' })];
    const incoming = [rec('L1', 'Heritage', '2026-01-01', 100, { grade: 'MS66', note: 'late update' })];
    const { merged, added } = _dedupeRecords(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(added).toBe(0);
    // EXISTING wins -- the incoming record is dropped, even though its
    // non-key fields differ. This documents the contract: callers must
    // not rely on dedupeRecords to merge differing payloads under the
    // same key.
    expect(merged[0].grade).toBe('MS65');
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
