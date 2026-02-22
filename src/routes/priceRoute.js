// src/routes/priceRoute.js — POST /api/price
// CommonJS

const express = require('express');
const router = express.Router();

const pcgsService = require('../services/pcgsService');
const ebayService = require('../services/ebayService');
const { computeValuation } = require('../services/valuationService');
const { getMetalsSpotPrice } = require('../services/metalsSpotPrice');
const numistaService = require('../services/numistaService');
const { lookupKeyDate } = require('../data/keyDates');
const { lookupMintage } = require('../data/mintages');
const { buildLunarComparison } = require('../data/lunarReference');
const { resolveCoinVariant } = require('../data/halfDollarSeries');
const { zodiacForYear, perthLunarSeries } = require('../data/constants');

// ── Semiquincentennial circulating denomination map ──
// Maps parsed "semiquincentennial <denom>" keywords to their canonical series
const SEMI250_DENOM_MAP = {
  'semiquincentennial half dollar': 'Kennedy Half Dollar',
  'semiquincentennial clad half':   'Kennedy Half Dollar',
  'semiquincentennial quarter':     'Washington Quarter',
  'semiquincentennial dime':        'Roosevelt Dime',
  'semiquincentennial nickel':      'Jefferson Nickel',
  'semiquincentennial cent':        'Lincoln Cent',
};

// ── Bullion series that default to 1 oz when no weight is specified ──
// Also used to detect bullion coins for steeper recency decay in valuation.
const BULLION_1OZ_DEFAULT = [
  'libertad', 'silver eagle', 'gold eagle', 'maple leaf', 'britannia',
  'philharmonic', 'krugerrand', 'kangaroo', 'kookaburra', 'panda',
  'gold buffalo', 'platinum eagle', 'palladium eagle', 'lunar',
  'polar bear'
];

/**
 * For semiquincentennial circulating coins, resolve to canonical series
 * so that key-date, mintage, and eBay lookups use the right name.
 */
function resolveSemi250Series(series) {
  if (!series) return null;
  const s = series.toLowerCase().trim();
  return SEMI250_DENOM_MAP[s] || null;
}

router.post('/', async (req, res) => {
  try {
    const { query, askingPrice, options, coinData, weight: bodyWeight } = req.body || {};
    if (!query) {
      return res.status(400).json({ error: 'query field is required' });
    }

    const opts = {
      timeWindowDays: options?.timeWindowDays || 90,
      requirePCGSOnly: !!options?.requirePCGSOnly,
      exactGradeOnly: !!options?.exactGradeOnly,
      usMinComps: options?.usMinComps || 8,
      maxPages: options?.maxPages || 3
    };

    // ── 1. Identify the coin via PCGS ──
    let pcgs;
    const certMatch = String(query).match(/^\d{7,9}$/);
    if (certMatch) {
      pcgs = await pcgsService.lookupByCert(query);
    } else if (coinData?.pcgsNumber) {
      // User supplied PCGS coin # directly via structured form
      const gradeNum = coinData?.grade
        ? parseInt(String(coinData.grade).replace(/[^\d]/g, ''), 10) || 65
        : 65;
      pcgs = await pcgsService.lookupByCoinNumberAndGrade(coinData.pcgsNumber, gradeNum);
    } else {
      pcgs = await pcgsService.resolveFromDescription(String(query));
    }

    const identification = {
      inputQuery: query,
      resolvedVia: pcgs.verified ? 'pcgs-api' : 'description-parse',
      parsed: pcgs.parsed || pcgsService.parseDescription(String(query))
    };

    // ── 2. Build eBay keywords ──
    let resolvedWeight = coinData?.weight || bodyWeight || identification.parsed?.weight || null;

    // Default bullion coins to 1 oz when no weight is specified.
    // Users commonly search "Mexican Silver Libertad 2024" without saying "1oz";
    // without a weight hint the system can't filter out fractional-oz comps.
    if (!resolvedWeight) {
      const seriesHint = (identification.parsed?.series || pcgs.series || '').toLowerCase();
      if (BULLION_1OZ_DEFAULT.some(b => seriesHint.includes(b))) {
        resolvedWeight = 1;
      }
    }

    // Detect proof/mint set from parser or structured input
    const resolvedSetType = coinData?.setType || identification.parsed?.setType || null;
    const isSet = !!resolvedSetType;

    let ebayKeywords;
    if (isSet) {
      // For sets, build targeted keywords (PCGS won't resolve these)
      const yr = coinData?.year || pcgs.year || identification.parsed?.year || '';
      const setLabels = {
        'clad': 'US proof set',
        'silver': 'US silver proof set',
        'prestige': 'US prestige proof set',
        'premier-silver': 'US premier silver proof set',
        'mint-uncirculated': 'US mint set uncirculated'
      };
      ebayKeywords = `${yr} ${setLabels[resolvedSetType] || 'US proof set'}`.trim();
    } else {
      // Enrich pcgs object with parsed finish so buildKeywords can use it
      const parsedFinish = identification.parsed?.finish || null;
      if (parsedFinish && !pcgs.finish) pcgs.finish = parsedFinish;
      ebayKeywords = ebayService.buildKeywords(pcgs, String(query), resolvedWeight);
    }

    // ── 2a. Semiquincentennial circulating coin enrichment ──
    // If the parsed series is a "semiquincentennial <denom>", resolve to the
    // canonical coin series and enrich eBay keywords for better results.
    const parsedSeries = identification.parsed?.series || pcgs.series || '';
    const semi250Canonical = resolveSemi250Series(parsedSeries);
    const isSemi250 = !!(semi250Canonical || /semiquincentennial|250th\s*anniversary/i.test(String(query)));
    if (semi250Canonical) {
      // Override eBay keywords to use the real series name + "semiquincentennial"
      const yr = pcgs.year || identification.parsed?.year || 2026;
      const mint = pcgs.mint || identification.parsed?.mint || '';
      ebayKeywords = `${yr}${mint ? '-' + mint : ''} ${semi250Canonical} Semiquincentennial`.trim();
    } else if (isSemi250 && !semi250Canonical) {
      // Commemorative / special numismatic coin — ensure "semiquincentennial" is in keywords
      if (!ebayKeywords.toLowerCase().includes('semiquincentennial')) {
        ebayKeywords += ' Semiquincentennial';
      }
    }

    // ── 2b. Lunar series enrichment ──
    // If this is a Lunar coin, append zodiac animal + Perth series number for precision
    const coinName = (coinData?.name || pcgs.series || identification.parsed?.series || '').toLowerCase();
    const coinYear = coinData?.year || pcgs.year || identification.parsed?.year;
    const isLunarCoin = /\blunar\b/i.test(coinName);
    let zodiacAnimal = null;
    let perthSeriesLabel = null;

    if (isLunarCoin && coinYear) {
      zodiacAnimal = zodiacForYear(coinYear);
      if (zodiacAnimal && !ebayKeywords.toLowerCase().includes(zodiacAnimal.toLowerCase())) {
        ebayKeywords += ' ' + zodiacAnimal;
      }
      // Perth Mint series numbering
      if (/perth/i.test(coinName)) {
        const { label } = perthLunarSeries(coinYear);
        perthSeriesLabel = label;
        if (perthSeriesLabel && !ebayKeywords.toLowerCase().includes('series')) {
          ebayKeywords += ' ' + perthSeriesLabel;
        }
      }
    }

    // ── 3. Fetch eBay comps (US + Global) ──
    // Detect expected metal from parsed query or PCGS metalContent
    const parsedMetal = identification.parsed?.metal || null;
    const pcgsMetal = pcgs.metalContent ? (pcgs.metalContent.toLowerCase().includes('gold') ? 'gold'
      : pcgs.metalContent.toLowerCase().includes('silver') ? 'silver'
      : pcgs.metalContent.toLowerCase().includes('platinum') ? 'platinum'
      : pcgs.metalContent.toLowerCase().includes('palladium') ? 'palladium' : null) : null;
    const expectedMetal = parsedMetal || pcgsMetal || null;

    const expected = {
      year: pcgs.year || identification.parsed?.year,
      mint: pcgs.mint || identification.parsed?.mint,
      series: pcgs.series || identification.parsed?.series,
      grade: isSet ? null : (pcgs.grade || identification.parsed?.grade),
      designation: pcgs.designation || identification.parsed?.designation,
      finish: identification.parsed?.finish || null,
      metal: expectedMetal,
      weight: resolvedWeight || null,
      zodiacAnimal: zodiacAnimal,
      isLunarCoin: isLunarCoin,
      perthSeriesLabel: perthSeriesLabel,
      _rawQuery: String(query),
    };

    // ── Precious metal content cross-check ──
    // Fetch spot price so the eBay filter can sanity-check bullion comps
    // against melt value (both fractional AND full-oz).  Non-fatal — skip if unavailable.
    if (expectedMetal && resolvedWeight) {
      const METAL_SYM = { silver: 'XAG', gold: 'XAU', platinum: 'XPT', palladium: 'XPD' };
      const sym = METAL_SYM[expectedMetal];
      if (sym) {
        try {
          const spot = await getMetalsSpotPrice(sym, 'USD');
          expected.meltPerOz = spot.price;
        } catch { /* non-fatal */ }
      }
    }

    const ebay = await ebayService.fetchSoldComps(ebayKeywords, opts, expected);

    // ── 4. Key Date Detection ──
    // For semiquincentennial circulating coins, look up both the canonical series
    // (e.g. "Kennedy Half Dollar") AND the semiquincentennial-specific entries.
    const rawKeyDateSeries = coinData?.name || pcgs.series || identification.parsed?.series || '';
    const keyDateSeries = semi250Canonical || rawKeyDateSeries;
    const keyDateYear   = coinData?.year || pcgs.year || identification.parsed?.year;
    const keyDateMint   = coinData?.mintMark || pcgs.mint || identification.parsed?.mint || '';
    let keyDateInfo     = lookupKeyDate(keyDateSeries, keyDateYear, keyDateMint);
    // If canonical lookup didn't flag it, try the raw series (catches commemoratives)
    if (!keyDateInfo.isKeyDate && rawKeyDateSeries !== keyDateSeries) {
      keyDateInfo = lookupKeyDate(rawKeyDateSeries, keyDateYear, keyDateMint);
    }
    // Tag semiquincentennial coins even if not in keyDates table
    if (!keyDateInfo.isKeyDate && isSemi250) {
      keyDateInfo = {
        isKeyDate: true,
        tier: 'semi-key',
        note: '2026 Semiquincentennial (250th Anniversary) — one-year-only special design'
      };
    }

    // ── 5. Valuation + Decisions ──
    // Pass the USER's grade intent — not the PCGS-resolved grade.
    // coinData?.grade comes from structured input; identification.parsed?.grade
    // comes from free-text parsing.  If neither is set, user wants raw.
    // Sets (proof/mint) are never graded — pass null so all comps are used.
    const userGrade = isSet ? null : (coinData?.grade || identification.parsed?.grade || null);

    // Detect if this is a bullion coin ( values track metal spot price → steeper recency)
    const seriesForBullion = (identification.parsed?.series || pcgs.series || '').toLowerCase();
    const isBullion = BULLION_1OZ_DEFAULT.some(b => seriesForBullion.includes(b));

    const { valuation, decisions } = computeValuation(pcgs, ebay, askingPrice || null, userGrade, { isBullion });

    // ── 5a. Numista Catalogue Lookup (non-blocking) ──
    // Enrich the response with Numista rarity index, prices, composition, and references.
    let numista = null;
    try {
      // Detect country from PCGS, structured input, or series name keywords
      const seriesForCountry = (identification.parsed?.series || pcgs.series || '').toLowerCase();
      const queryForCountry = String(query).toLowerCase();
      const numistaCountry = pcgs.country || coinData?.country
        || (/\bcanad/i.test(seriesForCountry + ' ' + queryForCountry) ? 'canada'
          : /\baustral|\bperth|\bkookaburra|\bkangaroo|\blunar(?!.*chinese)/i.test(seriesForCountry + ' ' + queryForCountry) ? 'australia'
          : /\bmexi|\blibertad/i.test(seriesForCountry + ' ' + queryForCountry) ? 'mexico'
          : /\bsouth\s*afric|\bkrugerrand/i.test(seriesForCountry + ' ' + queryForCountry) ? 'south africa'
          : /\bbritish|\bbritannia|\broyal\s*mint\b.*\buk/i.test(seriesForCountry + ' ' + queryForCountry) ? 'united kingdom'
          : /\baustri|\bphilharmonic/i.test(seriesForCountry + ' ' + queryForCountry) ? 'austria'
          : /\bchin|\bpanda/i.test(seriesForCountry + ' ' + queryForCountry) ? 'china'
          : null);
      numista = await numistaService.lookupCoin(identification.parsed || {}, numistaCountry);
    } catch (err) {
      console.warn('[Numista] Non-fatal lookup error:', err.message);
      numista = { accessible: false, limitations: ['Numista lookup failed: ' + err.message] };
    }

    // ── 6. Static Mintage Fallback ──
    let mintSeries = semi250Canonical || coinData?.name || pcgs.series || identification.parsed?.series || '';
    const mintYear   = coinData?.year || pcgs.year || identification.parsed?.year;
    let   mintMark   = coinData?.mintMark || pcgs.mint || identification.parsed?.mint || '';
    const mintWeight = resolvedWeight;

    // For proof/mint sets, build the correct lookup key
    if (resolvedSetType) {
      if (resolvedSetType === 'mint-uncirculated') {
        mintSeries = 'us mint set';
        mintMark = mintMark || 'P';
      } else {
        mintSeries = 'us proof set ' + resolvedSetType;
        mintMark = mintMark || 'S';
      }
    }

    const pcgsMintage = pcgs.mintage ? Number(pcgs.mintage) : null;
    let resolvedMintage = pcgsMintage;
    let mintageSource   = pcgsMintage ? 'pcgs' : null;
    if (!resolvedMintage) {
      const staticLookup = lookupMintage(mintSeries, mintYear, mintMark, mintWeight);
      if (staticLookup.mintage) {
        resolvedMintage = staticLookup.mintage;
        mintageSource   = 'static';
      }
    }

    // ── 7. Reproducibility ──
    const reproducibility = {
      pcgs: {
        certNumber: certMatch ? query : null,
        barcode: null,
        pcgsCoinNumber: pcgs.pcgsCoinNumber || null
      },
      ebay: {
        timeWindowDays: opts.timeWindowDays,
        usItemIds: (ebay.us?.comps || []).map(c => c.itemId).filter(Boolean),
        globalItemIds: (ebay.global?.comps || []).map(c => c.itemId).filter(Boolean)
      }
    };

    // ── Response ──
    return res.json({
      query: { input: query, askingPrice: askingPrice || null, weight: resolvedWeight, setType: resolvedSetType, options: opts },
      coinData: coinData || null,
      keyDate: keyDateInfo,
      identification,
      mintageData: {
        mintage: resolvedMintage,
        source: mintageSource
      },
      pcgs: {
        verified: pcgs.verified,
        pcgsCoinNumber: pcgs.pcgsCoinNumber,
        series: pcgs.series,
        year: pcgs.year,
        mint: pcgs.mint,
        grade: pcgs.grade,
        designation: pcgs.designation,
        variety: pcgs.variety,
        priceGuide: pcgs.priceGuide,
        population: pcgs.population,
        auction: pcgs.auction,
        trueViewUrl: pcgs.trueViewUrl,
        coinImages: pcgs.coinImages || [],
        mintage: pcgs.mintage || null,
        metalContent: pcgs.metalContent || null,
        country: pcgs.country || null
      },
      ebay: {
        keywords: ebayKeywords,
        us: ebay.us,
        global: ebay.global,
        usedFallback: ebay.usedFallback,
        lookback: ebay.lookback || { requested: opts.timeWindowDays, used: opts.timeWindowDays, extended: false }
      },
      valuation,
      decisions,
      numista: numista || null,
      reproducibility,
      lunarComparison: isLunarCoin ? buildLunarComparison(coinYear, coinName + ' ' + String(query)) : null,
      coinVariant: (function() {
        // Resolve design series label for Half Dollar (and future denominations)
        const denomName = semi250Canonical || coinData?.name || pcgs.series || identification.parsed?.series || '';
        const denomYear = coinData?.year || pcgs.year || identification.parsed?.year;
        if (/half\s*dollar|kennedy|franklin|walking\s*liberty|barber\s*half|seated.*half|capped.*half|draped.*half|flowing.*half/i.test(denomName)) {
          return resolveCoinVariant('Half Dollar', denomYear);
        }
        return null;
      })()
    });
  } catch (err) {
    console.error('[/api/price] Unhandled error:', err.message);
    return res.status(500).json({
      error: 'Internal server error',
      message: err.message
    });
  }
});

module.exports = router;
