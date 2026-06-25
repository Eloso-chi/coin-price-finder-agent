// src/routes/terapeakRoute.js — Terapeak CSV import API
// CommonJS

const express = require('express');
const multer = require('multer');
const router = express.Router();

const terapeakService = require('../services/terapeakService');
const quotaService = require('../services/terapeakQuotaService');
const requireAdmin = require('../middleware/requireAdminOrKey');

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
    if (typeof searchTerm !== 'string' || searchTerm.length > 500) {
      return res.status(400).json({ error: 'searchTerm must be a string of 500 characters or fewer' });
    }

    // ── Quota: log the import for tracking, but don't enforce the limit ──
    // Imports are uploads of already-aggregated data — the actual Terapeak
    // search already happened.  Blocking imports doesn't reduce eBay load.
    const queryCount = Math.max(1, parseInt(req.body?.queryCount) || 1);
    const quota = quotaService.getStatus();
    // Still log it for visibility, but never block
    quotaService.recordQueries(queryCount, `import: ${searchTerm}`);

    // Parse CSV
    const { comps, skipped, columns, unmappedColumns, totalRows } = terapeakService.parseCSV(req.file.buffer, searchTerm);

    if (comps.length === 0) {
      // Invalid/empty uploads should not mutate refresh/no-data metadata.
      // True no-results should be reported via /report-no-data.
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
    // Build aggregationMeta from request body fields (sent by sales-aggregator.py / terapeak-export.py)
    const aggregationMeta = {};
    if (req.body?.page1At) aggregationMeta.page1At = req.body.page1At;
    if (req.body?.deepAt) aggregationMeta.deepAt = req.body.deepAt;
    if (req.body?.maxPageReached) aggregationMeta.maxPageReached = parseInt(req.body.maxPageReached) || null;
    if (req.body?.lastRefreshAt) aggregationMeta.lastRefreshAt = req.body.lastRefreshAt;

    const result = terapeakService.importComps(searchTerm, comps, {
      fileName: req.file.originalname,
      fileSize: req.file.size,
      ...(Object.keys(aggregationMeta).length > 0 ? { aggregationMeta } : {})
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
    if (typeof searchTerm !== 'string' || searchTerm.length > 500) {
      return res.status(400).json({ error: 'searchTerm must be a string of 500 characters or fewer' });
    }

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
 * Admin-only: dataset list reveals operator research backlog and import cadence.
 */
router.get('/datasets', requireAdmin, (_req, res) => {
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
 * Admin-only: exposes internal operational state (today's usage, daily limit,
 * previous-day stats). Not useful to end users.
 */
router.get('/quota', requireAdmin, (_req, res) => {
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

/**
 * POST /api/terapeak/reimport
 * Re-import Terapeak CSVs from Azure Blob + local folder.
 * Bypasses freshness skip when force=true in body.
 * Admin-only.
 */
router.post('/reimport', requireAdmin, express.json(), async (req, res) => {
  const force = req.body?.force === true;
  const dataDir = process.env.TERAPEAK_DATA_DIR || 'data/terapeak';
  const results = { blob: null, local: null };

  try {
    // Blob import
    const blobClient = require('../utils/blobClient');
    if (blobClient.isEnabled()) {
      results.blob = await terapeakService.autoImportFromBlob({ force });
    } else {
      results.blob = { skipped: true, reason: 'Blob storage not configured' };
    }

    // Local folder import
    results.local = terapeakService.autoImportFolder(dataDir, { force });

    // Clear eBay cache if new data was imported
    const totalImported = (results.blob?.imported || 0) + (results.local?.imported || 0);
    if (totalImported > 0) {
      const ebayService = require('../services/ebayService');
      ebayService.clearCache();
    }

    res.json({ status: 'ok', force, ...results, totalImported });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/terapeak/aggregation-status
 * Returns aggregation depth status for all datasets.
 * Query params:
 *   - needs=deep  -- only datasets that haven't been deep-aggregated
 *   - needs=page1 -- only datasets missing page1At
 *   - needs=refresh&maxAge=14 -- datasets not refreshed in N days
 *   - minComps=50 -- only datasets with at least N comps (candidates for deep)
 *   - excludeLowVolume=1 -- drop datasets flagged is_low_volume_candidate (S7)
 *   - excludeBarberNonHalf=1 -- drop Barber quarter/dime/dollar datasets (S8)
 *   - excludeNoData=1 -- drop datasets with noDataAt stamped (Terapeak empty)
 */
router.get('/aggregation-status', requireAdmin, (req, res) => {
  const datasets = terapeakService.listDatasets();
  const {
    needs,
    maxAge,
    minComps,
    excludeLowVolume,
    excludeBarberNonHalf,
    excludeNoData,
  } = req.query;
  const maxAgeDays = parseInt(maxAge) || 14;
  const minCompCount = parseInt(minComps) || 0;
  const truthy = (v) => v === '1' || v === 'true' || v === 'yes';
  const BARBER_NONHALF_RE = /\bbarber\b(?!.*\bhalf\b)/i;

  let filtered = datasets;

  if (minComps) {
    filtered = filtered.filter(d => d.compCount >= minCompCount);
  }

  if (needs === 'deep') {
    filtered = filtered.filter(d => !d.aggregationMeta?.deepAt);
  } else if (needs === 'page1') {
    filtered = filtered.filter(d => !d.aggregationMeta?.page1At);
  } else if (needs === 'refresh') {
    const cutoffDate = new Date(Date.now() - maxAgeDays * 86400000).toISOString().split('T')[0]; // YYYY-MM-DD
    filtered = filtered.filter(d => {
      // Use newestSaleDate (ground truth from actual sold data) if available;
      // fall back to process timestamps for datasets not yet backfilled.
      const newestSale = d.aggregationMeta?.newestSaleDate;
      if (newestSale) return newestSale < cutoffDate;
      const lastRefresh = d.aggregationMeta?.lastRefreshAt || d.aggregationMeta?.page1At || d.lastImport;
      return !lastRefresh || lastRefresh < cutoffDate;
    });
  }

  // Low-signal exclusions (S2a) -- mirror the dashboard filters so the
  // deep-needed candidate list isn't inflated by datasets we already know
  // aren't worth deep-paginating.
  const excluded = { lowVolume: 0, barberNonHalf: 0, noData: 0 };
  if (truthy(excludeLowVolume)) {
    const before = filtered.length;
    filtered = filtered.filter(d => !(d.identifiers && d.identifiers.is_low_volume_candidate));
    excluded.lowVolume = before - filtered.length;
  }
  if (truthy(excludeBarberNonHalf)) {
    const before = filtered.length;
    filtered = filtered.filter(d => !BARBER_NONHALF_RE.test(d.searchTerm || ''));
    excluded.barberNonHalf = before - filtered.length;
  }
  if (truthy(excludeNoData)) {
    const before = filtered.length;
    filtered = filtered.filter(d => !d.aggregationMeta?.noDataAt);
    excluded.noData = before - filtered.length;
  }

  // Summary stats
  const total = datasets.length;
  const withPage1 = datasets.filter(d => d.aggregationMeta?.page1At).length;
  const withDeep = datasets.filter(d => d.aggregationMeta?.deepAt).length;

  res.json({
    summary: { total, withPage1, withDeep, needsDeep: total - withDeep, excluded },
    datasets: filtered.map(d => ({
      key: d.key,
      searchTerm: d.searchTerm,
      compCount: d.compCount,
      aggregationMeta: d.aggregationMeta,
      ...(d.identifiers ? { identifiers: d.identifiers } : {})
    }))
  });
});

// Backward-compat alias for /scrape-status
router.get('/scrape-status', requireAdmin, (req, res) => {
  res.redirect(307, `/api/terapeak/aggregation-status?${new URLSearchParams(req.query)}`);
});

/**
 * POST /api/terapeak/report-no-data
 * Called by the export script when Terapeak returns no results for a dataset.
 * Increments noDataCount and stamps noDataAt so the freshness triage can
 * mark the dataset as dormant after repeated empty attempts.
 * Body: { searchTerm: string }
 */
router.post('/report-no-data', requireAdmin, express.json(), (req, res) => {
  const searchTerm = req.body?.searchTerm;
  if (!searchTerm || typeof searchTerm !== 'string') {
    return res.status(400).json({ error: 'searchTerm is required' });
  }

  // Resolve the key + read the previous count up front so the catch path
  // below can return a numerically-sane payload even when the meta-write
  // fails. (See #271H Item 3 + python-scraper compatibility note below.)
  const normalizedKey = terapeakService.normalizeSearchKey(searchTerm);
  let prevCount = 0;
  try {
    const store = terapeakService.listDatasets();
    const existing = store.find(d => d.key === normalizedKey);
    prevCount = existing?.aggregationMeta?.noDataCount || 0;
  } catch (_) {
    // listDatasets failed (e.g. sidecar unreadable). prevCount stays 0;
    // the outer try/catch on updateDatasetMeta will surface the failure.
  }

  // #271H Item 3: wrap the meta-write in try/catch so a storage failure does
  // not leak as a 500 to the python scraper. The contract with the client is "we received
  // your no-data report"; failure to persist the bookkeeping should not
  // appear as an HTTP error.
  //
  // Failure-path response shape: noDataCount is set to the PREVIOUS count
  // (the increment did NOT take effect) rather than null. The python caller
  // at scripts/terapeak-export.py:_report_no_data does `int(count) >= 2`,
  // which would otherwise raise TypeError on null and surface as a generic
  // "request failed" exception, masking the structured `warning` marker.
  try {
    // #271H Item 1: cap at NO_DATA_CAP (5) -- same rationale as _stampNoDataMeta.
    const NO_DATA_CAP = 5;
    const result = terapeakService.updateDatasetMeta(searchTerm, {
      noDataAt: new Date().toISOString(),
      noDataCount: Math.min(NO_DATA_CAP, prevCount + 1),
    });

    res.json({
      status: 'ok',
      key: result.key,
      noDataCount: result.aggregationMeta.noDataCount,
      noDataAt: result.aggregationMeta.noDataAt,
    });
  } catch (err) {
    console.error('[terapeak] /report-no-data meta-write failed for', searchTerm, '--', err.message);
    res.json({
      status: 'ok',
      key: normalizedKey,
      noDataCount: prevCount,
      noDataAt: null,
      warning: 'meta-write-failed',
    });
  }
});

/**
 * POST /api/terapeak/backfill-aggregation-meta
 * One-time backfill: parses page2 log files + export progress to stamp
 * aggregationMeta on existing datasets that were aggregated before this feature.
 * Also stamps page1At from the main export progress.json completed list.
 */
router.post('/backfill-aggregation-meta', requireAdmin, express.json(), (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const cacheDir = path.join(__dirname, '../../cache');
  const progressFile = path.join(cacheDir, 'terapeak_export_progress.json');

  let stamped = 0;
  let deepStamped = 0;
  let page1Stamped = 0;

  // ── 1. Parse page2 logs to find deep-aggregated datasets ──
  const p2Logs = fs.readdirSync(cacheDir)
    .filter(f => f.match(/terapeak_(p2_|eagles_p2|lunar_half_oz_p2).*\.log$/))
    .map(f => path.join(cacheDir, f));

  // Pattern: "  [ 48%] SEARCH TERM... p2:50 p3:50 ... OK (...)"
  const logLineRe = /^\s+\[\s*\d+%\]\s+(.+?)\.\.\.\s+(p\d+:\d+.*?)\s*OK/;
  const pageRe = /p(\d+):\d+/g;

  const deepMap = new Map(); // term -> { maxPage, logDate }

  for (const logPath of p2Logs) {
    const logStat = fs.statSync(logPath);
    const logDate = logStat.mtime.toISOString();
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(logLineRe);
      if (!m) continue;
      const term = m[1].trim();
      const pageStr = m[2];
      let maxPage = 1;
      let pm;
      while ((pm = pageRe.exec(pageStr)) !== null) {
        maxPage = Math.max(maxPage, parseInt(pm[1]));
      }
      pageRe.lastIndex = 0;
      // Keep the highest maxPage seen across all logs
      const prev = deepMap.get(term);
      if (!prev || maxPage > prev.maxPage) {
        deepMap.set(term, { maxPage, logDate });
      }
    }
  }

  // ── 2. Parse export progress for page1 completions ──
  let page1Terms = new Set();
  if (fs.existsSync(progressFile)) {
    try {
      const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      page1Terms = new Set(progress.completed || []);
    } catch (_) { /* ignore parse errors */ }
  }

  // ── 3. Stamp datasets ──
  for (const [term, { maxPage, logDate }] of deepMap) {
    terapeakService.importComps(term, [], {
      aggregationMeta: { deepAt: logDate, maxPageReached: maxPage }
    });
    deepStamped++;
    stamped++;
  }

  for (const term of page1Terms) {
    // Only stamp page1At if not already set by deep-aggregation pass
    if (!deepMap.has(term)) {
      terapeakService.importComps(term, [], {
        aggregationMeta: { page1At: new Date().toISOString() }
      });
      page1Stamped++;
      stamped++;
    } else {
      // Deep-aggregated implies page1 was done too
      terapeakService.importComps(term, [], {
        aggregationMeta: { page1At: new Date().toISOString() }
      });
      page1Stamped++;
    }
  }

  res.json({
    status: 'ok',
    stamped,
    deepStamped,
    page1Stamped,
    logsProcessed: p2Logs.length,
    progressTerms: page1Terms.size
  });
});

module.exports = router;
