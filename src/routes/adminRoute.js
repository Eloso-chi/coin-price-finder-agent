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
 * GET /api/admin/stale-datasets?days=30&limit=50&includeSkipped=false
 * Staleness tracker: which CSVs need refreshing?
 *
 * By default, applies the same refresh-skip exclusions as
 * scripts/generate-freshness-report.js (dormant, confirmed-thin, thin-wait,
 * recently-confirmed-stale, dry-refresh-backoff) so scripts/refresh-stale.sh
 * doesn't waste scrapes on datasets the freshness report would skip.
 *
 * Pass `includeSkipped=true` to see the full picture (each row gets a
 * `skipReason` field when applicable).
 */
router.get('/stale-datasets', (req, res) => {
  try {
    const rawDays = parseInt(req.query.days, 10);
    const rawLimit = parseInt(req.query.limit, 10);
    const days = Math.max(1, Math.min(365, Number.isFinite(rawDays) ? rawDays : 30));
    const limit = Math.max(1, Math.min(500, Number.isFinite(rawLimit) ? rawLimit : 50));
    const includeSkipped = req.query.includeSkipped === 'true' || req.query.includeSkipped === '1';
    const result = adminService.getStaleDatasets({ days, limit, includeSkipped });
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

// ── APR Prefetch Status & Auction History ───────────────────

const prefetchScheduler = require('../services/prefetchScheduler');
const auctionPriceService = require('../services/auctionPriceService');
const pcgsQuotaService = require('../services/pcgsQuotaService');

/**
 * GET /api/admin/prefetch-status
 * Current state of the nightly APR prefetch scheduler.
 */
router.get('/prefetch-status', (_req, res) => {
  try {
    res.json(prefetchScheduler.getSchedulerStatus());
  } catch (err) {
    console.error('[admin] Prefetch status error:', err.message);
    res.status(500).json({ error: 'Failed to get prefetch status' });
  }
});

/**
 * POST /api/admin/prefetch-trigger
 * Manually trigger a prefetch run (for testing/admin).
 * Returns 202 Accepted — prefetch runs in background, check /prefetch-status for progress.
 */
router.post('/prefetch-trigger', (_req, res) => {
  try {
    const result = prefetchScheduler.triggerManual();
    res.status(202).json(result);
  } catch (err) {
    console.error('[admin] Prefetch trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/pcgs-quota
 * Current PCGS API quota status.
 */
router.get('/pcgs-quota', (_req, res) => {
  res.json(pcgsQuotaService.getStatus());
});

/**
 * GET /api/admin/auction-history?pcgsNo=7130&grade=65
 * Retrieve accumulated APR records for a coin.
 */
router.get('/auction-history', (req, res) => {
  const rawPcgsNo = parseInt(req.query.pcgsNo, 10);
  const rawGrade = parseInt(req.query.grade, 10);
  if (!Number.isFinite(rawPcgsNo)) {
    return res.status(400).json({ error: 'pcgsNo is required (numeric)' });
  }
  if (!Number.isFinite(rawGrade)) {
    return res.status(400).json({ error: 'grade is required (numeric)' });
  }
  try {
    const history = auctionPriceService.getHistory(rawPcgsNo, rawGrade);
    res.json(history);
  } catch (err) {
    console.error('[admin] Auction history error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve auction history' });
  }
});

/**
 * POST /api/admin/auction-fetch?pcgsNo=7130&grade=65
 * Trigger a live APR fetch for a specific coin (uses 1 API call).
 */
router.post('/auction-fetch', async (req, res) => {
  const rawPcgsNo = parseInt(req.query.pcgsNo || req.body?.pcgsNo, 10);
  const rawGrade = parseInt(req.query.grade || req.body?.grade, 10);
  if (!Number.isFinite(rawPcgsNo) || !Number.isFinite(rawGrade)) {
    return res.status(400).json({ error: 'pcgsNo and grade are required (numeric)' });
  }
  try {
    const result = await auctionPriceService.fetchByGrade(rawPcgsNo, rawGrade, { force: true });
    res.json(result);
  } catch (err) {
    console.error('[admin] Auction fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Terapeak meta sidecar export (#253) ─────────────────────

const fs = require('fs');
const path = require('path');
const META_PATH = path.join(__dirname, '..', '..', 'data', 'terapeak-meta.json');

/**
 * GET /api/admin/terapeak-meta
 * Returns the contents of data/terapeak-meta.json as the server currently
 * sees it on disk. Used by scripts/run-surface-freshness-loop.sh on remote
 * scraper machines (WSL/Codespaces) so the freshness classifier reads
 * Azure-current state, not a git-frozen snapshot. See #253.
 *
 * Response: application/json, the raw sidecar body.
 * Headers include `X-Meta-Mtime` (ISO8601 of the file's mtime) and
 * `X-Meta-Bytes` (raw file size) so clients can short-circuit identical
 * payloads in a future patch.
 *
 * Errors: 404 if the sidecar doesn't exist on this server yet; 500 on
 * unexpected I/O failure.
 */
router.get('/terapeak-meta', (_req, res) => {
  try {
    if (!fs.existsSync(META_PATH)) {
      return res.status(404).json({
        error: 'terapeak-meta.json not present on this server',
        path: 'data/terapeak-meta.json',
      });
    }
    const stat = fs.statSync(META_PATH);
    const body = fs.readFileSync(META_PATH);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('X-Meta-Mtime', stat.mtime.toISOString());
    res.set('X-Meta-Bytes', String(stat.size));
    res.type('application/json');
    res.send(body);
  } catch (err) {
    console.error('[admin] terapeak-meta export error:', err.message);
    res.status(500).json({ error: 'Failed to read terapeak-meta sidecar' });
  }
});

module.exports = router;
