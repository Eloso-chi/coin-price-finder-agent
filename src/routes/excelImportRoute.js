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

router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Attach a .xlsx file as field "file".' });
  }

  try {
    const result = mapExcelToBackup(req.file.buffer);

    // Missing sheet error
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    return res.json({
      payload: result.payload,
      summary: result.summary,
    });
  } catch (err) {
    // Multer or XLSX parse error
    return res.status(400).json({ error: 'Failed to parse Excel file: ' + (err.message || 'unknown error') });
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
