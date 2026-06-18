/**
 * loadMetaSidecarCanonicalize.test.js -- deep-review finding #1 regression
 *
 * After #266H Phase 2 shipped, `_rekeyStoreInPlace()` rewrites every in-
 * memory store key to the new canonical form on the first `loadStore()`
 * call. But the on-disk sidecar (data/terapeak-meta.json) still holds
 * the pre-Phase-2 raw keys until the next `saveMetaSidecar()` cycle
 * flushes the canonical form back. The original `loadMetaSidecar()`
 * implementation used the raw key directly to look up `store[key]` --
 * the lookup missed (because the in-memory store was canonicalized) and
 * an empty stub was inserted under the legacy key. Net effect: the
 * in-memory store ended up with BOTH a canonical entry (with comps but
 * stale/missing aggregationMeta) AND a legacy empty stub (with the
 * actual deepAt / page1At / identifiers), which split the meta away
 * from the data until the next debounced save cycle reconciled them.
 *
 * The fix is to canonicalize the raw key on read, mirroring what
 * `saveMetaSidecar` and `hydrateMetaFromCosmos` already do.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('loadMetaSidecar canonicalizes raw keys (deep-review #1)', () => {
  let tmpMeta;
  let originalMetaPath;

  beforeEach(() => {
    // Isolate the sidecar file from the shared per-worker tmp set up by
    // __tests__/setup/meta-path.js -- we need a clean file per test so
    // legacy-keyed contents do not leak across cases.
    originalMetaPath = process.env.META_PATH;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpf-loadmeta-'));
    tmpMeta = path.join(dir, 'terapeak-meta.json');
    process.env.META_PATH = tmpMeta;
    // Reset the module so the new META_PATH is picked up and the in-memory
    // store starts empty.
    jest.resetModules();
    const svc = require('../src/services/terapeakService');
    svc._cancelPendingSaves();
    svc._resetStoreCache();
  });

  afterEach(() => {
    try { require('../src/services/terapeakService')._cancelPendingSaves(); } catch { /* ignore */ }
    if (originalMetaPath !== undefined) {
      process.env.META_PATH = originalMetaPath;
    } else {
      delete process.env.META_PATH;
    }
    jest.resetModules();
  });

  test('legacy raw key on disk is canonicalized on read', () => {
    const svc = require('../src/services/terapeakService');
    const { normalizeSearchKey } = svc;

    // Write a sidecar file with a pre-Phase-2 raw key. After Phase 2 ships,
    // this key would normalize to a different canonical form (token sort +
    // country alias).
    const legacyKey = 'usa silver eagle 1oz';
    const canonical = normalizeSearchKey(legacyKey);
    expect(canonical).not.toBe(legacyKey); // sanity: Phase 2 actually changes it

    const sidecar = {
      [legacyKey]: {
        deepAt: '2026-06-01T00:00:00Z',
        page1At: '2026-06-01T00:00:00Z',
        identifiers: { pcgs: 'TEST-12345' },
      },
    };
    fs.writeFileSync(tmpMeta, JSON.stringify(sidecar));

    const { hydrated } = svc.loadMetaSidecar();
    expect(hydrated).toBe(1);

    // The canonical key MUST be present and own the meta + identifiers.
    const datasets = svc.listDatasets();
    const canonicalEntry = datasets.find(d => d.key === canonical);
    const legacyEntry = datasets.find(d => d.key === legacyKey);

    expect(canonicalEntry).toBeDefined();
    expect(canonicalEntry.aggregationMeta).toBeTruthy();
    expect(canonicalEntry.aggregationMeta.deepAt).toBe('2026-06-01T00:00:00Z');
    expect(canonicalEntry.identifiers).toEqual({ pcgs: 'TEST-12345' });
    // The legacy raw key MUST NOT also be present -- otherwise the meta
    // would be split between the canonical entry and a legacy empty stub.
    expect(legacyEntry).toBeUndefined();
  });

  test('multiple legacy keys collapsing to the same canonical key merge their meta', () => {
    const svc = require('../src/services/terapeakService');
    const { normalizeSearchKey } = svc;

    // Two legacy keys that Phase 2 collapses to the same canonical key.
    const legacyA = '2025 mexico half oz silver libertad';
    const legacyB = '2025 mexican silver libertad half oz';
    const canonical = normalizeSearchKey(legacyA);
    expect(normalizeSearchKey(legacyB)).toBe(canonical);

    const sidecar = {
      [legacyA]: {
        deepAt: '2026-05-01T00:00:00Z',
        page1At: '2026-05-01T00:00:00Z',
        identifiers: { pcgs: 'A' },
      },
      [legacyB]: {
        deepAt: '2026-06-01T00:00:00Z',
        page1At: '2026-06-01T00:00:00Z',
        // identifiers intentionally omitted on this side to verify A's win
      },
    };
    fs.writeFileSync(tmpMeta, JSON.stringify(sidecar));

    svc.loadMetaSidecar();

    const datasets = svc.listDatasets();
    const canonicalEntry = datasets.find(d => d.key === canonical);
    expect(canonicalEntry).toBeDefined();
    // _mergeAggregationMeta uses latest timestamps -- B's deepAt should win.
    expect(canonicalEntry.aggregationMeta.deepAt).toBe('2026-06-01T00:00:00Z');
    // Identifiers from A should survive (first-write-wins on the in-memory side).
    expect(canonicalEntry.identifiers).toEqual({ pcgs: 'A' });
    // Neither legacy key should be present as a separate entry.
    expect(datasets.find(d => d.key === legacyA)).toBeUndefined();
    expect(datasets.find(d => d.key === legacyB)).toBeUndefined();
  });

  test('key that normalizes to empty string is dropped, not inserted as empty', () => {
    const svc = require('../src/services/terapeakService');

    // A pathological key composed only of strippable tokens. Without the
    // fix, this would create an empty-string-keyed entry in the store.
    fs.writeFileSync(tmpMeta, JSON.stringify({
      '-gold': {
        deepAt: '2026-06-01T00:00:00Z',
      },
    }));

    svc.loadMetaSidecar();
    const datasets = svc.listDatasets();
    expect(datasets.find(d => d.key === '')).toBeUndefined();
    expect(datasets.find(d => d.key === '-gold')).toBeUndefined();
  });
});
