/**
 * prefetchScheduler.test.js — Tests for nightly APR prefetch scheduler
 *
 * Covers: executePrefetchRun quota handling, status persistence,
 * error escalation, getSchedulerStatus shape, triggerManual.
 */

'use strict';

// Set throttle to 1ms BEFORE module loads (0 won't work due to `|| 1000` in source)
process.env.PREFETCH_THROTTLE_MS = '1';
process.env.PREFETCH_RESERVE = '10';

const fs = require('fs');

// ── Mocks ───────────────────────────────────────────────────

jest.mock('../src/services/pcgsQuotaService', () => ({
  getAvailableForPrefetch: jest.fn(() => 50),
  isBreakerTripped: jest.fn(() => false),
  getStatus: jest.fn(() => ({ used: 10, remaining: 90, limit: 100, breakerTripped: false })),
}));

jest.mock('../src/services/auctionPriceService', () => ({
  needsRefresh: jest.fn(() => true),
  getManifest: jest.fn(() => ({ entries: {} })),
  fetchByGrade: jest.fn(async () => ({ records: [{ price: 100 }], newRecords: 1 })),
  updateRunStatus: jest.fn(),
}));

jest.mock('../src/services/alertService', () => ({
  alertPrefetchFailure: jest.fn(),
}));

jest.mock('../src/utils/cachePath', () => ({
  CACHE_DIR: '/tmp/test-cache-prefetch',
}));

// Mock fs to intercept status file reads/writes
let mockStatusStore = null;
const originalReadFileSync = fs.readFileSync.bind(fs);
const originalWriteFileSync = fs.writeFileSync.bind(fs);

jest.spyOn(fs, 'readFileSync').mockImplementation((p, enc) => {
  if (String(p).includes('prefetch_status')) {
    if (mockStatusStore === null) throw new Error('ENOENT');
    return JSON.stringify(mockStatusStore);
  }
  return originalReadFileSync(p, enc);
});

jest.spyOn(fs, 'writeFileSync').mockImplementation((p, data) => {
  if (String(p).includes('prefetch_status')) {
    mockStatusStore = JSON.parse(data);
    return;
  }
  return originalWriteFileSync(p, data);
});

// ── Import after mocks ──────────────────────────────────────

const pcgsQuota = require('../src/services/pcgsQuotaService');
const auctionPrice = require('../src/services/auctionPriceService');
const alertService = require('../src/services/alertService');
const scheduler = require('../src/services/prefetchScheduler');

beforeEach(() => {
  mockStatusStore = null;

  // Reset all mock call counts but preserve implementations
  pcgsQuota.getAvailableForPrefetch.mockClear().mockReturnValue(50);
  pcgsQuota.isBreakerTripped.mockClear().mockReturnValue(false);
  pcgsQuota.getStatus.mockClear().mockReturnValue({ used: 10, remaining: 90, limit: 100, breakerTripped: false });
  auctionPrice.needsRefresh.mockClear().mockReturnValue(true);
  auctionPrice.getManifest.mockClear().mockReturnValue({ entries: {} });
  auctionPrice.fetchByGrade.mockClear().mockImplementation(async () => ({ records: [{ price: 100 }], newRecords: 1 }));
  auctionPrice.updateRunStatus.mockClear();
  alertService.alertPrefetchFailure.mockClear();
});

// ═══════════════════════════════════════════════════════════════
//  executePrefetchRun — quota & queue behavior
// ═══════════════════════════════════════════════════════════════

describe('prefetchScheduler — executePrefetchRun', () => {

  test('skips when no quota available', async () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(0);
    await scheduler.executePrefetchRun();
    expect(auctionPrice.fetchByGrade).not.toHaveBeenCalled();
    expect(mockStatusStore.status).toBe('skipped');
    expect(mockStatusStore.reason).toContain('No quota');
  });

  test('processes items limited by available quota', async () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(3);
    await scheduler.executePrefetchRun();
    // Should call fetchByGrade at most 3 times (quota-limited)
    expect(auctionPrice.fetchByGrade.mock.calls.length).toBeLessThanOrEqual(3);
    expect(mockStatusStore.status).toBe('completed');
    expect(mockStatusStore.callsMade).toBeLessThanOrEqual(3);
  });

  test('stops mid-run when breaker trips', async () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(20);
    let checkCount = 0;
    pcgsQuota.isBreakerTripped.mockImplementation(() => {
      checkCount++;
      return checkCount > 3; // trip after 3 checks
    });
    await scheduler.executePrefetchRun();
    // Should have stopped early — fewer calls than quota allows
    expect(auctionPrice.fetchByGrade.mock.calls.length).toBeLessThanOrEqual(3);
  });

  test('records partial status when some calls error', async () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(5);
    let callIdx = 0;
    auctionPrice.fetchByGrade.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 3) throw new Error('timeout');
      return { records: [{ price: 50 }], newRecords: 1 };
    });
    await scheduler.executePrefetchRun();
    expect(mockStatusStore.status).toBe('partial');
    expect(mockStatusStore.errors.length).toBeGreaterThan(0);
  });

  test('stops immediately on 429 error', async () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(20);
    let callIdx = 0;
    auctionPrice.fetchByGrade.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 2) throw new Error('429 Too Many Requests');
      return { records: [{ price: 50 }], newRecords: 1 };
    });
    await scheduler.executePrefetchRun();
    // Should stop at call 2 (the 429 triggers break)
    expect(auctionPrice.fetchByGrade.mock.calls.length).toBe(2);
  });

  test('alerts on consecutive failures >= 2 (fatal error)', async () => {
    mockStatusStore = { consecutiveFailures: 1 };
    // Throw from getAvailableForPrefetch to trigger the outer catch
    pcgsQuota.getAvailableForPrefetch.mockImplementation(() => { throw new Error('fatal quota crash'); });
    await scheduler.executePrefetchRun();
    expect(alertService.alertPrefetchFailure).toHaveBeenCalledWith(
      2, expect.stringContaining('fatal')
    );
    expect(mockStatusStore.status).toBe('failed');
    expect(mockStatusStore.consecutiveFailures).toBe(2);
  });

  test('resets consecutiveFailures on successful run', async () => {
    mockStatusStore = { consecutiveFailures: 3 };
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(2);
    await scheduler.executePrefetchRun();
    expect(mockStatusStore.consecutiveFailures).toBe(0);
    expect(mockStatusStore.status).toBe('completed');
  });

  test('completes with "fresh" when queue is empty', async () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(50);
    auctionPrice.needsRefresh.mockReturnValue(false);
    await scheduler.executePrefetchRun();
    expect(auctionPrice.fetchByGrade).not.toHaveBeenCalled();
    expect(mockStatusStore.status).toBe('completed');
    expect(mockStatusStore.reason).toContain('fresh');
  });

  test('saves nextScheduled in status', async () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(2);
    await scheduler.executePrefetchRun();
    expect(mockStatusStore.nextScheduled).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(mockStatusStore.nextScheduled).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test('caps stored errors at 20', async () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(5);
    auctionPrice.fetchByGrade.mockRejectedValue(new Error('fail'));
    await scheduler.executePrefetchRun();
    // Even with many errors, stored array is capped
    expect(mockStatusStore.errors.length).toBeLessThanOrEqual(20);
  });
});

// ═══════════════════════════════════════════════════════════════
//  getSchedulerStatus — admin endpoint
// ═══════════════════════════════════════════════════════════════

describe('prefetchScheduler — getSchedulerStatus', () => {

  test('returns expected shape', () => {
    const status = scheduler.getSchedulerStatus();
    expect(status).toMatchObject({
      enabled: expect.any(Boolean),
      running: expect.any(Boolean),
      todayCompleted: expect.any(Boolean),
      triggerTime: expect.stringContaining('PT'),
      nextScheduled: expect.any(String),
      quota: expect.objectContaining({
        used: expect.any(Number),
        remaining: expect.any(Number),
        limit: expect.any(Number),
        breakerTripped: expect.any(Boolean),
      }),
    });
  });

  test('reflects quota breaker state', () => {
    pcgsQuota.getStatus.mockReturnValue({ used: 95, remaining: 5, limit: 100, breakerTripped: true });
    const status = scheduler.getSchedulerStatus();
    expect(status.quota.breakerTripped).toBe(true);
    expect(status.quota.remaining).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════
//  triggerManual — admin manual trigger
// ═══════════════════════════════════════════════════════════════

describe('prefetchScheduler — triggerManual', () => {

  test('returns ok:true and status on success', async () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(2);
    const result = await scheduler.triggerManual();
    expect(result.ok).toBe(true);
    expect(result.status).toBeDefined();
    expect(result.status.status).toBe('completed');
  });
});
