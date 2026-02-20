// src/routes/terapeakRoute.js — Terapeak CSV import API
// CommonJS

const express = require('express');
const multer = require('multer');
const router = express.Router();

const terapeakService = require('../services/terapeakService');

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
router.post('/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No CSV file uploaded' });
    }
    const searchTerm = req.body?.searchTerm;
    if (!searchTerm) {
      return res.status(400).json({ error: 'searchTerm is required — the keyword you searched in Terapeak' });
    }

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
      }
    });
  } catch (err) {
    console.error('[terapeak] Import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/terapeak/import-text
 * Import CSV as pasted text (no file upload needed).
 * Body (JSON):
 *   - csvText: the raw CSV string
 *   - searchTerm: the keyword used in Terapeak
 */
router.post('/import-text', express.json(), (req, res) => {
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

    const result = terapeakService.importComps(searchTerm, comps);
    res.json({ status: 'ok', import: result, parse: { totalRows, validComps: comps.length, skipped } });
  } catch (err) {
    console.error('[terapeak] Import-text error:', err.message);
    res.status(500).json({ error: err.message });
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
  const data = terapeakService.lookupComps(q);
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
router.delete('/datasets/:key', (req, res) => {
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
router.delete('/datasets', (_req, res) => {
  terapeakService.clearAll();
  res.json({ status: 'ok', message: 'All Terapeak data cleared' });
});

module.exports = router;
