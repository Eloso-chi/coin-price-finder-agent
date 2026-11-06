// src/routes/barPriceRoute.js — POST /api/bar-price
// Searches eBay for gold/silver bar sold comps (no PCGS needed)
// CommonJS

const express = require('express');
const router = express.Router();

const ebayService = require('../services/ebayService');
const { computeValuation } = require('../services/valuationService');
const { getMetalsSpotPrice } = require('../services/metalsSpotPrice');
const { zodiacForYear, perthLunarSeries } = require('../data/constants');
const { BAR_SERIES } = require('../data/barSeries');
const { redactCompsForPublic } = require('../utils/redactForPublic');
const { normalizeBarSize, parseBarSize, resolveBarSegment, describeBarSegment } = require('../utils/barIdentity');

const BAR_METALS = ['gold', 'silver', 'platinum', 'palladium'];

// ── GET /api/bar-options — return available brands + series for dropdowns ──
router.get('/options', (_req, res) => {
  const options = Object.entries(BAR_SERIES).map(([brand, entries]) => ({
    brand,
    series: entries.map(e => ({
      name: e.series,
      aliases: e.aliases,
    })),
  }));
  res.json({ brands: options });
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const { series, year, condition, askingPrice, options } = body;
    if (!body.metal || !body.size) {
      return res.status(400).json({ error: 'metal and size fields are required' });
    }
    if (typeof body.metal !== 'string' || !BAR_METALS.includes(body.metal.trim().toLowerCase())) {
      return res.status(400).json({ error: `metal must be one of: ${BAR_METALS.join(', ')}` });
    }
    // An unrecognized size is rejected, never defaulted to 1 oz.
    const parsedSize = parseBarSize(body.size);
    if (!parsedSize) {
      return res.status(400).json({ error: 'size not recognized; use grams, oz (e.g. 1/10 oz) or kilo' });
    }
    const metal = body.metal.trim().toLowerCase();
    const size = body.size;
    const brand = (typeof body.brand === 'string' && body.brand.trim()) ? body.brand.trim() : null;

    const opts = {
      timeWindowDays: options?.timeWindowDays || 120,
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

    // One bar segment (generic / brand / series), shared with the general path
    // Lunar bars match by animal and year, not by catalog series.
    const segment = resolveBarSegment({ brand, series, isLunar });
    const detectedSeries = segment.barSeries
      ? { series: segment.barSeries, re: segment.barSeriesRe, keywords: segment.barSeriesKeywords }
      : null;

    // ── Build eBay search keywords ──
    // Normalize size for eBay: ".5 gram" -> "0.5 gram", add alternates
    const sizeForSearch = normalizeBarSize(size);
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
    const barWeightOzt = parsedSize.weightOzt;

    // ── Expected fields for bar match scoring ──
    const resolvedSeriesName = isLunar ? 'Lunar' : (detectedSeries ? detectedSeries.series : null);
    const expected = {
      type: 'bar',
      brand: brand,
      barBrand: segment.barBrand,
      barSegment: segment,
      barSize: normalizeBarSize(size),
      metal: metal,
      weight: barWeightOzt,
      condition: condition || null,
      barYear: year || null,
      zodiacAnimal: zodiacAnimal,
      isLunar: isLunar,
      perthSeriesNum: perthSeriesNum,
      barSeries: segment.barSeries,
      barSeriesRe: segment.barSeriesRe,
      year: null,
      mint: null,
      series: null,
      grade: null,
      designation: null
    };

    // ── Fetch spot price for bullion valuation ──
    const METAL_SYM = { gold: 'XAU', silver: 'XAG', platinum: 'XPT', palladium: 'XPD' };
    const sym = METAL_SYM[metal.toLowerCase()];
    let spotPrice = null;
    if (sym) {
      try {
        const spot = await getMetalsSpotPrice(sym, 'USD');
        spotPrice = spot.price;
      } catch (_) { /* non-fatal -- valuation falls back to raw comps */ }
    }
    // Enables the melt floor and ceiling comp filters, as on the general path.
    if (spotPrice) expected.meltPerOz = spotPrice;

    // ── Fetch eBay comps ──
    const ebay = await ebayService.fetchSoldComps(keywords, opts, expected);

    // ── Compute valuation (no PCGS data, mark as bar) ──
    const pcgsStub = { verified: false, _isBar: true };
    const { valuation, decisions } = computeValuation(pcgsStub, ebay, askingPrice || null, null, {
      isBullion: true,
      metal,
      barSegment: segment,
      barSeries: segment.barSeries,
      spotPrice: spotPrice ? spotPrice * barWeightOzt : null,
      // #232 -- gate Greysheet/CPG dollar amounts to admins.
      audience: req.isAdmin ? 'admin' : 'public',
    });

    const pureOzt = barWeightOzt;

    return res.json(redactCompsForPublic({
      query: { metal, size, brand: brand || null, condition: condition || null, askingPrice: askingPrice || null, options: opts },
      bar: {
        metal,
        size,
        brand: brand || 'Generic',
        segment: describeBarSegment(segment),
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
    }, req.isAdmin === true));
  } catch (err) {
    console.error('[/api/bar-price] Unhandled error:', err.message);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

module.exports = router;
