// src/services/prefetchScheduler.js — Nightly APR prefetch scheduler
// Uses the nightly PCGS API budget before midnight PT reset.
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
const logger = require('../utils/logger').child({ component: 'prefetch' });

// ── Configuration ───────────────────────────────────────────
const PREFETCH_ENABLED = (process.env.PCGS_PREFETCH_ENABLED || 'true') !== 'false';
const PREFETCH_HOUR_PT = parseInt(process.env.PREFETCH_HOUR_PT, 10) || 23; // 11 PM Pacific
const THROTTLE_MS = parseInt(process.env.PREFETCH_THROTTLE_MS, 10) || 1000; // 1 sec between calls
const LOCAL_DAILY_LIMIT = Number.isInteger(pcgsQuota.DAILY_LIMIT) ? pcgsQuota.DAILY_LIMIT : 1000;

function parseBoundedInteger(value, fallback, minimum, maximum) {
  const normalized = value == null ? '' : String(value).trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

const RESERVE_CALLS = parseBoundedInteger(process.env.PREFETCH_RESERVE, 10, 0, LOCAL_DAILY_LIMIT);
const OBSERVED_UPSTREAM_LIMIT = parseBoundedInteger(
  process.env.PCGS_PREFETCH_OBSERVED_LIMIT,
  100,
  1,
  LOCAL_DAILY_LIMIT
);
const STATUS_PATH = path.join(CACHE_DIR, 'prefetch_status.json');
const ALERT_FAILURE_THRESHOLD = 2;
const INVALID_RESPONSE_ABORT_THRESHOLD = 5;
const SYSTEMIC_REJECTION_ABORT_THRESHOLD = 5;
const SYSTEMIC_RECOVERY_PROBE = Object.freeze({
  pcgsNo: 7130,
  grade: 65,
  category: 'us_classic',
  priority: 0,
  diagnostic: 'known-good-systemic-recovery'
});

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
    logger.error({ err, event: 'status_save_failed' }, 'Failed to save prefetch status');
  }
}

function maybeAlertPrefetchFailure(status, consecutiveFailures, detail) {
  if (status === 'completed' || consecutiveFailures < ALERT_FAILURE_THRESHOLD) return;
  alertService.alertPrefetchFailure(consecutiveFailures, detail);
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
 * Returns: {
 *   byCategory:      Map<category, [{pcgsNo, year}]>,
 *   pcgsYearMap:     Map<pcgsNo, year>,
 *   pcgsCategoryMap: Map<pcgsNo, category>   // first-seen category wins on collisions
 * }
 *
 * `pcgsCategoryMap` is used by `buildQueue` (Phase 1 tagging) and by
 * `executePrefetchRun` (per-category attempt / newRecord counters). Kept on
 * the same walk so it is O(N) rather than a second pass. First-seen wins on
 * cross-category collisions (see docs/memory/pcgs-numbers-collisions.md:
 * ASE/AGE share ~80 PCGS#s; both fall in us_bullion so no observable
 * divergence today).
 */
function getCategorizedEntries() {
  const { TABLES_BY_CATEGORY } = require('../data/pcgsNumbers');
  const byCategory = new Map();
  const pcgsYearMap = new Map();
  const pcgsCategoryMap = new Map();
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
          if (!pcgsCategoryMap.has(pcgsNo)) pcgsCategoryMap.set(pcgsNo, category);
        }
      }
    }
    byCategory.set(category, entries);
  }
  return { byCategory, pcgsYearMap, pcgsCategoryMap };
}

const PHASE2_ROUND_ROBIN_ORDER = ['us_classic', 'us_bullion', 'world_bullion'];

function sortByPriorityThenAge(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (!a.lastFetched && !b.lastFetched) return 0;
  if (!a.lastFetched) return -1;
  if (!b.lastFetched) return 1;
  return new Date(a.lastFetched) - new Date(b.lastFetched);
}

function logMissingKeyDateCategories(keyDateNumbers, pcgsCategoryMap) {
  for (const pcgsNo of new Set(keyDateNumbers)) {
    if (!pcgsCategoryMap.has(pcgsNo)) {
      logger.warn({ event: 'key_date_category_missing', pcgsNo }, 'Key date has no category');
    }
  }
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
  const { byCategory, pcgsYearMap, pcgsCategoryMap } = getCategorizedEntries();
  const totalNumbers = pcgsYearMap.size;
  const keyDateNumbers = getKeyDatePcgsNumbers();
  const keyDateSet = new Set(keyDateNumbers);
  const seen = new Set();

  // #214 / PR-2b: log extractor inventory so silent drops are visible.
  logger.info({
    event: 'extractor_inventory',
    totalNumbers,
    keyDateCount: keyDateNumbers.length,
    categoryCounts: {
      usClassic: byCategory.get('us_classic')?.length || 0,
      usBullion: byCategory.get('us_bullion')?.length || 0,
      worldBullion: byCategory.get('world_bullion')?.length || 0,
    },
  }, 'Built prefetch extractor inventory');

  // ── Phase 1: Key dates ──
  // #277W: tag each entry with its source category so downstream counters can
  // attribute API calls (and new-record yield) per category. Key dates that
  // are not present in any TABLES_BY_CATEGORY table get category='unknown';
  // this should be zero today but is tolerated rather than dropped so a
  // future extractor gap does not silently exclude them from the queue.
  // A warn is emitted once per unknown PCGS# so App Service log grep can
  // recover the diagnostic breadcrumb -- lastPerCategory.unknown alone is
  // an aggregate count with no way to identify which numbers fell through.
  logMissingKeyDateCategories(keyDateNumbers, pcgsCategoryMap);
  const phase1 = [];
  for (const pcgsNo of keyDateNumbers) {
    const year = pcgsYearMap.get(pcgsNo);
    const category = pcgsCategoryMap.get(pcgsNo) || 'unknown';
    for (const grade of targetGradesFor(year)) {
      const key = `${pcgsNo}:${grade}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!auctionPrice.needsRefresh(pcgsNo, grade)) continue;
      const entry = auctionPrice.getManifest().entries?.[key];
      phase1.push({
        pcgsNo,
        grade,
        category,
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
          category,
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
 * Uses available quota up to the observed upstream limit minus reserve.
 */
async function executePrefetchRun() {
  if (_running) {
    logger.info({ event: 'run_skipped', reason: 'already_running' }, 'Prefetch run skipped');
    return;
  }
  _running = true;
  const startTime = Date.now();
  let callsMade = 0;
  let recordsStored = 0;
  let newRecords = 0;
  // #277W: per-category attempt / newRecord counters. `attempted` increments
  // on every fetch (success OR error) so the sum matches callsMade. `newRecords`
  // only increments on success. `unknown` catches Phase 1 key dates that failed
  // category resolution (should be zero today; kept for observability).
  const perCategory = {
    us_classic:    { attempted: 0, newRecords: 0 },
    us_bullion:    { attempted: 0, newRecords: 0 },
    world_bullion: { attempted: 0, newRecords: 0 },
    unknown:       { attempted: 0, newRecords: 0 }
  };
  const errors = [];
  const rejectedTargets = [];
  const systemicRejectedTargets = new Set();
  let invalidResponses = 0;
  let consecutiveInvalidResponses = 0;

  logger.info({ event: 'run_started' }, 'Starting nightly APR prefetch run');

  try {
    let available = pcgsQuota.getAvailableForPrefetch(RESERVE_CALLS);
    const quotaAtStart = pcgsQuota.getStatus();
    const observedBudget = Math.max(0, OBSERVED_UPSTREAM_LIMIT - quotaAtStart.used - RESERVE_CALLS);
    available = Math.min(available, observedBudget);
    if (available <= 0) {
      const quotaStatus = pcgsQuota.getStatus();
      const skipReason = quotaStatus.upstreamAvailability === 'cooldown'
        ? `PCGS upstream cooldown until ${quotaStatus.nextEligibleProbeAt}`
        : 'No quota available';
      logger.info({ event: 'run_skipped', reason: skipReason }, 'Prefetch run skipped');
      // #277W: DO NOT overwrite `status` / `reason` / `lastRun` / `callsMade`
      // here. Those describe the LAST REAL RUN and are what the admin dashboard
      // and GH Actions safety-net workflow report. A safety-net trigger that
      // lands after the in-process scheduler has already burned quota should
      // record the skip attempt in a separate namespace so the completed-run
      // signal is preserved. See docs/memory/background-processes-status.md.
      saveStatus({
        ...loadStatus(),
        lastAttempt: new Date().toISOString(),
        lastAttemptStatus: 'skipped',
        lastAttemptReason: skipReason,
        nextScheduled: getNextRunTime().toISOString()
      });
      return;
    }

    logger.info({
      event: 'quota_available',
      available,
      reserveCalls: RESERVE_CALLS,
      observedUpstreamLimit: OBSERVED_UPSTREAM_LIMIT,
      localQuotaLimit: quotaAtStart.limit,
    }, 'Prefetch quota available');
    let queue = buildQueue();
    const systemicRecoveryProbePending = pcgsQuota.isSystemicRecoveryProbeRequired?.() || false;
    if (systemicRecoveryProbePending) {
      queue = [
        SYSTEMIC_RECOVERY_PROBE,
        ...queue.filter(({ pcgsNo, grade }) => pcgsNo !== SYSTEMIC_RECOVERY_PROBE.pcgsNo
          || grade !== SYSTEMIC_RECOVERY_PROBE.grade)
      ];
    }
    logger.info({ event: 'queue_built', queueSize: queue.length }, 'Prefetch queue built');

    if (queue.length === 0) {
      logger.info({ event: 'run_skipped', reason: 'all_entries_fresh' }, 'Prefetch run skipped');
      saveStatus({
        ...loadStatus(),
        lastRun: new Date().toISOString(),
        status: 'completed',
        reason: 'All entries fresh',
        callsMade: 0,
        perCategory,
        nextScheduled: getNextRunTime().toISOString(),
        consecutiveFailures: 0
      });
      return;
    }

    let limit = Math.min(available, queue.length);
    let recoveryProbePending = pcgsQuota.isRecoveryProbeRequired?.() || false;

    for (let i = 0; i < limit; i++) {
      // Check breaker before each call
      if (pcgsQuota.isBreakerTripped()) {
        logger.warn({ event: 'breaker_tripped', callsMade }, 'Prefetch breaker tripped mid-run');
        break;
      }

      const { pcgsNo, grade, category } = queue[i];
      const bucket = perCategory[category] || perCategory.unknown;
      try {
        const result = await auctionPrice.fetchByGrade(pcgsNo, grade, { force: true });
        callsMade++;
        bucket.attempted++;
        recordsStored += result.records.length;
        const gained = result.newRecords || 0;
        newRecords += gained;
        bucket.newRecords += gained;
        consecutiveInvalidResponses = 0;
        if (recoveryProbePending) {
          recoveryProbePending = false;
          available = pcgsQuota.getAvailableForPrefetch(RESERVE_CALLS);
          limit = Math.min(available, observedBudget, queue.length);
          logger.info({ event: 'recovery_probe_succeeded', limit }, 'Prefetch recovery probe succeeded');
        }
      } catch (err) {
        callsMade++;
        bucket.attempted++;
        const errMsg = `${pcgsNo}:${grade} - ${err.message}`;
        errors.push(errMsg);
        if (err.code === 'PCGS_INVALID_RESPONSE') {
          invalidResponses++;
          consecutiveInvalidResponses++;
          rejectedTargets.push({
            pcgsNo,
            grade,
            reason: err.rejectionReason || 'IsValidRequest=false',
            scope: err.rejectionScope || 'target-specific',
            quarantinePersisted: err.quarantinePersisted !== false
          });
          logger.warn({
            event: 'invalid_response',
            pcgsNo,
            grade,
            reason: err.rejectionReason,
            consecutiveInvalidResponses
          }, 'PCGS rejected prefetch target');
          if (recoveryProbePending) {
            recoveryProbePending = false;
            if (systemicRecoveryProbePending) {
              pcgsQuota.tripSystemicRejection?.({ reason: err.rejectionReason });
            }
            logger.warn({
              event: 'recovery_probe_failed',
              pcgsNo,
              grade,
              reason: err.rejectionReason
            }, 'Prefetch recovery probe returned an invalid response');
            break;
          }
          if (err.rejectionScope === 'systemic') {
            systemicRejectedTargets.add(`${pcgsNo}:${grade}`);
            if (systemicRejectedTargets.size >= SYSTEMIC_REJECTION_ABORT_THRESHOLD) {
              pcgsQuota.tripSystemicRejection?.({ reason: err.rejectionReason });
              logger.warn({
                event: 'systemic_invalid_response_threshold',
                invalidResponses,
                distinctTargets: systemicRejectedTargets.size,
                threshold: SYSTEMIC_REJECTION_ABORT_THRESHOLD
              }, 'Stopping prefetch after generic PCGS rejections across unrelated targets');
              break;
            }
          }
          if (invalidResponses >= INVALID_RESPONSE_ABORT_THRESHOLD) {
            logger.warn({
              event: 'invalid_response_threshold',
              invalidResponses,
              threshold: INVALID_RESPONSE_ABORT_THRESHOLD
            }, 'Stopping prefetch after excessive invalid PCGS responses');
            break;
          }
        } else {
          // On 429, stop immediately (breaker already tripped by auctionPriceService)
          if (err.message.includes('429') || err.message.includes('breaker')) {
            logger.warn({ event: 'rate_limited', callsMade, pcgsNo, grade }, 'Prefetch rate limited');
            break;
          }
          if (recoveryProbePending) {
            if (systemicRecoveryProbePending) {
              pcgsQuota.tripSystemicRejection?.({ reason: 'Systemic APR recovery probe failed' });
            }
            logger.warn({ err, event: 'recovery_probe_failed', callsMade, pcgsNo, grade }, 'Prefetch recovery probe failed');
            break;
          }
          // On other errors, continue but log
          logger.warn({ err, event: 'fetch_failed', pcgsNo, grade }, 'Prefetch item failed');
        }
      }

      // Throttle between calls
      if (i < limit - 1) {
        await new Promise(r => setTimeout(r, THROTTLE_MS));
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const status = errors.length > 0 ? 'partial' : 'completed';
    logger.info({
      event: 'run_completed',
      status,
      callsMade,
      newRecords,
      errorCount: errors.length,
      durationMs: Number(duration) * 1000,
    }, 'Prefetch run completed');

    const prevStatus = loadStatus();
    const consecutiveFailures = status === 'completed'
      ? 0
      : (prevStatus.consecutiveFailures || 0) + 1;
    saveStatus({
      lastRun: new Date().toISOString(),
      status,
      duration: `${duration}s`,
      callsMade,
      recordsStored,
      newRecords,
      perCategory,
      errors: errors.slice(0, 20), // cap stored errors
      invalidResponses,
      rejectedTargets: rejectedTargets.slice(0, 20),
      consecutiveFailures,
      nextScheduled: getNextRunTime().toISOString(),
      queueRemaining: Math.max(0, queue.length - callsMade)
    });

    auctionPrice.updateRunStatus(status, { callsMade, recordsStored, newRecords });
    maybeAlertPrefetchFailure(
      status,
      consecutiveFailures,
      `Partial run: ${errors.length} errors in ${callsMade} calls. First error: ${errors[0] || 'unknown'}`
    );

  } catch (err) {
    logger.error({ err, event: 'run_failed', callsMade }, 'Prefetch run failed');
    const prevStatus = loadStatus();
    const failures = (prevStatus.consecutiveFailures || 0) + 1;
    saveStatus({
      lastRun: new Date().toISOString(),
      status: 'failed',
      error: err.message,
      callsMade,
      perCategory,
      consecutiveFailures: failures,
      nextScheduled: getNextRunTime().toISOString()
    });
    maybeAlertPrefetchFailure('failed', failures, err.message);
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
    logger.info({ event: 'schedule_due' }, 'Prefetch schedule is due');
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

  logger.info({ event: 'run_scheduled', nextRun: nextRun.toISOString(), delayMs: delay }, 'Next prefetch run scheduled');
  _timer = setTimeout(() => {
    _todayCompleted = false;
    executePrefetchRun().then(scheduleNext).catch(_handleScheduleError);
  }, delay);
}

// #194: Catch handler for schedule chain — prevents scheduler from dying silently
function _handleScheduleError(err) {
  logger.error({ err, event: 'schedule_failed' }, 'Prefetch schedule chain failed');
  alertService.alertPrefetchFailure(1, `Schedule chain broken: ${err.message}`);
  // Re-schedule despite error so the scheduler doesn't die permanently
  setTimeout(scheduleNext, 60 * 60 * 1000); // retry in 1 hour
}

/**
 * Initialize the scheduler. Called once from server.js on startup.
 */
function init() {
  if (!PREFETCH_ENABLED) {
    logger.info({ event: 'scheduler_disabled', reason: 'configuration' }, 'Prefetch scheduler disabled');
    return;
  }

  if (!process.env.PCGS_API_KEY) {
    logger.info({ event: 'scheduler_disabled', reason: 'pcgs_api_key_missing' }, 'Prefetch scheduler disabled');
    return;
  }

  // Check if we missed today's run (server restart after scheduled time)
  const status = loadStatus();
  const lastRunDate = status.lastRun ? toPacificDate(status.lastRun) : null;
  const today = todayPacific();
  const currentHour = getCurrentPacificHour();

  if (currentHour >= PREFETCH_HOUR_PT && lastRunDate !== today) {
    // We're past the trigger time and haven't run today -- run now (delayed 30s for startup)
    logger.info({ event: 'missed_run_detected', currentHour, scheduledHour: PREFETCH_HOUR_PT, delayMs: 30000 }, 'Missed prefetch run detected');
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
  const observedBudgetRemaining = Math.max(0, OBSERVED_UPSTREAM_LIMIT - quota.used - RESERVE_CALLS);
  const localBudgetRemaining = quota.upstreamAvailability === 'cooldown'
    ? 0
    : Math.max(0, quota.remaining - RESERVE_CALLS);
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
    // #277W: per-category attempt / newRecord counts from the last real run.
    // null when no run has recorded categorised numbers yet (pre-#277W status
    // files, or the module has just been loaded on a fresh cache).
    lastPerCategory: status.perCategory || null,
    // #277W: safety-net trigger that lands after quota is exhausted writes
    // ONLY these three fields, leaving lastRun / lastStatus intact for the
    // completed run they raced with. null on first boot.
    lastAttempt: status.lastAttempt || null,
    lastAttemptStatus: status.lastAttemptStatus || null,
    lastAttemptReason: status.lastAttemptReason || null,
    lastErrors: status.errors || [],
    lastInvalidResponses: status.invalidResponses || 0,
    lastRejectedTargets: status.rejectedTargets || [],
    consecutiveFailures: status.consecutiveFailures || 0,
    queueRemaining: status.queueRemaining || 0,
    quota: {
      used: quota.used,
      remaining: quota.remaining,
      limit: quota.limit,
      breakerTripped: quota.breakerTripped,
      localQuotaRemaining: quota.remaining,
      upstreamAvailability: quota.upstreamAvailability || 'available',
      upstreamBlockType: quota.upstreamBlockType || null,
      nextEligibleProbeAt: quota.nextEligibleProbeAt || null,
      rateLimitedAt: quota.rateLimitedAt || null,
      rateLimitReason: quota.rateLimitReason || null,
      upstreamReportedRemaining: quota.upstreamReportedRemaining ?? null,
      upstreamReportedLimit: quota.upstreamReportedLimit ?? null,
      prefetchObservedLimit: OBSERVED_UPSTREAM_LIMIT,
      prefetchBudgetRemaining: Math.min(observedBudgetRemaining, localBudgetRemaining),
      lastProbeAt: quota.lastProbeAt || null,
      lastProbeOutcome: quota.lastProbeOutcome || null
    },
    upstreamAvailability: quota.upstreamAvailability || 'available'
  };
}

/**
 * Manually trigger a prefetch run (for admin/testing).
 * Returns immediately (202 Accepted) and runs async in background.
 * Idempotent: won't run twice in the same calendar day (Pacific Time).
 */
function triggerManual() {
  const today = todayPacific();
  const quota = pcgsQuota.getStatus();
  const status = loadStatus();

  if (quota.upstreamAvailability === 'cooldown') {
    return {
      started: false,
      reason: `PCGS upstream cooldown until ${quota.nextEligibleProbeAt}`,
      nextEligibleProbeAt: quota.nextEligibleProbeAt
    };
  }
  
  // Already ran today
  const persistedRunCompletedToday = status.lastRun && toPacificDate(status.lastRun) === today;
  if (quota.upstreamAvailability !== 'probe-required'
      && ((_todayCompleted && _todayDate === today) || persistedRunCompletedToday)) {
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
  logger.info({ event: 'background_run_completed', callsMade: status.callsMade, newRecords: status.newRecords }, 'Background prefetch run completed');
}

/**
 * Handle error in background prefetch.
 */
function _handleRunError(err) {
  logger.error({ err, event: 'background_run_failed' }, 'Background prefetch run failed');
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
  logMissingKeyDateCategories,
  buildQueue,
  extractAllPcgsNumbers,
  parseBoundedInteger,
  SYSTEMIC_RECOVERY_PROBE
};
