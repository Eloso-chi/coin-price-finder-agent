// __tests__/metalsHistoryImport.test.js -- #333H: live-reading filter, retention, atomic store and validated backfill import
'use strict';

const fs = require('fs');
const path = require('path');

const mockUpsert = jest.fn(() => Promise.resolve());
let mockCosmosEnabled = false;
let mockCacheDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'metals-import-'));

jest.mock('../src/utils/cachePath', () => ({ get CACHE_DIR() { return mockCacheDir; } }));
jest.mock('../src/utils/cosmosClient', () => ({
  isEnabled: () => mockCosmosEnabled,
  container: () => ({ items: { upsert: mockUpsert } }),
}));

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().substring(0, 10);

async function expectImportError(promise, pattern) {
  let error;
  try { await promise; } catch (err) { error = err; }
  expect(error && error.name).toBe('ImportError');
  if (pattern) expect(error.message).toMatch(pattern);
}

// A fresh directory per load: a debounced write left by an earlier test then lands in a directory nobody reads.
function load({ keepFiles = false } = {}) {
  if (!keepFiles) mockCacheDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'metals-import-'));
  const storeFile = path.join(mockCacheDir, 'metals_history.json');
  jest.resetModules();
  const service = require('../src/services/metalsHistoryService');
  return { service, storeFile, backupFile: `${storeFile}.bak` };
}

beforeEach(() => {
  mockUpsert.mockClear();
  mockCosmosEnabled = false;
});

describe('retention', () => {
  test('keeps at least as long as the Terapeak comp horizon (about two years)', () => {
    expect(load().service.RETENTION_DAYS).toBeGreaterThanOrEqual(740);
  });

  test('evictOld with no argument uses the retention window, not the old 400 days', async () => {
    const { service } = load();
    await service.importHistory({ XAU: { [daysAgo(500)]: 3000, [daysAgo(499)]: 3001 } });
    expect(service.evictOld()).toBe(0);
    expect(service.getSpotOnDate('XAU', daysAgo(500))).toBe(3000);
  });
});

describe('recordSpotReadings', () => {
  test('records live readings and skips stale copies and the hardcoded fallback', () => {
    const { service } = load();
    const out = service.recordSpotReadings({
      XAU: { price: 4000, source: 'gold-api-com', timestamp: new Date().toISOString() },
      XAG: { price: 80.27, source: 'hardcoded-fallback', timestamp: '2026-03-03T00:00:00Z', stale: true, cached: true },
      XPT: { price: 1500, source: 'gold-api-com (stale)', timestamp: new Date().toISOString(), stale: true },
      XPD: { price: 0, source: 'gold-api-com' },
    });
    expect(out).toEqual({ offered: 1, skipped: 3 });
    expect(service.getHistory('XAU', 5)).toHaveLength(1);
    expect(service.getHistory('XAG', 9999)).toEqual([]);
    expect(service.getHistory('XPT', 9999)).toEqual([]);
  });

  test('a fallback price carrying the hardcoded source is skipped even without the stale flag', () => {
    const { service } = load();
    expect(service.recordSpotReadings({ XAG: { price: 80.27, source: 'hardcoded-fallback', timestamp: new Date().toISOString() } })).toEqual({ offered: 0, skipped: 1 });
  });

  test('an empty or missing result records nothing', () => {
    const { service } = load();
    expect(service.recordSpotReadings({})).toEqual({ offered: 0, skipped: 0 });
    expect(service.recordSpotReadings(undefined)).toEqual({ offered: 0, skipped: 0 });
  });
});

describe('importHistory', () => {
  test('adds new days, rounds to cents and reports counts and persistence per metal', async () => {
    const { service } = load();
    const out = await service.importHistory({ XAU: { [daysAgo(10)]: 4000.126, [daysAgo(9)]: 4010 }, XAG: { [daysAgo(10)]: 50 } });
    expect(out.summary).toEqual({
      XAU: { added: 2, replaced: 0, kept: 0, skippedOld: 0, previous: {} },
      XAG: { added: 1, replaced: 0, kept: 0, skippedOld: 0, previous: {} },
    });
    expect(out.persisted).toEqual({ file: 'ok', cosmos: 'disabled' });
    expect(service.getSpotOnDate('XAU', daysAgo(10))).toBe(4000.13);
  });

  test('days already in the store are kept; replaceDays replaces only the listed ones and reports the old price', async () => {
    const { service } = load();
    await service.importHistory({ XAU: { [daysAgo(10)]: 4000, [daysAgo(9)]: 4010 } });
    const kept = await service.importHistory({ XAU: { [daysAgo(10)]: 4100, [daysAgo(9)]: 4110 } });
    expect(kept.summary.XAU).toEqual({ added: 0, replaced: 0, kept: 2, skippedOld: 0, previous: {} });
    expect(kept.persisted).toEqual({ file: 'unchanged', cosmos: 'unchanged' });
    expect(service.getSpotOnDate('XAU', daysAgo(10))).toBe(4000);
    const replaced = await service.importHistory({ XAU: { [daysAgo(10)]: 4100, [daysAgo(9)]: 4110 } }, { replaceDays: [daysAgo(10)] });
    expect(replaced.summary.XAU).toEqual({ added: 0, replaced: 1, kept: 1, skippedOld: 0, previous: { [daysAgo(10)]: 4000 } });
    expect(service.getSpotOnDate('XAU', daysAgo(10))).toBe(4100);
    expect(service.getSpotOnDate('XAU', daysAgo(9))).toBe(4010);
  });

  test('a replacement with the same price is counted as kept', async () => {
    const { service } = load();
    await service.importHistory({ XAU: { [daysAgo(3)]: 4000 } });
    const out = await service.importHistory({ XAU: { [daysAgo(3)]: 4000 } }, { replaceDays: [daysAgo(3)] });
    expect(out.summary.XAU).toEqual({ added: 0, replaced: 0, kept: 1, skippedOld: 0, previous: {} });
  });

  test('days older than the retention window are skipped, not stored', async () => {
    const { service } = load();
    const old = daysAgo(service.RETENTION_DAYS + 5);
    const out = await service.importHistory({ XAU: { [old]: 4000, [daysAgo(2)]: 4010 } });
    expect(out.summary.XAU).toEqual({ added: 1, replaced: 0, kept: 0, skippedOld: 1, previous: {} });
    expect(service.getHistory('XAU', service.RETENTION_DAYS + 30).map(([d]) => d)).toEqual([daysAgo(2)]);
  });

  test('importing the same data twice changes nothing the second time', async () => {
    const { service } = load();
    const data = { XAU: { [daysAgo(4)]: 4000, [daysAgo(3)]: 4010 } };
    await service.importHistory(data);
    expect((await service.importHistory(data)).summary.XAU).toEqual({ added: 0, replaced: 0, kept: 2, skippedOld: 0, previous: {} });
  });

  test.each([
    ['not an object', null],
    ['an array', []],
    ['an unknown metal', { DOGE: { '2026-01-01': 1 } }],
    ['__proto__ as a metal', JSON.parse('{"__proto__":{"2026-01-01":1}}')],
    ['a metal that is not an object', { XAU: 5 }],
    ['a day that is not a date', { XAU: { soon: 4000 } }],
    ['an impossible date', { XAU: { '2026-02-30': 4000 } }],
    ['a price that is a string', { XAU: { '2026-01-01': '4000' } }],
    ['an infinite price', { XAU: { '2026-01-01': Infinity } }],
  ])('%s is rejected', async (_label, history) => {
    const { service } = load();
    await expectImportError(service.importHistory(history));
  });

  test('today and later days are rejected, because the live poll records today', async () => {
    const { service } = load();
    await expectImportError(service.importHistory({ XAU: { [daysAgo(0)]: 4000 } }), /today or later/);
    await expectImportError(service.importHistory({ XAU: { '2999-01-01': 4000 } }), /today or later/);
    expect((await service.importHistory({ XAU: { [daysAgo(1)]: 4000 } })).summary.XAU.added).toBe(1);
  });

  test.each([
    ['XAU', 99.99], ['XAU', 20001], ['XAG', 0.99], ['XAG', 1001], ['XPT', 99], ['XPD', 10001], ['XAU', 0.001], ['XAU', 0],
  ])('%s at %p is outside the plausible range', async (metal, price) => {
    const { service } = load();
    await expectImportError(service.importHistory({ [metal]: { [daysAgo(5)]: price } }), /implausible|invalid/);
  });

  test('a sub-cent price is judged after rounding, so it cannot be stored as 0', async () => {
    const { service } = load();
    await expectImportError(service.importHistory({ XAG: { [daysAgo(5)]: 0.004 } }), /implausible/);
  });

  test('a day far from the days around it is rejected, a normal move is not', async () => {
    const { service } = load();
    await service.importHistory({ XAG: { [daysAgo(10)]: 50, [daysAgo(9)]: 51, [daysAgo(8)]: 52 } });
    await expectImportError(service.importHistory({ XAG: { [daysAgo(7)]: 90 } }), /more than 40%/);
    expect((await service.importHistory({ XAG: { [daysAgo(7)]: 58 } })).summary.XAG.added).toBe(1);
  });

  test('replacing a good day with a wild value is rejected and the good value stays', async () => {
    const { service } = load();
    await service.importHistory({ XAG: { [daysAgo(10)]: 50, [daysAgo(9)]: 51, [daysAgo(8)]: 52 } });
    await expectImportError(service.importHistory({ XAG: { [daysAgo(9)]: 900 } }, { replaceDays: [daysAgo(9)] }), /more than 40%/);
    expect(service.getSpotOnDate('XAG', daysAgo(9))).toBe(51);
  });

  test('a bad stored day is replaced when the neighbours in the same import are sane', async () => {
    const { service } = load();
    await service.importHistory({ XPT: { [daysAgo(20)]: 1050 } });
    const days = { [daysAgo(20)]: 2114 };
    for (let i = 19; i >= 15; i--) days[daysAgo(i)] = 2100 + (20 - i);
    const out = await service.importHistory({ XPT: days }, { replaceDays: [daysAgo(20)] });
    expect(out.summary.XPT.replaced).toBe(1);
    expect(out.summary.XPT.previous).toEqual({ [daysAgo(20)]: 1050 });
    expect(service.getSpotOnDate('XPT', daysAgo(20))).toBe(2114);
  });

  test('too many days for one metal is rejected', async () => {
    const { service } = load();
    const many = {};
    const start = Date.parse('2000-01-01T00:00:00Z');
    for (let i = 0; i < 1501; i++) many[new Date(start + i * 86400000).toISOString().substring(0, 10)] = 1000;
    await expectImportError(service.importHistory({ XAU: many }), /more than 1500 days/);
  });

  test.each([
    ['not a list', 'nope'],
    ['a bad date', ['soon']],
    ['more than 60 entries', Array.from({ length: 61 }, () => '2026-01-01')],
  ])('replaceDays that is %s is rejected', async (_label, replaceDays) => {
    const { service } = load();
    await expectImportError(service.importHistory({ XAU: { [daysAgo(2)]: 4000 } }, { replaceDays }));
  });

  test('one bad entry rejects the whole import and nothing is stored', async () => {
    const { service } = load();
    await expectImportError(service.importHistory({ XAU: { [daysAgo(5)]: 4000 }, XAG: { soon: 50 } }), /invalid entry in XAG/);
    expect(service.getHistory('XAU', 9999)).toEqual([]);
  });

  test('the store is written before the call returns', async () => {
    const { service, storeFile } = load();
    await service.importHistory({ XPT: { [daysAgo(6)]: 1234.5 } });
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf8')).XPT[daysAgo(6)]).toBe(1234.5);
  });

  test('a store file that cannot be written is reported as failed, not ok', async () => {
    const { service, storeFile } = load();
    fs.mkdirSync(storeFile); // a directory where the file should go makes the rename fail
    const out = await service.importHistory({ XPT: { [daysAgo(6)]: 1234.5 } });
    expect(out.persisted.file).toBe('failed');
    fs.rmSync(storeFile, { recursive: true, force: true });
  });

  test('Cosmos is written only for the metals that changed, and its failure is reported', async () => {
    mockCosmosEnabled = true;
    const { service } = load();
    const first = await service.importHistory({ XAU: { [daysAgo(7)]: 4000 }, XAG: { [daysAgo(7)]: 50 } });
    expect(first.persisted).toEqual({ file: 'ok', cosmos: 'ok' });
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    mockUpsert.mockClear();
    await service.importHistory({ XAU: { [daysAgo(7)]: 4100 }, XAG: { [daysAgo(8)]: 51 } });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'XAG', metal: 'XAG' }));
    mockUpsert.mockClear();
    expect((await service.importHistory({ XAU: { [daysAgo(7)]: 4100 } })).persisted.cosmos).toBe('unchanged');
    expect(mockUpsert).not.toHaveBeenCalled();
    mockUpsert.mockImplementationOnce(() => Promise.reject(new Error('cosmos down')));
    expect((await service.importHistory({ XPT: { [daysAgo(7)]: 1500 } })).persisted).toEqual({ file: 'ok', cosmos: 'failed' });
  });
});

describe('the store file', () => {
  test('a write keeps the previous good file as .bak and leaves no temp file', async () => {
    const { service, storeFile, backupFile } = load();
    await service.importHistory({ XAU: { [daysAgo(6)]: 4000 } });
    expect(fs.existsSync(backupFile)).toBe(false);
    await service.importHistory({ XAU: { [daysAgo(5)]: 4010 } });
    expect(Object.keys(JSON.parse(fs.readFileSync(backupFile, 'utf8')).XAU)).toEqual([daysAgo(6)]);
    expect(Object.keys(JSON.parse(fs.readFileSync(storeFile, 'utf8')).XAU)).toHaveLength(2);
    expect(fs.existsSync(`${storeFile}.tmp`)).toBe(false);
  });

  test('a truncated store file does not replace the last good backup', async () => {
    const { service, storeFile, backupFile } = load();
    await service.importHistory({ XAU: { [daysAgo(6)]: 4000 } });
    await service.importHistory({ XAU: { [daysAgo(5)]: 4010 } });
    fs.writeFileSync(storeFile, '{"XAU": {"2026-0');
    const goodBackup = fs.readFileSync(backupFile, 'utf8');
    await service.importHistory({ XAU: { [daysAgo(4)]: 4020 } });
    expect(fs.readFileSync(backupFile, 'utf8')).toBe(goodBackup);
  });

  test('on start an unreadable store falls back to the backup', async () => {
    const first = load();
    await first.service.importHistory({ XAU: { [daysAgo(6)]: 4000 } });
    await first.service.importHistory({ XAU: { [daysAgo(5)]: 4010 } });
    fs.writeFileSync(first.storeFile, '{"XAU": {"2026-0');
    const reloaded = load({ keepFiles: true }).service;
    expect(reloaded.getSpotOnDate('XAU', daysAgo(6))).toBe(4000);
  });
});

describe('getSpotOnDate after changes', () => {
  test('a lookup between days sees days added by an import or a record after an earlier lookup', async () => {
    const { service } = load();
    await service.importHistory({ XAU: { [daysAgo(10)]: 4000 } });
    expect(service.getSpotOnDate('XAU', daysAgo(7))).toBe(4000);
    await service.importHistory({ XAU: { [daysAgo(8)]: 4050 } });
    expect(service.getSpotOnDate('XAU', daysAgo(7))).toBe(4050);
    const tomorrow = daysAgo(-1);
    await service.importHistory({ XAU: { [daysAgo(3)]: 4060 } });
    expect(service.getSpotOnDate('XAU', tomorrow)).toBe(4060);
    service.recordDaily('XAU', 4100, new Date().toISOString());
    expect(service.getSpotOnDate('XAU', tomorrow)).toBe(4100);
  });
});
