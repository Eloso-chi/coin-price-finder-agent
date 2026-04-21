// src/routes/bulkEvaluateRoute.js -- POST /api/bulk-evaluate + GET /api/bulk-evaluate/:jobId/stream
// Bulk Collection Evaluator with SSE progress streaming.
// CommonJS
'use strict';

const express = require('express');
const crypto  = require('crypto');
const multer  = require('multer');
const router  = express.Router();

const { runBulkEvaluation, MAX_COINS } = require('../services/bulkEvaluateService');
const { mapExcelToBackup, parseCoinString } = require('../utils/excelMapper');

// ── Multer for Excel upload ──────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    cb(null, name.endsWith('.xlsx'));
  },
});

// ── In-memory job store ──────────────────────────────────────
const _jobs = new Map();
const JOB_TTL = 60 * 60 * 1000; // 1 hr

function _pruneJobs() {
  const now = Date.now();
  for (const [id, job] of _jobs) {
    if (now - job.created > JOB_TTL) _jobs.delete(id);
  }
}

// ── Input parsers ────────────────────────────────────────────

/** Parse one-coin-per-line text format.
 *  Each line: "query text" or "query | qty=N | grade=X"
 */
function parseTextInput(text) {
  if (!text || typeof text !== 'string') return [];
  return text.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(line => {
      // Support pipe-delimited fields: "1921 Morgan Dollar | qty=5 | grade=MS-63"
      const parts = line.split('|').map(p => p.trim());
      const coin = { query: parts[0] };
      for (let i = 1; i < parts.length; i++) {
        const m = parts[i].match(/^(\w+)\s*=\s*(.+)$/);
        if (m) {
          const key = m[1].toLowerCase();
          const val = m[2].trim();
          if (key === 'qty' || key === 'quantity') coin.qty = parseInt(val) || 1;
          else if (key === 'grade') coin.grade = val;
          else if (key === 'year')  coin.year = val;
          else if (key === 'mint')  coin.mintMark = val;
          else if (key === 'weight') coin.weight = parseFloat(val) || null;
        }
      }
      return coin;
    })
    .slice(0, MAX_COINS);
}

/** Parse JSON array input. Accepts [{query, qty, grade, year, ...}] */
function parseJsonInput(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_COINS).map(item => {
    if (typeof item === 'string') return { query: item };
    return {
      query:    String(item.query || item.name || item.coin || '').slice(0, 300),
      qty:      parseInt(item.qty || item.quantity) || 1,
      grade:    item.grade || null,
      year:     item.year ? String(item.year) : null,
      mintMark: item.mintMark || item.mint || null,
      weight:   item.weight ? parseFloat(item.weight) : null,
      series:   item.series || null,
    };
  });
}

/** Parse Excel buffer into coin array using excelMapper. */
function parseExcelInput(buffer) {
  // Magic-byte check: .xlsx = ZIP (PK 0x50 0x4B), .xls/encrypted = OLE/CFB (0xD0 0xCF 0x11 0xE0)
  const isPK  = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
  const isCFB = buffer.length >= 4 && buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0;
  if (!isPK && !isCFB) {
    throw new Error('File does not appear to be a valid .xlsx file.');
  }
  const { payload } = mapExcelToBackup(buffer);
  if (!payload?.coins?.length) {
    throw new Error('No coins found in Excel file. Ensure a "Collectors" sheet exists.');
  }
  return payload.coins.slice(0, MAX_COINS).map(c => ({
    query:  c.name || '',
    qty:    c.count || 1,
    grade:  c.grade || null,
    year:   c.year || null,
    mintMark: c.mintMark || null,
    weight: c.weight || null,
  }));
}

// ── POST /api/bulk-evaluate ──────────────────────────────────
// Accepts: JSON body { items: [...] } or { text: "..." } or multipart Excel upload
// Returns: { jobId } immediately. Client connects to SSE stream for results.

router.post('/', upload.single('file'), async (req, res) => {
  try {
    let coins;

    // 1. Excel upload
    if (req.file) {
      coins = parseExcelInput(req.file.buffer);
    }
    // 2. JSON array
    else if (req.body?.items) {
      coins = parseJsonInput(req.body.items);
    }
    // 3. Text paste
    else if (req.body?.text) {
      coins = parseTextInput(req.body.text);
    }
    else {
      return res.status(400).json({ error: 'Provide items (JSON array), text (one coin per line), or upload an Excel file.' });
    }

    if (!coins.length) {
      return res.status(400).json({ error: 'No valid coins found in input.' });
    }
    if (coins.length > MAX_COINS) {
      return res.status(400).json({ error: `Maximum ${MAX_COINS} coins per evaluation.` });
    }

    // Create job
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      created: Date.now(),
      coins,
      status: 'pending',     // pending → running → complete | error
      results: [],
      lotSummary: null,
      error: null,
      listeners: new Set(),   // SSE response objects
    };
    _pruneJobs();
    _jobs.set(jobId, job);

    // Start evaluation in background (non-blocking)
    _runJob(job);

    return res.status(202).json({ jobId, coinCount: coins.length });
  } catch (err) {
    const status = err.status || 400;
    const msg = status < 500 ? err.message : 'Internal server error';
    if (status >= 500) console.error('[bulk-evaluate] POST error:', err);
    return res.status(status).json({ error: msg });
  }
});

// ── GET /api/bulk-evaluate/:jobId/stream ─────────────────────
// SSE endpoint. Sends events: coin (per result), summary (lot summary), done, error.

router.get('/:jobId/stream', (req, res) => {
  const job = _jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired.' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection:      'keep-alive',
    'X-Accel-Buffering': 'no',   // disable nginx buffering
  });
  res.flushHeaders();

  // Replay already-completed results
  for (let i = 0; i < job.results.length; i++) {
    _sseWrite(res, 'coin', { index: i, total: job.coins.length, ...job.results[i] });
  }
  if (job.status === 'complete') {
    _sseWrite(res, 'summary', job.lotSummary);
    _sseWrite(res, 'done', { status: 'complete' });
    res.end();
    return;
  }
  if (job.status === 'error') {
    _sseWrite(res, 'error', { message: job.error });
    res.end();
    return;
  }

  // Register for live updates
  job.listeners.add(res);
  req.on('close', () => job.listeners.delete(res));
});

// ── GET /api/bulk-evaluate/:jobId ────────────────────────────
// Poll endpoint (non-SSE). Returns current state of the job.

router.get('/:jobId', (req, res) => {
  const job = _jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired.' });
  }
  return res.json({
    jobId:      job.id,
    status:     job.status,
    coinCount:  job.coins.length,
    completed:  job.results.length,
    results:    job.results,
    lotSummary: job.lotSummary,
    error:      job.error,
  });
});

// ── Internal helpers ─────────────────────────────────────────

function _sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* client disconnected */ }
}

async function _runJob(job) {
  job.status = 'running';
  try {
    const { results, lotSummary } = await runBulkEvaluation(job.coins, (result, index, total) => {
      job.results[index] = result;
      // Broadcast to all SSE listeners
      for (const res of job.listeners) {
        _sseWrite(res, 'coin', { index, total, ...result });
      }
    });

    job.results = results;
    job.lotSummary = lotSummary;
    job.status = 'complete';

    // Broadcast summary + done
    for (const res of job.listeners) {
      _sseWrite(res, 'summary', lotSummary);
      _sseWrite(res, 'done', { status: 'complete' });
      res.end();
    }
    job.listeners.clear();
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    for (const res of job.listeners) {
      _sseWrite(res, 'error', { message: err.message });
      res.end();
    }
    job.listeners.clear();
    if (err.status !== 429) console.error('[bulk-evaluate] job error:', err);
  }
}

module.exports = router;

// Exposed for testing
module.exports._parseTextInput  = parseTextInput;
module.exports._parseJsonInput  = parseJsonInput;
module.exports._parseExcelInput = parseExcelInput;
module.exports._jobs = _jobs;
