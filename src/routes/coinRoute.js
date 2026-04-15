// src/routes/coinRoute.js -- Server-side coin collection CRUD API
// All endpoints require a valid JWT in Authorization: Bearer <token>
// CommonJS

'use strict';

const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const coinStorage = require('../services/coinStorageService');

// ── Auth middleware ──────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = authService.verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

router.use(requireAuth);

// ── Endpoints ───────────────────────────────────────────────

/**
 * GET /api/coins — list all coins for the authenticated user.
 */
router.get('/', (req, res) => {
  const coins = coinStorage.getAllCoins(req.user.userId);
  res.json({ coins });
});

/**
 * GET /api/coins/count — coin count.
 */
router.get('/count', (req, res) => {
  res.json({ count: coinStorage.count(req.user.userId) });
});

/**
 * GET /api/coins/export — export backup JSON.
 */
router.get('/export', (req, res) => {
  res.json(coinStorage.exportCoins(req.user.userId));
});

/**
 * POST /api/coins — add (or update) a coin.
 * Body: coin object { series, year, mint, grade, ... }
 * Returns: { coinHash }
 */
router.post('/', (req, res) => {
  const coin = req.body;
  if (!coin || typeof coin !== 'object' || Array.isArray(coin)) {
    return res.status(400).json({ error: 'Invalid coin data' });
  }
  const hash = coinStorage.addCoin(req.user.userId, coin);
  res.json({ coinHash: hash });
});

/**
 * POST /api/coins/get — get a single coin by its identifying fields.
 * Body: coin object { series, year, mint, grade, notes, label }
 * Returns: { coin } or { coin: null }
 */
router.post('/get', (req, res) => {
  const coin = req.body;
  if (!coin || typeof coin !== 'object') {
    return res.status(400).json({ error: 'Missing coin data' });
  }
  const hash = coinStorage.coinHash(coin);
  const all = coinStorage.getAllCoins(req.user.userId);
  const found = all.find(c => c.coinHash === hash);
  res.json({ coin: found || null });
});

/**
 * POST /api/coins/import — import coins from backup.
 * Body: { format, coins: [...] }
 * Returns: { imported, skipped }
 */
router.post('/import', (req, res) => {
  const data = req.body;
  if (!data || data.format !== 'coin-price-agent-backup-v1' || !Array.isArray(data.coins)) {
    return res.status(400).json({ error: 'Invalid backup file format' });
  }
  if (data.coins.length > 5000) {
    return res.status(400).json({ error: 'Too many coins (max 5000 per import)' });
  }
  const result = coinStorage.importCoins(req.user.userId, data.coins);
  res.json(result);
});

/**
 * POST /api/coins/bulk-delete — delete multiple coins by hash.
 * Body: { hashes: string[] }
 * Returns: { deleted: number }
 */
router.post('/bulk-delete', (req, res) => {
  const { hashes } = req.body || {};
  if (!Array.isArray(hashes)) {
    return res.status(400).json({ error: 'hashes must be an array' });
  }
  const deleted = coinStorage.bulkDelete(req.user.userId, hashes);
  res.json({ deleted });
});

/**
 * PUT /api/coins/:hash — update a coin's count or costPer.
 * Body: { count?, costPer? }
 */
router.put('/:hash', (req, res) => {
  const { hash } = req.params;
  const { count, costPer } = req.body || {};
  let updated = false;
  if (count != null) {
    updated = coinStorage.updateCount(req.user.userId, hash, count) || updated;
  }
  if (costPer !== undefined) {
    updated = coinStorage.updateCostPer(req.user.userId, hash, costPer) || updated;
  }
  if (!updated) return res.status(404).json({ error: 'Coin not found' });
  res.json({ status: 'ok' });
});

/**
 * DELETE /api/coins/:hash — remove a coin.
 */
router.delete('/:hash', (req, res) => {
  const removed = coinStorage.removeCoin(req.user.userId, req.params.hash);
  if (!removed) return res.status(404).json({ error: 'Coin not found' });
  res.json({ status: 'ok' });
});

module.exports = router;
