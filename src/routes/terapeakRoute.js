// src/routes/terapeakRoute.js — Terapeak CSV import API
// CommonJS

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const router = express.Router();

const terapeakService = require('../services/terapeakService');
const quotaService = require('../services/terapeakQuotaService');

// ── Admin API-key guard (shared with server.js) ───────────
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Admin API key not configured on server' });
  }
  const provided = req.headers['x-api-key'] || '';
  if (provided.length !== ADMIN_API_KEY.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ADMIN_API_KEY))) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// ── Multer: accept CSV uploads up to 10 MB ──────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname || '').toLowerCase();
    if (ext.endsWith('.csv') || ext.endsWith('.tsv') || ext.endsWith('.txt') || file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'), false);
    }
  }
});

/**
 * POST /api/terapeak/import
 * Upload a Terapeak CSV export.
 * Body (multipart/form-data):
 *   - file: the CSV file
 *   - searchTerm: the keyword used in Terapeak (e.g. "1892-S Morgan Silver Dollar")
 */
router.post('/import', requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }
    const searchTerm = req.body?.searchTerm;
    if (!searchTerm) {
      return res.status(400).json({ error: 'searchTerm is required — the keyword you searched in Terapeak' });
    }

    // ── Quota: log the import for tracking, but don't enforce the limit ──
    // Imports are uploads of already-scraped data — the actual Terapeak
    // search already happened.  Blocking imports doesn't reduce eBay load.
    const queryCount = Math.max(1, parseInt(req.body?.queryCount) || 1);
    const quota = quotaService.getStatus();
    // Still log it for visibility, but never block
    quotaService.recordQueries(queryCount, `import: ${searchTerm}`);

    // Parse CSV
    const { comps, skipped, columns, unmappedColumns, totalRows } = terapeakService.parseCSV(req.file.buffer, searchTerm);

    if (comps.length === 0) {
      return res.status(422).json({
        error: 'No valid comps found in CSV',
        details: {
          totalRows,
          skipped,
          mappedColumns: columns,
          unmappedColumns,
          hint: 'Ensure the CSV has columns like "Title", "Sold Price", "Sold Date", etc.'
        }
      });
    }

    // Import into store
    const result = terapeakService.importComps(searchTerm, comps, {
      fileName: req.file.originalname,
      fileSize: req.file.size
    });

    res.json({
      status: 'ok',
      import: result,
      parse: {
        totalRows,
        validComps: comps.length,
        skipped,
        mappedColumns: columns,
        unmappedColumns
      },
      quota: { used: quota.used, remaining: quota.remaining, limit: quota.limit, warning: quota.warning || null }
    });
  } catch (err) {
    console.error('[terapeak] Import error:', err.message);
    res.status(500).json({ error: 'CSV import failed' });
  }
});

/**
 * POST /api/terapeak/import-text
 * Import CSV as pasted text (no file upload needed).
 * Body (JSON):
 *   - csvText: the raw CSV string
 *   - searchTerm: the keyword used in Terapeak
 */
router.post('/import-text', requireAdmin, express.json(), (req, res) => {
  try {
    const { csvText, searchTerm } = req.body || {};
    if (!csvText) return res.status(400).json({ error: 'csvText is required' });
    if (!searchTerm) return res.status(400).json({ error: 'searchTerm is required' });

    const { comps, skipped, columns, unmappedColumns, totalRows } = terapeakService.parseCSV(csvText, searchTerm);

    if (comps.length === 0) {
      return res.status(422).json({
        error: 'No valid comps found in CSV text',
        details: { totalRows, skipped, mappedColumns: columns, unmappedColumns }
      });
    }

    // ── Quota: record the query for text imports too ──
    const queryCount = Math.max(1, parseInt(req.body?.queryCount) || 1);
    const quota = quotaService.recordQueries(queryCount, `import-text: ${searchTerm}`);
    if (!quota.ok) {
      return res.status(429).json({
        error: 'Terapeak daily query limit reached',
        quota: { used: quota.used, remaining: quota.remaining, limit: quota.limit },
        message: quota.warning
      });
    }

    const result = terapeakService.importComps(searchTerm, comps);
    res.json({
      status: 'ok',
      import: result,
      parse: { totalRows, validComps: comps.length, skipped },
      quota: { used: quota.used, remaining: quota.remaining, limit: quota.limit, warning: quota.warning || null }
    });
  } catch (err) {
    console.error('[terapeak] Import-text error:', err.message);
    res.status(500).json({ error: 'CSV text import failed' });
  }
});

/**
 * GET /api/terapeak/datasets
 * List all imported Terapeak datasets.
 */
router.get('/datasets', (_req, res) => {
  const datasets = terapeakService.listDatasets();
  res.json({ datasets });
});

/**
 * GET /api/terapeak/lookup?q=keywords
 * Look up terapeak sold comps matching a search term.
 */
router.get('/lookup', (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q query param required' });
  // Auto-detect metal from query so the lookup rejects cross-metal datasets
  const metal = req.query.metal || terapeakService.detectMetal(q) || undefined;
  const data = terapeakService.lookupComps(q, { metal });
  if (!data) return res.json({ found: false, comps: [] });
  res.json({
    found: true,
    searchTerm: data.searchTerm,
    compCount: data.comps.length,
    lastImport: data.lastImport,
    comps: data.comps
  });
});

/**
 * DELETE /api/terapeak/datasets/:key
 * Delete a specific Terapeak dataset.
 */
router.delete('/datasets/:key', requireAdmin, (req, res) => {
  const deleted = terapeakService.deleteDataset(decodeURIComponent(req.params.key));
  if (deleted) {
    res.json({ status: 'ok', message: 'Dataset deleted' });
  } else {
    res.status(404).json({ error: 'Dataset not found' });
  }
});

/**
 * DELETE /api/terapeak/datasets
 * Clear all Terapeak data.
 */
router.delete('/datasets', requireAdmin, (_req, res) => {
  terapeakService.clearAll();
  res.json({ status: 'ok', message: 'All Terapeak data cleared' });
});

// ══════════════════════════════════════════════════════════
// TERAPEAK DAILY QUERY QUOTA ENDPOINTS
// ══════════════════════════════════════════════════════════

/**
 * GET /api/terapeak/quota
 * Get current daily quota status.
 */
router.get('/quota', (_req, res) => {
  res.json(quotaService.getStatus());
});

/**
 * POST /api/terapeak/quota/record
 * Manually record Terapeak queries (e.g. searches/filters done in eBay UI).
 * Body: { count: number, note?: string }
 */
router.post('/quota/record', requireAdmin, express.json(), (req, res) => {
  const count = Math.max(1, parseInt(req.body?.count) || 1);
  const note = req.body?.note || '';
  const result = quotaService.recordQueries(count, note);
  res.json(result);
});

/**
 * POST /api/terapeak/quota/set-used
 * Manually set the used count (e.g. sync with actual eBay usage).
 * Body: { used: number }
 */
router.post('/quota/set-used', requireAdmin, express.json(), (req, res) => {
  const used = parseInt(req.body?.used);
  if (isNaN(used) || used < 0) return res.status(400).json({ error: 'used must be a non-negative number' });
  res.json(quotaService.setUsed(used));
});

/**
 * POST /api/terapeak/quota/reset
 * Reset today's query counter to 0.
 */
router.post('/quota/reset', requireAdmin, (_req, res) => {
  res.json(quotaService.resetToday());
});

/**
 * POST /api/terapeak/quota/set-limit
 * Change the daily limit (default 250).
 * Body: { limit: number }
 */
router.post('/quota/set-limit', requireAdmin, express.json(), (req, res) => {
  const limit = parseInt(req.body?.limit);
  if (isNaN(limit) || limit < 1) return res.status(400).json({ error: 'limit must be a positive number' });
  res.json(quotaService.setLimit(limit));
});

/**
 * POST /api/terapeak/purge-stale-csvs
 * Delete CSV files from TERAPEAK_DATA_DIR where every comp is older than 180 days.
 * Body (optional): { maxDays: number }
 */
router.post('/purge-stale-csvs', requireAdmin, express.json(), (req, res) => {
  const maxDays = parseInt(req.body?.maxDays) || 180;
  const dataDir = process.env.TERAPEAK_DATA_DIR || 'data/terapeak';
  const result = terapeakService.purgeStaleCSVs(dataDir, maxDays);
  res.json({ status: 'ok', ...result });
});

module.exports = router;
