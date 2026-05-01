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
const { zodiacForYear, perthLunarSeries, getRollQuantity } = require('../data/constants');
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

    // Spot price for bullion -- fetch before eBay so meltPerOz is available for comp filtering
    let meltPerOz = null;
    let spotStale = false;
    let spotAsOf = null;
    if (isBullion && metalKey && weight) {
      const sym = METAL_SYM[metalKey];
      if (sym) {
        try {
          const spot = await getMetalsSpotPrice(sym, 'USD');
          meltPerOz = spot.price;
          if (spot.stale || /hardcoded|stale/i.test(spot.source || '')) {
            spotStale = true;
            spotAsOf = spot.timestamp || null;
          }
        } catch { /* non-fatal */ }
      }
    }

    // Lunar enrichment -- detect Lunar context from series, raw query, and zodiac patterns
    const rawQueryLower = String(query).toLowerCase();
    const hasLunarKeyword = /\blunar\b/i.test(series.toLowerCase()) || /\blunar\b/i.test(rawQueryLower);
    const hasZodiacPattern = /\byear\s+of\s+the\s+(rat|ox|tiger|rabbit|dragon|snake|horse|goat|monkey|rooster|dog|pig)\b/i.test(rawQueryLower);
    const isLunarCoin = hasLunarKeyword || hasZodiacPattern;
    const hasPerthContext = /\bperth\b/i.test(rawQueryLower);
    const hasAustralianContext = /\baustralian?\b/i.test(rawQueryLower);

    let zodiacAnimal = null;
    let perthSeriesLabel = null;

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
    if (isLunarCoin && year) {
      zodiacAnimal = zodiacForYear(Number(year));
      expected.zodiacAnimal = zodiacAnimal;
      expected.isLunarCoin = true;
      if (hasPerthContext || hasAustralianContext) {
        const lunarInfo = perthLunarSeries(Number(year));
        if (lunarInfo) perthSeriesLabel = lunarInfo.label || null;
        expected.perthSeriesLabel = perthSeriesLabel;
      }
    }

    // Auto-detect Brand for eBay aspect filtering (#155)
    if (hasPerthContext || hasAustralianContext)                   expected._brandFilter = 'Perth Mint';
    else if (/\broyal\s*mint\b/i.test(rawQueryLower))             expected._brandFilter = 'The Royal Mint';
    else if (/\broyal\s*canadian\b|\brcm\b/i.test(rawQueryLower)) expected._brandFilter = 'Royal Canadian Mint';

    // Build eBay keywords using PCGS-parsed series (not raw coinData.name) (#155)
    const pcgsParsedForKeywords = { series: parsed.series || series, year, mint };
    const parsedFinish = coinData.finish || parsed.finish || null;
    if (parsedFinish && !pcgsParsedForKeywords.finish) pcgsParsedForKeywords.finish = parsedFinish;
    let keywords = ebayService.buildKeywords
      ? ebayService.buildKeywords(pcgsParsedForKeywords, query, weight)
      : query;

    // Roll/tube keyword override -- match priceRoute parity
    if (isRoll) {
      const yr = year || '';
      const ser = parsed.series || series || '';
      keywords = `${yr}${mint ? '-' + mint : ''} ${ser} (roll,tube)`.trim();
    }

    // Semiquincentennial enrichment (#155)
    const SEMI250_DENOM_MAP = {
      'semiquincentennial half dollar': 'Kennedy Half Dollar',
      'semiquincentennial clad half':   'Kennedy Half Dollar',
      'semiquincentennial quarter':     'Washington Quarter',
      'semiquincentennial dime':        'Roosevelt Dime',
      'semiquincentennial nickel':      'Jefferson Nickel',
      'semiquincentennial cent':        'Lincoln Cent',
    };
    const semi250Canonical = SEMI250_DENOM_MAP[(parsed.series || '').toLowerCase().trim()] || null;
    const isSemi250 = !!(semi250Canonical || /semiquincentennial|250th\s*anniversary/i.test(String(query)));
    if (semi250Canonical) {
      const yr = year || 2026;
      keywords = `${yr}${mint ? '-' + mint : ''} ${semi250Canonical} Semiquincentennial`.trim();
    } else if (isSemi250 && !keywords.toLowerCase().includes('semiquincentennial')) {
      keywords += ' Semiquincentennial';
    }

    // Lunar keyword enrichment: append zodiac animal + Perth series label (#155)
    if (isLunarCoin && year) {
      if (zodiacAnimal && !keywords.toLowerCase().includes(zodiacAnimal.toLowerCase())) {
        keywords += ' ' + zodiacAnimal;
      }
      if (perthSeriesLabel && !keywords.toLowerCase().includes('series')) {
        keywords += ' ' + perthSeriesLabel;
      }
    }

    // Fetch eBay comps -- parity with priceRoute (#155): 180d, 3 pages
    const ebay = await ebayService.fetchSoldComps(keywords, {
      timeWindowDays: 180,
      maxPages: 3,
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

    // #156: Auto-derive COA/Box appeal multiplier
    const hasCoa = coinData.coa === 'Y' || coinData.coa === true || /\bCOA=Y\b/i.test(query);
    const hasBox = coinData.originalBox === 'Y' || coinData.originalBox === true;
    let coaAppealMultiplier = 1.0;
    if (hasCoa && hasBox) coaAppealMultiplier = 1.10;
    else if (hasCoa || hasBox) coaAppealMultiplier = 1.05;

    const result = computeValuation(pcgs, ebay, null, gradeNum, {
      isBullion,
      isSet,
      isRoll,
      greysheet,
      appealMultiplier: coaAppealMultiplier > 1.0 ? coaAppealMultiplier : undefined,
      spotPrice: (isBullion && meltPerOz && weight)
        ? meltPerOz * weight
        : null,
    });
    const val = result.valuation || {};

    // Roll/tube enrichment
    let rollQty = null;
    let perCoinFmv = null;
    if (isRoll) {
      rollQty = getRollQuantity(parsed.series || series || String(query));
      const fmvCore = val.fmvCore || null;
      perCoinFmv = (rollQty && fmvCore) ? +(fmvCore / rollQty).toFixed(2) : null;
    }

    return {
      query,
      fmv: val.fmvCore || null,
      rangeLow: val.rangeLow || null,
      rangeHigh: val.rangeHigh || null,
      avgEbay: ebay?.us?.stats?.median || ebay?.us?.stats?.mean || null,
      confidence: val.confidence || null,
      spotStale: spotStale || undefined,
      spotAsOf: spotAsOf || undefined,
      rollQty: rollQty || undefined,
      perCoinFmv: perCoinFmv || undefined,
    };
  } catch (err) {
    return { query: item.query || '', error: err.message };
  }
}

module.exports = router;
