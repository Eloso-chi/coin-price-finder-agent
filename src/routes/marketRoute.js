// src/routes/marketRoute.js — GET /api/market/ebay
// Returns aggregated eBay market matrix for a coin series.
// CommonJS

'use strict';

const express = require('express');
const router = express.Router();

const { fetchMarketMatrix } = require('../services/marketAggregator');
const ebayService = require('../services/ebayService');
const { lookupKeyDate } = require('../data/keyDates');

/**
 * GET /api/market/ebay?series=Franklin+Half+Dollar&grade=MS65&days=90
 *
 * Query params:
 *   series  (required) — coin series / denomination, e.g. "Franklin Half Dollar"
 *   grade   (optional) — grade filter, e.g. "MS65", "PR69". Default "All"
 *   days    (optional) — lookback window for completed sales. Default 90
 *
 * Response: {
 *   series, grade, keywords, years, mintMarks,
 *   summary: { totalCells, cellsWithPriceData, yearMin, yearMax, mintCount },
 *   cells: [{ year, mint, keyDate, keyDateTier, medianCompleted, cheapestBin }, ...]
 * }
 */
router.get('/', async (req, res) => {
  try {
    const { series, grade, days } = req.query;

    if (!series) {
      return res.status(400).json({ error: 'Missing required parameter: series' });
    }

    const timeWindowDays = parseInt(days) || 90;
    const gradeFilter = grade || 'All';

    const matrix = await fetchMarketMatrix({
      series: series.trim(),
      grade: gradeFilter,
      timeWindowDays,
      lookupKeyDate,
      ebayService,
    });

    return res.json(matrix);
  } catch (err) {
    console.error('[/api/market/ebay] Error:', err.message);
    return res.status(500).json({
      error: err.message || 'Internal server error',
      series: req.query.series || null,
    });
  }
});

module.exports = router;
