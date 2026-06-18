// __tests__/identifierPersistence.test.js — Verify identifiers survive import cycles
'use strict';

const fs = require('fs');
const path = require('path');

// Isolate store so tests don't affect production data
const CACHE_DIR = require('../src/utils/cachePath').CACHE_DIR;
const STORE_PATH = path.join(CACHE_DIR, 'terapeak_sold.json');
// #273H: prefer the per-worker tmpdir set by __tests__/setup/meta-path.js so
// direct test writes land in the same file the service code reads.
const META_SIDECAR_PATH = process.env.META_PATH || path.join(__dirname, '../data/terapeak-meta.json');

let originalStore;
let originalMeta;

beforeAll(() => {
  // Snapshot current state
  try { originalStore = fs.readFileSync(STORE_PATH, 'utf8'); } catch { originalStore = null; }
  try { originalMeta = fs.readFileSync(META_SIDECAR_PATH, 'utf8'); } catch { originalMeta = null; }
});

afterAll(() => {
  // Cancel any pending debounced writes BEFORE restoring files.
  // Without this, saveStore()/saveMetaSidecar() timers fire after restore
  // and overwrite production data with test data (root cause of sidecar loss).
  const svc = require('../src/services/terapeakService');
  svc._cancelPendingSaves();
  // Restore original state
  if (originalStore !== null) fs.writeFileSync(STORE_PATH, originalStore);
  if (originalMeta !== null) fs.writeFileSync(META_SIDECAR_PATH, originalMeta);
  // Force store reload on next access
  jest.resetModules();
});

// Fresh require each test to reset in-memory store
function freshService() {
  // Cancel any debounced writes from the previous module instance
  // before resetting, so they don't fire and overwrite our test data.
  try { require('../src/services/terapeakService')._cancelPendingSaves(); } catch {}
  jest.resetModules();
  return require('../src/services/terapeakService');
}

describe('identifier persistence', () => {
  const TEST_KEY = '__test_identifier_persistence__';
  const TEST_IDENTIFIERS = {
    is_low_volume_candidate: true,
    is_bullion: false,
    identifier_reason: 'test: low volume',
    identifier_source: 'test',
    identifier_confidence: 'High',
    total_runs_seen: 5,
    runs_with_insufficient_comps: 4,
    median_comps_count: 3,
    bullion_signal_hits: 0,
    last_updated: '2026-05-13T00:00:00.000Z',
  };

  test('importComps preserves existing identifiers on the store entry', () => {
    const svc = freshService();
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));

    // Seed a store entry with identifiers
    store[TEST_KEY] = {
      searchTerm: TEST_KEY,
      comps: [],
      aggregationMeta: { page1At: '2026-01-01T00:00:00Z' },
      identifiers: TEST_IDENTIFIERS,
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(store));

    // Force reload
    const svc2 = freshService();

    // Import new comps -- should NOT wipe identifiers
    const result = svc2.importComps(TEST_KEY, [
      { title: 'Test Comp 1', totalUsd: 100, soldDate: '2026-05-01' },
    ]);

    expect(result.newComps).toBe(1);

    // Read back and verify identifiers survived
    const after = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    // Allow debounced write time
    const entry = after[TEST_KEY];
    expect(entry).toBeDefined();
    expect(entry.identifiers).toEqual(TEST_IDENTIFIERS);
  });

  test('listDatasets includes identifiers when present', () => {
    const svc = freshService();
    const datasets = svc.listDatasets();
    const testDataset = datasets.find(d => d.key === TEST_KEY);

    if (testDataset) {
      expect(testDataset.identifiers).toEqual(TEST_IDENTIFIERS);
    }
  });

  test('loadMetaSidecar restores identifiers from sidecar file', () => {
    // Write a sidecar entry with identifiers
    const meta = JSON.parse(fs.readFileSync(META_SIDECAR_PATH, 'utf8'));
    const SIDECAR_KEY = '__test_sidecar_restore__';
    meta[SIDECAR_KEY] = {
      page1At: '2026-01-01T00:00:00Z',
      compCount: 10,
      identifiers: TEST_IDENTIFIERS,
    };
    fs.writeFileSync(META_SIDECAR_PATH, JSON.stringify(meta, null, 2));

    // Clear the store entry and reload
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    delete store[SIDECAR_KEY];
    fs.writeFileSync(STORE_PATH, JSON.stringify(store));

    // Fresh service will call loadMetaSidecar at require time
    const svc = freshService();
    svc.loadMetaSidecar();

    // #266H Phase 2: loadMetaSidecar canonicalizes raw keys on read (so
    // legacy on-disk keys do not bypass the in-memory canonical-form
    // migration). Look up by the canonical key, not the raw one.
    const restoredKey = svc.normalizeSearchKey(SIDECAR_KEY);

    // Verify identifiers were restored
    const datasets = svc.listDatasets();
    const restored = datasets.find(d => d.key === restoredKey);
    expect(restored).toBeDefined();
    expect(restored.identifiers).toEqual(TEST_IDENTIFIERS);

    // Cleanup sidecar
    delete meta[SIDECAR_KEY];
    fs.writeFileSync(META_SIDECAR_PATH, JSON.stringify(meta, null, 2));
  });
});
