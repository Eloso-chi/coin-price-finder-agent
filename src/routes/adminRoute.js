// src/routes/adminRoute.js — Admin dashboard API endpoints
// CommonJS

'use strict';

const express = require('express');
const router = express.Router();
const adminService = require('../services/adminService');

// All routes are protected by requireAdmin middleware (applied in server.js mount)

/**
 * GET /api/admin/dashboard
 * Overview: users, data stats, quota, uptime
 */
router.get('/dashboard', (_req, res) => {
  try {
    const stats = adminService.getDashboardStats();
    res.json(stats);
  } catch (err) {
    console.error('[admin] Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

/**
 * GET /api/admin/stale-datasets?days=30&limit=50
 * Staleness tracker: which CSVs need refreshing?
 */
router.get('/stale-datasets', (req, res) => {
  try {
    const rawDays = parseInt(req.query.days, 10);
    const rawLimit = parseInt(req.query.limit, 10);
    const days = Math.max(1, Math.min(365, Number.isFinite(rawDays) ? rawDays : 30));
    const limit = Math.max(1, Math.min(500, Number.isFinite(rawLimit) ? rawLimit : 50));
    const result = adminService.getStaleDatasets({ days, limit });
    res.json(result);
  } catch (err) {
    console.error('[admin] Stale datasets error:', err.message);
    res.status(500).json({ error: 'Failed to analyze dataset staleness' });
  }
});

/**
 * GET /api/admin/data-health
 * Aggregate dataset health: totals, empty CSVs, date range
 */
router.get('/data-health', (_req, res) => {
  try {
    const health = adminService.getDatasetHealth();
    res.json(health);
  } catch (err) {
    console.error('[admin] Data health error:', err.message);
    res.status(500).json({ error: 'Failed to analyze data health' });
  }
});

module.exports = router;
