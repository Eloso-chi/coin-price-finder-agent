// src/services/authService.js -- Server-side user authentication
// bcrypt password hashing + JWT session tokens.
// User store: cache/users.json (persisted to disk).
// CommonJS

'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { CACHE_DIR } = require('../utils/cachePath');
const cosmos = require('../utils/cosmosClient');

const STORE_PATH = path.join(CACHE_DIR, 'users.json');
const BCRYPT_ROUNDS = 12;
// Admin accounts must use a stronger password than the 6-char floor used
// historically for regular users. CLI/bootstrap reset paths enforce this.
const ADMIN_MIN_PASSWORD_LEN = 12;

// ── JWT secret ──────────────────────────────────────────────
// In production, JWT_SECRET MUST be set via environment variable.
// In development, a random secret is generated (sessions lost on restart).
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: JWT_SECRET environment variable is required in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
const JWT_EXPIRY = '7d';

if (!process.env.JWT_SECRET) {
  console.warn('  [auth] WARNING: JWT_SECRET not set -- sessions will not survive restarts.');
}

// ── Store ───────────────────────────────────────────────────
let _store = null;

// ── verifyTokenStrict TTL cache (backlog #218) ──────────────
// Small in-process Map keyed by username with a short TTL (default 5s).
// Caches the (doc.userId, doc.tokenVersion, doc.isAdmin) tuple needed for
// strict verification so back-to-back admin requests skip the Cosmos read.
// Disabled when STRICT_TOKEN_CACHE_TTL_MS=0. Invalidation hooks fire on
// every _saveUser (covers grantAdmin / revokeAdmin / changePassword /
// resetPassword) and on deleteUser.
const STRICT_TOKEN_CACHE_TTL_MS = (() => {
  const raw = process.env.STRICT_TOKEN_CACHE_TTL_MS;
  if (raw === undefined || raw === '') return 5000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 5000;
})();
const _strictCache = new Map(); // username -> { expiresAt, userId, tokenVersion, isAdmin }
function _strictCacheGet(username) {
  if (!STRICT_TOKEN_CACHE_TTL_MS) return null;
  const entry = _strictCache.get(username);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    _strictCache.delete(username);
    return null;
  }
  return entry;
}
function _strictCacheSet(username, doc) {
  if (!STRICT_TOKEN_CACHE_TTL_MS) return;
  _strictCache.set(username, {
    expiresAt: Date.now() + STRICT_TOKEN_CACHE_TTL_MS,
    userId: doc.userId,
    tokenVersion: typeof doc.tokenVersion === 'number' ? doc.tokenVersion : 0,
    isAdmin: doc.isAdmin === true,
  });
}
function _strictCacheInvalidate(username) {
  _strictCache.delete((username || '').trim().toLowerCase());
}
function _strictCacheClear() { _strictCache.clear(); }
function _strictCacheSize() { return _strictCache.size; }

function loadStore() {
  if (_store) return _store;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    _store = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    _store = {};
  }
  return _store;
}

function saveStore() {
  const data = JSON.stringify(_store, null, 2);
  fs.writeFileSync(STORE_PATH, data, 'utf8');
}

// ── Public API ──────────────────────────────────────────────

/**
 * Create a new user account.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{userId: string, token: string}>}
 */
async function signup(username, password) {
  username = (username || '').trim().toLowerCase();
  if (!username || username.length < 1) throw new Error('Username is required');
  if (username.length > 50) throw new Error('Username too long');
  if (!/^[a-z0-9_.-]+$/.test(username)) throw new Error('Username may only contain letters, numbers, dots, hyphens, underscores');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');

  const userId = crypto.randomUUID();
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // tokenVersion lets us invalidate all outstanding JWTs for a user by
  // bumping the number (used on revoke-admin, password reset, etc.).
  const acct = { userId, hash, createdAt: new Date().toISOString(), tokenVersion: 0 };

  if (cosmos.isEnabled()) {
    const cont = cosmos.container('users');
    // Check existence in both Cosmos and file store
    let exists = false;
    try {
      const { resource } = await cont.item(username, username).read();
      if (resource) exists = true;
    } catch (err) {
      if (err.code !== 404) throw err;
    }
    if (!exists) {
      const store = loadStore();
      if (store[username]) exists = true;
    }
    if (exists) throw new Error('Username already exists');
    await cont.items.create({ id: username, username, ...acct });
  } else {
    const store = loadStore();
    if (store[username]) throw new Error('Username already exists');
    store[username] = acct;
    _store = store;
    saveStore();
  }

  const token = _signToken(userId, username, { isAdmin: false, tokenVersion: 0 });
  return { userId, token, username };
}

/**
 * Log in to an existing account.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{userId: string, token: string}>}
 */
async function login(username, password) {
  username = (username || '').trim().toLowerCase();
  let acct;

  if (cosmos.isEnabled()) {
    try {
      const { resource } = await cosmos.container('users').item(username, username).read();
      acct = resource || null;
    } catch (err) {
      if (err.code !== 404) throw err;
      // Not in Cosmos -- fall through to file store
    }
  }

  // Fall back to file store (handles pre-Cosmos accounts)
  if (!acct) {
    const store = loadStore();
    acct = store[username];
  }

  if (!acct) throw new Error('Account not found');

  const valid = await bcrypt.compare(password, acct.hash);
  if (!valid) throw new Error('Incorrect password');

  const token = _signToken(acct.userId, username, {
    isAdmin: acct.isAdmin === true,
    tokenVersion: typeof acct.tokenVersion === 'number' ? acct.tokenVersion : 0,
  });
  return {
    userId: acct.userId,
    token,
    username,
    isAdmin: acct.isAdmin === true,
  };
}

/**
 * Change password for a user. Bumps tokenVersion to invalidate outstanding JWTs.
 * Persists via `_saveUser` so the file-store mirror policy and Cosmos system-field
 * stripping are applied consistently with grant/revoke/reset.
 * @param {string} username
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
async function changePassword(username, currentPassword, newPassword) {
  username = (username || '').trim().toLowerCase();
  if (!newPassword || newPassword.length < 6) throw new Error('New password must be at least 6 characters');

  const doc = await getUser(username);
  if (!doc) throw new Error('Account not found');

  const valid = await bcrypt.compare(currentPassword, doc.hash);
  if (!valid) throw new Error('Current password is incorrect');
  doc.hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  // Bump tokenVersion so any other outstanding JWTs are invalidated.
  doc.tokenVersion = (typeof doc.tokenVersion === 'number' ? doc.tokenVersion : 0) + 1;
  doc.passwordChangedAt = new Date().toISOString();
  await _saveUser(username, doc);
}

/**
 * Verify a JWT and return the payload.
 * @param {string} token
 * @returns {{ userId: string, username: string }}
 * @throws if token is invalid or expired
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

/**
 * Check if a username exists.
 * @param {string} username
 * @returns {boolean}
 */
function userExists(username) {
  if (cosmos.isEnabled()) {
    // Sync check not possible with Cosmos -- use file fallback or make async
    // For routes that need this, they should use userExistsAsync
    const store = loadStore();
    return !!store[(username || '').trim().toLowerCase()];
  }
  const store = loadStore();
  return !!store[(username || '').trim().toLowerCase()];
}

/**
 * Async version of userExists for Cosmos DB.
 * @param {string} username
 * @returns {Promise<boolean>}
 */
async function userExistsAsync(username) {
  username = (username || '').trim().toLowerCase();
  if (cosmos.isEnabled()) {
    try {
      await cosmos.container('users').item(username, username).read();
      return true;
    } catch (err) {
      if (err.code === 404) return false;
      throw err;
    }
  }
  const store = loadStore();
  return !!store[username];
}

/**
 * Delete a user account (does NOT delete their coins -- that's separate).
 * @param {string} username
 * @returns {boolean} true if deleted
 */
async function deleteUser(username) {
  const key = (username || '').trim().toLowerCase();
  if (cosmos.isEnabled()) {
    try {
      await cosmos.container('users').item(key, key).delete();
      _strictCacheInvalidate(key);
      return true;
    } catch (err) {
      if (err.code === 404) return false;
      throw err;
    }
  }
  const store = loadStore();
  if (!store[key]) return false;
  delete store[key];
  _store = store;
  saveStore();
  _strictCacheInvalidate(key);
  return true;
}

// ── Internal ────────────────────────────────────────────────

function _signToken(userId, username, extras) {
  const payload = {
    userId,
    username,
    isAdmin: extras && extras.isAdmin === true,
    tokenVersion: extras && typeof extras.tokenVersion === 'number' ? extras.tokenVersion : 0,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

// ── Admin helpers ───────────────────────────────────────────

/**
 * Read a user record from whichever store has it.
 * Returns null if not found. Includes the bcrypt hash -- callers MUST NOT
 * return the raw record over the wire.
 * @param {string} username
 * @returns {Promise<object|null>}
 */
async function getUser(username) {
  const key = (username || '').trim().toLowerCase();
  if (cosmos.isEnabled()) {
    try {
      const { resource } = await cosmos.container('users').item(key, key).read();
      if (resource) return resource;
    } catch (err) {
      if (err.code !== 404) throw err;
    }
  }
  const store = loadStore();
  return store[key] || null;
}

/**
 * Write a user record. For Cosmos-enabled deployments we always upsert to
 * Cosmos; for admin records (current OR newly-removed) we additionally
 * mirror to the file store so the admin role transitions can never diverge
 * between the two stores. Strips Cosmos system fields (`_rid`, `_self`,
 * `_etag`, `_attachments`, `_ts`) before persisting to either store.
 * Internal helper -- callers pass the already-mutated record.
 * @param {string} username
 * @param {object} doc
 * @returns {Promise<void>}
 */
async function _saveUser(username, doc) {
  const key = (username || '').trim().toLowerCase();

  // Strip Cosmos system fields so we don't echo them into the file store
  // or back into Cosmos with stale values.
  const clean = {};
  for (const k of Object.keys(doc || {})) {
    if (k.startsWith('_')) continue;
    if (k === 'id') continue;
    clean[k] = doc[k];
  }

  if (cosmos.isEnabled()) {
    const cont = cosmos.container('users');
    await cont.items.upsert({ id: key, username: key, ...clean });
  }

  // Mirror to the file store on EVERY write. The file mirror is the durable
  // fallback for `login()` when Cosmos returns 404 -- if any write only lands
  // in Cosmos, a transient Cosmos miss could authenticate against the stale
  // file copy (defeating password changes, revocations, etc.). The store is
  // small (one row per user) so the cost is negligible.
  _store = loadStore();
  _store[key] = clean;
  saveStore();

  // Invalidate the strict-verification TTL cache so the next admin request
  // re-reads the canonical record (catches grant/revoke/changePassword/
  // resetPassword and any other mutation that flows through _saveUser).
  _strictCacheInvalidate(key);
}

/**
 * Grant the admin role to an existing user. Idempotent.
 * Does NOT bump tokenVersion (a fresh admin's existing tokens are upgraded
 * on next sign-in; existing sessions stay valid as non-admin until then).
 * @param {string} username
 * @returns {Promise<{ username: string, userId: string, isAdmin: true }>}
 */
async function grantAdmin(username) {
  const key = (username || '').trim().toLowerCase();
  const doc = await getUser(key);
  if (!doc) throw new Error('Account not found');
  if (typeof doc.tokenVersion !== 'number') doc.tokenVersion = 0;
  doc.isAdmin = true;
  doc.adminGrantedAt = new Date().toISOString();
  // Explicit re-grant via the CLI clears the sticky revoke marker so the
  // bootstrap path will treat the account as a normal admin going forward.
  delete doc.adminRevokedAt;
  await _saveUser(key, doc);
  return { username: key, userId: doc.userId, isAdmin: true };
}

/**
 * Revoke the admin role. Bumps tokenVersion so any outstanding admin
 * JWT is rejected on the next request.
 * @param {string} username
 * @returns {Promise<{ username: string, userId: string, isAdmin: false }>}
 */
async function revokeAdmin(username) {
  const key = (username || '').trim().toLowerCase();
  const doc = await getUser(key);
  if (!doc) throw new Error('Account not found');
  doc.isAdmin = false;
  doc.adminRevokedAt = new Date().toISOString();
  doc.tokenVersion = (typeof doc.tokenVersion === 'number' ? doc.tokenVersion : 0) + 1;
  await _saveUser(key, doc);
  return { username: key, userId: doc.userId, isAdmin: false };
}

/**
 * Reset a user's password (admin-only -- bypasses the current-password check).
 * Used by the grant-admin CLI and emergency recovery. Bumps tokenVersion.
 * Enforces ADMIN_MIN_PASSWORD_LEN when the user is an admin.
 * @param {string} username
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
async function resetPassword(username, newPassword) {
  const key = (username || '').trim().toLowerCase();
  const doc = await getUser(key);
  if (!doc) throw new Error('Account not found');
  if (!newPassword || typeof newPassword !== 'string') {
    throw new Error('New password is required');
  }
  const isAdmin = doc.isAdmin === true;
  const minLen = isAdmin ? ADMIN_MIN_PASSWORD_LEN : 6;
  if (newPassword.length < minLen) {
    throw new Error(`Password must be at least ${minLen} characters`);
  }
  doc.hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  doc.tokenVersion = (typeof doc.tokenVersion === 'number' ? doc.tokenVersion : 0) + 1;
  doc.passwordResetAt = new Date().toISOString();
  await _saveUser(key, doc);
}

/**
 * Return the list of admin usernames. Reads file store only (admin records
 * are mirrored there by design).
 * @returns {Promise<{ username: string, userId: string, adminGrantedAt?: string }[]>}
 */
async function listAdmins() {
  const out = [];
  const store = loadStore();
  for (const [username, doc] of Object.entries(store)) {
    if (doc && doc.isAdmin === true) {
      out.push({
        username,
        userId: doc.userId,
        adminGrantedAt: doc.adminGrantedAt || null,
      });
    }
  }
  return out;
}

/**
 * Verify a JWT AND re-check the user's current tokenVersion + admin status.
 * Use this for any request that should be invalidated on revoke or password
 * reset. Returns the freshly-read user payload.
 * @param {string} token
 * @returns {Promise<{ userId: string, username: string, isAdmin: boolean, tokenVersion: number }>}
 * @throws if token is invalid, expired, or tokenVersion is stale
 */
async function verifyTokenStrict(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  const username = payload.username;

  // TTL-cached fast path: if we have a recent canonical snapshot of this
  // user, re-check tokenVersion + userId without a Cosmos round-trip.
  const cached = _strictCacheGet(username);
  if (cached) {
    if (payload.userId && cached.userId && payload.userId !== cached.userId) {
      throw new Error('Token has been revoked');
    }
    const tokenVersion = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
    if (tokenVersion !== cached.tokenVersion) {
      throw new Error('Token has been revoked');
    }
    return {
      userId: cached.userId,
      username,
      isAdmin: cached.isAdmin,
      tokenVersion: cached.tokenVersion,
    };
  }

  const doc = await getUser(username);
  if (!doc) throw new Error('Account no longer exists');
  // If the username was deleted and recreated, the new account has a fresh
  // userId. Reject the old JWT even though its tokenVersion happens to match
  // the new (zero) version.
  if (payload.userId && doc.userId && payload.userId !== doc.userId) {
    throw new Error('Token has been revoked');
  }
  const currentVersion = typeof doc.tokenVersion === 'number' ? doc.tokenVersion : 0;
  const tokenVersion = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
  if (tokenVersion !== currentVersion) {
    throw new Error('Token has been revoked');
  }
  _strictCacheSet(username, doc);
  return {
    userId: doc.userId,
    username: payload.username,
    isAdmin: doc.isAdmin === true,
    tokenVersion: currentVersion,
  };
}

/**
 * List all users (admin-only). Returns sanitized records -- no hashes.
 * @returns {{ username: string, userId: string, createdAt: string, isAdmin?: boolean }[]}
 */
function listUsers() {
  const store = loadStore();
  return Object.entries(store).map(([username, data]) => ({
    username,
    userId: data.userId,
    createdAt: data.createdAt || null,
    isAdmin: data.isAdmin === true,
  }));
}

// ── Test helpers ────────────────────────────────────────────

function _resetStore() {
  _store = {};
  saveStore();
  _strictCacheClear();
}

module.exports = {
  signup,
  login,
  changePassword,
  verifyToken,
  verifyTokenStrict,
  userExists,
  userExistsAsync,
  deleteUser,
  listUsers,
  getUser,
  grantAdmin,
  revokeAdmin,
  resetPassword,
  listAdmins,
  ADMIN_MIN_PASSWORD_LEN,
  _resetStore,
  _strictCacheClear,
  _strictCacheSize,
  STRICT_TOKEN_CACHE_TTL_MS,
};
