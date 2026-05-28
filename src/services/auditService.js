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
// Partition key choice trade-off:
//   `/actorUsername` makes "all actions by user X" a single-partition query,
//   which is the common admin/forensics read pattern. The buckets
//   `'admin-key'` and `'anonymous'` absorb shared-key and failed-signin
//   events respectively -- both are bounded by admin event volume and a
//   container-level TTL (configure separately) keeps logical partitions
//   well under Cosmos's 20 GB cap. Time-range queries are cross-partition,
//   which is fine at this write rate.
const PARTITION_KEY_PATH = '/actorUsername';

// Once-per-process flag so we don't spam logs when the audit container hasn't
// been provisioned yet on a fresh deployment.
let _cosmosWriteWarned = false;

// HTTP status codes that indicate a permanent misconfiguration (RBAC, bad
// account, missing parent database, partition-key conflict). Treat as a hard
// stop -- no value in re-attempting provisioning every audit forever.
const _PERMANENT_COSMOS_ERRORS = new Set([401, 403, 404, 409]);
let _provisioningDisabled = false;

// One-time async container provisioning. We kick this off lazily on the first
// audit() call so module load stays synchronous and harmless when Cosmos is
// disabled. Subsequent audits await the same promise -- so we never race
// container creation against the first .items.create() call.
let _ensurePromise = null;
function _ensureContainer() {
  if (!cosmos.isEnabled() || _provisioningDisabled) return Promise.resolve();
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = cosmos.ensureContainer(CONTAINER, PARTITION_KEY_PATH)
    .catch((err) => {
      // Permanent errors latch the disabled flag so subsequent audits
      // short-circuit both the provisioning round-trip and the items.create.
      // Transient errors (429/503/network) clear the promise so the next
      // caller retries -- with a small risk of a thundering-herd burst,
      // which is bounded by admin write rate.
      if (_PERMANENT_COSMOS_ERRORS.has(err && err.code)) {
        _provisioningDisabled = true;
      }
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
  if (cosmos.isEnabled() && !_provisioningDisabled) {
    try {
      await _ensureContainer();
      await cosmos.container(CONTAINER).items.create(record);
    } catch (err) {
      if (_PERMANENT_COSMOS_ERRORS.has(err && err.code)) {
        _provisioningDisabled = true;
      }
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

// Test helper: reset module-scoped state so each test starts from a clean
// slate. Not part of the public API -- exposed under a leading underscore.
function _resetForTests() {
  _cosmosWriteWarned = false;
  _provisioningDisabled = false;
  _ensurePromise = null;
}

module.exports = { audit, _resetForTests };
