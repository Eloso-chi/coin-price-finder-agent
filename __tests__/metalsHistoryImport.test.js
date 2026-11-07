// __tests__/metalsHistoryImport.test.js -- #333H: live-reading filter, retention and validated backfill import
'use strict';

const fs = require('fs');
const path = require('path');

const mockUpsert = jest.fn(() => Promise.resolve());
let mockCosmosEnabled = false;

jest.mock('../src/utils/cachePath', () => ({
  CACHE_DIR: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'metals-import-')),
}));
jest.mock('../src/utils/cosmosClient', () => ({
  isEnabled: () => mockCosmosEnabled,
  container: () => ({ items: { upsert: mockUpsert } }),
}));

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().substring(0, 10);

function expectImportError(fn) {
  let error;
  try { fn(); } catch (err) { error = err; }
  expect(error && error.name).toBe('ImportError');
}

function load() {
  jest.resetModules();
  const service = require('../src/services/metalsHistoryService');
  const { CACHE_DIR } = require('../src/utils/cachePath');
  return { service, storeFile: path.join(CACHE_DIR, 'metals_history.json') };
}

beforeEach(() => {
  mockUpsert.mockClear();
  mockCosmosEnabled = false;
});

describe('retention', () => {
  test('keeps at least as long as the Terapeak comp horizon (about two years)', () => {
    expect(load().service.RETENTION_DAYS).toBeGreaterThanOrEqual(740);
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
  test('adds new days, rounds to cents and reports counts per metal', () => {
    const { service } = load();
    const out = service.importHistory({ XAU: { [daysAgo(10)]: 4000.126, [daysAgo(9)]: 4010 }, XAG: { [daysAgo(10)]: 50 } });
    expect(out).toEqual({
      XAU: { added: 2, replaced: 0, kept: 0, skippedOld: 0 },
      XAG: { added: 1, replaced: 0, kept: 0, skippedOld: 0 },
    });
    expect(service.getSpotOnDate('XAU', daysAgo(10))).toBe(4000.13);
  });

  test('days already in the store are kept; replaceDays replaces only the listed ones', () => {
    const { service } = load();
    service.importHistory({ XAU: { [daysAgo(10)]: 1000, [daysAgo(9)]: 2000 } });
    const kept = service.importHistory({ XAU: { [daysAgo(10)]: 1111, [daysAgo(9)]: 2222 } });
    expect(kept.XAU).toEqual({ added: 0, replaced: 0, kept: 2, skippedOld: 0 });
    expect(service.getSpotOnDate('XAU', daysAgo(10))).toBe(1000);
    const replaced = service.importHistory({ XAU: { [daysAgo(10)]: 1111, [daysAgo(9)]: 2222 } }, { replaceDays: [daysAgo(10)] });
    expect(replaced.XAU).toEqual({ added: 0, replaced: 1, kept: 1, skippedOld: 0 });
    expect(service.getSpotOnDate('XAU', daysAgo(10))).toBe(1111);
    expect(service.getSpotOnDate('XAU', daysAgo(9))).toBe(2000);
  });

  test('a replacement with the same price is counted as kept', () => {
    const { service } = load();
    service.importHistory({ XAU: { [daysAgo(3)]: 5 } });
    expect(service.importHistory({ XAU: { [daysAgo(3)]: 5 } }, { replaceDays: [daysAgo(3)] }).XAU).toEqual({ added: 0, replaced: 0, kept: 1, skippedOld: 0 });
  });

  test('days older than the retention window are skipped, not stored', () => {
    const { service } = load();
    const old = daysAgo(service.RETENTION_DAYS + 5);
    const out = service.importHistory({ XAU: { [old]: 1000, [daysAgo(2)]: 2000 } });
    expect(out.XAU).toEqual({ added: 1, replaced: 0, kept: 0, skippedOld: 1 });
    expect(service.getHistory('XAU', service.RETENTION_DAYS + 30).map(([d]) => d)).toEqual([daysAgo(2)]);
  });

  test('importing the same data twice changes nothing the second time', () => {
    const { service } = load();
    const data = { XAU: { [daysAgo(4)]: 10, [daysAgo(3)]: 11 } };
    service.importHistory(data);
    expect(service.importHistory(data).XAU).toEqual({ added: 0, replaced: 0, kept: 2, skippedOld: 0 });
  });

  test.each([
    ['not an object', null],
    ['an array', []],
    ['an unknown metal', { DOGE: { '2026-01-01': 1 } }],
    ['__proto__ as a metal', JSON.parse('{"__proto__":{"2026-01-01":1}}')],
    ['a metal that is not an object', { XAU: 5 }],
    ['a day that is not a date', { XAU: { soon: 1 } }],
    ['an impossible date', { XAU: { '2026-02-30': 1 } }],
    ['a future day', { XAU: { '2999-01-01': 1 } }],
    ['a price that is a string', { XAU: { '2026-01-01': '5' } }],
    ['a zero price', { XAU: { '2026-01-01': 0 } }],
    ['a negative price', { XAU: { '2026-01-01': -5 } }],
    ['an infinite price', { XAU: { '2026-01-01': Infinity } }],
    ['an absurd price', { XAU: { '2026-01-01': 1e9 } }],
  ])('%s is rejected', (_label, history) => {
    const { service } = load();
    expectImportError(() => service.importHistory(history));
  });

  test('too many days for one metal is rejected', () => {
    const { service } = load();
    const many = {};
    const start = Date.parse('2000-01-01T00:00:00Z');
    for (let i = 0; i < 1501; i++) many[new Date(start + i * 86400000).toISOString().substring(0, 10)] = 1;
    expect(() => service.importHistory({ XAU: many })).toThrow(/more than 1500 days/);
  });

  test.each([
    ['not a list', 'nope'],
    ['a bad date', ['soon']],
    ['more than 400 entries', Array.from({ length: 401 }, () => '2026-01-01')],
  ])('replaceDays that is %s is rejected', (_label, replaceDays) => {
    const { service } = load();
    expectImportError(() => service.importHistory({ XAU: { [daysAgo(2)]: 1 } }, { replaceDays }));
  });

  test('one bad entry rejects the whole import and writes nothing', () => {
    const { service } = load();
    expect(() => service.importHistory({ XAU: { [daysAgo(5)]: 1 }, XAG: { soon: 2 } })).toThrow(/invalid entry in XAG/);
    expect(service.getHistory('XAU', 9999)).toEqual([]);
  });

  test('the store is written to disk after the debounce', async () => {
    const { service, storeFile } = load();
    service.importHistory({ XPT: { [daysAgo(6)]: 1234.5 } });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf8')).XPT[daysAgo(6)]).toBe(1234.5);
  });

  test('Cosmos is written only for the metals that changed, and not at all when nothing changed', () => {
    mockCosmosEnabled = true;
    const { service } = load();
    service.importHistory({ XAU: { [daysAgo(7)]: 10 }, XAG: { [daysAgo(7)]: 20 } });
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    mockUpsert.mockClear();
    service.importHistory({ XAU: { [daysAgo(7)]: 99 }, XAG: { [daysAgo(8)]: 21 } });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'XAG', metal: 'XAG' }));
    mockUpsert.mockClear();
    service.importHistory({ XAU: { [daysAgo(7)]: 99 } });
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
