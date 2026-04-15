// auth.js — Server-backed signup / login / logout
// Calls /api/auth/* endpoints. Session (JWT) stored in memory only.
// Accounts and coins persist on the server across browser restarts.

'use strict';

const CoinAuth = (() => {
  // In-memory session state (lost on page reload — user must re-login)
  let _session = null; // { username, userId, token }

  // ── Internal helpers ─────────────────────────────────────

  function _authHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (_session && _session.token) h['Authorization'] = 'Bearer ' + _session.token;
    return h;
  }

  // ── Public API ───────────────────────────────────────────

  /**
   * Create a new account on the server.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<{username, userId}>}
   */
  async function signup(username, password) {
    const resp = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Signup failed');
    _session = { username: data.username, userId: data.userId, token: data.token };
    return { username: data.username, userId: data.userId };
  }

  /**
   * Log in to an existing server account.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<{username, userId}>}
   */
  async function login(username, password) {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Login failed');
    _session = { username: data.username, userId: data.userId, token: data.token };
    return { username: data.username, userId: data.userId };
  }

  /**
   * Log out (clear in-memory token).
   */
  function logout() {
    _session = null;
  }

  /**
   * Get current session (null if not logged in).
   * @returns {{ username: string, userId: string, token: string } | null}
   */
  function currentUser() {
    return _session;
  }

  /**
   * No-op — server-backed auth has no localStorage session to restore.
   * @returns {null}
   */
  function pendingReauth() {
    return null;
  }

  /**
   * Change password on the server.
   * @param {string} currentPassword
   * @param {string} newPassword
   * @returns {Promise<{}>}
   */
  async function changePassword(currentPassword, newPassword) {
    const resp = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: _authHeaders(),
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Password change failed');
    return {};
  }

  // Stubs — kept for interface compatibility with old calling code
  function deleteAccount() {}
  function listAccounts() { return []; }
  async function loginWithRecovery() { throw new Error('Recovery login is not available — use your password to log in'); }
  async function resetPasswordWithRecovery() { throw new Error('Recovery is not available in server-backed mode'); }

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
