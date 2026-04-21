// src/routes/pricingBatchRoute.js — POST /api/pricing-batch
// Lightweight batch pricing: accepts up to 25 coin queries,
// returns FMV + avg eBay for each (public data only, no user info).
// CommonJS

const express = require('express');
const router  = express.Router();

const pcgsService  = require('../services/pcgsService');
const ebayService  = require('../services/ebayService');
const greysheetService = require('../services/greysheetService');
const { computeValuation } = require('../services/valuationService');
const { getMetalsSpotPrice } = require('../services/metalsSpotPrice');
const { getCoinMetalProfile } = require('../utils/coinMetalProfile');
const { lookupKeyDate } = require('../data/keyDates');
const { zodiacForYear, perthLunarSeries } = require('../data/constants');
const { detectDenomination } = require('../utils/filters');

const MAX_ITEMS = 25;
const BULLION_1OZ_DEFAULT = [
  'libertad', 'silver eagle', 'gold eagle', 'maple leaf', 'britannia',
  'philharmonic', 'krugerrand', 'kangaroo', 'kookaburra', 'panda',
  'gold buffalo', 'platinum eagle', 'palladium eagle', 'lunar', 'polar bear'
];

router.post('/', async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }
    if (items.length > MAX_ITEMS) {
      return res.status(400).json({ error: `Maximum ${MAX_ITEMS} items per batch` });
    }

    const results = await Promise.all(items.map(item => _priceOne(item)));
    return res.json({ ok: true, results });
  } catch (err) {
    console.error('pricing-batch error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

async function _priceOne(item) {
  try {
    const query = item.query || '';
    const coinData = item.coinData || {};
    if (!query) return { error: 'missing query' };

    // Parse description
    const parsed = pcgsService.parseDescription(query);
    const series = coinData.name || parsed.series || '';
    const year   = coinData.year || parsed.year;
    const mint   = coinData.mintMark || parsed.mint || '';
    const grade  = coinData.grade || parsed.grade || '';
    const gradeNum = parsed.gradeNum || parseInt((grade.match(/\d+/) || [])[0]) || null;

    // Weight defaulting for bullion
    let weight = coinData.weight || parsed.weight || null;
    if (!weight && series) {
      const sl = series.toLowerCase();
      if (BULLION_1OZ_DEFAULT.some(b => sl.includes(b))) weight = 1;
    }

    // Detect proof / roll / set from parsed description
    const isRoll = !!(coinData.isRoll || parsed.isRoll);
    const isSet  = !!(parsed.setType);
    const isProof = !isSet && (
      parsed.finish === 'Proof' ||
      parsed.grade  === 'Proof' ||
      /^(PF|PR)[-\s]?\d/i.test(grade)
    );

    // Detect metal and bullion status early — needed for melt cross-check on eBay comps
    const isBullion = BULLION_1OZ_DEFAULT.some(b => (series || '').toLowerCase().includes(b));
    const { metal: detectedMetal } = getCoinMetalProfile(query);
    const METAL_SYM = { silver: 'XAG', gold: 'XAU', platinum: 'XPT', palladium: 'XPD' };
    const metalKey = detectedMetal || parsed.metal || null;

    // Spot price for bullion — fetch before eBay so meltPerOz is available for comp filtering
    let meltPerOz = null;
    if (isBullion && metalKey && weight) {
      const sym = METAL_SYM[metalKey];
      if (sym) {
        try {
          const spot = await getMetalsSpotPrice(sym, 'USD');
          meltPerOz = spot.price;
        } catch { /* non-fatal */ }
      }
    }

    // Lunar enrichment
    let expected = {
      year, mint, series, grade, weight,
      finish:  parsed.finish || null,
      isProof,
      isRoll,
      isSet,
      setType: parsed.setType || null,
      metal: metalKey,
      _rawQuery: String(query),
    };
    if (meltPerOz) expected.meltPerOz = meltPerOz;
    if (year && /lunar/i.test(series)) {
      expected.zodiacAnimal = zodiacForYear(Number(year));
      expected.isLunarCoin = true;
    }

    // Build eBay keywords
    const keywords = ebayService.buildKeywords
      ? ebayService.buildKeywords({ series }, query, weight)
      : query;

    // Fetch eBay comps (lightweight: 1 page only)
    const ebay = await ebayService.fetchSoldComps(keywords, {
      timeWindowDays: 90,
      maxPages: 1,
      usMinComps: 3,
    }, expected);

    // PCGS (cached lookup, no extra API calls if not cached)
    let pcgs = { verified: false };
    try {
      pcgs = await pcgsService.resolveFromDescription(query);
    } catch { /* non-critical */ }

    // Greysheet wholesale lookup (non-fatal)
    // When no PCGS number (generic / yearless coin), fall back to Type GSID lookup.
    const pcgsNo = pcgs?.pcgsCoinNumber || pcgs?.pcgsNo || null;
    let greysheet = pcgsNo ? await greysheetService.fetchPriceByPcgsNumber(pcgsNo, gradeNum) : null;
    if (!greysheet) {
      const parsedMetal = parsed?.metal || null;
      greysheet = await greysheetService.fetchTypePrice(query, gradeNum, {
        series,
        metal: parsedMetal,
        weight,
        finish: isProof ? 'Proof' : (parsed.finish || null),
      });
    }

    const result = computeValuation(pcgs, ebay, null, gradeNum, {
      isBullion,
      isSet,
      isRoll,
      greysheet,
      spotPrice: (isBullion && meltPerOz && weight)
        ? meltPerOz * weight
        : null,
    });
    const val = result.valuation || {};

    return {
      query,
      fmv: val.fmvCore || null,
      rangeLow: val.rangeLow || null,
      rangeHigh: val.rangeHigh || null,
      avgEbay: ebay?.us?.stats?.median || ebay?.us?.stats?.mean || null,
      confidence: val.confidence || null,
    };
  } catch (err) {
    return { query: item.query || '', error: err.message };
  }
}

module.exports = router;
