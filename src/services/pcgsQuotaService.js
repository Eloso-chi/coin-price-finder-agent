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
const MIN_COOLDOWN_MS = 60 * 1000;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const PROBE_LEASE_MS = 5 * 60 * 1000;
const configuredCooldownMs = Number(process.env.PCGS_429_COOLDOWN_MS);
const DEFAULT_COOLDOWN_MS = Number.isInteger(configuredCooldownMs)
  && configuredCooldownMs >= MIN_COOLDOWN_MS
  && configuredCooldownMs <= MAX_COOLDOWN_MS
  ? configuredCooldownMs
  : 60 * 60 * 1000;

// ── Helpers ─────────────────────────────────────────────────

/** Get today's date string in Pacific Time (PCGS reset timezone). */
function todayPacific() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function normalizeResetAt(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric)
    ? (numeric > 1e12 ? numeric : numeric * 1000)
    : Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > now && parsed <= now + MAX_COOLDOWN_MS
    ? new Date(parsed).toISOString()
    : null;
}

function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds * 1000 <= MAX_COOLDOWN_MS) {
    return new Date(now + seconds * 1000).toISOString();
  }
  return normalizeResetAt(value, now);
}

function normalizeQuotaValue(value) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

// ── Persistent state ────────────────────────────────────────
let _state = null;

function normalizeCurrentDayState(raw) {
  const limit = Number.isInteger(raw.limit) && raw.limit > 0 && raw.limit <= DAILY_LIMIT
    ? raw.limit
    : DAILY_LIMIT;
  let remaining;
  if (Number.isInteger(raw.remaining) && raw.remaining >= 0 && raw.remaining <= limit) {
    remaining = raw.remaining;
  } else if (Number.isInteger(raw.used) && raw.used >= 0 && raw.used <= limit) {
    remaining = limit - raw.used;
  } else {
    remaining = 0;
  }
  return { ...raw, limit, remaining, used: limit - remaining };
}

function loadState() {
  const today = todayPacific();
  if (_state && _state.date === today) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(QUOTA_PATH, 'utf8'));
    if (raw.date === today) {
      _state = normalizeCurrentDayState(raw);
    } else {
      _state = newDayState(raw);
    }
  } catch (err) {
    _state = newDayState(_state);
    if (!_state.upstreamCooldown && err?.code !== 'ENOENT') {
      const now = Date.now();
      _state.breakerTripped = true;
      _state.breakerTrippedAt = new Date(now).toISOString();
      _state.upstreamCooldown = {
        rateLimitedAt: _state.breakerTrippedAt,
        resetAt: new Date(now + DEFAULT_COOLDOWN_MS).toISOString(),
        reason: 'PCGS quota state could not be read',
        retryAfter: null,
        lastProbeAt: null,
        lastProbeOutcome: 'blocked'
      };
    }
  }
  return _state;
}

function newDayState(previous) {
  const previousCooldown = previous?.upstreamCooldown;
  const keepCooldown = previousCooldown?.resetAt
    && Date.parse(previousCooldown.resetAt) > Date.now();
  return {
    date: todayPacific(),
    used: 0,
    remaining: DAILY_LIMIT,
    limit: DAILY_LIMIT,
    headerSynced: false,
    breakerTripped: false,
    breakerTrippedAt: null,
    upstreamCooldown: keepCooldown ? previousCooldown : null,
    lastRecoveryProbe: previous?.lastRecoveryProbe || null,
    log: [],
    previousDay: previous ? {
      date: previous.date,
      used: previous.used,
      remaining: previous.remaining
    } : null
  };
}

function saveState() {
  const temporaryPath = `${QUOTA_PATH}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(_state, null, 2));
    fs.renameSync(temporaryPath, QUOTA_PATH);
  } catch (err) {
    console.error('[pcgs-quota] Failed to save state:', err.message);
    try { fs.unlinkSync(temporaryPath); } catch { /* best effort */ }
  }
}

// ── Public API ──────────────────────────────────────────────

/**
 * Sync quota state from PCGS API response headers.
 * This is the authoritative source -- always trust headers over local counter.
 */
function syncFromHeaders(remaining, limit) {
  const state = loadState();
  const effectiveLimit = limit == null ? state.limit : limit;
  const validLimit = Number.isInteger(effectiveLimit)
    && effectiveLimit > 0
    && effectiveLimit <= DAILY_LIMIT;
  const validRemaining = Number.isInteger(remaining)
    && remaining >= 0
    && validLimit
    && remaining <= effectiveLimit;
  if (validRemaining) {
    state.remaining = remaining;
    state.used = effectiveLimit - remaining;
    state.limit = effectiveLimit;
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
  if (state.upstreamCooldown?.lastProbeOutcome === 'in-flight') {
    state.lastRecoveryProbe = {
      at: state.upstreamCooldown.lastProbeAt,
      outcome: 'succeeded'
    };
  }
  clearUpstreamCooldown(state);
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
 * Trip the circuit breaker after an upstream 429. Local quota is preserved:
 * upstream availability and the client-side daily counter are distinct.
 */
function tripBreaker(options = {}) {
  const state = loadState();
  const now = Date.now();
  const resetAt = normalizeResetAt(options.resetAt, now)
    || parseRetryAfter(options.retryAfter, now)
    || new Date(now + DEFAULT_COOLDOWN_MS).toISOString();
  state.breakerTripped = true;
  state.breakerTrippedAt = new Date(now).toISOString();
  state.upstreamCooldown = {
    rateLimitedAt: state.breakerTrippedAt,
    resetAt,
    reason: options.reason || 'PCGS API rate limit exceeded (429)',
    retryAfter: options.retryAfter == null ? null : String(options.retryAfter),
    reportedRemaining: normalizeQuotaValue(options.upstreamRemaining),
    reportedLimit: normalizeQuotaValue(options.upstreamLimit),
    lastProbeAt: null,
    lastProbeOutcome: 'blocked'
  };
  saveState();
  console.warn(`[pcgs-quota] Circuit breaker TRIPPED — upstream cooldown until ${resetAt}`);
}

function clearUpstreamCooldown(state = loadState()) {
  if (!state.upstreamCooldown && !state.breakerTripped) return false;
  state.upstreamCooldown = null;
  state.breakerTripped = false;
  state.breakerTrippedAt = null;
  return true;
}

function getUpstreamAvailability(state = loadState(), now = Date.now()) {
  const cooldown = state.upstreamCooldown;
  if (!cooldown) return 'available';
  if (Date.parse(cooldown.resetAt) > now) return 'cooldown';
  if (cooldown.lastProbeOutcome === 'in-flight'
      && Date.parse(cooldown.lastProbeAt) + PROBE_LEASE_MS > now) {
    return 'probe-in-flight';
  }
  return 'probe-required';
}

function acquireRequestPermit() {
  const state = loadState();
  const availability = getUpstreamAvailability(state);
  if (availability === 'cooldown' || availability === 'probe-in-flight') return false;
  if (availability === 'probe-required') {
    state.upstreamCooldown.lastProbeAt = new Date().toISOString();
    state.upstreamCooldown.lastProbeOutcome = 'in-flight';
    saveState();
  }
  return true;
}

function releaseRecoveryProbe(outcome = 'failed') {
  const state = loadState();
  if (state.upstreamCooldown?.lastProbeOutcome !== 'in-flight') return false;
  state.upstreamCooldown.lastProbeOutcome = outcome;
  state.lastRecoveryProbe = {
    at: state.upstreamCooldown.lastProbeAt,
    outcome
  };
  saveState();
  return true;
}

/**
 * Check if the breaker is currently tripped.
 * Auto-resets if the day has rolled over in Pacific Time.
 */
function isBreakerTripped() {
  const state = loadState();
  const availability = getUpstreamAvailability(state);
  return availability === 'cooldown' || availability === 'probe-in-flight';
}

function isRecoveryProbeRequired() {
  return getUpstreamAvailability() === 'probe-required';
}

/**
 * Get current quota status.
 */
function getStatus() {
  const state = loadState();
  const upstreamAvailability = getUpstreamAvailability(state);
  return {
    date: state.date,
    used: state.used,
    remaining: state.remaining,
    limit: state.limit,
    pct: Math.round((state.used / state.limit) * 100),
    headerSynced: state.headerSynced,
    breakerTripped: upstreamAvailability === 'cooldown',
    breakerTrippedAt: state.breakerTrippedAt,
    upstreamAvailability,
    rateLimitedAt: state.upstreamCooldown?.rateLimitedAt || null,
    nextEligibleProbeAt: state.upstreamCooldown?.resetAt || null,
    rateLimitReason: state.upstreamCooldown?.reason || null,
    upstreamReportedRemaining: state.upstreamCooldown?.reportedRemaining ?? null,
    upstreamReportedLimit: state.upstreamCooldown?.reportedLimit ?? null,
    lastProbeAt: state.upstreamCooldown?.lastProbeAt || state.lastRecoveryProbe?.at || null,
    lastProbeOutcome: state.upstreamCooldown?.lastProbeOutcome || state.lastRecoveryProbe?.outcome || null,
    previousDay: state.previousDay
  };
}

/**
 * Get remaining calls available for prefetch (accounts for safety reserve).
 * @param {number} reserve - calls to hold back for organic daytime usage (default 10)
 */
function getAvailableForPrefetch(reserve = 10) {
  const state = loadState();
  const upstreamAvailability = getUpstreamAvailability(state);
  if (upstreamAvailability === 'cooldown' || upstreamAvailability === 'probe-in-flight') return 0;
  if (upstreamAvailability === 'probe-required') return 1;
  return Math.max(0, state.remaining - reserve);
}

module.exports = {
  syncFromHeaders,
  recordCall,
  tripBreaker,
  acquireRequestPermit,
  releaseRecoveryProbe,
  isBreakerTripped,
  isRecoveryProbeRequired,
  getStatus,
  getAvailableForPrefetch,
  DAILY_LIMIT,
  DEFAULT_COOLDOWN_MS
};
