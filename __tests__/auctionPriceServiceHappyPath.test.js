'use strict';

/**
 * auctionPriceServiceHappyPath.test.js -- Coverage for the fetch + write
 * paths of src/services/auctionPriceService.js that were not exercised by
 * the existing test files.
 *
 * Existing files cover:
 *   - auctionPriceService.test.js: computeStats, computeTrend, needsRefresh,
 *     getHistory, FRESHNESS_DAYS / DATE_WINDOW_YEARS constants
 *   - auctionPriceServiceErrorPaths.test.js: _dedupeRecords (also covered by
 *     auctionDedupCollision.test.js), getManifest, getStaleEntries,
 *     updateRunStatus, fetchByGrade guard (missing PCGS_API_KEY)
 *
 * This file fills the remaining ~30% of the file:
 *   - fetchByGrade happy path (axios mock + manifest write + file write +
 *     sort callback)
 *   - fetchByGrade cached path (fresh manifest -> no axios call)
 *   - fetchByGrade force=true (bypasses freshness check)
 *   - fetchByGrade 429 response (trips breaker)
 *   - fetchByGrade breaker tripped (throws before axios call)
 *   - fetchByGrade IsValidRequest=false (returns empty stats)
 *   - fetchByCertNo happy path (uses returned PCGSNo + Grade to update store)
 *   - fetchByCertNo IsValidRequest=false (empty stats, no store write)
 *   - saveManifest write failure (catch branch)
 *   - aprGet header sync on error response
 *
 * Anti-cheating: every assertion checks an observable behavior of the
 * service (return value, file written, manifest entry written, breaker
 * tripped). No introspection of internal state via private accessors.
 *
 * Mock pattern: jest.resetModules() is required to clear the service's
 * module-level _manifest cache between tests. Because the service does
 * `require('axios')` at module top level, after resetModules() the service
 * receives a FRESH axios mock instance -- so axios.get must be re-required
 * and re-configured inside each setupFresh() call (after resetModules)
 * rather than at the top of the file.
 */

jest.mock('fs');
jest.mock('axios');
jest.mock('../src/utils/cachePath', () => ({ CACHE_DIR: '/tmp/test-cache' }));
jest.mock('../src/services/pcgsQuotaService', () => ({
  recordCall: jest.fn(() => ({ remaining: 999, used: 1 })),
  syncFromHeaders: jest.fn(),
  tripBreaker: jest.fn(),
  isBreakerTripped: jest.fn(() => false),
}));

// ============================================================
// Helpers
// ============================================================

function makeAuctionRecords(n, startPrice = 100, startMonth = 1, startYear = 2024) {
  return Array.from({ length: n }, (_, i) => ({
    LotNo: `L${i + 1}`,
    Auctioneer: i % 2 === 0 ? 'Heritage' : "Stack's Bowers",
    Date: `${String(((startMonth + i - 1) % 12) + 1).padStart(2, '0')}-${startYear + Math.floor((startMonth + i - 1) / 12)}`,
    Price: startPrice + i * 50,
    Grade: 'MS65',
  }));
}

/**
 * Set up a fresh module graph with all mocks freshly initialized. Returns
 * the re-required mock instances so each test can override behavior.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.cleanFs=true]   Configure fs for an empty cache.
 * @param {boolean} [opts.breakerTripped] If true, pcgsQuota.isBreakerTripped returns true.
 * @returns {{svc, axios, fs, pcgsQuota}}
 */
function setupFresh(opts = {}) {
  jest.resetModules();
  // jest.clearAllMocks() clears call history on every registered mock; combined
  // with resetModules() (which gives us fresh module instances) this is the
  // idiomatic Jest 30 reset pattern. The explicit mockReturnValue below is
  // still needed because we want isBreakerTripped to reflect the opts arg
  // instead of the factory default of () => false.
  jest.clearAllMocks();
  const axios = require('axios');
  const fs = require('fs');
  const pcgsQuota = require('../src/services/pcgsQuotaService');
  pcgsQuota.isBreakerTripped.mockReturnValue(!!opts.breakerTripped);

  if (opts.cleanFs !== false) {
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});
    fs.readFileSync.mockImplementation((filePath) => {
      if (String(filePath).includes('manifest')) {
        return JSON.stringify({ entries: {}, lastRun: null, lastRunStatus: null });
      }
      return JSON.stringify({ pcgsNo: '7296', name: null, grades: {} });
    });
  }

  const svc = require('../src/services/auctionPriceService');
  return { svc, axios, fs, pcgsQuota };
}

// ============================================================
// fetchByGrade -- happy path
// ============================================================

describe('fetchByGrade -- happy path', () => {
  beforeEach(() => {
    process.env.PCGS_API_KEY = 'test-key';
  });

  it('returns records, stats, and fromCache=false on first fetch', async () => {
    const { svc, axios } = setupFresh();
    axios.get.mockResolvedValue({
      data: {
        IsValidRequest: true,
        Name: '1881-S Morgan Dollar',
        Auctions: makeAuctionRecords(3, 500),
      },
      headers: { 'x-ratelimit-remaining': '95', 'x-ratelimit-limit': '100' },
    });
    const result = await svc.fetchByGrade(7296, 65);
    expect(result.fromCache).toBe(false);
    expect(result.records).toHaveLength(3);
    expect(result.stats.count).toBe(3);
    expect(result.stats.medianUsd).toBeGreaterThan(0);
    expect(result.newRecords).toBe(3);
  });

  it('calls the GetAPRByGrade endpoint with PCGSNo and GradeNo in the URL', async () => {
    const { svc, axios } = setupFresh();
    axios.get.mockResolvedValue({
      data: { IsValidRequest: true, Name: 'X', Auctions: [] },
      headers: {},
    });
    await svc.fetchByGrade(7296, 65);
    expect(axios.get).toHaveBeenCalledTimes(1);
    const calledUrl = axios.get.mock.calls[0][0];
    expect(calledUrl).toContain('/coindetail/GetAPRByGrade');
    expect(calledUrl).toContain('PCGSNo=7296');
    expect(calledUrl).toContain('GradeNo=65');
  });

  it('sends Authorization: Bearer header on the axios call', async () => {
    const { svc, axios } = setupFresh();
    axios.get.mockResolvedValue({
      data: { IsValidRequest: true, Name: 'X', Auctions: [] },
      headers: {},
    });
    await svc.fetchByGrade(7296, 65);
    const calledOpts = axios.get.mock.calls[0][1];
    expect(calledOpts.headers.Authorization).toBe('Bearer test-key');
  });

  it('strips "+" from grade input and passes PlusGrade=true', async () => {
    const { svc, axios } = setupFresh();
    axios.get.mockResolvedValue({
      data: { IsValidRequest: true, Name: 'X', Auctions: [] },
      headers: {},
    });
    await svc.fetchByGrade(7296, '65+');
    const calledUrl = axios.get.mock.calls[0][0];
    expect(calledUrl).toContain('GradeNo=65');
    expect(calledUrl).toContain('PlusGrade=true');
  });

  it('writes the merged coin file to disk', async () => {
    const { svc, axios, fs } = setupFresh();
    axios.get.mockResolvedValue({
      data: {
        IsValidRequest: true,
        Name: '1881-S Morgan Dollar',
        Auctions: makeAuctionRecords(3, 500),
      },
      headers: {},
    });
    await svc.fetchByGrade(7296, 65);
    const writes = fs.writeFileSync.mock.calls;
    const coinWrite = writes.find(([fp]) => String(fp).endsWith('7296.json'));
    expect(coinWrite).toBeDefined();
    const written = JSON.parse(coinWrite[1]);
    expect(written.pcgsNo).toBe('7296');
    expect(written.name).toBe('1881-S Morgan Dollar');
    expect(written.grades['65'].records).toHaveLength(3);
    expect(written.lastUpdated).toBeDefined();
  });

  it('writes manifest entry with freshUntil and records count', async () => {
    const { svc, axios, fs } = setupFresh();
    axios.get.mockResolvedValue({
      data: {
        IsValidRequest: true,
        Name: '1881-S Morgan Dollar',
        Auctions: makeAuctionRecords(3, 500),
      },
      headers: {},
    });
    await svc.fetchByGrade(7296, 65);
    const writes = fs.writeFileSync.mock.calls;
    const manifestWrite = writes.find(([fp]) => String(fp).includes('apr_manifest'));
    expect(manifestWrite).toBeDefined();
    const manifest = JSON.parse(manifestWrite[1]);
    expect(manifest.entries['7296:65']).toBeDefined();
    expect(manifest.entries['7296:65'].records).toBe(3);
    expect(manifest.entries['7296:65'].freshUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('syncs PCGS quota from response headers', async () => {
    const { svc, axios, pcgsQuota } = setupFresh();
    axios.get.mockResolvedValue({
      data: { IsValidRequest: true, Name: 'X', Auctions: [] },
      headers: { 'x-ratelimit-remaining': '95', 'x-ratelimit-limit': '100' },
    });
    await svc.fetchByGrade(7296, 65);
    expect(pcgsQuota.syncFromHeaders).toHaveBeenCalledWith(95, 100);
    expect(pcgsQuota.recordCall).toHaveBeenCalledWith('apr');
  });

  it('sorts merged records by date descending (newest first)', async () => {
    const { svc, axios } = setupFresh();
    axios.get.mockResolvedValueOnce({
      data: {
        IsValidRequest: true,
        Name: '1881-S Morgan Dollar',
        Auctions: [
          { LotNo: 'L1', Auctioneer: 'Heritage', Date: '03-2022', Price: 100 },
          { LotNo: 'L2', Auctioneer: 'Heritage', Date: '11-2024', Price: 200 },
          { LotNo: 'L3', Auctioneer: 'Heritage', Date: '06-2023', Price: 150 },
        ],
      },
      headers: {},
    });
    const result = await svc.fetchByGrade(7296, 65);
    expect(result.records[0].Date).toBe('11-2024');
    expect(result.records[1].Date).toBe('06-2023');
    expect(result.records[2].Date).toBe('03-2022');
  });

  it('returns empty results when IsValidRequest=false', async () => {
    const { svc, axios } = setupFresh();
    axios.get.mockResolvedValue({
      data: { IsValidRequest: false },
      headers: {},
    });
    const result = await svc.fetchByGrade(7296, 65);
    expect(result.records).toEqual([]);
    expect(result.stats.count).toBe(0);
    expect(result.fromCache).toBe(false);
  });
});

// ============================================================
// fetchByGrade -- cache + force + breaker paths
// ============================================================

describe('fetchByGrade -- cache + force', () => {
  beforeEach(() => {
    process.env.PCGS_API_KEY = 'test-key';
  });

  it('returns cached result without calling axios when manifest is fresh', async () => {
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const { svc, axios, fs } = setupFresh({ cleanFs: false });
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});
    fs.readFileSync.mockImplementation((fp) => {
      if (String(fp).includes('manifest')) {
        return JSON.stringify({
          entries: {
            '7296:65': {
              lastFetched: '2024-06-01T00:00:00Z',
              records: 2,
              freshUntil: future,
            },
          },
        });
      }
      return JSON.stringify({
        pcgsNo: '7296',
        name: '1881-S Morgan Dollar',
        grades: {
          '65': {
            records: [
              { Price: 400, LotNo: 'A1', Auctioneer: 'Heritage', Date: '01-2024' },
              { Price: 500, LotNo: 'A2', Auctioneer: 'Heritage', Date: '03-2024' },
            ],
          },
        },
      });
    });
    const result = await svc.fetchByGrade(7296, 65);
    expect(result.fromCache).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('bypasses freshness check when force=true', async () => {
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const { svc, axios, fs } = setupFresh({ cleanFs: false });
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});
    fs.readFileSync.mockImplementation((fp) => {
      if (String(fp).includes('manifest')) {
        return JSON.stringify({
          entries: {
            '7296:65': { lastFetched: '2024-06-01T00:00:00Z', records: 2, freshUntil: future },
          },
        });
      }
      return JSON.stringify({ pcgsNo: '7296', name: null, grades: {} });
    });
    axios.get.mockResolvedValue({
      data: { IsValidRequest: true, Name: '1881-S', Auctions: makeAuctionRecords(1, 700) },
      headers: {},
    });

    const result = await svc.fetchByGrade(7296, 65, { force: true });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
  });

  it('throws and trips breaker on 429 response', async () => {
    const { svc, axios, pcgsQuota } = setupFresh();
    axios.get.mockRejectedValue({
      response: { status: 429, headers: {} },
    });
    await expect(svc.fetchByGrade(7296, 65)).rejects.toThrow(/rate limit/i);
    expect(pcgsQuota.tripBreaker).toHaveBeenCalled();
  });

  it('throws when breaker is already tripped before making any HTTP call', async () => {
    const { svc, axios } = setupFresh({ breakerTripped: true });
    await expect(svc.fetchByGrade(7296, 65)).rejects.toThrow(/breaker tripped/);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('syncs quota headers from non-429 error responses', async () => {
    const { svc, axios, pcgsQuota } = setupFresh();
    axios.get.mockRejectedValue({
      response: {
        status: 500,
        headers: { 'x-ratelimit-remaining': '42', 'x-ratelimit-limit': '100' },
      },
      message: 'Server error',
    });
    await expect(svc.fetchByGrade(7296, 65)).rejects.toBeDefined();
    expect(pcgsQuota.syncFromHeaders).toHaveBeenCalledWith(42, 100);
    expect(pcgsQuota.tripBreaker).not.toHaveBeenCalled();
  });
});

// ============================================================
// fetchByCertNo -- happy path + edge cases
// ============================================================

describe('fetchByCertNo', () => {
  beforeEach(() => {
    process.env.PCGS_API_KEY = 'test-key';
  });

  it('throws when PCGS_API_KEY is missing', async () => {
    delete process.env.PCGS_API_KEY;
    const { svc } = setupFresh();
    await expect(svc.fetchByCertNo(12345678)).rejects.toThrow(/PCGS API key/);
  });

  it('returns records and updates the store on a valid response with PCGSNo + Grade', async () => {
    const { svc, axios, fs } = setupFresh();
    axios.get.mockResolvedValue({
      data: {
        IsValidRequest: true,
        PCGSNo: 7296,
        Grade: '65',
        Name: '1881-S Morgan Dollar',
        Auctions: makeAuctionRecords(2, 400),
      },
      headers: {},
    });
    const result = await svc.fetchByCertNo(12345678);
    expect(result.records).toHaveLength(2);
    expect(result.pcgsNo).toBe(7296);
    expect(result.grade).toBe('65');
    expect(result.stats.count).toBe(2);

    const writes = fs.writeFileSync.mock.calls;
    const coinWrite = writes.find(([fp]) => String(fp).endsWith('7296.json'));
    expect(coinWrite).toBeDefined();
  });

  it('calls /coindetail/GetAPRByCertNo/<certNo>', async () => {
    const { svc, axios } = setupFresh();
    axios.get.mockResolvedValue({
      data: { IsValidRequest: true, PCGSNo: 7296, Grade: '65', Auctions: [] },
      headers: {},
    });
    await svc.fetchByCertNo(12345678);
    const calledUrl = axios.get.mock.calls[0][0];
    expect(calledUrl).toContain('/coindetail/GetAPRByCertNo/12345678');
  });

  it('returns empty stats when IsValidRequest=false', async () => {
    const { svc, axios } = setupFresh();
    axios.get.mockResolvedValue({
      data: { IsValidRequest: false },
      headers: {},
    });
    const result = await svc.fetchByCertNo(12345678);
    expect(result.records).toEqual([]);
    expect(result.stats.count).toBe(0);
  });

  it('skips the store write when PCGSNo or Grade are missing', async () => {
    const { svc, axios, fs } = setupFresh();
    axios.get.mockResolvedValue({
      data: {
        IsValidRequest: true,
        // PCGSNo + Grade omitted
        Auctions: makeAuctionRecords(1, 100),
      },
      headers: {},
    });
    await svc.fetchByCertNo(12345678);
    const coinWrites = fs.writeFileSync.mock.calls.filter(([fp]) =>
      /\d+\.json$/.test(String(fp)) && !String(fp).includes('manifest')
    );
    expect(coinWrites).toEqual([]);
  });
});

// ============================================================
// getStaleEntries -- non-empty stale branch
// (closes L352-353 -- the stale.push() body when an entry has expired)
// ============================================================

describe('getStaleEntries -- non-empty manifest', () => {
  it('includes entries whose freshUntil is in the past', () => {
    const past = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const { svc, fs } = setupFresh({ cleanFs: false });
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});
    fs.readFileSync.mockImplementation(() => JSON.stringify({
      entries: {
        '7296:65': { lastFetched: '2024-01-01T00:00:00Z', records: 5, freshUntil: past },
        '7297:66': { lastFetched: '2024-06-01T00:00:00Z', records: 3, freshUntil: future },
      },
    }));
    const stale = svc.getStaleEntries();
    expect(stale).toHaveLength(1);
    expect(stale[0].key).toBe('7296:65');
    expect(stale[0].records).toBe(5);
  });

  it('sorts multiple stale entries by lastFetched ascending', () => {
    const past = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const { svc, fs } = setupFresh({ cleanFs: false });
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});
    fs.readFileSync.mockImplementation(() => JSON.stringify({
      entries: {
        '7296:65': { lastFetched: '2024-06-01T00:00:00Z', records: 5, freshUntil: past },
        '7297:66': { lastFetched: '2024-01-01T00:00:00Z', records: 3, freshUntil: past },
        '7298:67': { lastFetched: '2024-03-15T00:00:00Z', records: 1, freshUntil: past },
      },
    }));
    const stale = svc.getStaleEntries();
    expect(stale).toHaveLength(3);
    expect(stale[0].key).toBe('7297:66'); // oldest
    expect(stale[1].key).toBe('7298:67');
    expect(stale[2].key).toBe('7296:65'); // newest
  });
});

// ============================================================
// saveManifest write failure -- catch branch
// ============================================================

describe('saveManifest -- error path', () => {
  it('does not throw when writeFileSync fails (logs and continues)', async () => {
    process.env.PCGS_API_KEY = 'test-key';
    const { svc, axios, fs } = setupFresh({ cleanFs: false });

    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockImplementation(() => {});
    fs.readFileSync.mockImplementation((fp) => {
      if (String(fp).includes('manifest')) {
        return JSON.stringify({ entries: {} });
      }
      return JSON.stringify({ pcgsNo: '7296', name: null, grades: {} });
    });
    // First write (coin file) succeeds; manifest write fails.
    fs.writeFileSync.mockImplementation((fp) => {
      if (String(fp).includes('manifest')) {
        throw new Error('EACCES: permission denied');
      }
    });
    axios.get.mockResolvedValue({
      data: {
        IsValidRequest: true,
        Name: '1881-S Morgan Dollar',
        Auctions: makeAuctionRecords(1, 500),
      },
      headers: {},
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await svc.fetchByGrade(7296, 65);
    expect(result.fromCache).toBe(false);
    expect(result.records).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledWith(
      '[apr] Failed to save manifest:',
      expect.stringMatching(/permission denied/),
    );
    errSpy.mockRestore();
  });
});
