'use strict';

const express = require('express');
const { fetchMarketMatrix } = require('../services/marketAggregator');
const ebayService = require('../services/ebayService');
const { lookupKeyDate } = require('../data/keyDates');
const { summarizeMatrix, compareMatrices, buildYearSeries } = require('../services/marketAnalyticsService');

const router = express.Router();
const MAX_COMPARISON_SERIES = 3;

async function fetchOne(input) {
  return fetchMarketMatrix({
    series: String(input.series).trim(),
    grade: input.grade || 'All',
    timeWindowDays: Math.min(365, Math.max(1, parseInt(input.days, 10) || 90)),
    weight: input.weight == null ? null : parseFloat(input.weight),
    lookupKeyDate,
    ebayService,
  });
}

router.post('/market', async (req, res) => {
  const body = req.body || {};
  const intent = ['coverage', 'compare', 'year-series'].includes(body.intent) ? body.intent : 'coverage';

  try {
    if (intent === 'compare') {
      if (!Array.isArray(body.series) || body.series.length < 1 || body.series.length > MAX_COMPARISON_SERIES) {
        return res.status(400).json({ ok: false, error: 'series must contain 1 to 3 market series' });
      }
      const matrices = await Promise.all(body.series.map(series => fetchOne({
        series,
        grade: body.grade,
        days: body.days,
        weight: body.weight,
      })));
      return res.json({
        ok: true,
        mode: 'ai',
        intent,
        classifications: { source: 'observed-completed-sales', metrics: 'derived-from-matrix' },
        results: compareMatrices(matrices),
        missing: matrices.length ? [] : ['market matrices'],
      });
    }

    if (typeof body.series !== 'string' || !body.series.trim()) {
      return res.status(400).json({ ok: false, error: 'series is required' });
    }
    const matrix = await fetchOne(body);
    const result = intent === 'year-series' ? buildYearSeries(matrix) : summarizeMatrix(matrix);
    return res.json({
      ok: true,
      mode: 'ai',
      intent,
      classifications: { source: 'observed-completed-sales', metrics: 'derived-from-matrix' },
      result,
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message || 'market analytics unavailable' });
  }
});

module.exports = router;