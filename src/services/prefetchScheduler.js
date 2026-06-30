// src/services/prefetchScheduler.js — Nightly APR prefetch scheduler
// Burns remaining PCGS API quota before midnight PT reset.
// Trigger: 11:00 PM Pacific Time (configurable via PREFETCH_HOUR_PT env var).
// Cycle: runs nightly, seeding new coins then refreshing stale entries.
// CommonJS

'use strict';

const path = require('path');
const fs = require('fs');

const pcgsQuota = require('./pcgsQuotaService');
const auctionPrice = require('./auctionPriceService');
const alertService = require('./alertService');
const { CACHE_DIR } = require('../utils/cachePath');

// ── Configuration ───────────────────────────────────────────
const PREFETCH_ENABLED = (process.env.PCGS_PREFETCH_ENABLED || 'true') !== 'false';
const PREFETCH_HOUR_PT = parseInt(process.env.PREFETCH_HOUR_PT, 10) || 23; // 11 PM Pacific
const THROTTLE_MS = parseInt(process.env.PREFETCH_THROTTLE_MS, 10) || 1000; // 1 sec between calls
const RESERVE_CALLS = parseInt(process.env.PREFETCH_RESERVE, 10) || 10;
const STATUS_PATH = path.join(CACHE_DIR, 'prefetch_status.json');

// Grades worth fetching APR data for (collectible grades)
const TARGET_GRADES = [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70];

// ── State ───────────────────────────────────────────────────
let _timer = null;
let _running = false;
let _todayCompleted = false;
let _todayDate = null;

// ── Status persistence ──────────────────────────────────────
function loadStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return { lastRun: null, status: 'never', consecutiveFailures: 0 };
  }
}

function saveStatus(status) {
  try {
    fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));
  } catch (err) {
    console.error('[prefetch] Failed to save status:', err.message);
  }
}

// ── Priority queue builder ──────────────────────────────────

/**
 * Era-aware target grades for a coin year (PR-2b).
 *
 * Rationale: querying PCGS APR for grades that have zero population is wasted
 * quota. Pre-1900 issues -- especially classic gold -- almost never grade above
 * MS65; mid-range classic-era (1900-1933) issues rarely grade above MS67.
 * Modern (1934+) and bullion: keep the full MS60-MS70 ladder.
 *
 * If `year` is null/undefined we fall back to the full ladder to avoid silently
 * dropping coverage for any number we cannot date.
 *
 * Empirical estimate (from current pcgsNumbers.js inventory):
 *   pre-1900: ~257 numbers x 6 grades  (was x11 = 1542 wasted/cycle)
 *   1900-1933: ~204 numbers x 8 grades (was x11 =  612 wasted/cycle)
 *   modern + bullion: unchanged
 */
function targetGradesFor(year) {
  if (!Number.isFinite(year)) return TARGET_GRADES;
  if (year < 1900) return [60, 61, 62, 63, 64, 65];
  if (year < 1934) return [60, 61, 62, 63, 64, 65, 66, 67];
  return TARGET_GRADES;
}

/**
 * Walk TABLES_BY_CATEGORY and emit `{pcgsNo, year}` per coin, grouped by
 * category. Also returns a `pcgsYearMap` so callers (e.g. key-date Phase 1)
 * can look up a year by PCGS number without rescanning.
 *
 * Returns: { byCategory: Map<category, [{pcgsNo, year}]>, pcgsYearMap: Map<pcgsNo, year> }
 */
function getCategorizedEntries() {
  const { TABLES_BY_CATEGORY } = require('../data/pcgsNumbers');
  const byCategory = new Map();
  const pcgsYearMap = new Map();
  for (const [category, tables] of Object.entries(TABLES_BY_CATEGORY)) {
    const entries = [];
    for (const table of Object.values(tables)) {
      for (const [yearKey, yearData] of Object.entries(table)) {
        const year = parseInt(yearKey, 10);
        if (!Number.isFinite(year) || !yearData || typeof yearData !== 'object') continue;
        for (const pcgsNo of Object.values(yearData)) {
          if (typeof pcgsNo !== 'number' || pcgsNo <= 100) continue;
          entries.push({ pcgsNo, year });
          if (!pcgsYearMap.has(pcgsNo)) pcgsYearMap.set(pcgsNo, year);
        }
      }
    }
    byCategory.set(category, entries);
  }
  return { byCategory, pcgsYearMap };
}

const PHASE2_ROUND_ROBIN_ORDER = ['us_classic', 'us_bullion', 'world_bullion'];

function sortByPriorityThenAge(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (!a.lastFetched && !b.lastFetched) return 0;
  if (!a.lastFetched) return -1;
  if (!b.lastFetched) return 1;
  return new Date(a.lastFetched) - new Date(b.lastFetched);
}

/**
 * Build priority queue of pcgsNo:grade combos to fetch.
 *
 * Phase 1 (front of queue): Key dates, era-aware grades.
 *   priority 1 = key date never-fetched
 *   priority 2 = key date stale
 *
 * Phase 2 (round-robin): Regular coins, era-aware grades, interleaved
 *   1:1:1 across us_classic / us_bullion / world_bullion so world bullion
 *   is not starved behind the much larger US block (PR-2b fix for the
 *   "0 of 749 bullion cached after 30 nightly runs" symptom recorded in
 *   getKeyDatePcgsNumbers comment).
 *
 *   priority 3 = regular never-fetched
 *   priority 4 = regular stale
 *
 *   Within each bucket entries are sorted by (priority asc, lastFetched asc).
 *   Buckets are then interleaved in PHASE2_ROUND_ROBIN_ORDER.
 */
function buildQueue() {
  const { byCategory, pcgsYearMap } = getCategorizedEntries();
  const totalNumbers = pcgsYearMap.size;
  const keyDateNumbers = getKeyDatePcgsNumbers();
  const keyDateSet = new Set(keyDateNumbers);
  const seen = new Set();

  // #214 / PR-2b: log extractor inventory so silent drops are visible.
  console.log(
    `[prefetch] Extractor inventory: ${totalNumbers} total PCGS numbers, ` +
    `${keyDateNumbers.length} key dates ` +
    `(us_classic=${byCategory.get('us_classic')?.length || 0}, ` +
    `us_bullion=${byCategory.get('us_bullion')?.length || 0}, ` +
    `world_bullion=${byCategory.get('world_bullion')?.length || 0} pre-dedup combos)`
  );

  // ── Phase 1: Key dates ──
  const phase1 = [];
  for (const pcgsNo of keyDateNumbers) {
    const year = pcgsYearMap.get(pcgsNo);
    for (const grade of targetGradesFor(year)) {
      const key = `${pcgsNo}:${grade}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!auctionPrice.needsRefresh(pcgsNo, grade)) continue;
      const entry = auctionPrice.getManifest().entries?.[key];
      phase1.push({
        pcgsNo,
        grade,
        priority: entry ? 2 : 1,
        lastFetched: entry?.lastFetched || null
      });
    }
  }
  phase1.sort(sortByPriorityThenAge);

  // ── Phase 2: Regular coins, bucketed by category ──
  const buckets = { us_classic: [], us_bullion: [], world_bullion: [] };
  for (const [category, entries] of byCategory) {
    if (!buckets[category]) continue;
    for (const { pcgsNo, year } of entries) {
      if (keyDateSet.has(pcgsNo)) continue;
      for (const grade of targetGradesFor(year)) {
        const key = `${pcgsNo}:${grade}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!auctionPrice.needsRefresh(pcgsNo, grade)) continue;
        const entry = auctionPrice.getManifest().entries?.[key];
        buckets[category].push({
          pcgsNo,
          grade,
          priority: entry ? 4 : 3,
          lastFetched: entry?.lastFetched || null
        });
      }
    }
  }
  for (const bucket of Object.values(buckets)) bucket.sort(sortByPriorityThenAge);

  // Round-robin merge so world bullion always gets a slot every 3 calls.
  // Use index pointers (not Array.shift) to keep the merge O(N) instead of
  // O(N^2) re-indexing cost.
  const phase2 = [];
  const cursors = { us_classic: 0, us_bullion: 0, world_bullion: 0 };
  let anyRemaining = true;
  while (anyRemaining) {
    anyRemaining = false;
    for (const category of PHASE2_ROUND_ROBIN_ORDER) {
      const bucket = buckets[category];
      const idx = cursors[category];
      if (idx < bucket.length) {
        phase2.push(bucket[idx]);
        cursors[category] = idx + 1;
        anyRemaining = true;
      }
    }
  }

  return [...phase1, ...phase2];
}

/**
 * Extract all unique PCGS numbers from the static tables.
 * Retained for backward compatibility (used by world-bullion-extraction
 * regression test in #214). The scheduler itself now uses
 * `getCategorizedEntries()` so it can attach year + category to each number.
 *
 * Range 3-7 digits covers US coins (4-6 digits) and world bullion (6-7 digits,
 * e.g. Kookaburra 114425, Maple Leaf 1004509). #214.
 */
function extractAllPcgsNumbers() {
  try {
    const src = fs.readFileSync(path.resolve(__dirname, '../data/pcgsNumbers.js'), 'utf8');
    const matches = src.match(/:\s*(\d{3,7})\b/g);
    if (!matches) return [];
    const numbers = [...new Set(matches.map(m => parseInt(m.replace(/[:\s]/g, ''), 10)))];
    return numbers.filter(n => n > 100); // filter out noise
  } catch {
    return [];
  }
}

/**
 * Get PCGS numbers for key date coins (highest priority).
 *
 * BUGFIX 2026-06-29: previously did `const KEY_DATES = require('../data/keyDates')`
 * which returned the module object `{ KEY_DATES, lookupKeyDate }` instead of the
 * array. The `for (const kd of KEY_DATES)` then threw `TypeError: not iterable`,
 * which the surrounding try/catch silently swallowed, returning [] forever.
 * Net effect: Phase 1 (key-date priority) was disabled from the moment the
 * prefetch scheduler shipped. Spike on 2026-06-29 confirmed 0 of 749 bullion
 * PCGS#s cached after ~30 nightly runs.
 */
function getKeyDatePcgsNumbers() {
  try {
    const { KEY_DATES } = require('../data/keyDates');
    const { lookupPCGSNumber } = require('../data/pcgsNumbers');
    const numbers = [];
    for (const kd of KEY_DATES) {
      const pcgsNo = lookupPCGSNumber(kd.series, kd.year, kd.mint);
      if (pcgsNo) numbers.push(pcgsNo);
    }
    return [...new Set(numbers)];
  } catch {
    return [];
  }
}

// ── Main execution ──────────────────────────────────────────

/**
 * Execute the nightly prefetch run.
 * Burns all remaining quota (minus reserve) on APR calls.
 */
async function executePrefetchRun() {
  if (_running) {
    console.log('[prefetch] Already running, skipping');
    return;
  }
  _running = true;
  const startTime = Date.now();
  let callsMade = 0;
  let recordsStored = 0;
  let newRecords = 0;
  const errors = [];

  console.log('[prefetch] Starting nightly APR prefetch run...');

  try {
    const available = pcgsQuota.getAvailableForPrefetch(RESERVE_CALLS);
    if (available <= 0) {
      console.log('[prefetch] No quota available (breaker tripped or fully used)');
      saveStatus({
        ...loadStatus(),
        lastAttempt: new Date().toISOString(),
        status: 'skipped',
        reason: 'No quota available',
        nextScheduled: getNextRunTime().toISOString()
      });
      return;
    }

    console.log(`[prefetch] Quota available: ${available} calls (reserve: ${RESERVE_CALLS})`);
    const queue = buildQueue();
    console.log(`[prefetch] Queue size: ${queue.length} combos to fetch`);

    if (queue.length === 0) {
      console.log('[prefetch] All entries are fresh — nothing to do');
      saveStatus({
        ...loadStatus(),
        lastRun: new Date().toISOString(),
        status: 'completed',
        reason: 'All entries fresh',
        callsMade: 0,
        nextScheduled: getNextRunTime().toISOString(),
        consecutiveFailures: 0
      });
      return;
    }

    const limit = Math.min(available, queue.length);

    for (let i = 0; i < limit; i++) {
      // Check breaker before each call
      if (pcgsQuota.isBreakerTripped()) {
        console.warn('[prefetch] Breaker tripped mid-run, stopping');
        break;
      }

      const { pcgsNo, grade } = queue[i];
      try {
        const result = await auctionPrice.fetchByGrade(pcgsNo, grade, { force: true });
        callsMade++;
        recordsStored += result.records.length;
        newRecords += result.newRecords || 0;
      } catch (err) {
        callsMade++;
        const errMsg = `${pcgsNo}:${grade} — ${err.message}`;
        errors.push(errMsg);
        // On 429, stop immediately (breaker already tripped by auctionPriceService)
        if (err.message.includes('429') || err.message.includes('breaker')) {
          console.warn(`[prefetch] Rate limited at call ${callsMade}, stopping`);
          break;
        }
        // On other errors, continue but log
        console.warn(`[prefetch] Error on ${pcgsNo}:${grade}: ${err.message}`);
      }

      // Throttle between calls
      if (i < limit - 1) {
        await new Promise(r => setTimeout(r, THROTTLE_MS));
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const status = errors.length > 0 ? 'partial' : 'completed';
    console.log(`[prefetch] ${status}: ${callsMade} calls, ${newRecords} new records, ${errors.length} errors in ${duration}s`);

    const prevStatus = loadStatus();
    saveStatus({
      lastRun: new Date().toISOString(),
      status,
      duration: `${duration}s`,
      callsMade,
      recordsStored,
      newRecords,
      errors: errors.slice(0, 20), // cap stored errors
      consecutiveFailures: status === 'completed' ? 0 : (prevStatus.consecutiveFailures || 0) + 1,
      nextScheduled: getNextRunTime().toISOString(),
      queueRemaining: Math.max(0, queue.length - callsMade)
    });

    auctionPrice.updateRunStatus(status, { callsMade, recordsStored, newRecords });

  } catch (err) {
    console.error('[prefetch] Fatal error:', err.message);
    const prevStatus = loadStatus();
    const failures = (prevStatus.consecutiveFailures || 0) + 1;
    saveStatus({
      lastRun: new Date().toISOString(),
      status: 'failed',
      error: err.message,
      callsMade,
      consecutiveFailures: failures,
      nextScheduled: getNextRunTime().toISOString()
    });
    if (failures >= 2) {
      alertService.alertPrefetchFailure(failures, err.message);
    }
  } finally {
    _running = false;
    _todayCompleted = true;
    _todayDate = todayPacific();
  }
}

// ── Scheduling ──────────────────────────────────────────────

function todayPacific() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function toPacificDate(isoString) {
  return new Date(isoString).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function getCurrentPacificHour() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }), 10);
}

/**
 * Calculate the next run time (next occurrence of PREFETCH_HOUR_PT in Pacific).
 */
function getNextRunTime() {
  const now = new Date();
  // Calculate today's target time in Pacific
  // Use a simple approach: find the UTC offset for Pacific and compute
  const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const utcOffset = now - pacificNow; // diff between UTC and Pacific representation

  const target = new Date(pacificNow);
  target.setHours(PREFETCH_HOUR_PT, 0, 0, 0);

  // If target is in the past today, schedule for tomorrow
  if (target <= pacificNow) {
    target.setDate(target.getDate() + 1);
  }

  // Convert back to UTC
  return new Date(target.getTime() + utcOffset);
}

/**
 * Schedule the next run using setTimeout.
 */
function scheduleNext() {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }

  const nextRun = getNextRunTime();
  const delay = nextRun - new Date();

  if (delay <= 0) {
    // Should run now (e.g., server just started and we're past the hour)
    console.log('[prefetch] Past scheduled time, checking if already ran today...');
    if (_todayDate !== todayPacific() || !_todayCompleted) {
      executePrefetchRun().then(scheduleNext).catch(_handleScheduleError);
    } else {
      // Already ran today, schedule for tomorrow
      _timer = setTimeout(() => {
        _todayCompleted = false;
        executePrefetchRun().then(scheduleNext).catch(_handleScheduleError);
      }, 24 * 60 * 60 * 1000);
    }
    return;
  }

  console.log(`[prefetch] Next run scheduled: ${nextRun.toISOString()} (in ${(delay / 3600000).toFixed(1)}h)`);
  _timer = setTimeout(() => {
    _todayCompleted = false;
    executePrefetchRun().then(scheduleNext).catch(_handleScheduleError);
  }, delay);
}

// #194: Catch handler for schedule chain — prevents scheduler from dying silently
function _handleScheduleError(err) {
  console.error('[prefetch] Schedule chain error:', err.message);
  alertService.alertPrefetchFailure(1, `Schedule chain broken: ${err.message}`);
  // Re-schedule despite error so the scheduler doesn't die permanently
  setTimeout(scheduleNext, 60 * 60 * 1000); // retry in 1 hour
}

/**
 * Initialize the scheduler. Called once from server.js on startup.
 */
function init() {
  if (!PREFETCH_ENABLED) {
    console.log('[prefetch] Disabled (PCGS_PREFETCH_ENABLED=false)');
    return;
  }

  if (!process.env.PCGS_API_KEY) {
    console.log('[prefetch] Disabled (no PCGS_API_KEY configured)');
    return;
  }

  // Check if we missed today's run (server restart after scheduled time)
  const status = loadStatus();
  const lastRunDate = status.lastRun ? toPacificDate(status.lastRun) : null;
  const today = todayPacific();
  const currentHour = getCurrentPacificHour();

  if (currentHour >= PREFETCH_HOUR_PT && lastRunDate !== today) {
    // We're past the trigger time and haven't run today -- run now (delayed 30s for startup)
    console.log(`[prefetch] Missed today's run (hour=${currentHour} >= ${PREFETCH_HOUR_PT}), executing in 30s...`);
    setTimeout(() => {
      executePrefetchRun().then(scheduleNext).catch(_handleScheduleError);
    }, 30000);
  } else {
    scheduleNext();
  }
}

/**
 * Get current scheduler status (for admin endpoint).
 */
function getSchedulerStatus() {
  const status = loadStatus();
  const quota = pcgsQuota.getStatus();
  return {
    enabled: PREFETCH_ENABLED,
    running: _running,
    todayCompleted: _todayCompleted,
    triggerTime: `${PREFETCH_HOUR_PT}:00 PT`,
    quotaResetTime: '00:00 PT',
    nextScheduled: status.nextScheduled || getNextRunTime().toISOString(),
    lastRun: status.lastRun,
    lastStatus: status.status,
    lastDuration: status.duration || null,
    lastCallsMade: status.callsMade || 0,
    lastNewRecords: status.newRecords || 0,
    lastErrors: status.errors || [],
    consecutiveFailures: status.consecutiveFailures || 0,
    queueRemaining: status.queueRemaining || 0,
    quota: {
      used: quota.used,
      remaining: quota.remaining,
      limit: quota.limit,
      breakerTripped: quota.breakerTripped
    }
  };
}

/**
 * Manually trigger a prefetch run (for admin/testing).
 * Returns immediately (202 Accepted) and runs async in background.
 * Idempotent: won't run twice in the same calendar day (Pacific Time).
 */
function triggerManual() {
  const today = todayPacific();
  
  // Already ran today
  if (_todayCompleted && _todayDate === today) {
    const status = loadStatus();
    return { 
      started: false, 
      reason: 'Already completed today',
      lastRun: status.lastRun,
      callsMade: status.callsMade,
      newRecords: status.newRecords
    };
  }
  
  // Already in progress
  if (_running) {
    return { 
      started: false, 
      reason: 'Run already in progress',
      lastRun: loadStatus().lastRun
    };
  }
  
  // Fire and forget (no await) — runs in background
  executePrefetchRun().then(_handleRunComplete).catch(_handleRunError);
  
  return { 
    started: true, 
    reason: 'Prefetch run triggered, executing in background',
    nextStatus: 'Check /api/admin/prefetch-status for progress'
  };
}

/**
 * Handle successful completion of background prefetch.
 */
function _handleRunComplete() {
  const status = loadStatus();
  console.log(`[prefetch] Run completed: ${status.callsMade} calls, ${status.newRecords} new records`);
}

/**
 * Handle error in background prefetch.
 */
function _handleRunError(err) {
  console.error('[prefetch] Background run failed:', err.message);
  const status = loadStatus();
  const failures = (status.consecutiveFailures || 0) + 1;
  if (failures >= 2) {
    alertService.alertPrefetchFailure(failures, err.message);
  }
}

module.exports = {
  init,
  getSchedulerStatus,
  triggerManual,
  executePrefetchRun,
  // Export for workflow status checks
  todayPacific,
  // Exposed for regression tests (keep Phase 1 key-date resolution covered)
  getKeyDatePcgsNumbers,
  // PR-2b: exposed so tests can assert grade-pruning + round-robin behaviour
  // without spinning up the full executePrefetchRun loop.
  targetGradesFor,
  getCategorizedEntries,
  buildQueue,
  extractAllPcgsNumbers
};
