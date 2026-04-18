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

// ── JWT secret ──────────────────────────────────────────────
// Use env var if set, otherwise generate a random secret on startup.
// A generated secret means all JWTs expire on server restart (users must re-login).
// For persistent sessions across restarts, set JWT_SECRET in your env.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
const JWT_EXPIRY = '7d';

if (!process.env.JWT_SECRET) {
  console.warn('  [auth] WARNING: JWT_SECRET not set -- sessions will not survive restarts.');
}

// ── Store ───────────────────────────────────────────────────
let _store = null;

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
  const acct = { userId, hash, createdAt: new Date().toISOString() };

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

  const token = _signToken(userId, username);
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

  const token = _signToken(acct.userId, username);
  return { userId: acct.userId, token, username };
}

/**
 * Change password for a user.
 * @param {string} username
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<void>}
 */
async function changePassword(username, currentPassword, newPassword) {
  username = (username || '').trim().toLowerCase();
  if (!newPassword || newPassword.length < 6) throw new Error('New password must be at least 6 characters');

  let doc;
  let source = 'file'; // track where the account was found

  if (cosmos.isEnabled()) {
    try {
      const { resource } = await cosmos.container('users').item(username, username).read();
      if (resource) { doc = resource; source = 'cosmos'; }
    } catch (err) {
      if (err.code !== 404) throw err;
      // Not in Cosmos -- fall through to file store
    }
  }

  // Fall back to file store (handles pre-Cosmos accounts)
  if (!doc) {
    const store = loadStore();
    doc = store[username];
    source = 'file';
  }

  if (!doc) throw new Error('Account not found');

  const valid = await bcrypt.compare(currentPassword, doc.hash);
  if (!valid) throw new Error('Current password is incorrect');
  doc.hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  if (source === 'cosmos') {
    await cosmos.container('users').item(username, username).replace(doc);
  } else {
    _store = loadStore();
    _store[username] = doc;
    saveStore();
  }
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
  return true;
}

// ── Internal ────────────────────────────────────────────────

function _signToken(userId, username) {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

// ── Test helpers ────────────────────────────────────────────

function _resetStore() {
  _store = {};
  saveStore();
}

module.exports = {
  signup,
  login,
  changePassword,
  verifyToken,
  userExists,
  userExistsAsync,
  deleteUser,
  _resetStore,
};
