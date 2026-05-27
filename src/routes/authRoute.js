// src/routes/authRoute.js -- Server-side authentication API
// POST /api/auth/signup, POST /api/auth/login, GET /api/auth/me, POST /api/auth/change-password
// CommonJS

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authService = require('../services/authService');
const auditService = require('../services/auditService');

// Stricter limit on /login to slow credential-stuffing attacks.
// Window + cap apply per source IP; standardHeaders so clients can back off.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'production' ? 5 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});

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
 * Returns: { userId, username, token, isAdmin }
 */
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const result = await authService.login(username, password);
    auditService.audit({
      action: 'signin',
      actor: { userId: result.userId, username: result.username },
      meta: { isAdmin: result.isAdmin === true },
      req,
    }).catch(() => {});
    res.json(result);
  } catch (err) {
    auditService.audit({
      action: 'signin-failed',
      actor: { username: (username || '').trim().toLowerCase() || 'anonymous' },
      meta: { reason: err.message },
      req,
    }).catch(() => {});
    const status = err.message.includes('not found') ? 404
      : err.message.includes('Incorrect') ? 401
      : 400;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me
 * Header: Authorization: Bearer <token>
 * Returns: { userId, username, isAdmin }
 * Uses verifyTokenStrict so revoked admins / bumped tokenVersions
 * are rejected immediately.
 */
router.get('/me', async (req, res) => {
  const token = _extractToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const claims = await authService.verifyTokenStrict(token);
    res.json({
      userId: claims.userId,
      username: claims.username,
      isAdmin: claims.isAdmin === true,
    });
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
