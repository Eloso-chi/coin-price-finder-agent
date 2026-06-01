// src/middleware/optionalAdminContext.js -- Non-blocking admin detection
//
// Sets `req.isAdmin = true` when the caller presents either:
//   1. `Authorization: Bearer <jwt>` with a valid token whose `isAdmin === true`
//      (verified via authService.verifyTokenStrict), OR
//   2. `x-api-key: <ADMIN_API_KEY>` (timing-safe compare).
//
// Unlike requireAdminOrKey, this middleware NEVER rejects the request -- it
// only annotates `req` so downstream handlers can choose to surface admin-only
// detail (e.g. verbose valuation reasoning that would otherwise leak licensed
// data or competitive weighting math to anonymous visitors).
//
// Anonymous and non-admin authenticated requests pass through with
// `req.isAdmin === false`.
//
// CommonJS.

'use strict';

const crypto = require('crypto');
const authService = require('../services/authService');

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

async function optionalAdminContext(req, _res, next) {
  req.isAdmin = false;

  // 1. Bearer JWT path (non-fatal: bad token -> just stay anonymous).
  // Defense-in-depth: a successfully verified JWT establishes caller identity,
  // so we never fall through to the shared-secret path. Otherwise a
  // non-admin user who also happens to know ADMIN_API_KEY would silently
  // get escalated by the api-key branch.
  const token = _extractBearer(req);
  if (token) {
    try {
      const claims = await authService.verifyTokenStrict(token);
      if (claims && claims.isAdmin === true) {
        req.isAdmin = true;
        req.adminActor = { userId: claims.userId, username: claims.username, via: 'jwt' };
      }
      return next();
    } catch {
      // Invalid/expired token -- intentionally ignore; fall through to api-key.
    }
  }

  // 2. ADMIN_API_KEY shared-secret path (only reached when no valid JWT).
  const providedKey = req.headers['x-api-key'] || '';
  if (ADMIN_API_KEY && _timingSafeKeyMatch(providedKey, ADMIN_API_KEY)) {
    req.isAdmin = true;
    req.adminActor = { userId: 'admin-key', username: 'admin-key', via: 'api-key' };
  }

  return next();
}

module.exports = optionalAdminContext;
