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
const PARTITION_KEY_PATH = '/actorUsername';

// Once-per-process flag so we don't spam logs when the audit container hasn't
// been provisioned yet on a fresh deployment.
let _cosmosWriteWarned = false;

// One-time async container provisioning. We kick this off lazily on the first
// audit() call so module load stays synchronous and harmless when Cosmos is
// disabled. Subsequent audits await the same promise -- so we never race
// container creation against the first .items.create() call.
let _ensurePromise = null;
function _ensureContainer() {
  if (!cosmos.isEnabled()) return Promise.resolve();
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = cosmos.ensureContainer(CONTAINER, PARTITION_KEY_PATH)
    .catch((err) => {
      // Reset so a transient failure can be retried by the next caller.
      _ensurePromise = null;
      throw err;
    });
  return _ensurePromise;
}

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

  // Write to Cosmos best-effort. Never throw to caller. We lazily provision
  // the container on first use so a fresh deployment doesn't require any
  // portal click. If provisioning or write still fails, warn once and move on.
  if (cosmos.isEnabled()) {
    try {
      await _ensureContainer();
      await cosmos.container(CONTAINER).items.create(record);
    } catch (err) {
      if (!_cosmosWriteWarned) {
        _cosmosWriteWarned = true;
        console.warn(`[admin-audit] cosmos write failed (will not warn again this process): ${err.code || err.message}`);
      }
    }
  }
}

function _extractIp(req) {
  if (!req) return null;
  // Trust Express's resolution. `app.set('trust proxy', 1)` in server.js
  // makes req.ip the originating client behind App Service's proxy. Reading
  // X-Forwarded-For directly here would let any client spoof the audit-log
  // source IP via a forged header.
  return req.ip || null;
}

module.exports = { audit };
