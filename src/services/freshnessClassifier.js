// src/services/freshnessClassifier.js
// Shared freshness classification + refresh-skip logic.
//
// Used by:
//   - scripts/generate-freshness-report.js  (priority queue generator)
//   - src/services/adminService.js          (/api/admin/stale-datasets)
//
// Keeping this in one place ensures the admin staleness API and the
// freshness report agree on which datasets should be skipped from refresh.

'use strict';

// ── Thresholds ──────────────────────────────────────────────
const STALE_THRESHOLD_DAYS = 15;
const VERY_STALE_MULTIPLIER = 2; // very-stale = 2x stale threshold

const THIN_MARKET_THRESHOLD = 10;     // <10 comps = thin market
const CONFIRMED_THIN_REFRESHES = 3;   // After N refreshes still thin = confirmed-thin
const CONFIRMED_THIN_CADENCE_DAYS = 90; // Confirmed-thin: only refresh every 90d
const THIN_MARKET_CADENCE_DAYS = 60;  // Thin (not yet confirmed): refresh every 60d
const RECENTLY_REFRESHED_DAYS = 14;   // Stale + scraped <14d ago -> don't re-queue

// Dry-refresh backoff: consecutive refreshes that yielded 0 new comps
const DRY_REFRESH_TIER1 = 2;
const DRY_REFRESH_TIER2 = 4;
const DRY_REFRESH_TIER1_DAYS = 30;
const DRY_REFRESH_TIER2_DAYS = 60;

// Dormant detection
const DORMANT_MIN_NO_DATA_COUNT = 2;
const DORMANT_WINDOW_DAYS = 60;

// Evidence-based low-volume gate (BACKLOG #245 Fix A):
//  When build-evidence-index.js has marked a dataset as a high-confidence
//  low-volume candidate (e.g. 5/5 historical runs returned 0 comps), trust
//  that evidence and only re-probe on quarterly cadence. Prevents the queue
//  from drowning in known-empty bullion series like Krugerrand/Britannia.
const EVIDENCE_LOW_VOL_CADENCE_DAYS = 90;

const THRESHOLDS = Object.freeze({
  STALE_THRESHOLD_DAYS,
  VERY_STALE_MULTIPLIER,
  THIN_MARKET_THRESHOLD,
  CONFIRMED_THIN_REFRESHES,
  CONFIRMED_THIN_CADENCE_DAYS,
  THIN_MARKET_CADENCE_DAYS,
  RECENTLY_REFRESHED_DAYS,
  DRY_REFRESH_TIER1,
  DRY_REFRESH_TIER2,
  DRY_REFRESH_TIER1_DAYS,
  DRY_REFRESH_TIER2_DAYS,
  DORMANT_MIN_NO_DATA_COUNT,
  DORMANT_WINDOW_DAYS,
  EVIDENCE_LOW_VOL_CADENCE_DAYS,
});

// ── Helpers ─────────────────────────────────────────────────
function _daysBetween(now, iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/**
 * Returns true when meta.identifiers indicates a high-confidence
 * low-volume candidate from the historical evidence index.
 * Medium/Low confidence is NOT trusted (may be a false negative on a
 * single run); only High triggers the queue-skip.
 */
function _isHighConfidenceLowVolEvidence(meta) {
  const ids = meta && meta.identifiers;
  if (!ids) return false;
  return ids.is_low_volume_candidate === true
      && ids.identifier_confidence === 'High';
}

/**
 * Returns true when meta.identifiers indicates a Medium-confidence
 * low-volume candidate. Used by #248 to demote these entries to a
 * single evidence-probe (page-1 refresh at P3) rather than full P0/P1
 * refresh until one runtime touch confirms or refutes the evidence.
 */
function _isMediumConfidenceLowVolEvidence(meta) {
  const ids = meta && meta.identifiers;
  if (!ids) return false;
  return ids.is_low_volume_candidate === true
      && ids.identifier_confidence === 'Medium';
}

/**
 * Derive raw freshness/depth state from a meta entry.
 * Pure function; no exclusions applied yet.
 *
 * @param {object} meta - aggregationMeta-like object
 * @param {string|null} meta.newestSaleDate
 * @param {number} [meta.compCount]
 * @param {number} [meta.refreshCount]
 * @param {string|null} [meta.lastRefreshAt]
 * @param {string|null} [meta.page1At]
 * @param {number} [meta.noDataCount]
 * @param {string|null} [meta.noDataAt]
 * @param {number} [meta.consecutiveDryRefreshes]
 * @param {boolean} [meta.csvExists]
 * @param {Date} [now]
 * @returns {{
 *   freshness: 'fresh'|'stale'|'very-stale'|'missing',
 *   marketDepth: 'viable'|'thin'|'confirmed-thin'|'empty'|'untested',
 *   staleDays: number|null,
 *   lastRefreshDays: number|null,
 *   noDataAgeDays: number|null,
 *   isDormant: boolean,
 * }}
 */
function classify(meta, now = new Date(), opts = {}) {
  const staleThreshold = opts.staleThresholdDays || STALE_THRESHOLD_DAYS;
  const veryStaleThreshold = staleThreshold * VERY_STALE_MULTIPLIER;
  const newestSaleDate = meta.newestSaleDate || null;
  const compCount = meta.compCount || 0;
  const refreshCount = meta.refreshCount || 0;
  const csvExists = !!meta.csvExists;
  const noDataCount = meta.noDataCount || 0;

  const staleDays = _daysBetween(now, newestSaleDate);
  const lastRefreshDays = _daysBetween(now, meta.lastRefreshAt || meta.page1At);
  const noDataAgeDays = _daysBetween(now, meta.noDataAt);

  // Axis 1: Freshness
  let freshness;
  if (compCount === 0 && newestSaleDate === null) {
    freshness = csvExists ? 'stale' : 'missing';
  } else if (staleDays !== null && staleDays >= veryStaleThreshold) {
    freshness = 'very-stale';
  } else if (staleDays !== null && staleDays >= staleThreshold) {
    freshness = 'stale';
  } else if (staleDays !== null) {
    freshness = 'fresh';
  } else {
    freshness = 'stale';
  }

  // Axis 2: Market Depth
  // #248: a single dry refresh (refreshCount>=1 AND lastRefreshNewComps===0)
  // escalates a thin market to 'confirmed-thin' immediately, instead of
  // waiting for CONFIRMED_THIN_REFRESHES cycles. Rationale: if the live
  // page-1 fetch added zero new listings AND we still have <10 total comps,
  // the market is structurally thin -- additional probes will not change
  // that and just burn quota.
  let marketDepth;
  const lastRefreshNewComps = meta.lastRefreshNewComps;
  const dryConfirmedThin = refreshCount >= 1 && lastRefreshNewComps === 0;
  if (compCount === 0 && !csvExists && refreshCount === 0) {
    marketDepth = 'untested';
  } else if (compCount === 0) {
    marketDepth = 'empty';
  } else if (compCount < THIN_MARKET_THRESHOLD) {
    marketDepth = (refreshCount >= CONFIRMED_THIN_REFRESHES || dryConfirmedThin)
      ? 'confirmed-thin'
      : 'thin';
  } else {
    marketDepth = 'viable';
  }

  const isDormant =
    noDataCount >= DORMANT_MIN_NO_DATA_COUNT &&
    noDataAgeDays !== null &&
    noDataAgeDays < DORMANT_WINDOW_DAYS;

  return { freshness, marketDepth, staleDays, lastRefreshDays, noDataAgeDays, isDormant };
}

/**
 * Decide whether this dataset should be SKIPPED from the refresh queue.
 *
 * Mirrors the priority=null branches in scripts/generate-freshness-report.js
 * so the admin staleness API and the freshness report agree on exclusions.
 *
 * @param {object} meta - same shape as classify()
 * @param {Date} [now]
 * @returns {{ skip: boolean, reason: string|null, state: object }}
 *   state = the classify() return value, for callers that want it
 */
function shouldSkipRefresh(meta, now = new Date(), opts = {}) {
  const state = classify(meta, now, opts);
  const { freshness, marketDepth, lastRefreshDays, isDormant } = state;
  const compCount = meta.compCount || 0;
  const consecutiveDryRefreshes = meta.consecutiveDryRefreshes || 0;

  if (isDormant) {
    return { skip: true, reason: 'dormant', state };
  }

  // BACKLOG #245 Fix A: high-confidence historical evidence of low volume.
  // Skip on quarterly cadence regardless of current freshness/depth axes.
  if (_isHighConfidenceLowVolEvidence(meta)) {
    if (lastRefreshDays === null || lastRefreshDays < EVIDENCE_LOW_VOL_CADENCE_DAYS) {
      return { skip: true, reason: 'evidence-low-vol', state };
    }
    // >=90 days since last attempt: allow a probe-refresh through.
  }

  if (marketDepth === 'empty') {
    // Empty (no comps, but tested): treat as dormant for refresh purposes.
    return { skip: true, reason: 'empty', state };
  }

  if (marketDepth === 'confirmed-thin') {
    if (lastRefreshDays !== null && lastRefreshDays < CONFIRMED_THIN_CADENCE_DAYS) {
      return { skip: true, reason: 'confirmed-thin-skip', state };
    }
    return { skip: false, reason: null, state };
  }

  if (marketDepth === 'thin') {
    if (lastRefreshDays !== null && lastRefreshDays < THIN_MARKET_CADENCE_DAYS) {
      return { skip: true, reason: 'thin-wait', state };
    }
    return { skip: false, reason: null, state };
  }

  // viable from here on
  if (freshness === 'stale' || freshness === 'very-stale') {
    if (lastRefreshDays !== null && lastRefreshDays < RECENTLY_REFRESHED_DAYS) {
      return { skip: true, reason: 'recently-confirmed-stale', state };
    }
    if (
      consecutiveDryRefreshes >= DRY_REFRESH_TIER2 &&
      lastRefreshDays !== null &&
      lastRefreshDays < DRY_REFRESH_TIER2_DAYS
    ) {
      return { skip: true, reason: 'dry-refresh-backoff', state };
    }
    if (
      consecutiveDryRefreshes >= DRY_REFRESH_TIER1 &&
      lastRefreshDays !== null &&
      lastRefreshDays < DRY_REFRESH_TIER1_DAYS
    ) {
      return { skip: true, reason: 'dry-refresh-backoff', state };
    }
    return { skip: false, reason: null, state };
  }

  // Fresh viable: not skipped, but nothing to refresh either.
  if (freshness === 'fresh') {
    return { skip: false, reason: null, state };
  }

  // missing/untested: caller decides (initial-fetch is its own queue)
  return { skip: false, reason: null, state };
}

module.exports = {
  THRESHOLDS,
  classify,
  shouldSkipRefresh,
  _isHighConfidenceLowVolEvidence,
  _isMediumConfidenceLowVolEvidence,
};
