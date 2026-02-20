// src/services/terapeakQuotaService.js — Terapeak daily query quota tracker
// CommonJS
//
// eBay Seller Hub → Research (Terapeak) enforces ~250 queries/day per account.
// Each search, filter change, or date-range adjustment counts as 1 query.
// This service tracks usage to prevent exceeding the daily limit.

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '..', 'cache');
const QUOTA_PATH = path.join(CACHE_DIR, 'terapeak_quota.json');
const DAILY_LIMIT = 250;

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ── Persistent state ────────────────────────────────────────
let _state = null;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function loadState() {
  if (_state && _state.date === todayKey()) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(QUOTA_PATH, 'utf8'));
    // Auto-reset if it's a new day
    if (raw.date === todayKey()) {
      _state = raw;
    } else {
      _state = newDayState(raw);
    }
  } catch {
    _state = newDayState(null);
  }
  return _state;
}

function newDayState(previous) {
  return {
    date: todayKey(),
    used: 0,
    limit: DAILY_LIMIT,
    log: [],
    // Keep yesterday's summary for reference
    previousDay: previous ? {
      date: previous.date,
      used: previous.used,
      limit: previous.limit
    } : null
  };
}

function saveState() {
  fs.writeFileSync(QUOTA_PATH, JSON.stringify(_state, null, 2));
}

/**
 * Record one or more Terapeak queries.
 * @param {number} count - number of queries to record (default 1)
 * @param {string} [note] - optional note (e.g. search term or action)
 * @returns {{ ok: boolean, used: number, remaining: number, limit: number, warning?: string }}
 */
function recordQueries(count = 1, note = '') {
  const state = loadState();
  const remaining = state.limit - state.used;

  if (count > remaining) {
    return {
      ok: false,
      used: state.used,
      remaining,
      limit: state.limit,
      warning: `BLOCKED: Recording ${count} query(ies) would exceed daily limit. ${remaining} remaining today.`
    };
  }

  state.used += count;
  state.log.push({
    time: new Date().toISOString(),
    count,
    note: note || undefined,
    runningTotal: state.used
  });

  // Keep log manageable (last 300 entries)
  if (state.log.length > 300) {
    state.log = state.log.slice(-250);
  }

  saveState();

  const newRemaining = state.limit - state.used;
  const result = {
    ok: true,
    used: state.used,
    remaining: newRemaining,
    limit: state.limit
  };

  // Add warnings at thresholds
  if (newRemaining <= 10) {
    result.warning = `CRITICAL: Only ${newRemaining} Terapeak queries remaining today!`;
  } else if (newRemaining <= 25) {
    result.warning = `WARNING: Only ${newRemaining} Terapeak queries remaining today.`;
  } else if (newRemaining <= 50) {
    result.warning = `CAUTION: ${newRemaining} Terapeak queries remaining today.`;
  }

  return result;
}

/**
 * Get current quota status without recording anything.
 * @returns {{ date: string, used: number, remaining: number, limit: number, pct: number, log: object[], previousDay: object|null }}
 */
function getStatus() {
  const state = loadState();
  const remaining = state.limit - state.used;
  return {
    date: state.date,
    used: state.used,
    remaining,
    limit: state.limit,
    pct: Math.round((state.used / state.limit) * 100),
    log: state.log,
    previousDay: state.previousDay
  };
}

/**
 * Check if we can safely use `n` more queries.
 * @param {number} n - number of queries to check
 * @returns {{ allowed: boolean, remaining: number, limit: number }}
 */
function canQuery(n = 1) {
  const state = loadState();
  const remaining = state.limit - state.used;
  return {
    allowed: n <= remaining,
    remaining,
    limit: state.limit
  };
}

/**
 * Adjust the daily limit (e.g. if eBay changes it).
 * @param {number} newLimit
 */
function setLimit(newLimit) {
  const state = loadState();
  state.limit = Math.max(1, Math.round(newLimit));
  saveState();
  return { limit: state.limit };
}

/**
 * Manually adjust the used count (e.g. if you did queries outside the app).
 * @param {number} newUsed
 */
function setUsed(newUsed) {
  const state = loadState();
  state.used = Math.max(0, Math.round(newUsed));
  state.log.push({
    time: new Date().toISOString(),
    count: 0,
    note: `Manual adjustment to ${state.used}`,
    runningTotal: state.used
  });
  saveState();
  return getStatus();
}

/**
 * Reset today's counter to 0.
 */
function resetToday() {
  const state = loadState();
  state.used = 0;
  state.log = [{
    time: new Date().toISOString(),
    count: 0,
    note: 'Counter reset',
    runningTotal: 0
  }];
  saveState();
  return getStatus();
}

module.exports = {
  recordQueries,
  getStatus,
  canQuery,
  setLimit,
  setUsed,
  resetToday,
  DAILY_LIMIT
};
