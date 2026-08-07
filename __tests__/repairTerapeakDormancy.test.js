'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyCosmosRepairs,
  applySidecarRepairs,
  buildRepairPlan,
  cosmosDocId,
} = require('../scripts/repair-terapeak-dormancy');

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
      event('Recovered Coin', 2, { status: 'ok', dormant: false }),
    ];
    expect(buildRepairPlan(rows, { 'coin recovered': {} }, RUN_ID)).toEqual([]);
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

    applySidecarRepairs(meta, [{
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

  test('reads and replaces the existing Cosmos document without dropping comps', async () => {
    const document = {
      id: cosmosDocId('target key'),
      searchTerm: 'target key',
      comps: [{ itemId: 'kept' }],
      aggregationMeta: { compCount: 1, noDataAt: '2026-08-08T00:00:00Z' },
    };
    const replace = jest.fn(async () => ({}));
    const read = jest.fn(async () => ({ resource: document }));
    const item = jest.fn(() => ({ read, replace }));
    const cosmos = {
      isEnabled: jest.fn(() => true),
      container: jest.fn(() => ({ item })),
    };

    await applyCosmosRepairs([{
      key: 'target key',
      noDataCount: 2,
      noDataAt: '2026-08-07T00:00:00Z',
    }], cosmos);

    expect(item).toHaveBeenCalledWith(cosmosDocId('target key'), 'target key');
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({
      comps: [{ itemId: 'kept' }],
      aggregationMeta: expect.objectContaining({
        compCount: 1,
        noDataCount: 2,
        noDataAt: '2026-08-08T00:00:00Z',
      }),
    }));
  });
});
