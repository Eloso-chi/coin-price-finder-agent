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
 * Build priority queue of pcgsNo:grade combos to fetch.
 * Priority: 1) Key dates never-fetched, 2) Key dates stale,
 * 3) Regular coins never-fetched, 4) Regular coins stale.
 */
function buildQueue() {
  const queue = [];

  // Get all PCGS numbers from our static data
  const allPcgsNumbers = extractAllPcgsNumbers();
  const keyDateNumbers = getKeyDatePcgsNumbers();

  // #214: log extractor inventory so silent drops (e.g. regex mis-matches) are visible.
  console.log(
    `[prefetch] Extractor inventory: ${allPcgsNumbers.length} total PCGS numbers, ` +
    `${keyDateNumbers.length} key dates`
  );

  // Separate key dates from regular
  const keyDateSet = new Set(keyDateNumbers);

  // Phase 1: Key dates (never fetched)
  for (const pcgsNo of keyDateNumbers) {
    for (const grade of TARGET_GRADES) {
      if (auctionPrice.needsRefresh(pcgsNo, grade)) {
        const entry = auctionPrice.getManifest().entries?.[`${pcgsNo}:${grade}`];
        queue.push({
          pcgsNo,
          grade,
          priority: entry ? 2 : 1, // 1 = never fetched key date, 2 = stale key date
          lastFetched: entry?.lastFetched || null
        });
      }
    }
  }

  // Phase 2: Regular coins
  for (const pcgsNo of allPcgsNumbers) {
    if (keyDateSet.has(pcgsNo)) continue; // already handled
    for (const grade of TARGET_GRADES) {
      if (auctionPrice.needsRefresh(pcgsNo, grade)) {
        const entry = auctionPrice.getManifest().entries?.[`${pcgsNo}:${grade}`];
        queue.push({
          pcgsNo,
          grade,
          priority: entry ? 4 : 3, // 3 = never fetched regular, 4 = stale regular
          lastFetched: entry?.lastFetched || null
        });
      }
    }
  }

  // Sort: priority asc, then oldest lastFetched first (null = never fetched = earliest)
  queue.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (!a.lastFetched && !b.lastFetched) return 0;
    if (!a.lastFetched) return -1;
    if (!b.lastFetched) return 1;
    return new Date(a.lastFetched) - new Date(b.lastFetched);
  });

  return queue;
}

/**
 * Extract all unique PCGS numbers from the static tables.
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
  getKeyDatePcgsNumbers
};
