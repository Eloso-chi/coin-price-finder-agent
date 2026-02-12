// src/routes/metalsRoute.js — GET /api/metals  &  GET /api/metals/:metal
// CommonJS

const express = require('express');
const router  = express.Router();

const { getMetalsSpotPrice, getMetalsSpotPrices } = require('../services/metalsSpotPrice');
const { MetalsSpotPriceError } = require('../services/MetalsSpotPriceError');

const VALID_METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

// GET /api/metals?currency=USD  → returns XAU + XAG (or custom list)
router.get('/', async (req, res) => {
  try {
    const currency = (req.query.currency || 'USD').toUpperCase();
    const metals   = req.query.metals
      ? String(req.query.metals).split(',').map(m => m.trim().toUpperCase())
      : ['XAU', 'XAG'];

    const invalid = metals.filter(m => !VALID_METALS.has(m));
    if (invalid.length) {
      return res.status(400).json({ error: `Invalid metal(s): ${invalid.join(', ')}. Valid: ${[...VALID_METALS].join(', ')}` });
    }

    const prices = await getMetalsSpotPrices(metals, currency);
    return res.json({ ok: true, prices });
  } catch (err) {
    return handleError(err, res);
  }
});

// GET /api/metals/:metal?currency=USD  → single metal
// Express 5 uses path-to-regexp v8 syntax: {param} instead of :param
router.get('/{:metal}', async (req, res) => {
  try {
    const metal    = req.params.metal.toUpperCase();
    const currency = (req.query.currency || 'USD').toUpperCase();

    if (!VALID_METALS.has(metal)) {
      return res.status(400).json({ error: `Invalid metal: ${metal}. Valid: ${[...VALID_METALS].join(', ')}` });
    }

    const price = await getMetalsSpotPrice(metal, currency);
    return res.json({ ok: true, ...price });
  } catch (err) {
    return handleError(err, res);
  }
});

function handleError(err, res) {
  if (err instanceof MetalsSpotPriceError) {
    return res.status(502).json({
      error: err.message,
      providersTried: err.providersTried,
      metal: err.metal,
      currency: err.currency,
    });
  }
  console.error('[/api/metals] Unhandled error:', err.message);
  return res.status(500).json({ error: 'Internal server error', message: err.message });
}

module.exports = router;
