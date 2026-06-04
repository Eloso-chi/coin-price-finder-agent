// src/routes/priceRoute.js — POST /api/price
// CommonJS

const express = require('express');
const router = express.Router();

const pcgsService = require('../services/pcgsService');
const ebayService = require('../services/ebayService');
const greysheetService = require('../services/greysheetService');
const greysheetHistory = require('../services/greysheetHistoryService');
const auctionPriceService = require('../services/auctionPriceService');
const { computeValuation } = require('../services/valuationService');
const { getMetalsSpotPrice } = require('../services/metalsSpotPrice');
const numistaService = require('../services/numistaService');
const { lookupKeyDate } = require('../data/keyDates');
const { lookupMintage } = require('../data/mintages');
const { buildLunarComparison } = require('../data/lunarReference');
const { resolveCoinVariant } = require('../data/halfDollarSeries');
const { zodiacForYear, perthLunarSeries, getRollQuantity, ALLOWED_LABELS, BULLION_1OZ_DEFAULT } = require('../data/constants');
const { validateSeriesIntegrity, validateNumericSanity } = require('../utils/responseValidator');
const { hasSeriesConflict, detectDenomination } = require('../utils/filters');
const { getCoinMetalProfile } = require('../utils/coinMetalProfile');
const terapeakService = require('../services/terapeakService');
const { redactCompsForPublic } = require('../utils/redactForPublic');
const { extractCoinIntent } = require('../utils/coinIntent');
const stats = require('../utils/stats');

// ── #41: Adjacent-year context ──
// When exact coin has few/no comps, look up Terapeak data for same series +/- 2 years.
// Returns informational context only -- NOT blended into FMV.
function buildAdjacentYearContext(series, year, metal, soldCount) {
  if (!series || !year || soldCount >= 5) return null;
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
  return results.length > 0 ? results : null;
}

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

// BULLION_1OZ_DEFAULT + ALLOWED_LABELS imported from data/constants.js above

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
    const { query, askingPrice, options, coinData, weight: bodyWeight, saleContext: rawSaleCtx, appealMultiplier: rawAppeal } = req.body || {};
    if (!query) {
      return res.status(400).json({ error: 'query field is required' });
    }

    // #55: Validate sale context
    const VALID_SALE_CONTEXTS = new Set(['ebay', 'private', 'wholesale']);
    const saleContext = VALID_SALE_CONTEXTS.has(rawSaleCtx) ? rawSaleCtx : 'ebay';

    // #56: Appeal multiplier — clamp to [1.0, 2.0], default 1.0.
    const appealMultiplier = Math.min(2.0, Math.max(1.0, Number(rawAppeal) || 1.0));

    const opts = {
      timeWindowDays: options?.timeWindowDays || 180,
      requirePCGSOnly: !!options?.requirePCGSOnly,
      exactGradeOnly: !!options?.exactGradeOnly,
      usMinComps: options?.usMinComps || 8,
      maxPages: options?.maxPages || 3
    };

    // Peek ahead for roll detection so we can adjust opts before eBay calls.
    // Roll sold listings are sparser than individual coins — lower the minimum
    // comp threshold to prevent unnecessary Browse API (active-listing) fallback.
    const peekParsed = pcgsService.parseDescription(String(query));
    if (peekParsed?.isRoll || coinData?.isRoll) {
      opts.usMinComps = Math.min(opts.usMinComps, 3);
    }

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

    // Detect roll searches (e.g. "1960 P lincoln cent roll")
    const isRoll = !!(coinData?.isRoll || identification.parsed?.isRoll);

    // Validate label against allowlist (used in both keyword building and expected object)
    // User-explicit label takes priority; fall back to auto-detected from parseDescription (e.g. "Type 1")
    const rawLabel = coinData?.label || identification.parsed?.label || null;
    const validLabel = (rawLabel && ALLOWED_LABELS.has(rawLabel)) ? rawLabel : null;

    let ebayKeywords;
    if (isRoll) {
      // For rolls/tubes, build targeted keywords (PCGS won't price these)
      // Include both "roll" and "tube" via eBay OR syntax so we capture
      // listings that say "tube" instead of "roll" (common for bullion).
      const yr = coinData?.year || pcgs.year || identification.parsed?.year || '';
      const mint = identification.parsed?.mint || pcgs.mint || '';
      const series = identification.parsed?.series || pcgs.series || '';
      ebayKeywords = `${yr}${mint ? '-' + mint : ''} ${series} (roll,tube)`.trim();
    } else if (isSet) {
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
      const parsedFinish = coinData?.finish || identification.parsed?.finish || null;
      if (parsedFinish && !pcgs.finish) pcgs.finish = parsedFinish;
      ebayKeywords = ebayService.buildKeywords(pcgs, String(query), resolvedWeight, validLabel);
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
    // If this is a Lunar coin, append zodiac animal + Perth series number for precision.
    // Detect Lunar context from: parsed series, raw query, AND zodiac patterns.
    const coinName = (coinData?.name || pcgs.series || identification.parsed?.series || '').toLowerCase();
    const rawQueryLower = String(query).toLowerCase();
    const coinYear = coinData?.year || pcgs.year || identification.parsed?.year;
    const hasLunarKeyword = /\blunar\b/i.test(coinName) || /\blunar\b/i.test(rawQueryLower);
    const hasZodiacPattern = /\byear\s+of\s+the\s+(rat|ox|tiger|rabbit|dragon|snake|horse|goat|monkey|rooster|dog|pig)\b/i.test(coinName)
      || /\byear\s+of\s+the\s+(rat|ox|tiger|rabbit|dragon|snake|horse|goat|monkey|rooster|dog|pig)\b/i.test(rawQueryLower);
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
      // Perth Mint series numbering — check raw query too, not just parsed coinName
      if (hasPerthContext || hasAustralianContext) {
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
    // Fallback: infer metal from series name or query keywords (e.g. "Krugerrand" implies gold)
    const profileMetal = getCoinMetalProfile(query).metal || null;
    const expectedMetal = parsedMetal || pcgsMetal || profileMetal || null;

    // #254: Centralize grade/finish/isProof derivation so we accept every
    // shape a UI or API caller may reasonably send (lowercase finish,
    // explicit isProof flag, coinData.grade with no grade word in query).
    // Previously several of these were silently dropped, putting the wrong
    // pool through the strike-split filter and producing incorrect FMV.
    const intent = extractCoinIntent({
      coinData,
      options,
      parsed: identification.parsed,
      pcgs,
      isSet,
    });

    const expected = {
      year: pcgs.year || identification.parsed?.year,
      mint: identification.parsed?.mint || '',  // #167: only user-specified mint drives filtering (PCGS mint used for display only)
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
      _gradeSource: identification.parsed?._gradeSource || null,
      _exclusions: identification.parsed?._exclusions || null,
      _rawQuery: String(query),
    };

    // #162: Null out BU-expanded grade for bullion coins BEFORE eBay fetch.
    // "BU" for world bullion means raw mint-sealed, not a specific PCGS grade.
    // Leaving it set causes gradeNumMismatch to kill 50-90% of valid comps.
    const earlyBullionSeries = (expected.series || '').toLowerCase();
    const earlyIsBullion = BULLION_1OZ_DEFAULT.some(b => earlyBullionSeries.includes(b));
    if (earlyIsBullion && expected.grade && expected._gradeSource === 'bu-term') {
      expected.grade = null;
    }

    // Auto-detect Brand for eBay aspect filtering (Perth Mint, Royal Mint, etc.)
    if (hasPerthContext || hasAustralianContext)             expected._brandFilter = 'Perth Mint';
    else if (/\broyal\s*mint\b/i.test(rawQueryLower))       expected._brandFilter = 'The Royal Mint';
    else if (/\broyal\s*canadian\b|\brcm\b/i.test(rawQueryLower)) expected._brandFilter = 'Royal Canadian Mint';

    // Build a tracker-appropriate series name for the Live eBay Tracker.
    // For Lunar coins, broaden from specific animal ("Perth Year Of The Rooster")
    // to the full series ("Perth Lunar Series II Silver") so all years appear.
    let trackerSeries = pcgs.series || identification.parsed?.series || '';
    if (isLunarCoin && coinYear && (hasPerthContext || hasAustralianContext)) {
      const { label: serLabel } = perthLunarSeries(coinYear);
      if (serLabel) {
        const metalToken = expectedMetal || 'silver';
        trackerSeries = `Perth Lunar ${serLabel} ${metalToken}`;
      }
    }

    // ── Precious metal content cross-check ──
    // Fetch spot price so the eBay filter can sanity-check bullion comps
    // against melt value (both fractional AND full-oz).  Non-fatal -- skip if unavailable.
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
    // Sets (proof/mint) and rolls are never graded — pass null so all comps are used.
    let userGrade = (isSet || isRoll) ? null : (coinData?.grade || identification.parsed?.grade || null);

    // Detect if this is a bullion coin ( values track metal spot price → steeper recency)
    const seriesForBullion = (identification.parsed?.series || pcgs.series || '').toLowerCase();
    const isBullion = BULLION_1OZ_DEFAULT.some(b => seriesForBullion.includes(b));

    // #162: World bullion BU fix — "BU" expands to MS60/MS63/MS65/MS67 via
    // pcgsService.parseDescription, but for bullion coins BU means "raw mint-sealed",
    // not a PCGS-graded slab. Passing the expanded grade triggers graded pool
    // selection + gradeNumMismatch filter, killing 50-90% of valid raw comps.
    // Null it out so valuation uses the raw pool.
    if (isBullion && userGrade && identification.parsed?._gradeSource === 'bu-term') {
      userGrade = null;
    }

    // ── 5a. Greysheet wholesale price lookup ──
    // Use PCGS number if available; non-fatal if unavailable or API not configured.
    // When no PCGS number (generic / yearless coin), fall back to Type GSID lookup.
    const pcgsNo = pcgs?.pcgsCoinNumber || pcgs?.pcgsNo || coinData?.pcgsNumber || null;
    const gradeNum = userGrade ? parseInt(String(userGrade).replace(/[^\d]/g, ''), 10) || null : null;
    let greysheet = pcgsNo ? await greysheetService.fetchPriceByPcgsNumber(pcgsNo, gradeNum) : null;
    if (!greysheet) {
      const parsedMetal = identification.parsed?.metal || null;
      const parsedFinishForGs = coinData?.finish || identification.parsed?.finish || (expected.isProof ? 'Proof' : null);
      greysheet = await greysheetService.fetchTypePrice(String(query), gradeNum, {
        series: identification.parsed?.series || pcgs.series || '',
        metal: parsedMetal,
        weight: resolvedWeight,
        finish: parsedFinishForGs,
      });
    }

    // Piggyback: record Greysheet snapshot for history charting (zero extra API calls)
    if (greysheet && (greysheet.greyVal || greysheet.cpgVal)) {
      const gsHistKey = greysheetHistory.makeKey(
        pcgsNo || greysheet.gsid,
        gradeNum
      );
      greysheetHistory.recordSnapshot(gsHistKey, greysheet.greyVal, greysheet.cpgVal);
    }

    // ── Enrich pcgs.auction with cached APR data (richer than CoinFacts AuctionList) ──
    if (pcgsNo && gradeNum) {
      const aprData = auctionPriceService.getHistory(pcgsNo, gradeNum);
      if (aprData.stats.count > (pcgs.auction?.count || 0)) {
        pcgs.auction = { ...aprData.stats, trend: auctionPriceService.computeTrend(aprData.records) };
      }
    }

    // #156: Auto-derive COA/Box appeal multiplier when not explicitly set by user
    let resolvedAppeal = appealMultiplier;
    if (resolvedAppeal <= 1.0) {
      const hasCoa = coinData?.coa === 'Y' || coinData?.coa === true || /\bCOA=Y\b/i.test(String(query));
      const hasBox = coinData?.originalBox === 'Y' || coinData?.originalBox === true;
      if (hasCoa && hasBox) resolvedAppeal = 1.10;
      else if (hasCoa || hasBox) resolvedAppeal = 1.05;
    }

    const { valuation, decisions } = computeValuation(pcgs, ebay, askingPrice || null, userGrade, {
      isBullion,
      isProof: expected.isProof,
      greysheet,
      saleContext,
      appealMultiplier: resolvedAppeal,
      spotPrice: (isBullion && expected.meltPerOz && resolvedWeight)
        ? expected.meltPerOz * resolvedWeight
        : null,
      // #232 -- gate Greysheet/CPG dollar amounts and other licensed/competitive
      // detail to admins; anonymous + standard users see sanitized reasoning.
      audience: req.isAdmin ? 'admin' : 'public',
    });

    // ── 5b. Runtime series integrity guardrail ──
    // Detect if PCGS resolved to a conflicting series (e.g., query="Jefferson"
    // but PCGS returned "Buffalo"). If so, log a warning and null out the
    // untrusted PCGS data to prevent cross-series contamination in the response.
    {
      const querySeries = identification.parsed?.series || '';
      const pcgsSeries  = pcgs.series || '';
      if (querySeries && pcgsSeries && hasSeriesConflict(querySeries, pcgsSeries)) {
        console.warn(`[guardrail] Series conflict: query="${querySeries}" vs pcgs="${pcgsSeries}" — nulling PCGS data`);
        pcgs.series = querySeries;  // override to match query intent
        pcgs.priceGuide = null;
        pcgs.auction = null;
        pcgs.trueViewUrl = null;
        pcgs.coinImages = [];
        pcgs.pcgsCoinNumber = null;
        pcgs._seriesConflictOverride = true;
        valuation.explanation.push(`⚠ PCGS series conflict detected (resolved "${pcgsSeries}" vs query "${querySeries}") — PCGS data excluded.`);
      }
      // Also check denomination mismatch
      const queryDenom = detectDenomination(querySeries);
      const pcgsDenom  = detectDenomination(pcgsSeries);
      if (queryDenom && pcgsDenom && queryDenom !== pcgsDenom) {
        console.warn(`[guardrail] Denomination conflict: query="${queryDenom}" vs pcgs="${pcgsDenom}"`);
        valuation.explanation.push(`⚠ Denomination mismatch detected (query="${queryDenom}" vs pcgs="${pcgsDenom}").`);
      }
    }

    // ── 5a. Numista Catalogue Lookup (non-blocking) ──
    // Enrich the response with Numista rarity index, prices, composition, and references.
    // Skip for sets and rolls — Numista catalogues individual coin types, not
    // multi-coin sets or roll quantities, and searches for them return wrong matches
    // (e.g. a Lincoln Cent when the user searched "US Mint Set").
    let numista = null;
    if (isSet) {
      numista = { accessible: true, type: null, issue: null, rarity: null, numistaUrl: null, prices: null, composition: null, references: null, limitations: ['Numista lookup skipped for mint/proof sets (sets are not individual coin types)'] };
    } else if (isRoll) {
      numista = { accessible: true, type: null, issue: null, rarity: null, numistaUrl: null, prices: null, composition: null, references: null, limitations: ['Numista lookup skipped for roll searches'] };
    } else {
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
    } // end else (not set/roll)

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
      const mintFinish = coinData?.finish || identification.parsed?.finish || (expected.isProof ? 'Proof' : null);
      const staticLookup = lookupMintage(mintSeries, mintYear, mintMark, mintWeight, mintFinish);
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

    // ── Roll / tube enrichment ──
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

    // ── Response ──
    return res.json(redactCompsForPublic({
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
      spotPrice: spotStale ? { stale: true, asOf: spotAsOf } : undefined,
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
      valuation,
      decisions,
      rollInfo: rollInfo || undefined,
      adjacentYears: buildAdjacentYearContext(
        pcgs.series || identification.parsed?.series,
        pcgs.year || identification.parsed?.year,
        identification.parsed?.metal,
        valuation.compCount || 0
      ),
      numista: numista || null,
      reproducibility,
      trackerSeries: trackerSeries || null,
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
    }, req.isAdmin === true));
  } catch (err) {
    console.error('[/api/price] Unhandled error:', err.message);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

module.exports = router;
