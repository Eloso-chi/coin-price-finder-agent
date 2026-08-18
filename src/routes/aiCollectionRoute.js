'use strict';

const express = require('express');
const authService = require('../services/authService');
const coinStorage = require('../services/coinStorageService');
const { getCollectionContext } = require('../services/collectionContextService');

const router = express.Router();

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  try {
    req.user = authService.verifyToken(token);
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}

router.post('/collection', requireAuth, (req, res) => {
  const intent = typeof req.body?.intent === 'string' ? req.body.intent : 'summary';
  const coins = coinStorage.getAllCoins(req.user.userId);
  const context = getCollectionContext(coins, intent);
  return res.json({
    ok: true,
    mode: 'ai',
    ...context,
    handoff: {
      route: '/api/coins',
      authenticatedUser: true,
    },
  });
});

module.exports = router;