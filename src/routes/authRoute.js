// src/routes/authRoute.js -- Server-side authentication API
// POST /api/auth/signup, POST /api/auth/login, GET /api/auth/me, POST /api/auth/change-password
// CommonJS

'use strict';

const express = require('express');
const router = express.Router();
const authService = require('../services/authService');

/**
 * POST /api/auth/signup
 * Body: { username, password }
 * Returns: { userId, username, token }
 */
router.post('/signup', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await authService.signup(username, password);
    res.json(result);
  } catch (err) {
    const status = err.message.includes('already exists') ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Returns: { userId, username, token }
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await authService.login(username, password);
    res.json(result);
  } catch (err) {
    const status = err.message.includes('not found') ? 404
      : err.message.includes('Incorrect') ? 401
      : 400;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me
 * Header: Authorization: Bearer <token>
 * Returns: { userId, username }
 */
router.get('/me', (req, res) => {
  const token = _extractToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = authService.verifyToken(token);
    res.json({ userId: payload.userId, username: payload.username });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

/**
 * POST /api/auth/change-password
 * Header: Authorization: Bearer <token>
 * Body: { currentPassword, newPassword }
 */
router.post('/change-password', async (req, res) => {
  const token = _extractToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = authService.verifyToken(token);
    const { currentPassword, newPassword } = req.body || {};
    await authService.changePassword(payload.username, currentPassword, newPassword);
    res.json({ status: 'ok' });
  } catch (err) {
    const status = err.message.includes('Incorrect') ? 401 : 400;
    res.status(status).json({ error: err.message });
  }
});

// ── Helper ──────────────────────────────────────────────────

function _extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

module.exports = router;
