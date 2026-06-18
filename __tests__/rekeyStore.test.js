/**
 * rekeyStore.test.js -- #266H Phase 2 in-place store migration.
 *
 * Verifies that `_rekeyStoreInPlace()` re-keys legacy un-canonical store
 * entries to the current `normalizeSearchKey()` output and MERGES (not
 * overwrites) when two legacy raw keys collapse to the same canonical
 * key. Last-write-wins on collision would silently drop half of the
 * existing comps on first load after Phase 2 deploys.
 */
'use strict';

const {
  _rekeyStoreInPlace,
  _mergeStoreEntries,
  normalizeSearchKey,
} = require('../src/services/terapeakService');

describe('_rekeyStoreInPlace (#266H Phase 2 migration)', () => {
  test('idempotent: already-canonical store is returned unchanged', () => {
    const k = normalizeSearchKey('2024 American Silver Eagle 1oz');
    const store = {
      [k]: { searchTerm: k, comps: [{ itemId: 'A1', title: 'x', totalUsd: 30 }] },
    };
    const out = _rekeyStoreInPlace(store);
    // Fast path: when no key needs renaming, identity is preserved.
    expect(out).toBe(store);
    expect(Object.keys(out)).toEqual([k]);
  });

  test('renames a single legacy un-sorted key to its canonical form', () => {
    const legacy = '2024 american silver eagle 1oz'; // un-sorted (old form)
    const canonical = normalizeSearchKey(legacy);
    expect(canonical).not.toBe(legacy);

    const store = {
      [legacy]: { searchTerm: 'orig', comps: [{ itemId: 'A1', title: 'x', totalUsd: 30 }] },
    };
    const out = _rekeyStoreInPlace(store);
    expect(out[canonical]).toBeDefined();
    expect(out[legacy]).toBeUndefined();
    expect(out[canonical].comps).toHaveLength(1);
    expect(out[canonical].comps[0].itemId).toBe('A1');
  });

  test('merges comps when two legacy keys collide on the same canonical key', () => {
    // Two real duplicates that collapse via Phase 2 token-sort + alias map.
    const legacyA = '2025 mexico half oz silver libertad';
    const legacyB = '2025 mexican silver libertad half oz';
    const canonical = normalizeSearchKey(legacyA);
    expect(normalizeSearchKey(legacyB)).toBe(canonical);

    const store = {
      [legacyA]: {
        searchTerm: legacyA,
        comps: [
          { itemId: 'X1', title: 'a', totalUsd: 30 },
          { itemId: 'X2', title: 'b', totalUsd: 31 },
          { itemId: 'X3', title: 'c', totalUsd: 32 },
        ],
        aggregationMeta: { compCount: 3, refreshCount: 5, lastRefreshAt: '2026-06-01T00:00:00Z' },
      },
      [legacyB]: {
        searchTerm: legacyB,
        comps: [
          { itemId: 'Y1', title: 'd', totalUsd: 33 },
          { itemId: 'Y2', title: 'e', totalUsd: 34 },
        ],
        aggregationMeta: { compCount: 2, refreshCount: 3, lastRefreshAt: '2026-06-10T00:00:00Z' },
      },
    };
    const out = _rekeyStoreInPlace(store);

    expect(out[canonical]).toBeDefined();
    expect(out[legacyA]).toBeUndefined();
    expect(out[legacyB]).toBeUndefined();
    // All 5 comps merged, none dropped.
    expect(out[canonical].comps).toHaveLength(5);
    expect(out[canonical].comps.map(c => c.itemId).sort()).toEqual(['X1', 'X2', 'X3', 'Y1', 'Y2']);
    // Meta merged via _mergeAggregationMeta: latest timestamps, max counters.
    expect(out[canonical].aggregationMeta.lastRefreshAt).toBe('2026-06-10T00:00:00Z');
    expect(out[canonical].aggregationMeta.refreshCount).toBe(5);
    // compCount refreshed from the deduped union.
    expect(out[canonical].aggregationMeta.compCount).toBe(5);
  });

  test('dedupes comps by itemId on collision (does not double-count)', () => {
    const legacyA = '2025 mexico half oz silver libertad';
    const legacyB = '2025 mexican silver libertad half oz';
    const shared = { itemId: 'DUP', title: 'shared', totalUsd: 30 };
    const store = {
      [legacyA]: { searchTerm: legacyA, comps: [shared, { itemId: 'X1', title: 'a', totalUsd: 30 }] },
      [legacyB]: { searchTerm: legacyB, comps: [shared, { itemId: 'Y1', title: 'b', totalUsd: 31 }] },
    };
    const out = _rekeyStoreInPlace(store);
    const canonical = normalizeSearchKey(legacyA);
    // 3 distinct comps after dedup (shared appears once).
    expect(out[canonical].comps).toHaveLength(3);
    const ids = out[canonical].comps.map(c => c.itemId).sort();
    expect(ids).toEqual(['DUP', 'X1', 'Y1']);
  });

  test('dedupes by title+totalUsd+soldDate when itemId is missing', () => {
    const legacyA = '2025 mexico half oz silver libertad';
    const legacyB = '2025 mexican silver libertad half oz';
    // Same fingerprint, different itemId-less listings: should dedupe.
    const sharedFingerprint = { title: 'identical listing', totalUsd: 30, soldDate: '2026-05-01T00:00:00Z' };
    const store = {
      [legacyA]: { searchTerm: legacyA, comps: [{ ...sharedFingerprint }] },
      [legacyB]: { searchTerm: legacyB, comps: [{ ...sharedFingerprint }] },
    };
    const out = _rekeyStoreInPlace(store);
    const canonical = normalizeSearchKey(legacyA);
    expect(out[canonical].comps).toHaveLength(1);
  });

  test('preserves identifiers when only one side has them', () => {
    const legacyA = '2025 mexico half oz silver libertad';
    const legacyB = '2025 mexican silver libertad half oz';
    const store = {
      [legacyA]: { searchTerm: legacyA, comps: [] },
      [legacyB]: { searchTerm: legacyB, comps: [], identifiers: { pcgs: '12345', ngc: null } },
    };
    const out = _rekeyStoreInPlace(store);
    const canonical = normalizeSearchKey(legacyA);
    expect(out[canonical].identifiers).toEqual({ pcgs: '12345', ngc: null });
  });

  test('drops entries that normalize to an empty string', () => {
    const store = {
      // A pathological key composed only of strippable tokens; normalizes to "".
      '-gold': { searchTerm: '-gold', comps: [] },
    };
    const out = _rekeyStoreInPlace(store);
    expect(Object.keys(out)).toHaveLength(0);
  });

  test('handles null / non-object store gracefully', () => {
    expect(_rekeyStoreInPlace(null)).toEqual({});
    expect(_rekeyStoreInPlace(undefined)).toEqual({});
  });
});

describe('_mergeStoreEntries (#266H Phase 2 helper)', () => {
  test('null inputs short-circuit to the non-null side', () => {
    const entry = { searchTerm: 'k', comps: [{ itemId: 'A', totalUsd: 1 }] };
    expect(_mergeStoreEntries(null, entry)).toBe(entry);
    expect(_mergeStoreEntries(entry, null)).toBe(entry);
  });

  test('importCount is summed across both sides', () => {
    const a = { searchTerm: 'k', comps: [], importCount: 5 };
    const b = { searchTerm: 'k', comps: [], importCount: 3 };
    const out = _mergeStoreEntries(a, b);
    expect(out.importCount).toBe(8);
  });

  test('lastImport picks the latest of the two', () => {
    const a = { searchTerm: 'k', comps: [], lastImport: '2026-05-01T00:00:00Z' };
    const b = { searchTerm: 'k', comps: [], lastImport: '2026-06-01T00:00:00Z' };
    const out = _mergeStoreEntries(a, b);
    expect(out.lastImport).toBe('2026-06-01T00:00:00Z');
  });
});
