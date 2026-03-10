// auth.js — Client-only signup / login / logout
// Depends on: CoinCrypto (crypto.js)
// All identity data stays in localStorage. Never contacts the server.

'use strict';

const CoinAuth = (() => {
  const STORAGE_KEY = 'cpf_accounts';
  const SESSION_KEY = 'cpf_active_user';

  // In-memory session state (lost on page reload)
  let _session = null; // { username, userId, key }

  // ── localStorage helpers ─────────────────────────────────

  function _loadAccounts() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch { return {}; }
  }

  function _saveAccounts(accounts) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Create a new local account.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<{username, userId}>}
   * @throws if username already exists or inputs invalid
   */
  async function signup(username, password) {
    username = (username || '').trim();
    if (!username || username.length < 1) throw new Error('Username is required');
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');

    const accounts = _loadAccounts();
    if (accounts[username]) throw new Error('Username already exists on this device');

    const userId = crypto.randomUUID();
    const salt = CoinCrypto.randomBytes(CoinCrypto.SALT_BYTES);
    const key = await CoinCrypto.deriveKey(password, salt);
    const verifier = await CoinCrypto.createVerifier(key);

    accounts[username] = {
      userId,
      salt: CoinCrypto.bufToBase64(salt),
      verifier,
    };
    _saveAccounts(accounts);

    _session = { username, userId, key };
    localStorage.setItem(SESSION_KEY, username);

    return { username, userId };
  }

  /**
   * Log in to an existing local account.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<{username, userId}>}
   * @throws if account not found or password wrong
   */
  async function login(username, password) {
    username = (username || '').trim();
    const accounts = _loadAccounts();
    const acct = accounts[username];
    if (!acct) throw new Error('Account not found on this device');

    const salt = CoinCrypto.base64ToBuf(acct.salt);
    const key = await CoinCrypto.deriveKey(password, salt);
    const valid = await CoinCrypto.checkVerifier(key, acct.verifier);
    if (!valid) throw new Error('Incorrect password');

    _session = { username, userId: acct.userId, key };
    localStorage.setItem(SESSION_KEY, username);

    return { username, userId: acct.userId };
  }

  /**
   * Log out (clear in-memory key).
   */
  function logout() {
    _session = null;
    localStorage.removeItem(SESSION_KEY);
  }

  /**
   * Get current session (null if not logged in).
   * @returns {{ username: string, userId: string, key: CryptoKey } | null}
   */
  function currentUser() {
    return _session;
  }

  /**
   * Check if a session was active before page reload.
   * Returns the username that needs re-authentication, or null.
   * @returns {string|null}
   */
  function pendingReauth() {
    if (_session) return null;
    const name = localStorage.getItem(SESSION_KEY);
    if (!name) return null;
    const accounts = _loadAccounts();
    return accounts[name] ? name : null;
  }

  /**
   * Delete a local account and all its localStorage data.
   * Does NOT clear IndexedDB (user must do that separately via CoinStorage.clearAll).
   * @param {string} username
   */
  function deleteAccount(username) {
    const accounts = _loadAccounts();
    delete accounts[username];
    _saveAccounts(accounts);
    if (_session && _session.username === username) {
      logout();
    }
  }

  /**
   * List all local account usernames (no secrets).
   * @returns {string[]}
   */
  function listAccounts() {
    return Object.keys(_loadAccounts());
  }

  /**
   * Change password for the current user.
   * Generates a new salt + key, re-encrypts the verifier, and returns the new
   * key so the caller can re-encrypt coin inventory.
   * @param {string} currentPassword
   * @param {string} newPassword
   * @returns {Promise<{newKey: CryptoKey}>}
   * @throws if not logged in, current password wrong, or new password too short
   */
  async function changePassword(currentPassword, newPassword) {
    if (!_session) throw new Error('Not logged in');
    if (!newPassword || newPassword.length < 6) throw new Error('New password must be at least 6 characters');

    const username = _session.username;
    const accounts = _loadAccounts();
    const acct = accounts[username];
    if (!acct) throw new Error('Account not found');

    // Verify current password
    const oldSalt = CoinCrypto.base64ToBuf(acct.salt);
    const oldKey = await CoinCrypto.deriveKey(currentPassword, oldSalt);
    const valid = await CoinCrypto.checkVerifier(oldKey, acct.verifier);
    if (!valid) throw new Error('Current password is incorrect');

    // Derive new key with fresh salt
    const newSalt = CoinCrypto.randomBytes(CoinCrypto.SALT_BYTES);
    const newKey = await CoinCrypto.deriveKey(newPassword, newSalt);
    const newVerifier = await CoinCrypto.createVerifier(newKey);

    // Update account
    acct.salt = CoinCrypto.bufToBase64(newSalt);
    acct.verifier = newVerifier;
    _saveAccounts(accounts);

    // Update session
    _session.key = newKey;

    return { newKey };
  }

  return {
    signup,
    login,
    logout,
    currentUser,
    pendingReauth,
    deleteAccount,
    listAccounts,
    changePassword,
  };
})();
