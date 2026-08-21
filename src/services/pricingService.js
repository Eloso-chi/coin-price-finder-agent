// src/services/pricingService.js — Shared deterministic pricing boundary
// Callable by routes, tests, and future conversational interfaces.
// Preserves existing route behavior while enabling AI access via allowlisted tools.
// CommonJS

'use strict';

const pcgsService = require('./pcgsService');
const ebayService = require('./ebayService');
const greysheetService = require('./greysheetService');
const greysheetHistory = require('./greysheetHistoryService');
const auctionPriceService = require('./auctionPriceService');
const { computeValuation } = require('./valuationService');
const { getMetalsSpotPrice } = require('./metalsSpotPrice');
const numistaService = require('./numistaService');
const terapeakService = require('./terapeakService');
const { lookupKeyDate } = require('../data/keyDates');
const { lookupMintage } = require('../data/mintages');
const { buildLunarComparison } = require('../data/lunarReference');
const { resolveCoinVariant } = require('../data/halfDollarSeries');
const { zodiacForYear, perthLunarSeries, getRollQuantity, ALLOWED_LABELS, BULLION_1OZ_DEFAULT } = require('../data/constants');
const { validateSeriesIntegrity, validateNumericSanity } = require('../utils/responseValidator');
const { hasSeriesConflict, detectDenomination } = require('../utils/filters');
const { getCoinMetalProfile } = require('../utils/coinMetalProfile');
const { extractCoinIntent } = require('../utils/coinIntent');
const stats = require('../utils/stats');

/**
 * Deterministic shared pricing boundary.
 * 
 * Input: caller-supplied coin query + structured metadata (coinData, options)
 * TrustedContext: server-derived audience, admin status, redaction rules
 * 
 * Returns: complete valuation object with provenance, applicable to structured
 * routes (priceRoute, barPriceRoute, pricingBatchRoute) and future conversational
 * routes.
 * 
 * @param {Object} input - Caller-provided coin query + metadata
 *   @param {string} input.query - Free-text coin description (e.g. "1921 Morgan Dollar")
 *   @param {Object} [input.coinData] - Structured form inputs (year, grade, mint, name, etc.)
 *   @param {number} [input.weight] - Override weight (from HTTP body)
 *   @param {Object} [input.options] - Pricing options (timeWindowDays, usMinComps, etc.)
 *   @param {string} [input.saleContext] - 'ebay' (default), 'private', 'wholesale'
 *   @param {number} [input.askingPrice] - Caller's suggested listing price (used in valuation)
 *   @param {number} [input.appealMultiplier] - COA/Box appeal boost [1.0..2.0]
 * 
 * @param {Object} trustedContext - Server-derived security boundary
 *   @param {boolean} [trustedContext.isAdmin] - Admin flag from auth middleware (gates licensed data)
 *   @param {string} [trustedContext.audience] - 'admin' or 'public' (gates Greysheet $ amounts)
 * 
 * @returns {Promise<Object>} Complete valuation result
 *   @returns {Object} .valuation - FMV, range, algorithm version, confidence, explanation
 *   @returns {Object} .decisions - Why this FMV was selected (comps used, fallback reason, etc.)
 *   @returns {Object} .coin - Identification metadata (series, year, grade, etc.)
 *   @returns {Object} .ebay - Comp search results (US, Global, fallback flag)
 *   @returns {Object} .pcgs - Graded population & price guide (if verified)
 *   @returns {Object} .greysheet - Wholesale pricing (if available & audience=admin)
 *   @returns {Object} .numista - Catalogue enrichment (rarity, composition, refs)
 *   @returns {Object} .rollInfo - Per-coin FMV (for rolls)
 *   @returns {Object} .reproducibility - Audit trail (comp IDs, cert #, timestamp)
 */
async function priceCoin(input, trustedContext = {}) {
  // ── Input validation ──
  const {
    query = '',
    coinData = {},
    weight: bodyWeight = null,
    options = {},
    saleContext: rawSaleCtx = 'ebay',
    askingPrice = null,
    appealMultiplier: rawAppeal = 1.0,
  } = input || {};

  if (!query) {
    throw new Error('query field is required');
  }
  if (String(query).length > 300) {
    throw new Error('query must be 300 characters or fewer');
  }

  const trustedIsAdmin = trustedContext.isAdmin === true;
  const trustedAudience = trustedContext.audience || (trustedIsAdmin ? 'admin' : 'public');

  // ── Sale context fallback ──
  const VALID_SALE_CONTEXTS = new Set(['ebay', 'private', 'wholesale']);
  const saleContext = VALID_SALE_CONTEXTS.has(rawSaleCtx) ? rawSaleCtx : 'ebay';

  // ── Appeal multiplier clamp ──
  const appealMultiplier = Math.min(2.0, Math.max(1.0, Number(rawAppeal) || 1.0));

  // ── 1. Identify the coin via PCGS ──
  let pcgs;
  const certMatch = String(query).match(/^\d{7,9}$/);
  if (certMatch) {
    pcgs = await pcgsService.lookupByCert(query);
  } else if (coinData?.pcgsNumber) {
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

  // ── 2. Normalize weight ──
  let resolvedWeight = coinData?.weight || bodyWeight || identification.parsed?.weight
    || pcgsService.parseDescription(String(query))?.weight || null;

  // Default bullion coins to 1 oz
  if (!resolvedWeight) {
    const seriesHint = (identification.parsed?.series || pcgs.series || '').toLowerCase();
    if (BULLION_1OZ_DEFAULT.some(b => seriesHint.includes(b))) {
      resolvedWeight = 1;
    }
  }

  // ── 3. Coin intent (grade, finish, isProof, etc.) ──
  const resolvedSetType = coinData?.setType || identification.parsed?.setType || null;
  const isSet = !!resolvedSetType;
  const isRoll = !!(coinData?.isRoll || identification.parsed?.isRoll);

  // ── 4. Build eBay keywords ──
  const peekParsed = pcgsService.parseDescription(String(query));
  const bullionHintText = `${coinData?.name || ''} ${peekParsed?.series || ''} ${String(query)}`.toLowerCase();
  const defaultLookbackDays = BULLION_1OZ_DEFAULT.some(b => bullionHintText.includes(b)) ? 120 : 180;

  const opts = {
    timeWindowDays: options?.timeWindowDays || defaultLookbackDays,
    requirePCGSOnly: !!options?.requirePCGSOnly,
    exactGradeOnly: !!options?.exactGradeOnly,
    usMinComps: options?.usMinComps || 8,
    maxPages: options?.maxPages || 3
  };

  // Adjust for rolls (sparser comps)
  if (peekParsed?.isRoll || coinData?.isRoll) {
    opts.usMinComps = Math.min(opts.usMinComps, 3);
  }

  // Build keywords based on coin type
  let ebayKeywords;
  const rawLabel = coinData?.label || identification.parsed?.label || null;
  const validLabel = (rawLabel && ALLOWED_LABELS.has(rawLabel)) ? rawLabel : null;

  const VARIANT_LABEL_TOKENS = new Set([
    'Colorized', 'Gilded', 'Privy', 'High Relief', 'Antiqued', 'Burnished',
    'Hologram', 'Gold Plated', 'Ruthenium',
  ]);
  const variantSuffix = (validLabel && VARIANT_LABEL_TOKENS.has(validLabel))
    ? validLabel.toLowerCase()
    : null;

  if (isRoll) {
    const yr = coinData?.year || pcgs.year || identification.parsed?.year || '';
    const mint = identification.parsed?.mint || pcgs.mint || '';
    const series = identification.parsed?.series || pcgs.series || '';
    ebayKeywords = `${yr}${mint ? '-' + mint : ''} ${series} (roll,tube)`.trim();
  } else if (isSet) {
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
    const parsedFinish = coinData?.finish || identification.parsed?.finish || null;
    if (parsedFinish && !pcgs.finish) pcgs.finish = parsedFinish;
    ebayKeywords = ebayService.buildKeywords(pcgs, String(query), resolvedWeight, validLabel);
  }

  // Append variant suffix if applicable
  if (variantSuffix && !ebayKeywords.toLowerCase().includes(variantSuffix)) {
    ebayKeywords += ' ' + variantSuffix;
  }

  // Lunar enrichment
  const coinName = (coinData?.name || pcgs.series || identification.parsed?.series || '').toLowerCase();
  const rawQueryLower = String(query).toLowerCase();
  const coinYear = coinData?.year || pcgs.year || identification.parsed?.year;
  const hasLunarKeyword = /\blunar\b/i.test(coinName) || /\blunar\b/i.test(rawQueryLower);
  const hasZodiacPattern = /\byear\s+of\s+the\s+(rat|ox|tiger|rabbit|dragon|snake|horse|goat|monkey|rooster|dog|pig)\b/i.test(rawQueryLower);
  const isLunarCoin = hasLunarKeyword || hasZodiacPattern;
  const hasPerthContext = /\bperth\b/i.test(coinName) || /\bperth\b/i.test(rawQueryLower);
  const hasAustralianContext = /\baustralian?\b/i.test(coinName) || /\baustralian?\b/i.test(rawQueryLower);

  let zodiacAnimal = null;
  let perthSeriesLabel = null;
  if (isLunarCoin && coinYear) {
    zodiacAnimal = zodiacForYear(coinYear);
    if (zodiacAnimal && !ebayKeywords.toLowerCase().includes(zodiacAnimal.toLowerCase())) {
      ebayKeywords += ' ' + zodiacAnimal;
    }
    if (hasPerthContext || hasAustralianContext) {
      const { label } = perthLunarSeries(coinYear);
      perthSeriesLabel = label;
      if (perthSeriesLabel && !ebayKeywords.toLowerCase().includes('series')) {
        ebayKeywords += ' ' + perthSeriesLabel;
      }
    }
  }

  // ── 5. Build expected coin object ──
  const parsedMetal = identification.parsed?.metal || null;
  const pcgsMetal = pcgs.metalContent ? (pcgs.metalContent.toLowerCase().includes('gold') ? 'gold'
    : pcgs.metalContent.toLowerCase().includes('silver') ? 'silver'
    : pcgs.metalContent.toLowerCase().includes('platinum') ? 'platinum'
    : pcgs.metalContent.toLowerCase().includes('palladium') ? 'palladium' : null) : null;
  const profileMetal = getCoinMetalProfile(query).metal || null;
  const expectedMetal = parsedMetal || pcgsMetal || profileMetal || null;

  const intent = extractCoinIntent({
    coinData,
    options,
    parsed: identification.parsed,
    pcgs,
    isSet,
  });

  const expected = {
    year: pcgs.year || identification.parsed?.year,
    mint: identification.parsed?.mint || '',
    series: pcgs.series || identification.parsed?.series,
    grade: intent.grade,
    designation: intent.designation,
    finish: intent.finish,
    isProof: intent.isProof,
    metal: expectedMetal,
    weight: resolvedWeight || null,
    zodiacAnimal: zodiacAnimal,
    isLunarCoin: isLunarCoin,
    isRoll: isRoll,
    isSet: isSet,
    setType: resolvedSetType || null,
    perthSeriesLabel: perthSeriesLabel,
    label: validLabel,
    barBrand: intent.barBrand,
    barSeries: intent.barSeries,
    _gradeSource: identification.parsed?._gradeSource || null,
    _exclusions: identification.parsed?._exclusions || null,
    _rawQuery: String(query),
  };

  // BU bullion grade fix
  const seriesForBullionCheck = (expected.series || '').toLowerCase();
  const earlyIsBullion = BULLION_1OZ_DEFAULT.some(b => seriesForBullionCheck.includes(b));
  if (earlyIsBullion && expected.grade && expected._gradeSource === 'bu-term') {
    expected.grade = null;
  }

  // Brand filter for eBay aspects
  if (hasPerthContext || hasAustralianContext) expected._brandFilter = 'Perth Mint';
  else if (/\broyal\s*mint\b/i.test(rawQueryLower)) expected._brandFilter = 'The Royal Mint';
  else if (/\broyal\s*canadian\b|\brcm\b/i.test(rawQueryLower)) expected._brandFilter = 'Royal Canadian Mint';

  // Tracker series
  let trackerSeries = pcgs.series || identification.parsed?.series || '';
  if (isLunarCoin && coinYear && (hasPerthContext || hasAustralianContext)) {
    const { label: serLabel } = perthLunarSeries(coinYear);
    if (serLabel) {
      const metalToken = expectedMetal || 'silver';
      trackerSeries = `Perth Lunar ${serLabel} ${metalToken}`;
    }
  }

  // ── 6. Spot price fetch (non-fatal) ──
  let spotStale = false;
  let spotAsOf = null;
  if (expectedMetal && resolvedWeight) {
    const METAL_SYM = { silver: 'XAG', gold: 'XAU', platinum: 'XPT', palladium: 'XPD' };
    const sym = METAL_SYM[expectedMetal];
    if (sym) {
      try {
        const spot = await getMetalsSpotPrice(sym, 'USD');
        expected.meltPerOz = spot.price;
        if (spot.stale || /hardcoded|stale/i.test(spot.source || '')) {
          spotStale = true;
          spotAsOf = spot.timestamp || null;
        }
      } catch { /* non-fatal */ }
    }
  }

  // ── 7. Fetch eBay comps ──
  const ebay = await ebayService.fetchSoldComps(ebayKeywords, opts, expected);

  // ── 8. Key date detection ──
  let keyDateInfo = lookupKeyDate(
    coinData?.name || pcgs.series || identification.parsed?.series || '',
    coinData?.year || pcgs.year || identification.parsed?.year,
    coinData?.mintMark || pcgs.mint || identification.parsed?.mint || ''
  );

  // ── 9. Valuation ──
  let userGrade = (isSet || isRoll) ? null : (coinData?.grade || identification.parsed?.grade || null);

  const isBullion = BULLION_1OZ_DEFAULT.some(b => seriesForBullionCheck.includes(b));
  if (isBullion && userGrade && identification.parsed?._gradeSource === 'bu-term') {
    userGrade = null;
  }

  // Greysheet lookup
  const pcgsNo = pcgs?.pcgsCoinNumber || pcgs?.pcgsNo || coinData?.pcgsNumber || null;
  const gradeNum = userGrade ? parseInt(String(userGrade).replace(/[^\d]/g, ''), 10) || null : null;
  let greysheet = pcgsNo ? await greysheetService.fetchPriceByPcgsNumber(pcgsNo, gradeNum) : null;
  if (!greysheet) {
    greysheet = await greysheetService.fetchTypePrice(String(query), gradeNum, {
      series: identification.parsed?.series || pcgs.series || '',
      metal: parsedMetal,
      weight: resolvedWeight,
      finish: coinData?.finish || identification.parsed?.finish || (expected.isProof ? 'Proof' : null),
    });
  }

  // Record Greysheet snapshot for history
  if (greysheet && (greysheet.greyVal || greysheet.cpgVal)) {
    const gsHistKey = greysheetHistory.makeKey(pcgsNo || greysheet.gsid, gradeNum);
    greysheetHistory.recordSnapshot(gsHistKey, greysheet.greyVal, greysheet.cpgVal);
  }

  // Enrich with APR data if available
  if (pcgsNo && gradeNum) {
    const aprData = auctionPriceService.getHistory(pcgsNo, gradeNum);
    if (aprData.stats.count > (pcgs.auction?.count || 0)) {
      pcgs.auction = { ...aprData.stats, trend: auctionPriceService.computeTrend(aprData.records) };
    }
  }

  // Appeal multiplier auto-derive
  let resolvedAppeal = appealMultiplier;
  if (resolvedAppeal <= 1.0) {
    const hasCoa = coinData?.coa === 'Y' || coinData?.coa === true || /\bCOA=Y\b/i.test(String(query));
    const hasBox = coinData?.originalBox === 'Y' || coinData?.originalBox === true;
    if (hasCoa && hasBox) resolvedAppeal = 1.10;
    else if (hasCoa || hasBox) resolvedAppeal = 1.05;
  }

  // Compute valuation
  const { valuation, decisions } = computeValuation(pcgs, ebay, askingPrice || null, userGrade, {
    isBullion,
    isProof: expected.isProof,
    barSeries: expected.barSeries,
    finish: expected.finish || expected.label,
    greysheet,
    saleContext,
    appealMultiplier: resolvedAppeal,
    spotPrice: (isBullion && expected.meltPerOz && resolvedWeight)
      ? expected.meltPerOz * resolvedWeight
      : null,
    audience: trustedAudience,
  });

  // ── 10. Series integrity guardrail ──
  const querySeries = identification.parsed?.series || '';
  const pcgsSeries = pcgs.series || '';
  if (querySeries && pcgsSeries && hasSeriesConflict(querySeries, pcgsSeries)) {
    console.warn(`[guardrail] Series conflict: query="${querySeries}" vs pcgs="${pcgsSeries}" — nulling PCGS data`);
    pcgs.series = querySeries;
    pcgs.priceGuide = null;
    pcgs.auction = null;
    pcgs.trueViewUrl = null;
    pcgs.coinImages = [];
    pcgs.pcgsCoinNumber = null;
    pcgs._seriesConflictOverride = true;
    valuation.explanation.push(`⚠ PCGS series conflict detected (resolved "${pcgsSeries}" vs query "${querySeries}") — PCGS data excluded.`);
  }

  // ── 11. Numista lookup (non-blocking) ──
  let numista = null;
  if (isSet) {
    numista = { accessible: true, type: null, issue: null, rarity: null, numistaUrl: null, prices: null, composition: null, references: null, limitations: ['Numista lookup skipped for mint/proof sets'] };
  } else if (isRoll) {
    numista = { accessible: true, type: null, issue: null, rarity: null, numistaUrl: null, prices: null, composition: null, references: null, limitations: ['Numista lookup skipped for roll searches'] };
  } else {
    try {
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
  }

  // ── 12. Mintage lookup ──
  let mintSeries = coinData?.name || pcgs.series || identification.parsed?.series || '';
  const mintYear = coinData?.year || pcgs.year || identification.parsed?.year;
  let mintMark = coinData?.mintMark || pcgs.mint || identification.parsed?.mint || '';

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
  let mintageSource = pcgsMintage ? 'pcgs' : null;
  if (!resolvedMintage) {
    const mintFinish = coinData?.finish || identification.parsed?.finish || (expected.isProof ? 'Proof' : null);
    const staticLookup = lookupMintage(mintSeries, mintYear, mintMark, resolvedWeight, mintFinish);
    if (staticLookup.mintage) {
      resolvedMintage = staticLookup.mintage;
      mintageSource = 'static';
    }
  }

  // ── 13. Reproducibility ──
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

  // ── 14. Roll info ──
  let rollInfo = null;
  if (isRoll) {
    const seriesHint = identification.parsed?.series || pcgs.series || String(query);
    const rollQty = getRollQuantity(seriesHint);
    const fmvCore = valuation?.fmvCore || null;
    rollInfo = {
      rollQty: rollQty,
      perCoinFmv: (rollQty && fmvCore) ? +(fmvCore / rollQty).toFixed(2) : null,
    };
  }

  // ── 15. Adjacent years context ──
  let adjacentYears = null;
  {
    const series = pcgs.series || identification.parsed?.series;
    const year = pcgs.year || identification.parsed?.year;
    const metal = identification.parsed?.metal;
    const soldCount = valuation.compCount || 0;
    if (series && year && soldCount < 5) {
      const results = [];
      for (let delta = -2; delta <= 2; delta++) {
        if (delta === 0) continue;
        const adjYear = year + delta;
        const adjQuery = `${adjYear} ${series}`;
        const data = terapeakService.lookupComps(adjQuery, { metal: metal || null });
        if (!data || !data.comps || data.comps.length === 0) continue;
        const prices = data.comps.map(c => c.totalUsd).filter(p => p != null);
        if (prices.length < 2) continue;
        results.push({
          year: adjYear,
          median: +stats.median(prices).toFixed(2),
          compCount: prices.length,
        });
      }
      adjacentYears = results.length > 0 ? results : null;
    }
  }

  // ── 16. Coin variant (Half Dollar, etc.) ──
  let coinVariant = null;
  {
    const denomName = coinData?.name || pcgs.series || identification.parsed?.series || '';
    const denomYear = coinData?.year || pcgs.year || identification.parsed?.year;
    if (/half\s*dollar|kennedy|franklin|walking\s*liberty|barber\s*half|seated.*half|capped.*half|draped.*half|flowing.*half/i.test(denomName)) {
      coinVariant = resolveCoinVariant('Half Dollar', denomYear);
    }
  }

  // ── Return structured result (Caller responsible for redaction) ──
  return {
    valuation,
    decisions,
    coin: {
      input: query,
      identification,
      coinData: coinData || null,
      expected,
      weight: resolvedWeight,
      setType: resolvedSetType,
      isProof: expected.isProof,
      isRoll: isRoll,
      isSet: isSet,
      isLunarCoin: isLunarCoin,
      zodiacAnimal: zodiacAnimal,
      perthSeriesLabel: perthSeriesLabel,
      trackerSeries: trackerSeries || null,
      coinVariant: coinVariant || null,
    },
    ebay: {
      keywords: ebayKeywords,
      us: ebay.us,
      global: ebay.global,
      usedFallback: ebay.usedFallback,
      lookback: ebay.lookback || { requested: opts.timeWindowDays, used: opts.timeWindowDays, extended: false }
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
    greysheet: greysheet ? {
      gsid: greysheet.gsid,
      name: greysheet.name,
      gradeLabel: greysheet.gradeLabel,
      wholesale: greysheet.greyVal,
      retail: greysheet.cpgVal,
      pcgsVal: greysheet.pcgsVal,
      ngcVal: greysheet.ngcVal,
      blueBookVal: greysheet.blueBookVal
    } : null,
    spotPrice: spotStale ? { stale: true, asOf: spotAsOf } : undefined,
    numista: numista || null,
    mintage: {
      value: resolvedMintage,
      source: mintageSource
    },
    keyDate: keyDateInfo,
    rollInfo: rollInfo || undefined,
    adjacentYears: adjacentYears || undefined,
    lunarComparison: isLunarCoin ? buildLunarComparison(coinYear, coinName + ' ' + String(query)) : null,
    reproducibility,
    options: opts,
  };
}

module.exports = {
  priceCoin
};
