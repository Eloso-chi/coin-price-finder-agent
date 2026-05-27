// src/services/auditService.js -- Admin action audit log
// Writes structured audit events to Cosmos `admin-audit` container (when configured)
// AND always emits a one-line summary to stdout via `[admin-audit]` prefix.
//
// Schema (Cosmos):
//   id            string  -- random UUID
//   actorUserId   string  -- partition key (or 'admin-key' when ADMIN_API_KEY used)
//   actorUsername string  -- username, or 'admin-key' for shared-key usage
//   action        string  -- e.g. 'signin', 'signin-failed', 'admin-key-use',
//                            'admin-granted', 'admin-revoked', 'password-reset',
//                            'bootstrap-admin', 'tokenversion-bumped'
//   target        string  -- username acted on (often == actor)
//   meta          object  -- arbitrary action-specific context
//   ip            string  -- client IP from req
//   at            string  -- ISO timestamp
//
// CommonJS. Failures here never throw to the caller -- audit logging
// must not break user-facing flows. We log + swallow.

'use strict';

const crypto = require('crypto');
const cosmos = require('../utils/cosmosClient');

const CONTAINER = 'admin-audit';

/**
 * Emit an audit event.
 * @param {object} ev
 * @param {string} ev.action
 * @param {{ userId?: string, username?: string }} [ev.actor]
 * @param {string} [ev.target]
 * @param {object} [ev.meta]
 * @param {import('express').Request} [ev.req]
 * @returns {Promise<void>}
 */
async function audit(ev) {
  const actorUserId = ev.actor?.userId || 'anonymous';
  const actorUsername = ev.actor?.username || 'anonymous';
  const ip = _extractIp(ev.req);
  const at = new Date().toISOString();

  const record = {
    id: crypto.randomUUID(),
    actorUserId,
    actorUsername,
    action: String(ev.action || 'unknown'),
    target: ev.target || actorUsername,
    meta: ev.meta || {},
    ip,
    at,
  };

  // Always emit to stdout so App Service log stream / local logs capture it.
  // Format: machine-parseable single line.
  try {
    console.info(`[admin-audit] ${JSON.stringify({
      at, action: record.action, actor: actorUsername,
      target: record.target, ip, meta: record.meta,
    })}`);
  } catch {
    // ignore -- console should not throw
  }

  // Write to Cosmos best-effort. Never throw to caller.
  if (cosmos.isEnabled()) {
    try {
      await cosmos.container(CONTAINER).items.create(record);
    } catch (err) {
      // Container may not exist yet on first run -- log once and continue.
      console.warn(`[admin-audit] cosmos write failed: ${err.code || err.message}`);
    }
  }
}

function _extractIp(req) {
  if (!req) return null;
  // Prefer X-Forwarded-For (App Service / proxies), fall back to req.ip.
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || null;
}

module.exports = { audit };
