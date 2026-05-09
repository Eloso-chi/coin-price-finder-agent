// src/routes/barPriceRoute.js — POST /api/bar-price
// Searches eBay for gold/silver bar sold comps (no PCGS needed)
// CommonJS

const express = require('express');
const router = express.Router();

const ebayService = require('../services/ebayService');
const { computeValuation } = require('../services/valuationService');
const { zodiacForYear, perthLunarSeries } = require('../data/constants');
const { detectBarSeries } = require('../data/barSeries');

// ── Size normalization helpers ──────────────────────────────
/**
 * Normalize a user-supplied size string for eBay search and matching.
 * ".5 gram" → "0.5 gram", "  1  OZ " → "1 oz"
 */
function normalizeSize(raw) {
  if (!raw) return raw;
  let s = raw.trim().toLowerCase();
  // ".5" → "0.5"
  s = s.replace(/^\.(\d)/, '0.$1');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ');
  return s;
}

/**
 * Parse a size string into troy oz for weight-mismatch filtering.
 * Supports grams, oz, and kilo.
 */
function parseBarWeight(size) {
  if (!size) return null;
  const s = size.trim().toLowerCase();
  // Grams: "0.5 gram", "1 gram", "100 gram", etc.
  const gMatch = s.match(/^(\d+(?:\.\d+)?)\s*(?:gram|g)\b/);
  if (gMatch) return parseFloat(gMatch[1]) / 31.1035;
  // ".5 gram" variant
  const gMatch2 = s.match(/^\.(\d+)\s*(?:gram|g)\b/);
  if (gMatch2) return parseFloat('0.' + gMatch2[1]) / 31.1035;
  // Oz: "1 oz", "10 oz"
  const ozMatch = s.match(/^(\d+(?:\.\d+)?)\s*oz/);
  if (ozMatch) return parseFloat(ozMatch[1]);
  // Kilo
  if (/kilo/i.test(s)) return 32.1507;
  return null;
}
router.post('/', async (req, res) => {
  try {
    const { metal, size, brand, series, year, condition, askingPrice, options } = req.body || {};
    if (!metal || !size) {
      return res.status(400).json({ error: 'metal and size fields are required' });
    }

    const opts = {
      timeWindowDays: options?.timeWindowDays || 90,
      requirePCGSOnly: false,
      exactGradeOnly: false,
      usMinComps: options?.usMinComps || 8,
      maxPages: options?.maxPages || 3
    };

    // ── Lunar series detection ──
    const isLunar = series === 'lunar';
    const isPerth = /perth/i.test(brand || '');
    const zodiacAnimal = isLunar ? zodiacForYear(year) : null;

    // Perth Mint Lunar series number from year
    const { num: perthSeriesNum } = (isLunar && isPerth) ? perthLunarSeries(year) : { num: null };

    // ── Bar series detection (Geiger Edelmetalle, PAMP Fortuna, etc.) ──
    const detectedSeries = (!isLunar && series) ? detectBarSeries(brand, series) : null;

    // ── Build eBay search keywords ──
    // Normalize size for eBay: ".5 gram" -> "0.5 gram", add alternates
    const sizeForSearch = normalizeSize(size);
    const parts = [];
    if (year) parts.push(String(year));
    if (brand) parts.push(brand);
    // Add series-specific keywords (e.g. "edelmetalle", "fortuna")
    if (detectedSeries) parts.push(detectedSeries.keywords);
    parts.push(sizeForSearch);
    parts.push(metal);
    parts.push('bar');
    // Lunar: add series label + animal name
    if (isLunar) {
      if (perthSeriesNum) parts.push('Lunar Series ' + perthSeriesNum);
      else parts.push('Lunar');
      if (zodiacAnimal) parts.push(zodiacAnimal);
    }
    if (condition === 'sealed') parts.push('sealed OR assay');
    const keywords = parts.join(' ');

    // ── Parse weight in troy oz from size string for weight-mismatch filtering ──
    const barWeightOzt = parseBarWeight(size);

    // ── Expected fields for bar match scoring ──
    const resolvedSeriesName = isLunar ? 'Lunar' : (detectedSeries ? detectedSeries.series : null);
    const expected = {
      type: 'bar',
      brand: brand || null,
      barSize: normalizeSize(size),
      metal: metal,
      weight: barWeightOzt,
      condition: condition || null,
      barYear: year || null,
      zodiacAnimal: zodiacAnimal,
      isLunar: isLunar,
      perthSeriesNum: perthSeriesNum,
      barSeries: resolvedSeriesName,
      barSeriesRe: detectedSeries ? detectedSeries.re : null,
      year: null,
      mint: null,
      series: null,
      grade: null,
      designation: null
    };

    // ── Fetch eBay comps ──
    const ebay = await ebayService.fetchSoldComps(keywords, opts, expected);

    // ── Compute valuation (no PCGS data, mark as bar) ──
    const pcgsStub = { verified: false, _isBar: true };
    const { valuation, decisions } = computeValuation(pcgsStub, ebay, askingPrice || null, null);

    // ── Melt value calculation ──
    const sizeMap = {
      '0.5 gram': 0.5 / 31.1035,
      '.5 gram':  0.5 / 31.1035,
      '1 gram':   1 / 31.1035,
      '2 gram':   2 / 31.1035,
      '2.5 gram': 2.5 / 31.1035,
      '5 gram':   5 / 31.1035,
      '10 gram':  10 / 31.1035,
      '20 gram':  20 / 31.1035,
      '50 gram':  50 / 31.1035,
      '100 gram': 100 / 31.1035,
      '1 oz':     1,
      '2 oz':     2,
      '5 oz':     5,
      '10 oz':    10,
      '1 kilo':   32.1507,
    };
    const pureOzt = sizeMap[size] || sizeMap[normalizeSize(size)] || 1;

    return res.json({
      query: { metal, size, brand: brand || null, condition: condition || null, askingPrice: askingPrice || null, options: opts },
      bar: {
        metal,
        size,
        brand: brand || 'Generic',
        series: resolvedSeriesName,
        perthSeriesNum,
        year: year || null,
        zodiacAnimal: zodiacAnimal,
        condition: condition || 'any',
        pureOzt: +pureOzt.toFixed(6),
      },
      ebay: {
        keywords,
        us: ebay.us,
        global: ebay.global,
        usedFallback: ebay.usedFallback
      },
      valuation,
      decisions,
    });
  } catch (err) {
    console.error('[/api/bar-price] Unhandled error:', err.message);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

module.exports = router;
