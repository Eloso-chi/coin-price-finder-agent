'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  acquireSidecarLock,
  applyCosmosRepairs,
  applySidecarRepairs,
  buildRepairPlan,
  cosmosDocId,
} = require('../scripts/repair-terapeak-dormancy');
const { _mergeMetaSidecarSnapshot } = require('../src/services/terapeakService');

const RUN_ID = 'test-run';

function event(coin, pass, overrides = {}) {
  return {
    run_id: RUN_ID,
    coin,
    pass,
    ts: `2026-08-0${pass}T00:00:00Z`,
    status: 'empty',
    dormant: false,
    ...overrides,
  };
}

describe('repair-terapeak-dormancy', () => {
  test('repairs proven dormant reset and preserves newer noDataAt', () => {
    const rows = [
      event('2017 Libertad Silver Tenth', 1),
      event('2017 Libertad Silver Tenth', 2, { dormant: true }),
      event('2017 Libertad Silver Tenth', 3),
    ];
    const meta = {
      '2017 libertad silver tenth': {
        noDataCount: 1,
        noDataAt: '2026-08-04T00:00:00Z',
      },
    };

    expect(buildRepairPlan(rows, meta, RUN_ID)).toEqual([
      expect.objectContaining({
        key: '2017 libertad silver tenth',
        action: 'repair',
        noDataCount: 2,
        noDataAt: '2026-08-04T00:00:00Z',
        evidencePass: 2,
      }),
    ]);
  });

  test('does not repair when a later direct search succeeded', () => {
    const rows = [
      event('Recovered Coin', 1, { dormant: true }),
      event('Recovered Coin', 2, { run_id: 'later-run', status: 'ok', dormant: false }),
    ];
    expect(buildRepairPlan(rows, { 'coin recovered': {} }, RUN_ID)).toEqual([]);
  });

  test('does not repair when current metadata has a later direct refresh', () => {
    const rows = [event('Recovered Coin', 1, { dormant: true })];
    const plan = buildRepairPlan(rows, {
      'coin recovered': { page1At: '2026-08-02T00:00:00Z' },
    }, RUN_ID);

    expect(plan).toEqual([
      expect.objectContaining({ action: 'skip', reason: 'metadata has a later direct refresh' }),
    ]);
  });

  test('reports already dormant and missing metadata without changing them', () => {
    const rows = [
      event('Already Dormant', 1, { dormant: true }),
      event('Missing Entry', 1, { dormant: true }),
    ];
    const plan = buildRepairPlan(rows, {
      'already dormant': { noDataCount: 2, noDataAt: '2026-08-01T00:00:00Z' },
    }, RUN_ID);

    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'already dormant', action: 'skip' }),
      expect.objectContaining({ key: 'entry missing', action: 'blocked' }),
    ]));
  });

  test('writes only repair entries to the sidecar', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormancy-repair-'));
    const metaPath = path.join(tempDir, 'meta.json');
    const meta = { target: { compCount: 4 }, untouched: { noDataCount: 1 } };
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    applySidecarRepairs([{
      key: 'target',
      noDataCount: 2,
      noDataAt: '2026-08-07T00:00:00Z',
    }], metaPath);

    const written = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(written.target).toEqual({
      compCount: 4,
      noDataCount: 2,
      noDataAt: '2026-08-07T00:00:00Z',
    });
    expect(written.untouched).toEqual({ noDataCount: 1 });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects a sidecar changed after planning and enforces its exclusive lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormancy-repair-'));
    const metaPath = path.join(tempDir, 'meta.json');
    const original = JSON.stringify({ target: {} });
    const expectedHash = crypto.createHash('sha256').update(original).digest('hex');
    fs.writeFileSync(metaPath, original);

    const release = acquireSidecarLock(metaPath);
    expect(() => acquireSidecarLock(metaPath)).toThrow('Sidecar is locked');
    release();

    fs.writeFileSync(metaPath, JSON.stringify({ target: {}, concurrent: {} }));
    expect(() => applySidecarRepairs([{
      key: 'target',
      noDataCount: 2,
      noDataAt: '2026-08-07T00:00:00Z',
    }], metaPath, expectedHash)).toThrow('Sidecar changed after repair planning');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('live sidecar saves preserve repaired dormancy unless a newer direct refresh clears it', () => {
    const disk = {
      preserved: { noDataCount: 2, noDataAt: '2026-08-07T00:00:00Z', compCount: 4 },
      recovered: { noDataCount: 2, noDataAt: '2026-08-07T00:00:00Z' },
    };
    const generated = {
      preserved: { noDataCount: 0, compCount: 5 },
      recovered: { page1At: '2026-08-08T00:00:00Z', noDataCount: 0 },
    };

    const merged = _mergeMetaSidecarSnapshot(generated, disk);

    expect(merged.preserved).toEqual(expect.objectContaining({
      noDataCount: 2,
      noDataAt: '2026-08-07T00:00:00Z',
      compCount: 5,
    }));
    expect(merged.recovered).toEqual(expect.objectContaining({
      page1At: '2026-08-08T00:00:00Z',
      noDataCount: 0,
      noDataAt: null,
    }));
  });

  test('patches only dormancy fields with an ETag precondition', async () => {
    const document = {
      id: cosmosDocId('target key'),
      searchTerm: 'target key',
      comps: [{ itemId: 'kept' }],
      aggregationMeta: { compCount: 1, noDataAt: '2026-08-08T00:00:00Z' },
      _etag: 'etag-1',
    };
    const patch = jest.fn(async () => ({}));
    const read = jest.fn(async () => ({ resource: document }));
    const item = jest.fn(() => ({ read, patch }));
    const cosmos = {
      isEnabled: jest.fn(() => true),
      container: jest.fn(() => ({ item })),
    };

    const result = await applyCosmosRepairs([{
      key: 'target key',
      noDataCount: 2,
      noDataAt: '2026-08-07T00:00:00Z',
      evidenceAt: '2026-08-07T00:00:00Z',
    }], cosmos);

    expect(item).toHaveBeenCalledWith(cosmosDocId('target key'), 'target key');
    expect(patch).toHaveBeenCalledWith([
      { op: 'set', path: '/aggregationMeta/noDataCount', value: 2 },
      { op: 'set', path: '/aggregationMeta/noDataAt', value: '2026-08-08T00:00:00Z' },
    ], { accessCondition: { type: 'IfMatch', condition: 'etag-1' } });
    expect(result).toEqual({
      reconciled: [expect.objectContaining({ key: 'target key' })],
      errors: [],
    });
  });

  test('reports patch conflicts while retaining successful repairs for sidecar reconciliation', async () => {
    const documents = {
      first: { aggregationMeta: {}, _etag: 'etag-1' },
      second: { aggregationMeta: {}, _etag: 'etag-2' },
    };
    const items = {
      first: {
        read: jest.fn(async () => ({ resource: documents.first })),
        patch: jest.fn(async () => ({})),
      },
      second: {
        read: jest.fn(async () => ({ resource: documents.second })),
        patch: jest.fn(async () => { throw Object.assign(new Error('conflict'), { code: 412 }); }),
      },
    };
    const cosmos = {
      isEnabled: jest.fn(() => true),
      container: jest.fn(() => ({ item: key => items[key] })),
    };
    const repairs = ['first', 'second'].map(key => ({
      key,
      noDataCount: 2,
      noDataAt: '2026-08-07T00:00:00Z',
      evidenceAt: '2026-08-07T00:00:00Z',
    }));

    const result = await applyCosmosRepairs(repairs, cosmos);

    expect(result.reconciled).toEqual([expect.objectContaining({ key: 'first' })]);
    expect(result.errors).toEqual([expect.objectContaining({ key: 'second' })]);
  });

  test('skips Cosmos recovery newer than evidence even when sidecar noDataAt is later', async () => {
    const patch = jest.fn();
    const cosmos = {
      isEnabled: jest.fn(() => true),
      container: jest.fn(() => ({
        item: () => ({
          read: async () => ({ resource: {
            _etag: 'etag-1',
            aggregationMeta: { page1At: '2026-08-08T00:00:00Z' },
          } }),
          patch,
        }),
      })),
    };

    const result = await applyCosmosRepairs([{
      key: 'recovered',
      noDataCount: 2,
      evidenceAt: '2026-08-07T00:00:00Z',
      noDataAt: '2026-08-09T00:00:00Z',
    }], cosmos);

    expect(result).toEqual({ reconciled: [], errors: [] });
    expect(patch).not.toHaveBeenCalled();
  });

  test('preserves a higher Cosmos dormancy count during sidecar reconciliation', async () => {
    const cosmos = {
      isEnabled: jest.fn(() => true),
      container: jest.fn(() => ({
        item: () => ({
          read: async () => ({ resource: {
            _etag: 'etag-1',
            aggregationMeta: { noDataCount: 5, noDataAt: '2026-08-08T00:00:00Z' },
          } }),
          patch: jest.fn(),
        }),
      })),
    };

    const result = await applyCosmosRepairs([{
      key: 'already-dormant',
      noDataCount: 2,
      evidenceAt: '2026-08-07T00:00:00Z',
      noDataAt: '2026-08-07T00:00:00Z',
    }], cosmos);

    expect(result.reconciled).toEqual([
      expect.objectContaining({ key: 'already-dormant', noDataCount: 5 }),
    ]);
  });
});
