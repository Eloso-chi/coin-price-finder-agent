// src/services/pcgsQuotaService.js — PCGS daily API quota tracker with circuit breaker
// Tracks usage via X-RateLimit-Remaining response headers (authoritative source).
// Falls back to local counter when headers unavailable.
// Resets at 00:00:00 Pacific Time daily (PCGS HQ in Santa Ana, CA).
// CommonJS

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIR = require('../utils/cachePath').CACHE_DIR;
const QUOTA_PATH = path.join(CACHE_DIR, 'pcgs_quota.json');
const DAILY_LIMIT = 1000;

// ── Helpers ─────────────────────────────────────────────────

/** Get today's date string in Pacific Time (PCGS reset timezone). */
function todayPacific() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// ── Persistent state ────────────────────────────────────────
let _state = null;

function loadState() {
  const today = todayPacific();
  if (_state && _state.date === today) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(QUOTA_PATH, 'utf8'));
    if (raw.date === today) {
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
    date: todayPacific(),
    used: 0,
    remaining: DAILY_LIMIT,
    limit: DAILY_LIMIT,
    headerSynced: false,
    breakerTripped: false,
    breakerTrippedAt: null,
    log: [],
    previousDay: previous ? {
      date: previous.date,
      used: previous.used,
      remaining: previous.remaining
    } : null
  };
}

function saveState() {
  try {
    fs.writeFileSync(QUOTA_PATH, JSON.stringify(_state, null, 2));
  } catch (err) {
    console.error('[pcgs-quota] Failed to save state:', err.message);
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Sync quota state from PCGS API response headers.
 * This is the authoritative source -- always trust headers over local counter.
 */
function syncFromHeaders(remaining, limit) {
  const state = loadState();
  if (typeof remaining === 'number' && !isNaN(remaining)) {
    state.remaining = remaining;
    state.used = (limit || DAILY_LIMIT) - remaining;
    state.limit = limit || DAILY_LIMIT;
    state.headerSynced = true;
  }
  saveState();
}

/**
 * Record a PCGS API call (local tracking fallback).
 * @param {string} source - 'coinfacts' | 'apr' | 'prefetch'
 * @param {string} [note] - optional description
 */
function recordCall(source = 'coinfacts', note = '') {
  const state = loadState();
  state.used += 1;
  state.remaining = Math.max(0, state.limit - state.used);

  state.log.push({
    time: new Date().toISOString(),
    source,
    note: note || undefined,
    remaining: state.remaining
  });

  // Keep log manageable
  if (state.log.length > 500) {
    state.log = state.log.slice(-400);
  }

  saveState();
  return { remaining: state.remaining, used: state.used };
}

/**
 * Trip the circuit breaker (429 received or remaining <= 0).
 * All PCGS API calls should check isBreaker() before calling.
 */
function tripBreaker() {
  const state = loadState();
  state.breakerTripped = true;
  state.breakerTrippedAt = new Date().toISOString();
  state.remaining = 0;
  saveState();
  console.warn('[pcgs-quota] Circuit breaker TRIPPED — no PCGS API calls until midnight PT reset');
}

/**
 * Check if the breaker is currently tripped.
 * Auto-resets if the day has rolled over in Pacific Time.
 */
function isBreakerTripped() {
  const state = loadState(); // loadState auto-resets on new day
  return state.breakerTripped;
}

/**
 * Get current quota status.
 */
function getStatus() {
  const state = loadState();
  return {
    date: state.date,
    used: state.used,
    remaining: state.remaining,
    limit: state.limit,
    pct: Math.round((state.used / state.limit) * 100),
    headerSynced: state.headerSynced,
    breakerTripped: state.breakerTripped,
    breakerTrippedAt: state.breakerTrippedAt,
    previousDay: state.previousDay
  };
}

/**
 * Get remaining calls available for prefetch (accounts for safety reserve).
 * @param {number} reserve - calls to hold back for organic daytime usage (default 10)
 */
function getAvailableForPrefetch(reserve = 10) {
  const state = loadState();
  if (state.breakerTripped) return 0;
  return Math.max(0, state.remaining - reserve);
}

module.exports = {
  syncFromHeaders,
  recordCall,
  tripBreaker,
  isBreakerTripped,
  getStatus,
  getAvailableForPrefetch,
  DAILY_LIMIT
};
