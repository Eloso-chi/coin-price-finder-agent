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

    // Generate recovery phrase + derive a second verifier from it
    const recovery = CoinCrypto.generateRecoveryPhrase();
    const recoverySalt = CoinCrypto.randomBytes(CoinCrypto.SALT_BYTES);
    const recoveryKey = await CoinCrypto.deriveKeyFromRecovery(recovery.seed, recoverySalt);
    const recoveryVerifier = await CoinCrypto.createVerifier(recoveryKey);

    // Generate a random data key and wrap it with both the password key and recovery key
    const dataKey = await CoinCrypto.generateDataKey();
    const wrappedDataKey = await CoinCrypto.wrapDataKey(key, dataKey);
    const recoveryWrappedDataKey = await CoinCrypto.wrapDataKey(recoveryKey, dataKey);

    accounts[username] = {
      userId,
      salt: CoinCrypto.bufToBase64(salt),
      verifier,
      recoverySeed: recovery.seed,
      recoverySalt: CoinCrypto.bufToBase64(recoverySalt),
      recoveryVerifier,
      wrappedDataKey,
      recoveryWrappedDataKey,
    };
    _saveAccounts(accounts);

    _session = { username, userId, key: dataKey };
    localStorage.setItem(SESSION_KEY, username);

    return { username, userId, recoveryPhrase: recovery.phrase };
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

    // Unwrap the data key if present (new accounts), otherwise use password key (legacy)
    let sessionKey = key;
    if (acct.wrappedDataKey) {
      sessionKey = await CoinCrypto.unwrapDataKey(
        key, acct.wrappedDataKey.iv, acct.wrappedDataKey.wrappedKey
      );
    }

    _session = { username, userId: acct.userId, key: sessionKey };
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
   * Log in using a recovery phrase. Derives the key from the stored
   * recovery seed and verifies against the recovery verifier.
   * After successful recovery login the caller should prompt the user
   * to set a new password (via changePassword-style re-encrypt).
   * @param {string} username
   * @param {string} phrase - the 8-word recovery phrase
   * @returns {Promise<{username, userId}>}
   * @throws if account not found, no recovery key stored, or phrase wrong
   */
  async function loginWithRecovery(username, phrase) {
    username = (username || '').trim();
    const accounts = _loadAccounts();
    const acct = accounts[username];
    if (!acct) throw new Error('Account not found on this device');
    if (!acct.recoverySeed || !acct.recoveryVerifier) {
      throw new Error('No recovery key set for this account');
    }
    if (!acct.recoveryWrappedDataKey) {
      throw new Error('This account was created before recovery was supported. Recovery is not available.');
    }

    const words = phrase.trim().toLowerCase().split(/\s+/);
    if (words.length !== 8) throw new Error('Recovery phrase must be exactly 8 words');

    // Derive key from stored seed and verify
    const recoverySalt = CoinCrypto.base64ToBuf(acct.recoverySalt);
    const recoveryKey = await CoinCrypto.deriveKeyFromRecovery(acct.recoverySeed, recoverySalt);
    const valid = await CoinCrypto.checkVerifier(recoveryKey, acct.recoveryVerifier);
    if (!valid) throw new Error('Recovery phrase does not match');

    // Unwrap the data key using the recovery-derived key
    const dataKey = await CoinCrypto.unwrapDataKey(
      recoveryKey,
      acct.recoveryWrappedDataKey.iv,
      acct.recoveryWrappedDataKey.wrappedKey
    );

    _session = { username, userId: acct.userId, key: dataKey, needsPasswordReset: true };
    localStorage.setItem(SESSION_KEY, username);

    return { username, userId: acct.userId };
  }

  /**
   * After recovery login, set a new password. Re-wraps the data key with
   * the new password-derived key. No coin re-encryption needed because
   * coins are encrypted with the data key (which doesn't change).
   * @param {string} newPassword
   * @returns {Promise<void>}
   */
  async function resetPasswordWithRecovery(newPassword) {
    if (!_session) throw new Error('Not logged in');
    if (!newPassword || newPassword.length < 6) throw new Error('New password must be at least 6 characters');

    const username = _session.username;
    const accounts = _loadAccounts();
    const acct = accounts[username];
    if (!acct) throw new Error('Account not found');

    // The session key IS the data key (unwrapped during recovery login)
    const dataKey = _session.key;

    // Derive new password key and re-wrap the data key
    const newSalt = CoinCrypto.randomBytes(CoinCrypto.SALT_BYTES);
    const newKey = await CoinCrypto.deriveKey(newPassword, newSalt);
    const newVerifier = await CoinCrypto.createVerifier(newKey);
    const wrappedDataKey = await CoinCrypto.wrapDataKey(newKey, dataKey);

    // Update account — preserve recovery key wrapping
    acct.salt = CoinCrypto.bufToBase64(newSalt);
    acct.verifier = newVerifier;
    acct.wrappedDataKey = wrappedDataKey;
    _saveAccounts(accounts);

    _session.needsPasswordReset = false;
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

    // Re-wrap the data key with the new password key (if present)
    if (acct.wrappedDataKey) {
      const dataKey = _session.key; // already the unwrapped data key
      acct.wrappedDataKey = await CoinCrypto.wrapDataKey(newKey, dataKey);
    }

    // Update account
    acct.salt = CoinCrypto.bufToBase64(newSalt);
    acct.verifier = newVerifier;
    _saveAccounts(accounts);

    // Session key stays the same (it's the data key, not the password key)
    // For legacy accounts without wrappedDataKey, update session to new key
    if (!acct.wrappedDataKey) {
      _session.key = newKey;
    }

    return { newKey };
  }

  return {
    signup,
    login,
    loginWithRecovery,
    resetPasswordWithRecovery,
    logout,
    currentUser,
    pendingReauth,
    deleteAccount,
    listAccounts,
    changePassword,
  };
})();
