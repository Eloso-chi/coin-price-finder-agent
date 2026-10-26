'use strict';

const DEFAULT_INTERVAL_DAYS = 7;
const MIN_INTERVAL_DAYS = 1;
const MAX_INTERVAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseRefreshIntervalDays(value) {
  if (value === undefined) return DEFAULT_INTERVAL_DAYS;

  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error('GS_REFRESH_INTERVAL_DAYS must be an integer from 1 to 30');
  }

  const intervalDays = Number(normalized);
  if (intervalDays < MIN_INTERVAL_DAYS || intervalDays > MAX_INTERVAL_DAYS) {
    throw new Error('GS_REFRESH_INTERVAL_DAYS must be an integer from 1 to 30');
  }
  return intervalDays;
}

function needsRefresh(lastCompletedAt, intervalDays, now = new Date()) {
  if (!lastCompletedAt) return true;
  const completedAtMs = Date.parse(lastCompletedAt);
  if (!Number.isFinite(completedAtMs)) return true;
  return now.getTime() - completedAtMs >= intervalDays * DAY_MS;
}

module.exports = { parseRefreshIntervalDays, needsRefresh };