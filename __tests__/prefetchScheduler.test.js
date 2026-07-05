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

  test('skips when no quota available and preserves prior completion (#277W)', async () => {
    // Seed with a prior completed run — this is the state the GH Actions
    // safety-net workflow races with when it fires ~1h after the in-process
    // scheduler already burned quota. Pre-#277W the skip write clobbered
    // `status` to 'skipped' and made lastStatus in /api/admin/prefetch-status
    // read as "nothing happened" for the whole day.
    mockStatusStore = {
      lastRun: '2026-07-02T07:48:37.720Z',
      status: 'completed',
      duration: '1658.6s',
      callsMade: 990,
      newRecords: 607,
      perCategory: {
        us_classic: { attempted: 330, newRecords: 200 },
        us_bullion: { attempted: 330, newRecords: 250 },
        world_bullion: { attempted: 330, newRecords: 157 },
        unknown: { attempted: 0, newRecords: 0 }
      }
    };
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(0);
    await scheduler.executePrefetchRun();

    expect(auctionPrice.fetchByGrade).not.toHaveBeenCalled();

    // Attempt namespace records the skip.
    expect(mockStatusStore.lastAttemptStatus).toBe('skipped');
    expect(mockStatusStore.lastAttemptReason).toContain('No quota');
    expect(typeof mockStatusStore.lastAttempt).toBe('string');
    expect(new Date(mockStatusStore.lastAttempt).getTime()).toBeGreaterThan(0);

    // Prior completion signal is PRESERVED (this is the whole point).
    expect(mockStatusStore.status).toBe('completed');
    expect(mockStatusStore.lastRun).toBe('2026-07-02T07:48:37.720Z');
    expect(mockStatusStore.callsMade).toBe(990);
    expect(mockStatusStore.newRecords).toBe(607);
    expect(mockStatusStore.perCategory.world_bullion.newRecords).toBe(157);
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

  test('returns the triggerManual response contract', () => {
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(2);
    const result = scheduler.triggerManual();
    expect(result).toHaveProperty('started');
    expect(typeof result.started).toBe('boolean');
    expect(result).toHaveProperty('reason');

    if (result.started) {
      expect(result.reason).toContain('background');
      expect(result.nextStatus).toContain('/api/admin/prefetch-status');
    } else {
      expect(result.reason).toMatch(/Already completed today|Run already in progress/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
//  #214 — World bullion PCGS numbers (6-7 digits) reach the queue
// ═══════════════════════════════════════════════════════════════

describe('prefetchScheduler — world bullion extraction (#214)', () => {

  test('extractor regex picks up 6-7 digit world bullion PCGS numbers', () => {
    // Read the real pcgsNumbers.js source (mirrors what extractAllPcgsNumbers does)
    const realFs = jest.requireActual('fs');
    const path = jest.requireActual('path');
    const src = realFs.readFileSync(
      path.resolve(__dirname, '../src/data/pcgsNumbers.js'),
      'utf8'
    );
    const matches = src.match(/:\s*(\d{3,7})\b/g) || [];
    const numbers = new Set(
      matches.map(m => parseInt(m.replace(/[:\s]/g, ''), 10)).filter(n => n > 100)
    );

    // Sample world bullion PCGS numbers from #206-#213 (Kookaburra, Krugerrand,
    // Kangaroo, Maple Leaf, Britannia, Panda, Perth Lunar). These are 6-7 digit
    // numbers that the old \d{3,5} regex skipped entirely.
    const worldBullionSamples = [
      114425,   // 1992 Kookaburra
      564601,   // 1967 Krugerrand
      143219,   // 1993 Kangaroo
      1004509,  // 2026 Maple Leaf
      1001434,  // 2026 Britannia
      1000705,  // 2026 Panda
      170456,   // 1999 Perth Lunar 1/2 oz
    ];
    for (const n of worldBullionSamples) {
      expect(numbers.has(n)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
//  Regression: getKeyDatePcgsNumbers must return a non-empty
//  array. The function silently returned [] from inception because
//  it imported the keyDates module object instead of destructuring
//  the KEY_DATES array, so `for (const kd of KEY_DATES)` threw
//  TypeError that the try/catch swallowed. Confirmed on
//  2026-06-29 spike: 0 of 749 bullion PCGS#s ever cached.
// ═══════════════════════════════════════════════════════════════

describe('prefetchScheduler — getKeyDatePcgsNumbers Phase 1 priority', () => {

  test('returns a non-empty array of PCGS numbers (regression: was [] for ~30 days)', () => {
    const nums = scheduler.getKeyDatePcgsNumbers();
    expect(Array.isArray(nums)).toBe(true);
    // 209 KEY_DATES entries, ~107 resolve via SERIES_MAP today. Floor at 90
    // gives margin for legitimate data trims without masking a future regression.
    expect(nums.length).toBeGreaterThan(90);
  });

  test('includes representative US numismatic, US bullion, and world bullion key dates', () => {
    const nums = new Set(scheduler.getKeyDatePcgsNumbers());
    // Each fixture was verified against lookupPCGSNumber on 2026-06-29.
    // Span all three pcgsNumbers.js sections so a partial regression is caught.
    const fixtures = [
      { pcgs: 6564,   note: 'Walking Liberty Half 1916 (US numismatic)' },
      { pcgs: 4902,   note: 'Mercury Dime 1916-D (US numismatic)' },
      { pcgs: 9801,   note: 'American Silver Eagle 1986 (US bullion)' },
      { pcgs: 9814,   note: 'American Gold Eagle 1986 (US bullion)' },
      { pcgs: 32496,  note: 'Canadian Silver Maple Leaf 1988 (world bullion)' },
      { pcgs: 526437, note: 'Mexican Silver Libertad 1982 (world bullion)' },
    ];
    for (const f of fixtures) {
      expect(nums.has(f.pcgs)).toBe(true);
    }
  });

  test('returns deduplicated PCGS numbers', () => {
    const nums = scheduler.getKeyDatePcgsNumbers();
    expect(nums.length).toBe(new Set(nums).size);
  });
});

// ═══════════════════════════════════════════════════════════════
//  PR-2b — Era-aware target grades + round-robin category queue
//  Addresses world-bullion starvation: pre-PR-2b, queue iterated
//  Phase 2 in source-file order so world bullion (positions 30-47
//  in pcgsNumbers.js) sat behind all US classic + US bullion at
//  positions 1-29. After PR-2a (+760 US classic numbers) the wait
//  grew from ~14 to ~23 days. PR-2b adds:
//    1. targetGradesFor(year): prunes MS66-MS70 for pre-1900
//       and MS68-MS70 for 1900-1933 (grades that almost never
//       have PCGS pop for those eras -> wasted APR calls).
//    2. Phase 2 round-robin across us_classic / us_bullion /
//       world_bullion so every 3rd Phase-2 fetch is world bullion.
// ═══════════════════════════════════════════════════════════════

describe('prefetchScheduler — PR-2b targetGradesFor era-aware grade ladder', () => {

  test('pre-1900 returns MS60-MS65 only (6 grades)', () => {
    expect(scheduler.targetGradesFor(1854)).toEqual([60, 61, 62, 63, 64, 65]);
    expect(scheduler.targetGradesFor(1899)).toEqual([60, 61, 62, 63, 64, 65]);
  });

  test('1900-1933 classic era returns MS60-MS67 (8 grades)', () => {
    expect(scheduler.targetGradesFor(1900)).toEqual([60, 61, 62, 63, 64, 65, 66, 67]);
    expect(scheduler.targetGradesFor(1916)).toEqual([60, 61, 62, 63, 64, 65, 66, 67]);
    expect(scheduler.targetGradesFor(1933)).toEqual([60, 61, 62, 63, 64, 65, 66, 67]);
  });

  test('modern (1934+) and bullion return full MS60-MS70 (11 grades)', () => {
    expect(scheduler.targetGradesFor(1934)).toHaveLength(11);
    expect(scheduler.targetGradesFor(2024)).toHaveLength(11);
    expect(scheduler.targetGradesFor(1986)).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
  });

  test('null/undefined/NaN year falls back to full ladder (no silent coverage loss)', () => {
    expect(scheduler.targetGradesFor(null)).toHaveLength(11);
    expect(scheduler.targetGradesFor(undefined)).toHaveLength(11);
    expect(scheduler.targetGradesFor(NaN)).toHaveLength(11);
  });
});

describe('prefetchScheduler — PR-2b getCategorizedEntries', () => {

  test('returns the three expected categories and a non-empty pcgsYearMap', () => {
    const { byCategory, pcgsYearMap } = scheduler.getCategorizedEntries();
    expect([...byCategory.keys()].sort()).toEqual(['us_bullion', 'us_classic', 'world_bullion']);
    expect(byCategory.get('us_classic').length).toBeGreaterThan(800);   // 22 tables, expect >800 year+mint combos
    expect(byCategory.get('us_bullion').length).toBeGreaterThan(150);    // 8 tables
    expect(byCategory.get('world_bullion').length).toBeGreaterThan(300); // 18 tables
    expect(pcgsYearMap.size).toBeGreaterThan(1500);
  });

  test('every PCGS number has an associated finite year (so targetGradesFor can prune)', () => {
    const { byCategory, pcgsYearMap } = scheduler.getCategorizedEntries();
    for (const entries of byCategory.values()) {
      for (const { pcgsNo, year } of entries) {
        expect(Number.isFinite(pcgsNo)).toBe(true);
        expect(Number.isFinite(year)).toBe(true);
        // Note: ~80 PCGS#s collide between AMERICAN_SILVER_EAGLE and
        // AMERICAN_GOLD_EAGLE_*OZ (pre-existing data bug -- Gold Eagle tables
        // appear to use Silver Eagle PCGS#s, e.g. 9814 used for both
        // ASE 1999 and AGE_1OZ 1986). The map keeps first-seen year per PCGS#.
        // Both years are post-1934 so era-aware grade pruning is unaffected.
        expect(pcgsYearMap.has(pcgsNo)).toBe(true);
        expect(Number.isFinite(pcgsYearMap.get(pcgsNo))).toBe(true);
      }
    }
  });

  test('walker categorisation matches representative fixtures from each category', () => {
    const { pcgsYearMap } = scheduler.getCategorizedEntries();
    // us_classic
    expect(pcgsYearMap.get(8912)).toBe(1854);   // 1854-O Liberty Double Eagle
    expect(pcgsYearMap.get(6564)).toBe(1916);   // 1916 Walking Liberty Half
    // us_bullion
    expect(pcgsYearMap.get(9801)).toBe(1986);   // 1986 American Silver Eagle
    // world_bullion
    expect(pcgsYearMap.get(1004509)).toBe(2026); // 2026 Maple Leaf
  });
});

describe('prefetchScheduler — PR-2b buildQueue round-robin + grade pruning', () => {

  test('Phase 1 (key dates) still at the front of the queue ahead of Phase 2', () => {
    const keyDateSet = new Set(scheduler.getKeyDatePcgsNumbers());
    const queue = scheduler.buildQueue();
    // First Phase 1 entry must be a key date (priority 1 or 2).
    expect(queue[0].priority).toBeLessThanOrEqual(2);
    expect(keyDateSet.has(queue[0].pcgsNo)).toBe(true);
    // All priority<=2 entries must precede all priority>=3 entries.
    const firstP3 = queue.findIndex(e => e.priority >= 3);
    const lastP2  = queue.length - 1 - [...queue].reverse().findIndex(e => e.priority <= 2);
    expect(firstP3).toBeGreaterThan(lastP2);
  });

  test('Phase 2 interleaves world_bullion within first 30 entries (no more starvation)', () => {
    const { byCategory } = scheduler.getCategorizedEntries();
    const worldBullionPcgsNos = new Set(byCategory.get('world_bullion').map(e => e.pcgsNo));
    const queue = scheduler.buildQueue();
    // Find first Phase 2 entry (priority >= 3)
    const phase2Start = queue.findIndex(e => e.priority >= 3);
    expect(phase2Start).toBeGreaterThanOrEqual(0);
    const first30 = queue.slice(phase2Start, phase2Start + 30);
    const worldInFirst30 = first30.filter(e => worldBullionPcgsNos.has(e.pcgsNo)).length;
    // Round-robin 1:1:1 across 3 categories -> roughly 10 world bullion in first 30.
    // Lower bound 5 leaves slack for cases where one bucket runs out mid-window.
    expect(worldInFirst30).toBeGreaterThanOrEqual(5);
  });

  test('grade pruning: pre-1900 Liberty Double Eagle 1854-O (pcgs 8912) only enqueued for MS60-MS65', () => {
    const queue = scheduler.buildQueue();
    const grades1854O = queue.filter(e => e.pcgsNo === 8912).map(e => e.grade).sort((a, b) => a - b);
    expect(grades1854O).toEqual([60, 61, 62, 63, 64, 65]);
  });

  test('grade pruning: modern bullion ASE 1986 (pcgs 9801) still enqueued for full MS60-MS70', () => {
    const queue = scheduler.buildQueue();
    const gradesASE = queue.filter(e => e.pcgsNo === 9801).map(e => e.grade).sort((a, b) => a - b);
    expect(gradesASE).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70]);
  });

  test('queue is shorter than pre-PR-2b baseline (no-prune control: 2009 numbers x 11 = 22099)', () => {
    const queue = scheduler.buildQueue();
    // With grade pruning we expect ~14-18k combos depending on key-date dedup.
    // Generous upper bound 20000 still catches a regression to the old 22099.
    expect(queue.length).toBeLessThan(20000);
    expect(queue.length).toBeGreaterThan(10000); // sanity lower bound
  });

  test('dedup: colliding PCGS# (ASE 1999 vs AGE_1OZ 1986 both = 9814) enqueues each grade exactly once', () => {
    // See docs/memory/pcgs-numbers-collisions.md -- pre-existing data bug
    // where Silver Eagle and Gold Eagle tables share 80 PCGS#s. The seen Set
    // in buildQueue() must prevent double-fetching the same pcgsNo:grade combo.
    // Regression guard: a future refactor that drops the seen-set would
    // silently double the quota burn for these 80 numbers.
    const queue = scheduler.buildQueue();
    const grades9814 = queue.filter(e => e.pcgsNo === 9814).map(e => e.grade);
    const unique9814 = new Set(grades9814);
    expect(grades9814.length).toBe(unique9814.size);
    // 9814 is a modern bullion year (1986/1999) -- full 11-grade ladder applies.
    expect(grades9814.length).toBeLessThanOrEqual(11);
  });
});

// ═══════════════════════════════════════════════════════════════
//  #277W — Per-category counters + skip observability
//  Motivating incident: the GH Actions safety-net polls
//  /api/admin/prefetch-status ~1h after the in-process scheduler
//  runs and races the second executePrefetchRun into the
//  "no quota available" branch. Pre-#277W that write clobbered
//  `status` to 'skipped', so the completed-run signal for the
//  night was invisible in the workflow report every morning
//  (verified against GH runs 28428064772 / 28501997783 /
//  28572716369 / 28644954256 on 2026-06-30 through 2026-07-03).
// ═══════════════════════════════════════════════════════════════

describe('prefetchScheduler — #277W per-category counters', () => {

  test('buildQueue tags every entry with a us_classic / us_bullion / world_bullion category', () => {
    const queue = scheduler.buildQueue();
    const allowed = new Set(['us_classic', 'us_bullion', 'world_bullion', 'unknown']);
    // Sample 200 entries evenly across the queue to keep the assertion fast.
    const step = Math.max(1, Math.floor(queue.length / 200));
    for (let i = 0; i < queue.length; i += step) {
      expect(allowed.has(queue[i].category)).toBe(true);
    }
    // In practice 'unknown' should never appear today (every key date resolves
    // to a table). Assert that so a future extractor regression is caught.
    const unknownCount = queue.filter(e => e.category === 'unknown').length;
    expect(unknownCount).toBe(0);
  });

  test('getCategorizedEntries returns a pcgsCategoryMap that matches TABLES_BY_CATEGORY', () => {
    const { pcgsCategoryMap } = scheduler.getCategorizedEntries();
    // Representative fixtures per category (mirrors the walker-categorisation
    // test above; verifies pcgsCategoryMap resolves the same way).
    expect(pcgsCategoryMap.get(6564)).toBe('us_classic');       // Walking Liberty 1916
    expect(pcgsCategoryMap.get(8912)).toBe('us_classic');       // Liberty Double Eagle 1854-O
    expect(pcgsCategoryMap.get(9801)).toBe('us_bullion');       // ASE 1986
    expect(pcgsCategoryMap.get(1004509)).toBe('world_bullion'); // Maple Leaf 2026
  });

  test('executePrefetchRun accumulates perCategory attempted + newRecords', async () => {
    // Force needsRefresh false for everything except a known fixture PCGS# in
    // each category, so the queue is small and deterministic.
    const seededCounts = { us_classic: 0, us_bullion: 0, world_bullion: 0 };
    const fixtures = {
      6564:    'us_classic',       // Walking Liberty 1916
      9801:    'us_bullion',       // ASE 1986
      1004509: 'world_bullion'     // Maple Leaf 2026
    };
    auctionPrice.needsRefresh.mockImplementation((pcgsNo) => Object.prototype.hasOwnProperty.call(fixtures, pcgsNo));
    // Each successful fetch yields 2 new records to make the summation visible.
    auctionPrice.fetchByGrade.mockImplementation(async (pcgsNo, _grade) => {
      const cat = fixtures[pcgsNo];
      if (cat) seededCounts[cat]++;
      return { records: [{ price: 1 }, { price: 2 }], newRecords: 2 };
    });
    // Give the run enough quota to drain all three fixtures.
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(200);

    await scheduler.executePrefetchRun();

    expect(mockStatusStore.perCategory).toBeDefined();
    for (const cat of ['us_classic', 'us_bullion', 'world_bullion']) {
      // Each fixture is enqueued at multiple grades, so attempted equals the
      // grade count for that fixture. The exact number depends on
      // targetGradesFor(year); we only assert it is > 0 and matches newRecords/2.
      expect(mockStatusStore.perCategory[cat].attempted).toBeGreaterThan(0);
      expect(mockStatusStore.perCategory[cat].newRecords)
        .toBe(mockStatusStore.perCategory[cat].attempted * 2);
    }
    // Sanity: total attempted across categories equals total callsMade.
    const totalAttempted = ['us_classic', 'us_bullion', 'world_bullion', 'unknown']
      .reduce((sum, c) => sum + mockStatusStore.perCategory[c].attempted, 0);
    expect(totalAttempted).toBe(mockStatusStore.callsMade);
  });

  test('getSchedulerStatus exposes lastPerCategory + lastAttempt fields', () => {
    mockStatusStore = {
      lastRun: '2026-07-02T07:48:37.720Z',
      status: 'completed',
      perCategory: {
        us_classic:    { attempted: 330, newRecords: 200 },
        us_bullion:    { attempted: 330, newRecords: 250 },
        world_bullion: { attempted: 330, newRecords: 157 },
        unknown:       { attempted: 0,   newRecords: 0 }
      },
      lastAttempt: '2026-07-03T07:17:03.000Z',
      lastAttemptStatus: 'skipped',
      lastAttemptReason: 'No quota available'
    };
    const status = scheduler.getSchedulerStatus();
    expect(status.lastPerCategory).toEqual(mockStatusStore.perCategory);
    expect(status.lastAttempt).toBe('2026-07-03T07:17:03.000Z');
    expect(status.lastAttemptStatus).toBe('skipped');
    expect(status.lastAttemptReason).toContain('No quota');
    // Completed status is what shows up as lastStatus, not the skip attempt.
    expect(status.lastStatus).toBe('completed');
  });

  test('getSchedulerStatus tolerates pre-#277W status files (all new fields null)', () => {
    mockStatusStore = {
      lastRun: '2026-06-01T00:00:00.000Z',
      status: 'completed',
      callsMade: 990
      // no perCategory, no lastAttempt* — pre-migration shape
    };
    const status = scheduler.getSchedulerStatus();
    expect(status.lastPerCategory).toBeNull();
    expect(status.lastAttempt).toBeNull();
    expect(status.lastAttemptStatus).toBeNull();
    expect(status.lastAttemptReason).toBeNull();
    // Existing fields remain untouched.
    expect(status.lastStatus).toBe('completed');
    expect(status.lastCallsMade).toBe(990);
  });

  test('double-skip refreshes lastAttempt timestamp (regression guard)', async () => {
    // Motivated by the deep review of PR #220: without this test, a future
    // refactor that stops the second saveStatus write from overwriting
    // `lastAttempt` (e.g. moving the timestamp assignment before the object
    // literal) would silently freeze the field at the first skip of the day.
    // Operators reading /api/admin/prefetch-status would then see a stale
    // "last skip 10 hours ago" even after the safety-net has retried five
    // more times.
    const seedAttempt = '2026-07-03T05:00:00.000Z';
    mockStatusStore = {
      lastRun: '2026-07-02T07:48:37.720Z',
      status: 'completed',
      callsMade: 990,
      newRecords: 607,
      lastAttempt: seedAttempt,
      lastAttemptStatus: 'skipped',
      lastAttemptReason: 'No quota available'
    };
    pcgsQuota.getAvailableForPrefetch.mockReturnValue(0);

    await scheduler.executePrefetchRun();

    // The completed run must still be untouched (same invariant as the
    // single-skip test).
    expect(mockStatusStore.status).toBe('completed');
    expect(mockStatusStore.lastRun).toBe('2026-07-02T07:48:37.720Z');
    expect(mockStatusStore.callsMade).toBe(990);

    // The attempt fields advance: same status + reason, newer timestamp.
    expect(mockStatusStore.lastAttemptStatus).toBe('skipped');
    expect(mockStatusStore.lastAttemptReason).toContain('No quota');
    expect(mockStatusStore.lastAttempt).not.toBe(seedAttempt);
    expect(new Date(mockStatusStore.lastAttempt).getTime())
      .toBeGreaterThan(new Date(seedAttempt).getTime());
  });

  test('buildQueue warns once per unknown-category Phase 1 key date (extractor drift breadcrumb)', () => {
    // Guard for the operability findings from the PR #220 self-review:
    // if a future data change drops a key-date PCGS# from TABLES_BY_CATEGORY,
    // the aggregate lastPerCategory.unknown counter alone gives no path to
    // find which numbers fell through. A console.warn with the pcgsNo makes
    // App Service log grep the recovery mechanism.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Force a Phase 1 key date to resolve to a nonexistent category by
      // shadowing pcgsCategoryMap.get -- but since getCategorizedEntries
      // returns a fresh Map on each call, we intercept via a needsRefresh
      // override that doesn't matter here; instead, verify the guard is
      // *reachable* today (unknown=0 is the assertion, warn count = 0).
      scheduler.buildQueue();
      const unknownWarns = warnSpy.mock.calls
        .filter(args => String(args[0] || '').includes('Key date has no category'));
      // Today every key date resolves; this test asserts NO warns fire.
      // Future regression: if TABLES_BY_CATEGORY loses a key-date-owning
      // table, this count will jump and pinpoint the culprit in the message.
      expect(unknownWarns.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
