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
const fs = require('fs');
const path = require('path');
const cosmos = require('../utils/cosmosClient');
const { CACHE_DIR } = require('../utils/cachePath');

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
const VALUATION_CONTAINER = 'valuation-audit';
const VALUATION_PARTITION_KEY_PATH = '/computedAtDate';
const VALUATION_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const MAX_VALUATION_QUEUE = 2000;

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
let _valuationEnsurePromise = null;
let _valuationProvisioningDisabled = false;
let _valuationActive = false;
let _valuationQueue = [];
let _valuationDrainWaiters = [];
let _valuationQueueWarned = false;
let _valuationAccepting = true;
let _valuationFallbackWarned = false;
let _fallbackWriteChain = Promise.resolve();
let _lastFallbackPruneDate = null;
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

function _ensureValuationContainer() {
  if (!cosmos.isEnabled() || _valuationProvisioningDisabled) return Promise.resolve();
  if (_valuationEnsurePromise) return _valuationEnsurePromise;
  _valuationEnsurePromise = cosmos.ensureContainer(VALUATION_CONTAINER, VALUATION_PARTITION_KEY_PATH, {
    defaultTtl: VALUATION_RETENTION_SECONDS,
  })
    .catch((err) => {
      if (_PERMANENT_COSMOS_ERRORS.has(err && err.code)) {
        _valuationProvisioningDisabled = true;
      }
      _valuationEnsurePromise = null;
      throw err;
    });
  return _valuationEnsurePromise;
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

function _buildValuationAuditRecord(ev) {
  const computedAt = ev.computedAt || new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    type: 'valuation',
    query: String(ev.query || ''),
    fmv: Number.isFinite(ev.fmv) ? ev.fmv : null,
    method: ev.method || null,
    confidence: Number.isFinite(ev.confidence) ? ev.confidence : null,
    algorithmVersion: ev.algorithmVersion,
    configVersion: ev.configVersion,
    computedAt,
    computedAtDate: computedAt.slice(0, 10),
    requestId: ev.requestId || null,
  };
  if (ev.actorId) record.actorId = ev.actorId;
  if (ev.actorId && ev.ip) record.ip = ev.ip;
  return record;
}

async function _appendValuationFallback(record) {
  const operation = _fallbackWriteChain.then(async () => {
    if (_lastFallbackPruneDate !== record.computedAtDate) {
      await _pruneValuationFallbacks(record.computedAt);
      _lastFallbackPruneDate = record.computedAtDate;
    }
    const fallbackPath = path.join(CACHE_DIR, `valuation-audit-${record.computedAtDate}.jsonl`);
    await fs.promises.appendFile(fallbackPath, `${JSON.stringify(record)}\n`, 'utf8');
  });
  _fallbackWriteChain = operation.catch(() => {});
  return operation;
}

async function _persistValuationAudit(record) {
  if (!cosmos.isEnabled() || _valuationProvisioningDisabled) {
    await _writeValuationFallback(record);
    return;
  }
  try {
    await _ensureValuationContainer();
    await cosmos.container(VALUATION_CONTAINER).items.create(record);
  } catch (err) {
    if (_PERMANENT_COSMOS_ERRORS.has(err && err.code)) {
      _valuationProvisioningDisabled = true;
    }
    await _writeValuationFallback(record);
  }
}

async function _writeValuationFallback(record) {
  try {
    await _appendValuationFallback(record);
  } catch (err) {
    if (!_valuationFallbackWarned) {
      _valuationFallbackWarned = true;
      console.warn(`[valuation-audit] persistence failed: ${err.code || err.message}`);
    }
  }
}

async function _pruneValuationFallbacks(now = new Date().toISOString()) {
  const cutoff = new Date(Date.parse(now) - VALUATION_RETENTION_SECONDS * 1000)
    .toISOString().slice(0, 10);
  const names = await fs.promises.readdir(CACHE_DIR);
  await Promise.all(names
    .filter(name => /^valuation-audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .filter(name => name.slice(16, 26) < cutoff)
    .map(name => fs.promises.unlink(path.join(CACHE_DIR, name))));
}

function _resolveValuationDrains() {
  if (_valuationActive || _valuationQueue.length) return;
  const waiters = _valuationDrainWaiters;
  _valuationDrainWaiters = [];
  for (const resolve of waiters) resolve();
}

function _runNextValuationAudit() {
  if (_valuationActive) return;
  const next = _valuationQueue.shift();
  if (!next) {
    _resolveValuationDrains();
    return;
  }
  _valuationActive = true;
  _persistValuationAudit(next.record)
    .then(() => next.resolve(true))
    .finally(() => {
      _valuationActive = false;
      _runNextValuationAudit();
    });
}

function writeValuationAudit(ev) {
  if (process.env.NODE_ENV === 'test') return Promise.resolve(false);
  if (!_valuationAccepting) return Promise.resolve(false);
  if (_valuationQueue.length + Number(_valuationActive) >= MAX_VALUATION_QUEUE) {
    if (!_valuationQueueWarned) {
      _valuationQueueWarned = true;
      console.warn(`[valuation-audit] queue full; dropping records above ${MAX_VALUATION_QUEUE}`);
    }
    return Promise.resolve(false);
  }
  const record = _buildValuationAuditRecord(ev);
  return new Promise((resolve) => {
    _valuationQueue.push({ record, resolve });
    _runNextValuationAudit();
  });
}

function drainValuationAudits() {
  if (!_valuationActive && !_valuationQueue.length) return Promise.resolve();
  return new Promise(resolve => _valuationDrainWaiters.push(resolve));
}

function closeAndDrainValuationAudits() {
  _valuationAccepting = false;
  return drainValuationAudits();
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
  _valuationEnsurePromise = null;
  _valuationProvisioningDisabled = false;
  _valuationActive = false;
  _valuationQueue = [];
  _valuationDrainWaiters = [];
  _valuationQueueWarned = false;
  _valuationAccepting = true;
  _valuationFallbackWarned = false;
  _fallbackWriteChain = Promise.resolve();
  _lastFallbackPruneDate = null;
}

module.exports = {
  audit,
  writeValuationAudit,
  drainValuationAudits,
  closeAndDrainValuationAudits,
  _buildValuationAuditRecord,
  _pruneValuationFallbacks,
  _resetForTests,
};
