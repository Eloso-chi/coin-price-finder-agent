// src/middleware/requireAdminOrKey.js -- Shared admin authorization
//
// Authorization precedence (first match wins):
//   1. `Authorization: Bearer <jwt>` with isAdmin === true AND a valid
//      current tokenVersion (verified via authService.verifyTokenStrict).
//   2. `x-api-key: <ADMIN_API_KEY>` (constant-time compare). Treated as a
//      break-glass shared key. Audited as `admin-key-use`.
//
// On success, sets `req.admin = { actor: { userId, username } }` for the
// downstream handler to use in audit calls. On failure, returns 401/403
// and emits an audit record.
//
// CommonJS.

'use strict';

const crypto = require('crypto');
const authService = require('../services/authService');
const auditService = require('../services/auditService');

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

function _extractBearer(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

function _timingSafeKeyMatch(provided, expected) {
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

/**
 * Express middleware: allow only admins (JWT-with-isAdmin OR ADMIN_API_KEY).
 */
async function requireAdminOrKey(req, res, next) {
  // 1. Try Bearer JWT first.
  const token = _extractBearer(req);
  let tokenInvalid = false;
  if (token) {
    try {
      const claims = await authService.verifyTokenStrict(token);
      if (claims.isAdmin === true) {
        req.admin = {
          actor: { userId: claims.userId, username: claims.username },
          via: 'jwt',
        };
        return next();
      }
      // Valid token but not admin -- 403.
      await auditService.audit({
        action: 'admin-denied',
        actor: { userId: claims.userId, username: claims.username },
        meta: { reason: 'not-admin', method: req.method, path: req.path },
        req,
      });
      return res.status(403).json({ error: 'Admin role required' });
    } catch {
      // Token invalid/expired/revoked -- fall through to key path.
      // We surface this in the audit log below so an operator can see
      // "invalid JWT presented + valid api-key used" patterns.
      tokenInvalid = true;
    }
  }

  // 2. Try ADMIN_API_KEY shared-secret.
  const providedKey = req.headers['x-api-key'] || '';
  if (ADMIN_API_KEY && _timingSafeKeyMatch(providedKey, ADMIN_API_KEY)) {
    req.admin = {
      actor: { userId: 'admin-key', username: 'admin-key' },
      via: 'api-key',
    };
    if (tokenInvalid) {
      auditService.audit({
        action: 'token-invalid',
        actor: req.admin.actor,
        meta: { method: req.method, path: req.path, note: 'invalid-jwt-with-valid-key' },
        req,
      }).catch(() => { /* audit must not block */ });
    }
    auditService.audit({
      action: 'admin-key-use',
      actor: req.admin.actor,
      meta: { method: req.method, path: req.path },
      req,
    }).catch(() => { /* audit must not block */ });
    return next();
  }

  // 3. Deny. Always return 401 to clients; the "key not configured" detail
  // stays in the server logs only (was previously a 403 leaking server config).
  auditService.audit({
    action: 'admin-denied',
    actor: { userId: 'anonymous', username: 'anonymous' },
    meta: {
      reason: tokenInvalid ? 'token-invalid' : (token ? 'token-invalid' : 'no-credentials'),
      method: req.method, path: req.path,
      adminKeyConfigured: !!ADMIN_API_KEY,
    },
    req,
  }).catch(() => { /* audit must not block */ });

  if (!ADMIN_API_KEY && !token) {
    console.warn('[admin] denying request: ADMIN_API_KEY is not set and no JWT was presented');
  }
  return res.status(401).json({ error: 'Invalid or missing admin credentials' });
}

module.exports = requireAdminOrKey;
module.exports.requireAdminOrKey = requireAdminOrKey;
