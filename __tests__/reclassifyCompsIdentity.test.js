'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  analyzeStore,
  classifyComp,
  canonicalizeStore,
  sourceFingerprint,
  assertSourceUnchanged,
  assertDistinctPaths,
  main,
} = require('../scripts/reclassify-comps');
const { normalizeSearchKey } = require('../src/services/terapeakService');

function comp(itemId, title) {
  return { itemId, title, totalUsd: 100, soldDate: '2026-08-01' };
}

function fixture() {
  return {
    '2025 american silver eagle 1oz': {
      searchTerm: '2025 American Silver Eagle 1oz',
      comps: [
        comp('valid', '2025 American Silver Eagle 1 oz BU'),
        comp('wrong', '2025 American Silver Eagle 5 oz BU'),
        comp('ambiguous', '2025 American Silver Eagle 1 oz with 5 oz bonus'),
        comp('unknown', '2025 American Silver Eagle BU sealed'),
      ],
      aggregationMeta: { compCount: 4 },
    },
  };
}

describe('canonical comp reclassification migration', () => {
  test.each([
    ['2025 American Silver Eagle 1 oz BU', 'valid'],
    ['2025 American Silver Eagle 5 oz BU', 'wrong_dataset'],
    ['2025 American Silver Eagle 1 oz with 5 oz bonus', 'ambiguous'],
    ['2025 American Silver Eagle BU sealed', 'unknown'],
    ['2024 American Silver Eagle 1 oz BU', 'wrong_dataset'],
    ['2025 American Silver Eagle 1 oz PCGS MS70', 'valid'],
    ['2025 American Silver Eagle 1 oz NGC PR70', 'valid'],
    ['2025 American Silver Eagle 1 oz Reverse Proof PR70', 'valid'],
  ])('classifies %s as %s', (title, status) => {
    expect(classifyComp('2025 american silver eagle 1oz', comp('x', title)).status).toBe(status);
  });

  test('does not reroute a non-weight identity mismatch', () => {
    const result = classifyComp(
      '2025 american silver eagle 1oz',
      comp('wrong-year', '2024 American Silver Eagle 5 oz BU')
    );

    expect(result).toEqual(expect.objectContaining({
      status: 'wrong_dataset',
      mismatches: expect.arrayContaining(['year', 'weight']),
      targetKey: null,
    }));
  });

  test('accepts equivalent 30 g evidence for a nominal 1 oz Panda dataset', () => {
    const result = classifyComp('2025 silver panda 1oz', comp('panda', '2025 Silver Panda 30 g BU'));

    expect(result.status).toBe('valid');
  });

  test.each([
    ['quarter oz', 0.25],
    ['tenth oz', 0.1],
    ['twentieth oz', 0.05],
  ])('keeps valid %s rows in a sorted canonical dataset key', (weightPhrase) => {
    const datasetKey = normalizeSearchKey(`2025 American Silver Eagle ${weightPhrase}`);
    const result = classifyComp(datasetKey, comp('fractional', `2025 American Silver Eagle ${weightPhrase} BU`));

    expect(result.status).toBe('valid');
  });

  test.each([
    ['quarter oz', 0.25],
    ['tenth oz', 0.1],
    ['twentieth oz', 0.05],
  ])('reroutes bidirectionally between %s and 1oz canonical keys', (weightPhrase) => {
    const fractionalKey = normalizeSearchKey(`2025 American Silver Eagle ${weightPhrase}`);
    const oneOzKey = normalizeSearchKey('2025 American Silver Eagle 1oz');

    expect(classifyComp(fractionalKey, comp('to-one', '2025 American Silver Eagle 1 oz BU')).targetKey)
      .toBe(oneOzKey);
    expect(classifyComp(oneOzKey, comp('to-fractional', `2025 American Silver Eagle ${weightPhrase} BU`)).targetKey)
      .toBe(fractionalKey);
  });

  test.each([
    '2024 2025 American Silver Eagle 1oz',
    '2025-S 2025-W American Silver Eagle 1oz',
    '2025 gold silver Eagle 1oz',
    '2025 American Silver Eagle PR69 MS70 1oz',
  ])('quarantines comps when dataset identity is ambiguous: %s', (datasetKey) => {
    expect(classifyComp(datasetKey, comp('x', '2025 American Silver Eagle 1 oz BU')).status)
      .toBe('ambiguous');
  });

  test('produces deterministic before/after manifests and rollback rows', () => {
    const result = analyzeStore(fixture());

    expect(result.manifest).toEqual(expect.objectContaining({
      parserVersion: '1.0.0',
      before: { datasets: 1, comps: 4 },
      after: { datasets: 2, comps: 3 },
      counts: { valid: 1, wrong_dataset: 1, ambiguous: 1, unknown: 1 },
      identityUpdated: 2,
      changed: 4,
      storeChanged: true,
    }));
    expect(result.rollback.rows).toHaveLength(2);
    expect(result.store[normalizeSearchKey('2025 american silver eagle 1oz')].comps.map(row => row.itemId))
      .toEqual(['valid', 'unknown']);
    expect(result.store[normalizeSearchKey('2025 american silver eagle 5oz')].comps.map(row => row.itemId))
      .toEqual(['wrong']);
  });

  test('is idempotent after the projected migration is applied', () => {
    const first = analyzeStore(fixture());
    const second = analyzeStore(first.store);

    expect(second.manifest.changed).toBe(0);
    expect(second.manifest.before).toEqual(second.manifest.after);
    expect(second.rollback.rows).toEqual([]);
  });

  test('deduplicates rerouted rows without item IDs using title, price, and sold date', () => {
    const duplicate = { title: '2025 American Silver Eagle 5 oz BU', totalUsd: 100, soldDate: '2026-08-01' };
    const result = analyzeStore({
      '2025 american silver eagle 1oz': { comps: [duplicate], aggregationMeta: {} },
      '2025 american silver eagle 5oz': { comps: [duplicate], aggregationMeta: {} },
    });

    const targetKey = normalizeSearchKey('2025 american silver eagle 5oz');
    expect(result.store[targetKey].comps).toHaveLength(1);
  });

  test('preserves distinct no-ID sales that differ by less than one dollar', () => {
    const base = { title: '2025 American Silver Eagle 5 oz BU', soldDate: '2026-08-01' };
    const result = analyzeStore({
      '2025 american silver eagle 1oz': {
        comps: [{ ...base, totalUsd: 100.10 }, { ...base, totalUsd: 100.40 }],
        aggregationMeta: {},
      },
    });

    const targetKey = normalizeSearchKey('2025 american silver eagle 5oz');
    expect(result.store[targetKey].comps.map(row => row.totalUsd))
      .toEqual([100.10, 100.40]);
  });

  test('merges reroutes into one canonical destination key', () => {
    const result = analyzeStore({
      '2025 Mexican Silver Libertad 1oz': {
        comps: [comp('reroute', '2025 Mexican Silver Libertad 5 oz BU')],
        aggregationMeta: {},
      },
      '2025 5oz libertad mexican silver': {
        comps: [comp('existing', '2025 Mexican Silver Libertad 5 oz BU')],
        aggregationMeta: {},
      },
    });
    const targetKey = normalizeSearchKey('2025 Mexican Silver Libertad 5oz');

    expect(Object.keys(result.store).filter(key => key.includes('libertad') && key.includes('5oz')))
      .toEqual([targetKey]);
    expect(result.store[targetKey].comps.map(row => row.itemId).sort())
      .toEqual(['existing', 'reroute']);
  });

  test('preserves collision metadata deterministically in either insertion order', () => {
    const entries = [
      ['2025 Mexican Silver Libertad 5oz', {
        searchTerm: 'legacy-a',
        comps: [
          comp('a', '2025 Mexican Silver Libertad 5 oz BU'),
          { ...comp('duplicate', 'Duplicate payload'), sourceMarker: 'a-side' },
        ],
        lastImport: '2026-08-01T00:00:00.000Z',
        importCount: 2,
        identifiers: { pcgs: '123', identifier_confidence: 'High' },
        fileName: 'older.csv',
        fileSize: 100,
        customLegacyField: 'preserved',
        aggregationMeta: {
          page1At: '2026-08-01T00:00:00.000Z',
          refreshCount: 2,
          lastRefreshNewComps: 2,
          customMetaA: 'preserved-a',
        },
      }],
      ['2025 5oz libertad mexican silver', {
        searchTerm: 'legacy-b',
        comps: [
          comp('b', '2025 Mexican Silver Libertad 5 oz Proof'),
          { ...comp('duplicate', 'Duplicate payload'), sourceMarker: 'b-side' },
        ],
        lastImport: '2026-08-01T00:00:00.000Z',
        importCount: 3,
        identifiers: { pcgs: '999', identifier_confidence: 'High' },
        fileName: 'newer.csv',
        fileSize: 200,
        autoImported: true,
        lastImportFileSize: 200,
        aggregationMeta: {
          deepAt: '2026-08-02T00:00:00.000Z',
          refreshCount: 4,
          lastRefreshNewComps: 4,
          customMetaB: 'preserved-b',
        },
      }],
      ['libertad silver mexican 2025 5oz', {
        searchTerm: 'legacy-c',
        comps: [comp('c', '2025 Mexican Silver Libertad 5 oz Satin')],
        lastImport: '2026-08-01T00:00:00.000Z',
        importCount: 1,
        identifiers: { pcgs: '555', identifier_confidence: 'High' },
        fileName: 'third.csv',
        fileSize: 150,
        aggregationMeta: { refreshCount: 3, lastRefreshNewComps: 3, customMetaC: 'preserved-c' },
      }],
    ];
    const targetKey = normalizeSearchKey('2025 Mexican Silver Libertad 5oz');
    const permutations = [
      [entries[0], entries[1], entries[2]],
      [entries[0], entries[2], entries[1]],
      [entries[1], entries[0], entries[2]],
      [entries[1], entries[2], entries[0]],
      [entries[2], entries[0], entries[1]],
      [entries[2], entries[1], entries[0]],
    ];
    const mergedStores = permutations.map(items => canonicalizeStore(Object.fromEntries(items))[targetKey]);
    const forward = mergedStores[0];

    expect(mergedStores).toEqual(Array(6).fill(forward));
    expect(forward).toEqual(expect.objectContaining({
      searchTerm: targetKey,
      lastImport: '2026-08-01T00:00:00.000Z',
      importCount: 6,
      identifiers: { pcgs: '555', identifier_confidence: 'High' },
      fileName: 'third.csv',
      fileSize: 150,
      autoImported: true,
      lastImportFileSize: 200,
      customLegacyField: 'preserved',
    }));
    expect(forward.comps.map(row => row.itemId)).toEqual(['a', 'b', 'c', 'duplicate']);
    expect(forward.comps.find(row => row.itemId === 'duplicate').sourceMarker).toBe('b-side');
    expect(forward.aggregationMeta).toEqual(expect.objectContaining({
      page1At: '2026-08-01T00:00:00.000Z',
      deepAt: '2026-08-02T00:00:00.000Z',
      refreshCount: 4,
      compCount: 4,
      lastRefreshNewComps: 3,
      customMetaA: 'preserved-a',
      customMetaB: 'preserved-b',
      customMetaC: 'preserved-c',
    }));
  });

  test('detects source changes before replacement', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reclassify-source-'));
    const storePath = path.join(tempDir, 'store.json');
    fs.writeFileSync(storePath, JSON.stringify(fixture()));
    const fingerprint = sourceFingerprint(storePath);
    fs.appendFileSync(storePath, ' ');

    try {
      expect(() => assertSourceUnchanged(storePath, fingerprint))
        .toThrow('Source store changed during reclassification; apply aborted');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('apply writes identity-only changes with the complete persisted schema', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reclassify-schema-'));
    const storePath = path.join(tempDir, 'store.json');
    const outputDir = path.join(tempDir, 'output');
    const store = {
      '2025 American Silver Eagle 1oz': {
        comps: [comp('valid-only', '2025 American Silver Eagle 1 oz PCGS MS70')],
        aggregationMeta: { compCount: 1 },
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const first = main(['--apply', '--store', storePath, '--output-dir', outputDir]);
      const written = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const identity = Object.values(written)[0].comps[0]._productIdentity;

      expect(first.manifest).toEqual(expect.objectContaining({
        identityUpdated: 1,
        storeChanged: true,
      }));
      expect(identity).toEqual(expect.objectContaining({
        grade: 'MS70',
        pool: 'graded',
        poolConstrained: true,
        parserVersion: '1.0.0',
      }));
      const lockPath = `${storePath}.reclassify.lock`;
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual(expect.objectContaining({
        state: 'restart-required',
      }));
      fs.rmSync(lockPath);
      const second = main(['--apply', '--store', storePath, '--output-dir', outputDir]);
      expect(second.manifest.storeChanged).toBe(false);
      expect(second.manifest.identityUpdated).toBe(0);
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('does not remove a migration lock owned by another process', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reclassify-lock-'));
    const storePath = path.join(tempDir, 'store.json');
    const outputDir = path.join(tempDir, 'output');
    const lockPath = `${storePath}.reclassify.lock`;
    fs.writeFileSync(storePath, JSON.stringify(fixture()));
    fs.writeFileSync(lockPath, JSON.stringify({ state: 'migration-active', pid: 999 }));

    try {
      expect(() => main(['--apply', '--store', storePath, '--output-dir', outputDir]))
        .toThrow(expect.objectContaining({ code: 'EEXIST' }));
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual({ state: 'migration-active', pid: 999 });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects collisions between the source store and artifact paths', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reclassify-collision-'));
    const storePath = path.join(tempDir, 'identity-reclassification-manifest.json');
    fs.writeFileSync(storePath, JSON.stringify(fixture()));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      expect(() => main(['--store', storePath, '--output-dir', tempDir]))
        .toThrow('Store and reclassification artifact paths must be distinct');
      expect(JSON.parse(fs.readFileSync(storePath, 'utf8'))).toEqual(fixture());
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rejects filesystem aliases between the source store and artifacts', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reclassify-alias-'));
    const storePath = path.join(tempDir, 'store.json');
    const outputDir = path.join(tempDir, 'output');
    const manifestPath = path.join(outputDir, 'identity-reclassification-manifest.json');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(storePath, JSON.stringify(fixture()));
    fs.linkSync(storePath, manifestPath);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      expect(() => main(['--store', storePath, '--output-dir', outputDir]))
        .toThrow('Store and reclassification artifact paths must be distinct');
      expect(JSON.parse(fs.readFileSync(storePath, 'utf8'))).toEqual(fixture());
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('does not treat unavailable zero inode values as filesystem aliases', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reclassify-zero-inode-'));
    const storePath = path.join(tempDir, 'store.json');
    const paths = {
      manifestPath: path.join(tempDir, 'manifest.json'),
      rollbackPath: path.join(tempDir, 'rollback.json'),
      transactionPath: path.join(tempDir, 'transaction.json'),
    };
    for (const filePath of [storePath, ...Object.values(paths)]) fs.writeFileSync(filePath, '{}');
    const originalStatSync = fs.statSync.bind(fs);
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(filePath => ({
      ...originalStatSync(filePath),
      dev: 0,
      ino: 0,
    }));

    try {
      expect(() => assertDistinctPaths(storePath, paths)).not.toThrow();
    } finally {
      statSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('syncs the parent when creating a new artifact directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reclassify-dir-sync-'));
    const storePath = path.join(tempDir, 'store.json');
    const outputDir = path.join(tempDir, 'new-output');
    fs.writeFileSync(storePath, JSON.stringify(fixture()));
    const openSpy = jest.spyOn(fs, 'openSync');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      main(['--store', storePath, '--output-dir', outputDir]);

      expect(openSpy).toHaveBeenCalledWith(tempDir, 'r');
      expect(fs.existsSync(outputDir)).toBe(true);
    } finally {
      openSpy.mockRestore();
      logSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('apply mode atomically writes a valid transformed temporary store', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reclassify-'));
    const storePath = path.join(tempDir, 'store.json');
    const outputDir = path.join(tempDir, 'output');
    fs.writeFileSync(storePath, JSON.stringify(fixture()));
    fs.chmodSync(storePath, 0o660);
    const originalMode = fs.statSync(storePath).mode & 0o777;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = main(['--apply', '--store', storePath, '--output-dir', outputDir]);
      const written = JSON.parse(fs.readFileSync(storePath, 'utf8'));

      expect(written).toEqual(result.store);
      expect(fs.readdirSync(tempDir).filter(file => file.endsWith('.tmp'))).toEqual([]);
      expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'identity-reclassification-manifest.json'), 'utf8')))
        .toEqual(result.manifest);
      expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'identity-reclassification-rollback.json'), 'utf8')))
        .toEqual(expect.objectContaining({ sourceStore: storePath, rows: expect.any(Array) }));
      expect(fs.existsSync(path.join(outputDir, 'identity-reclassification-transaction.json'))).toBe(false);
      expect(fs.statSync(storePath).mode & 0o777).toBe(originalMode);
      expect(fs.readdirSync(outputDir).filter(file => file.endsWith('.tmp'))).toEqual([]);
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});