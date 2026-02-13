// src/routes/barPriceRoute.js — POST /api/bar-price
// Searches eBay for gold/silver bar sold comps (no PCGS needed)
// CommonJS

const express = require('express');
const router = express.Router();

const ebayService = require('../services/ebayService');
const { computeValuation } = require('../services/valuationService');

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
    const ZODIAC = ['Rat','Ox','Tiger','Rabbit','Dragon','Snake','Horse','Goat','Monkey','Rooster','Dog','Pig'];
    const isLunar = series === 'lunar';
    const isPerth = /perth/i.test(brand || '');
    const zodiacAnimal = (isLunar && year && year >= 1996)
      ? ZODIAC[((year - 2020) % 12 + 12) % 12]
      : null;

    // Perth Mint Lunar series number from year
    let perthSeriesNum = null;
    if (isLunar && isPerth && year) {
      if (year >= 1996 && year <= 2007) perthSeriesNum = 'I';
      else if (year >= 2008 && year <= 2019) perthSeriesNum = 'II';
      else if (year >= 2020 && year <= 2031) perthSeriesNum = 'III';
    }

    // ── Build eBay search keywords ──
    const parts = [];
    if (year) parts.push(String(year));
    if (brand) parts.push(brand);
    parts.push(size);
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

    // ── Expected fields for bar match scoring ──
    const expected = {
      type: 'bar',
      brand: brand || null,
      barSize: size,
      metal: metal,
      condition: condition || null,
      barYear: year || null,
      zodiacAnimal: zodiacAnimal,
      isLunar: isLunar,
      perthSeriesNum: perthSeriesNum,
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
      '1 gram':   1 / 31.1035,
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
    };
    const pureOzt = sizeMap[size] || 1;

    return res.json({
      query: { metal, size, brand: brand || null, condition: condition || null, askingPrice: askingPrice || null, options: opts },
      bar: {
        metal,
        size,
        brand: brand || 'Generic',
        series: isLunar ? 'Lunar' : null,
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
      error: 'Internal server error',
      message: err.message
    });
  }
});

module.exports = router;
