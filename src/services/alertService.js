// src/services/alertService.js — Email alert notifications via SendGrid v3 API
// Sends failure alerts for background processes. No-op if not configured.
// CommonJS

'use strict';

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { CACHE_DIR } = require('../utils/cachePath');

// ── Configuration ───────────────────────────────────────────
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL || 'alerts@coinpricefinder.app';
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour per topic

const LOG_PATH = path.join(CACHE_DIR, 'alert_log.json');

// ── Rate limiter (per-topic, 1 alert per hour) ──────────────
const _lastSent = new Map(); // topic -> timestamp

function isRateLimited(topic) {
  const last = _lastSent.get(topic);
  if (!last) return false;
  return (Date.now() - last) < RATE_LIMIT_MS;
}

function markSent(topic) {
  _lastSent.set(topic, Date.now());
}

// ── Fallback logging ────────────────────────────────────────
function logToFile(topic, message, error) {
  try {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch { /* empty */ }
    log.push({
      timestamp: new Date().toISOString(),
      topic,
      message,
      error: error || null,
    });
    // Keep last 200 entries
    if (log.length > 200) log = log.slice(-200);
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  } catch (err) {
    console.error('[alert] Failed to write fallback log:', err.message);
  }
}

// ── Core send function ──────────────────────────────────────

/**
 * Send an alert email via SendGrid v3 API.
 * No-op if SENDGRID_API_KEY or ALERT_EMAIL_TO is not configured.
 * Rate-limited: max 1 email per topic per hour.
 *
 * @param {string} topic - Alert category (e.g. 'metals-refresh', 'prefetch-failed')
 * @param {string} subject - Email subject line
 * @param {string} body - Plain text email body
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendAlert(topic, subject, body) {
  // No-op if not configured
  if (!SENDGRID_API_KEY || !ALERT_EMAIL_TO) {
    logToFile(topic, `${subject}: ${body}`, 'not-configured');
    return { sent: false, reason: 'not-configured' };
  }

  // Rate limit check
  if (isRateLimited(topic)) {
    return { sent: false, reason: 'rate-limited' };
  }

  try {
    await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: ALERT_EMAIL_TO }] }],
      from: { email: ALERT_FROM_EMAIL, name: 'CoinPriceFinder Alerts' },
      subject: `[CoinPriceFinder] ${subject}`,
      content: [{
        type: 'text/plain',
        value: `${body}\n\n---\nTimestamp: ${new Date().toISOString()}\nTopic: ${topic}`,
      }],
    }, {
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    markSent(topic);
    return { sent: true };
  } catch (err) {
    const errMsg = err.response?.data?.errors?.[0]?.message || err.message;
    console.error(`[alert] SendGrid failed for topic "${topic}": ${errMsg}`);
    logToFile(topic, `${subject}: ${body}`, errMsg);
    markSent(topic); // Still rate-limit to avoid hammering a broken SendGrid
    return { sent: false, reason: errMsg };
  }
}

// ── Convenience helpers ─────────────────────────────────────

function alertMetalsFailure(consecutiveFailures, error) {
  return sendAlert(
    'metals-refresh',
    `Metals refresh failed ${consecutiveFailures}x`,
    `The metals spot price refresh has failed ${consecutiveFailures} consecutive times.\n\nLast error: ${error}`
  );
}

function alertGreysheetFailure(error) {
  return sendAlert(
    'greysheet-refresh',
    'Greysheet refresh failed',
    `The periodic Greysheet price refresh failed.\n\nError: ${error}`
  );
}

function alertBlobImportFailure(consecutiveFailures, error) {
  return sendAlert(
    'blob-reimport',
    `Terapeak blob re-import failed ${consecutiveFailures}x`,
    `The Terapeak blob re-import has failed ${consecutiveFailures} consecutive times.\n\nLast error: ${error}`
  );
}

function alertPrefetchFailure(consecutiveFailures, error) {
  return sendAlert(
    'prefetch-failed',
    `APR prefetch failed ${consecutiveFailures}x`,
    `The nightly APR prefetch scheduler has failed ${consecutiveFailures} consecutive times.\n\nError: ${error}`
  );
}

function alertServerCrash(type, error) {
  return sendAlert(
    'server-crash',
    `Server crash: ${type}`,
    `The server is crashing due to an ${type}.\n\nError: ${error}\n\nThe process will exit shortly.`
  );
}

function alertPcgsBreakerTripped(hour) {
  return sendAlert(
    'pcgs-breaker',
    'PCGS breaker tripped during daytime',
    `The PCGS rate-limit breaker tripped at hour ${hour} PT (before 9 PM). This is unexpected and may indicate an API issue or misconfigured quota.`
  );
}

module.exports = {
  sendAlert,
  alertMetalsFailure,
  alertGreysheetFailure,
  alertBlobImportFailure,
  alertPrefetchFailure,
  alertServerCrash,
  alertPcgsBreakerTripped,
  // Exposed for testing
  _isRateLimited: isRateLimited,
  _resetRateLimits: () => _lastSent.clear(),
};
