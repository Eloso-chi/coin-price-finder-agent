'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Greysheet refresh cross-process durability', () => {
  let cacheDir;
  let paidFetch;

  beforeEach(() => {
    jest.resetModules();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'greysheet-refresh-durable-'));
    paidFetch = jest.fn(async () => ({ greyVal: 100, cpgVal: 120 }));
    jest.doMock('../src/utils/cachePath', () => ({ CACHE_DIR: cacheDir }));
    jest.doMock('../src/utils/cosmosClient', () => ({
      isEnabled: () => false,
      container: () => ({ items: { upsert: jest.fn() } }),
    }));
    jest.doMock('../src/data/greysheetTypeMap', () => ({ TYPE_GSID_MAP: { test: 12345 } }));
    jest.doMock('../src/services/greysheetService', () => ({
      fetchPriceByGsid: paidFetch,
      fetchPriceByPcgsNumber: jest.fn(),
    }));
  });

  afterEach(() => {
    jest.dontMock('../src/utils/cachePath');
    jest.dontMock('../src/utils/cosmosClient');
    jest.dontMock('../src/data/greysheetTypeMap');
    jest.dontMock('../src/services/greysheetService');
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  function loadIndependentContext() {
    let context;
    jest.isolateModules(() => {
      const history = require('../src/services/greysheetHistoryService');
      context = {
        history,
        runRefresh: require('../scripts/greysheet-refresh').runRefresh,
      };
    });
    return context;
  }

  test('two independently loaded stale contexts perform one paid refresh', async () => {
    const first = loadIndependentContext();
    const second = loadIndependentContext();
    expect(first.history.getLastRefreshDate()).toBeNull();
    expect(second.history.getLastRefreshDate()).toBeNull();

    const firstResult = await first.runRefresh({ typesOnly: true, delayMs: 1, intervalDays: 7 });
    const secondResult = await second.runRefresh({ typesOnly: true, delayMs: 1, intervalDays: 7 });

    expect(firstResult.totalSnapshots).toBe(1);
    expect(secondResult).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'recently-completed',
    }));
    expect(paidFetch).toHaveBeenCalledTimes(1);
    expect(second.history.getLastRefreshDate()).not.toBeNull();
  });

  test('persists completion before releasing the durable lease', async () => {
    const events = [];
    jest.doMock('../src/utils/durableLease', () => ({
      acquireExclusiveLease: () => ({
        assertOwner: () => {},
        release: () => events.push('release'),
      }),
    }));
    jest.doMock('../src/services/greysheetHistoryService', () => ({
      getLastRefreshDate: () => null,
      makeKey: () => '12345:all',
      recordSnapshot: () => true,
      setLastRefreshDate: () => events.push('persist'),
      coinCount: () => 1,
    }));

    let runRefresh;
    jest.isolateModules(() => {
      runRefresh = require('../scripts/greysheet-refresh').runRefresh;
    });
    await runRefresh({ typesOnly: true, delayMs: 1, intervalDays: 7 });

    expect(events).toEqual(['persist', 'release']);
  });
});