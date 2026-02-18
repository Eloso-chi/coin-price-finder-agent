// src/routes/coinVariantRoute.js — GET /api/coin-variant
// Returns design-series metadata for a denomination + year.
// CommonJS

const express = require('express');
const router = express.Router();
const { resolveCoinVariant } = require('../data/halfDollarSeries');

/**
 * GET /api/coin-variant?denomination=Half+Dollar&year=2026
 *
 * Response: {
 *   denomination, year, designName, variantSuffix,
 *   composition, notes, label
 * }
 */
router.get('/', (req, res) => {
  const { denomination, year } = req.query;
  const result = resolveCoinVariant(denomination, year);
  return res.json(result);
});

module.exports = router;
