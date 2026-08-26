'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { analyzeStore, classifyComp, main } = require('../scripts/reclassify-comps');

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

  test('produces deterministic before/after manifests and rollback rows', () => {
    const result = analyzeStore(fixture());

    expect(result.manifest).toEqual(expect.objectContaining({
      parserVersion: '1.0.0',
      before: { datasets: 1, comps: 4 },
      after: { datasets: 2, comps: 3 },
      counts: { valid: 1, wrong_dataset: 1, ambiguous: 1, unknown: 1 },
      changed: 2,
    }));
    expect(result.rollback.rows).toHaveLength(2);
    expect(result.store['2025 american silver eagle 1oz'].comps.map(row => row.itemId)).toEqual(['valid', 'unknown']);
    expect(result.store['2025 american silver eagle 5oz'].comps.map(row => row.itemId)).toEqual(['wrong']);
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

    expect(result.store['2025 american silver eagle 5oz'].comps).toHaveLength(1);
  });

  test('preserves distinct no-ID sales that differ by less than one dollar', () => {
    const base = { title: '2025 American Silver Eagle 5 oz BU', soldDate: '2026-08-01' };
    const result = analyzeStore({
      '2025 american silver eagle 1oz': {
        comps: [{ ...base, totalUsd: 100.10 }, { ...base, totalUsd: 100.40 }],
        aggregationMeta: {},
      },
    });

    expect(result.store['2025 american silver eagle 5oz'].comps.map(row => row.totalUsd))
      .toEqual([100.10, 100.40]);
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