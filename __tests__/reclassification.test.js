// __tests__/reclassification.test.js — Tests for comp reclassification feature
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectWeightFromTitle, weightToKeyToken } = require('../src/utils/coinMetalProfile');

// ── detectWeightFromTitle ───────────────────────────────────

describe('detectWeightFromTitle', () => {
  test('detects 1 oz from "1 oz"', () => {
    expect(detectWeightFromTitle('2024 Gold Libertad 1 oz BU')).toBe(1);
  });

  test('detects 1/4 oz fraction', () => {
    expect(detectWeightFromTitle('2024 Mexico 1/4 oz Gold Libertad')).toBe(0.25);
  });

  test('detects 1/2 oz fraction', () => {
    expect(detectWeightFromTitle('2024 Mexico 1/2 oz Gold Libertad')).toBe(0.5);
  });

  test('detects 1/10 oz fraction', () => {
    expect(detectWeightFromTitle('2024 1/10 oz Gold Libertad BU')).toBe(0.1);
  });

  test('detects 1/20 oz fraction', () => {
    expect(detectWeightFromTitle('2024 Mexico 1/20 oz Gold Libertad')).toBe(0.05);
  });

  test('detects "quarter oz" word form', () => {
    expect(detectWeightFromTitle('Gold Eagle Quarter Ounce 2024')).toBe(0.25);
  });

  test('detects "half oz" word form', () => {
    expect(detectWeightFromTitle('2024 Half oz Gold Maple Leaf')).toBe(0.5);
  });

  test('detects gram-based weight', () => {
    const w = detectWeightFromTitle('1 gram Gold Bar PAMP Suisse');
    expect(w).toBeCloseTo(1 / 31.1035, 4);
  });

  test('detects kilo', () => {
    expect(detectWeightFromTitle('1 Kilo Silver Bar .999')).toBe(32.1507);
  });

  test('returns null for undetectable weight', () => {
    expect(detectWeightFromTitle('2024 Morgan Silver Dollar MS65')).toBeNull();
  });

  test('returns null for null/empty input', () => {
    expect(detectWeightFromTitle(null)).toBeNull();
    expect(detectWeightFromTitle('')).toBeNull();
  });
});

// ── weightToKeyToken ────────────────────────────────────────

describe('weightToKeyToken', () => {
  test('maps fractional weights to word tokens', () => {
    expect(weightToKeyToken(0.05)).toBe('twentieth oz');
    expect(weightToKeyToken(0.1)).toBe('tenth oz');
    expect(weightToKeyToken(0.25)).toBe('quarter oz');
    expect(weightToKeyToken(0.5)).toBe('half oz');
  });

  test('maps integer weights to Noz tokens', () => {
    expect(weightToKeyToken(1)).toBe('1oz');
    expect(weightToKeyToken(5)).toBe('5oz');
    expect(weightToKeyToken(10)).toBe('10oz');
  });

  test('returns null for unmappable weights', () => {
    expect(weightToKeyToken(null)).toBeNull();
    expect(weightToKeyToken(0.75)).toBeNull();
  });
});

// ── Import-time reclassification ────────────────────────────

describe('importComps reclassification', () => {
  const terapeakService = require('../src/services/terapeakService');

  beforeEach(() => {
    terapeakService._resetStoreCache();
  });
  // Cancel any pending debounced writes after all tests complete
  afterAll(() => {
    terapeakService._cancelPendingSaves();
    terapeakService._resetStoreCache();
  });

  test('reclassifies comp with wrong weight to correct dataset', () => {
    // Import a 1/4 oz comp into a 1oz dataset
    const comps = [
      { title: '2024 Mexico 1/4 oz Gold Libertad BU', totalUsd: 600, soldDate: '2024-06-01', itemId: 'test-reclass-1' },
      { title: '2024 Mexico 1 oz Gold Libertad BU', totalUsd: 2500, soldDate: '2024-06-02', itemId: 'test-reclass-2' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);

    // The 1oz comp should stay, the 1/4 oz should be reclassified
    expect(result.newComps).toBe(1);
    expect(result.reclassified).toBe(1);

    // Check the reclassified comp landed in the correct dataset
    const quarterDs = terapeakService.lookupComps('2024 Mexican Gold Libertad quarter oz');
    expect(quarterDs).not.toBeNull();
    expect(quarterDs.comps.length).toBe(1);
    expect(quarterDs.comps[0].itemId).toBe('test-reclass-1');
    expect(quarterDs.comps[0]._productIdentity).toEqual(expect.objectContaining({
      series: 'Gold Libertad',
      year: '2024',
      metal: 'gold',
      nominalWeightOz: 0.25,
      pool: 'raw',
      parserVersion: '2.0.0',
    }));
  });

  test('does not reclassify when weight matches', () => {
    const comps = [
      { title: '2024 Mexico 1 oz Gold Libertad BU', totalUsd: 2500, soldDate: '2024-06-01', itemId: 'test-match-1' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);
    expect(result.newComps).toBe(1);
    expect(result.reclassified).toBe(0);
  });

  test.each(['quarter oz', 'tenth oz', 'twentieth oz'])(
    'live import keeps matching %s rows and reroutes 1oz rows', (weightPhrase) => {
      const fractionalTitle = `2025 American Silver Eagle ${weightPhrase} BU`;
      const result = terapeakService.importComps(fractionalTitle, [
        { title: fractionalTitle, totalUsd: 100, soldDate: '2026-08-01', itemId: `keep-${weightPhrase}` },
        { title: '2025 American Silver Eagle 1 oz BU', totalUsd: 200, soldDate: '2026-08-02', itemId: `move-${weightPhrase}` },
      ]);

      expect(result).toEqual(expect.objectContaining({ newComps: 1, reclassified: 1 }));
      expect(terapeakService.lookupComps(fractionalTitle).comps.map(row => row.itemId))
        .toContain(`keep-${weightPhrase}`);
      expect(terapeakService.lookupComps('2025 American Silver Eagle 1oz').comps.map(row => row.itemId))
        .toContain(`move-${weightPhrase}`);
    }
  );

  test.each(['quarter oz', 'tenth oz', 'twentieth oz'])(
    'live import reroutes %s rows out of a 1oz dataset', (weightPhrase) => {
      const result = terapeakService.importComps('2025 American Silver Eagle 1oz', [
        {
          title: `2025 American Silver Eagle ${weightPhrase} BU`,
          totalUsd: 100,
          soldDate: '2026-08-03',
          itemId: `fractional-${weightPhrase}`,
        },
      ]);

      expect(result).toEqual(expect.objectContaining({ newComps: 0, reclassified: 1 }));
      expect(terapeakService.lookupComps(`2025 American Silver Eagle ${weightPhrase}`).comps.map(row => row.itemId))
        .toContain(`fractional-${weightPhrase}`);
    }
  );

  test.each([
    '2024 2025 American Silver Eagle 1oz',
    '2025-S 2025-W American Silver Eagle 1oz',
    '2025 gold silver Eagle 1oz',
    '2025 American Silver Eagle PR69 MS70 1oz',
  ])('excludes all rows when the dataset identity is ambiguous: %s', (datasetKey) => {
    const result = terapeakService.importComps(datasetKey, [
      { title: '2025 American Silver Eagle 1 oz BU', totalUsd: 50, soldDate: '2026-08-01' },
    ]);

    expect(result).toEqual(expect.objectContaining({
      newComps: 0,
      totalStored: 0,
      ambiguousExcluded: 1,
      identityExcluded: 0,
    }));
  });

  test('does not reclassify when weight is undetectable', () => {
    const comps = [
      { title: '2024 Mexico Gold Libertad BU Sealed', totalUsd: 2500, soldDate: '2024-06-01', itemId: 'test-noweight-1' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);
    expect(result.newComps).toBe(1);
    expect(result.reclassified).toBe(0);
  });

  test('excludes metal-mismatched comps from the dataset', () => {
    const comps = [
      { title: '2024 Mexico 1/4 oz Silver Libertad', totalUsd: 30, soldDate: '2024-06-01', itemId: 'test-metal-1' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);
    expect(result.newComps).toBe(0);
    expect(result.reclassified).toBe(0);
    expect(result.identityExcluded).toBe(1);
  });

  test('excludes wrong-year comps instead of treating them as valid', () => {
    const comps = [
      { title: '2023 Mexico 1 oz Gold Libertad BU', totalUsd: 2500, soldDate: '2024-06-01', itemId: 'test-year-1' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);
    expect(result.newComps).toBe(0);
    expect(result.reclassified).toBe(0);
    expect(result.identityExcluded).toBe(1);
  });

  test('checks identity conflicts for datasets without weight evidence', () => {
    const comps = [
      { title: '2023 Morgan Dollar MS65', totalUsd: 100, soldDate: '2024-06-01', itemId: 'test-weightless-year-1' },
    ];

    const result = terapeakService.importComps('2024 Morgan Dollar', comps);
    expect(result.newComps).toBe(0);
    expect(result.identityExcluded).toBe(1);
  });

  test('preserves raw, graded, proof, and reverse-proof rows in a generic dataset', () => {
    const comps = [
      { title: '2025 American Silver Eagle 1 oz BU', totalUsd: 40, soldDate: '2026-01-01', itemId: 'generic-raw' },
      { title: '2025 American Silver Eagle 1 oz PCGS MS70', totalUsd: 80, soldDate: '2026-01-02', itemId: 'generic-graded' },
      { title: '2025 American Silver Eagle 1 oz NGC PF70', totalUsd: 90, soldDate: '2026-01-03', itemId: 'generic-proof' },
      { title: '2025 American Silver Eagle 1 oz Reverse Proof PR70', totalUsd: 120, soldDate: '2026-01-04', itemId: 'generic-reverse-proof' },
    ];

    const result = terapeakService.importComps('2025 American Silver Eagle 1oz', comps);
    const stored = terapeakService.lookupComps('2025 American Silver Eagle 1oz');

    expect(result).toEqual(expect.objectContaining({ newComps: 4, identityExcluded: 0 }));
    expect(stored.comps.map(comp => comp._productIdentity.pool).sort())
      .toEqual(['graded', 'proof', 'raw', 'reverse-proof']);
  });

  test('excludes ambiguous multi-product rows instead of rerouting by first weight', () => {
    const comps = [
      { title: '2024 Mexico 1/20 oz Proof and 1/10 oz UNC Libertad', totalUsd: 500, soldDate: '2024-06-01', itemId: 'test-ambiguous-1' },
      { title: '2024 Mexico 1 oz Gold Libertad BU', totalUsd: 2500, soldDate: '2024-06-02', itemId: 'test-unambiguous-1' },
    ];

    const result = terapeakService.importComps('2024 Mexican Gold Libertad 1oz', comps);

    expect(result).toEqual(expect.objectContaining({
      newComps: 1,
      reclassified: 0,
      ambiguousExcluded: 1,
    }));
    expect(terapeakService.lookupComps('2024 Mexican Gold Libertad twentieth oz')).toBeNull();
    expect(terapeakService.lookupComps('2024 Mexican Gold Libertad tenth oz')).toBeNull();
  });
});

describe('Terapeak store writer lock', () => {
  const terapeakService = require('../src/services/terapeakService');

  test.each(['write', 'fsync'])('removes its owned lock when %s initialization fails', (failure) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-writer-lock-'));
    const lockPath = path.join(tempDir, 'store.json.reclassify.lock');
    const spy = jest.spyOn(fs, failure === 'write' ? 'writeFileSync' : 'fsyncSync')
      .mockImplementation(() => { throw new Error(`${failure} failed`); });

    try {
      expect(() => terapeakService.acquireStoreWriteLock(lockPath)).toThrow(`${failure} failed`);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      spy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('removes a writer lock owned by a dead process', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-stale-lock-'));
    const lockPath = path.join(tempDir, 'store.json.reclassify.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ state: 'writer-active', pid: 2147483647 }));

    try {
      expect(terapeakService.clearStaleWriterLock(lockPath)).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each([
    { state: 'writer-active', pid: process.pid },
    { state: 'migration-active', pid: 2147483647 },
    { state: 'restart-required', pid: 2147483647 },
  ])('retains non-stale-writer lock $state', (lock) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terapeak-retained-lock-'));
    const lockPath = path.join(tempDir, 'store.json.reclassify.lock');
    fs.writeFileSync(lockPath, JSON.stringify(lock));

    try {
      expect(terapeakService.clearStaleWriterLock(lockPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
