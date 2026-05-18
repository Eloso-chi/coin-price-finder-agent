'use strict';

const express = require('express');
const multer = require('multer');
const { mapExcelToBackup } = require('../utils/excelMapper');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (name.endsWith('.xlsx')) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx files are accepted'), false);
    }
  },
});

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Attach a .xlsx file as field "file".' });
  }

  // Magic-byte check: .xlsx must be ZIP format (PK 0x50 0x4B)
  const buf = req.file.buffer;
  const isPK = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  if (!isPK) {
    return res.status(400).json({ error: 'File does not appear to be a valid .xlsx file.' });
  }

  try {
    const result = await mapExcelToBackup(req.file.buffer);

    // Missing sheet error
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({
      payload: result.payload,
      summary: result.summary,
    });
  } catch (err) {
    // Log full error server-side; return generic message to client
    console.error('[/api/import/excel] Parse error:', err.message || err);
    return res.status(400).json({ error: 'Invalid or corrupted Excel file. Please check the file and try again.' });
  }
});

// Multer error handler
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum 10 MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err.message && err.message.includes('Only .xlsx')) {
    return res.status(400).json({ error: err.message });
  }
  return res.status(500).json({ error: 'Internal error processing upload' });
});

module.exports = router;
