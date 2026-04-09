// src/routes/marketRoute.js — GET /api/market/ebay
// Returns aggregated eBay market matrix for a coin series.
// CommonJS

'use strict';

const express = require('express');
const router = express.Router();

const { fetchMarketMatrix } = require('../services/marketAggregator');
const ebayService = require('../services/ebayService');
const { lookupKeyDate } = require('../data/keyDates');
const { batchRarityForSeries } = require('../services/numistaService');

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
    const { series, grade, days, weight } = req.query;

    if (!series) {
      return res.status(400).json({ error: 'Missing required parameter: series' });
    }

    const timeWindowDays = parseInt(days) || 90;
    const gradeFilter = grade || 'All';
    const parsedWeight = weight ? parseFloat(weight) : null;

    const matrix = await fetchMarketMatrix({
      series: series.trim(),
      grade: gradeFilter,
      timeWindowDays,
      weight: parsedWeight,
      lookupKeyDate,
      ebayService,
    });

    // ── Enrich cells with Numista rarity data (single batch, 2-3 API calls) ──
    try {
      const cellsForRarity = (matrix.cells || []).map(c => ({
        year: c.year,
        mint: c.mint || c.grade || 'P',
      }));
      const rarityMap = await batchRarityForSeries(series.trim(), cellsForRarity);
      if (rarityMap.size > 0) {
        for (const cell of matrix.cells) {
          const key = `${cell.year}-${cell.mint || cell.grade || 'P'}`;
          const rarity = rarityMap.get(key);
          if (rarity) cell.rarity = rarity;
        }
      }
    } catch (numErr) {
      console.warn('[/api/market/ebay] Numista enrichment skipped:', numErr.message);
    }

    return res.json(matrix);
  } catch (err) {
    console.error('[/api/market/ebay] Error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      series: req.query.series || null,
    });
  }
});

module.exports = router;
