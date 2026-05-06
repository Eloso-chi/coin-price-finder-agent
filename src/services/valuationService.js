// src/services/valuationService.js — FMV estimation + dealer buy/sell decisions
// CommonJS

const stats = require('../utils/stats');

/**
 * Compute FMV and dealer decisions from PCGS data + eBay comps + Greysheet.
 *
 * @param {object} pcgs       – pcgsService result
 * @param {object} ebay       – ebayService result  { us, global, usedFallback }
 * @param {number|null} askingPrice
 * @param {string|null} userGrade – grade FROM USER INPUT (not PCGS-resolved)
 * @param {object} [opts]     – { isBullion: boolean, greysheet: object|null, spotPrice: number|null, saleContext: string }
 * @returns {object} { valuation, decisions }
 */
function computeValuation(pcgs, ebay, askingPrice = null, userGrade = null, opts = {}) {
  const isCertified = !!(pcgs?.verified);
  const explanation = [];

  // ── Gather eBay comps and separate graded vs raw pools ──
  const usCompsAll = ebay?.us?.comps || [];
  const glCompsAll = ebay?.global?.comps || [];
  const usedFallback = ebay?.usedFallback || false;

  // Determine if user wants graded or raw comps
  // Use the explicit user-supplied grade, NOT the PCGS-resolved grade.
  // pcgs.grade can be set by PCGS Search API even when the user didn't
  // specify a grade, which would incorrectly filter to graded comps.
  const wantsGraded = !!(userGrade);
  const wantsProof = wantsGraded && /^(proof|pr|pf)$/i.test(String(userGrade || '').trim());

  const usGraded = usCompsAll.filter(c => c.gradeType === 'graded');
  const usRaw    = usCompsAll.filter(c => c.gradeType === 'raw');
  const usProof  = usCompsAll.filter(c => c.gradeType === 'proof');
  const glGraded = glCompsAll.filter(c => c.gradeType === 'graded');
  const glRaw    = glCompsAll.filter(c => c.gradeType === 'raw');
  const glProof  = glCompsAll.filter(c => c.gradeType === 'proof');

  // Pick the pool matching user intent (need >= 3 comps to be usable)
  let usComps, glComps;
  let poolFallback = false;
  if (wantsProof) {
    // User explicitly wants proof coins — use proof pool, fall back to all
    usComps = usProof.length >= 3 ? usProof : usCompsAll;
    glComps = glProof.length >= 3 ? glProof : glCompsAll;
    if (usProof.length >= 3) {
      const excluded = usCompsAll.length - usProof.length;
      if (excluded > 0) explanation.push(`Using ${usProof.length} proof comps for FMV (${excluded} non-proof comps excluded).`);
    } else {
      explanation.push(`Only ${usProof.length} proof comps — using all ${usCompsAll.length} comps.`);
    }
  } else if (wantsGraded) {
    usComps = usGraded.length >= 3 ? usGraded : usCompsAll;
    glComps = glGraded.length >= 3 ? glGraded : glCompsAll;
    // #176: Pool fallback — if graded pool has fewer than 5 SOLD comps but
    // raw pool has significantly more sold data, prefer raw over a thin/Browse
    // graded pool.  Terapeak sold data is always more reliable than Browse API
    // asking prices or a tiny graded sample.
    const gradedSold = usComps.filter(c => c._source === 'terapeak' || c._source === 'finding');
    const rawSold = usRaw.filter(c => c._source === 'terapeak' || c._source === 'finding');
    if (gradedSold.length < 5 && rawSold.length >= 10) {
      usComps = usRaw;
      glComps = glRaw.length >= 3 ? glRaw : glCompsAll;
      poolFallback = true;
      explanation.push(`⚠ Only ${gradedSold.length} sold graded comps — using ${rawSold.length} raw sold comps for more reliable FMV.`);
    } else if (gradedSold.length === 0 && usRaw.length >= 5) {
      usComps = usRaw;
      glComps = glRaw.length >= 3 ? glRaw : glCompsAll;
      poolFallback = true;
      explanation.push(`⚠ No sold graded comps — using ${usRaw.length} raw comps instead of asking-price fallback.`);
    } else if (usGraded.length >= 3 && usRaw.length > 0) {
      explanation.push(`Using ${usGraded.length} graded comps for FMV (${usRaw.length} raw comps excluded).`);
    } else if (usRaw.length > 0 && usGraded.length < 3) {
      explanation.push(`Only ${usGraded.length} graded comps — using all ${usCompsAll.length} comps (may include raw).`);
    }
  } else {
    usComps = usRaw.length >= 3 ? usRaw : usCompsAll;
    glComps = glRaw.length >= 3 ? glRaw : glCompsAll;
    if (usRaw.length >= 3 && (usGraded.length > 0 || usProof.length > 0)) {
      const excluded = usGraded.length + usProof.length;
      explanation.push(`Using ${usRaw.length} raw comps for FMV (${excluded} graded/proof comps excluded).`);
    } else if ((usGraded.length > 0 || usProof.length > 0) && usRaw.length < 3) {
      explanation.push(`Only ${usRaw.length} raw comps — using all ${usCompsAll.length} comps (may include graded/proof).`);
    }
  }

  const usPrices  = usComps.map(c => c.totalUsd).filter(p => p != null);
  const glPrices  = glComps.map(c => c.totalUsd).filter(p => p != null);

  // Weighted median using match-score based weights + recency
  const isBullion = !!(opts.isBullion);
  const usWM   = computeWeightedMedian(usComps, { isBullion });
  const glWM   = computeWeightedMedian(glComps, { isBullion });
  const usMed  = stats.median(usPrices);
  const glMed  = stats.median(glPrices);

  const ebayMedian = usWM || usMed || glWM || glMed;

  // ── Gather PCGS guide ──
  const pcgsGuide    = pcgs?.priceGuide?.valueUsd || null;
  const auctionMedian = pcgs?.auction?.medianUsd || null;

  // ── Gather Greysheet wholesale ──
  const gsData = opts.greysheet || null;
  const greysheetVal = gsData?.greyVal || null;

  // #54: Greysheet wholesale-to-retail spread as liquidity signal
  // Narrow spread = liquid (easy to buy/sell), wide = illiquid (hard to sell)
  const gsSpreadPct = (gsData?.greyVal > 0 && gsData?.cpgVal > 0)
    ? +((gsData.cpgVal - gsData.greyVal) / gsData.greyVal * 100).toFixed(1)
    : null;

  // ── Spot price for bullion premium calculation ──
  const spotPrice = opts.spotPrice || null;

  // ── Blend ──
  let fmv = null;
  let method;

  // #53: Bullion spot+premium FMV mode.
  // For bullion coins where we have both a spot price and eBay comps,
  // derive the current market premium from comps and anchor FMV to live spot.
  // This tracks metal price moves instantly instead of lagging with 30-day median.
  if (isBullion && spotPrice > 0 && ebayMedian != null && ebayMedian > spotPrice * 0.5) {
    const rawPremium = (ebayMedian - spotPrice) / spotPrice;
    // Clamp premium to reasonable bounds: -5% to +100% for silver, -5% to +40% for gold
    // (gold premiums are tighter; silver rounds/bars can carry 20-80% retail premium)
    const maxPremium = spotPrice > 500 ? 0.40 : 1.00;  // gold threshold ~$500/oz
    const premiumPct = Math.max(-0.05, Math.min(rawPremium, maxPremium));
    fmv = spotPrice * (1 + premiumPct);
    method = 'bullion-spot-premium';

    explanation.push(
      `Bullion spot+premium: spot $${spotPrice.toFixed(2)}, `
      + `comp-derived premium ${(premiumPct * 100).toFixed(1)}%, `
      + `FMV = $${fmv.toFixed(2)}. `
      + `(eBay median $${ebayMedian.toFixed(2)} used to derive premium.)`
    );

    // If Greysheet is available, blend it in at 15% weight for a reality check
    if (greysheetVal != null) {
      fmv = fmv * 0.85 + greysheetVal * 0.15;
      explanation.push(`Greysheet blend: 85% spot-premium + 15% wholesale ($${greysheetVal.toFixed(2)}).`);
    }
  }
  // #51: Dynamic weights based on grade tier.
  // High-grade coins (MS67+) trade at auction, not eBay commodity market.
  // Low-grade / raw coins are best reflected by eBay street prices.
  // Skip if bullion spot+premium mode already computed FMV above.
  if (fmv == null) {
  const gradeNum = parseGradeNumber(userGrade);
  const gradeTier = getGradeTier(gradeNum, isCertified);

  if (isCertified) {
    const weights = GRADE_WEIGHTS[gradeTier] || GRADE_WEIGHTS.mid;
    const available = {};
    if (ebayMedian != null) available.ebay = ebayMedian;
    if (pcgsGuide != null) available.pcgs = pcgsGuide;
    if (auctionMedian != null) available.auction = auctionMedian;
    if (greysheetVal != null) available.greysheet = greysheetVal;

    fmv = blendSources(available, weights);
    method = 'certified-blend';

    const pct = (k) => Math.round(weights[k] * 100);
    const usedSources = Object.keys(available).join('+');
    explanation.push(`Certified coin blend (${usedSources}), grade tier: ${gradeTier}. Weights: eBay ${pct('ebay')}%, PCGS Guide ${pct('pcgs')}%, Auction ${pct('auction')}%, Greysheet ${pct('greysheet')}%.`);
  } else {
    // Raw coin: eBay 70% + PCGS 10% + Greysheet 20%
    // If Greysheet unavailable, weights renormalize to eBay 80/PCGS 20
    const weights = { ebay: 0.70, pcgs: 0.10, greysheet: 0.20 };
    const available = {};
    if (ebayMedian != null) available.ebay = ebayMedian;
    if (pcgsGuide != null) available.pcgs = pcgsGuide;
    if (greysheetVal != null) available.greysheet = greysheetVal;

    fmv = blendSources(available, weights);
    method = 'raw-blend';
    explanation.push(`Raw coin blend. Base weights: eBay 70%, PCGS 10%, Greysheet 20%.`);
  }
  } // end if (fmv == null) — bullion spot+premium may have set it above

  if (fmv == null) {
    explanation.push('NO DATA: unable to compute FMV — no comps or guide prices available.');
    return {
      valuation: { fmvCore: null, rangeLow: null, rangeHigh: null, confidence: 0, explanation },
      decisions: _emptyDecisions(askingPrice)
    };
  }

  fmv = +fmv.toFixed(2);

  // #56: Toning / visual appeal multiplier.
  // Coins with exceptional toning or eye appeal command premiums above
  // raw market value.  Clamped to [1.0, 2.0] to prevent abuse.
  const appealMultiplier = Math.min(2.0, Math.max(1.0, Number(opts.appealMultiplier) || 1.0));
  if (appealMultiplier > 1.0) {
    fmv = +(fmv * appealMultiplier).toFixed(2);
    explanation.push(`🎨 Appeal multiplier ${appealMultiplier.toFixed(2)}× applied (toning/eye appeal premium).`);
  }

  // ── Data source analysis ──
  // Count how many comps are actual sold vs active-for-sale (Browse API)
  const soldComps = usComps.filter(c => c._source !== 'browse');
  const activeComps = usComps.filter(c => c._source === 'browse');
  const terapeakComps = usComps.filter(c => c._source === 'terapeak');
  const soldCount = soldComps.length;
  const activeCount = activeComps.length;
  const terapeakCount = terapeakComps.length;
  const totalComps = usComps.length;
  const soldRatio = totalComps > 0 ? soldCount / totalComps : 0;
  // If all or most comps are active listings, flag it
  const browseOnly = soldCount === 0 && activeCount > 0;
  const mostlyBrowse = soldRatio < 0.3 && activeCount > 0;

  if (terapeakCount > 0) {
    explanation.push(`${terapeakCount} Terapeak sold comps used (verified eBay sales data).`);
  }
  if (greysheetVal != null) {
    explanation.push(`Greysheet wholesale: $${greysheetVal.toFixed(2)}${gsData.cpgVal ? ` (retail CPG: $${gsData.cpgVal.toFixed(2)})` : ''}.`);
  }
  if (isBullion) {
    explanation.push('Bullion coin — using steeper recency weighting (30-day half-life) to track metal price shifts.');
  }
  if (browseOnly) {
    explanation.push('⚠ ALL comps are active listings (asking prices) — no verified sold data available. FMV is estimated from for-sale prices and may be inflated.');
  } else if (mostlyBrowse) {
    explanation.push(`⚠ Only ${soldCount} of ${totalComps} comps are sold — ${activeCount} are active listings (asking prices). FMV may be less reliable.`);
  } else if (soldCount > 0 && terapeakCount === 0) {
    explanation.push(`${soldCount} sold comps used for valuation.`);
  }

  // ── Confidence ──
  const isBar = !!(pcgs?._isBar);
  const pcgsFound = !!(pcgs?.pcgsNo || pcgs?.verified || pcgsGuide != null);
  // #159: Extract filter attrition from eBay tier results
  const usAttritionPct = ebay?.us?.attritionPct ?? null;
  const confidence = computeConfidence({
    verified: isCertified,
    usCompCount: usPrices.length,
    glCompCount: glPrices.length,
    dispersion: usPrices.length >= 2 ? stats.stddev(usPrices) / (usMed || 1) : 1,
    avgMatchScore: usComps.length ? usComps.reduce((s, c) => s + (c.matchScore || 50), 0) / usComps.length : 50,
    usedFallback,
    hasPcgsGuide: pcgsGuide != null,
    hasAuction: auctionMedian != null,
    hasGreysheet: greysheetVal != null,
    isBar,
    pcgsFound,
    browseOnly,
    soldRatio,
    population: pcgs?.population?.thisGrade ?? null,
    greysheetSpreadPct: gsSpreadPct,
    filterAttritionPct: usAttritionPct,
    poolFallback,
  });
  explanation.push(`Confidence ${confidence}/100.`);

  // #159: High attrition explanation
  if (usAttritionPct != null && usAttritionPct > 50) {
    explanation.push(`\u26a0 High filter attrition (${usAttritionPct}% of gathered comps removed) -- query may be too broad.`);
  }

  // #50: Low-pop explanation
  const popGrade = pcgs?.population?.thisGrade;
  if (popGrade != null && popGrade < 200 && !isBar) {
    explanation.push(`⚠ Low population (${popGrade}) — thin market, confidence reduced.`);
  }

  if (usedFallback && !browseOnly) {
    explanation.push('⚠ US comps below threshold; global/Browse API data used — confidence reduced.');
  }

  // ── Range ──
  const sd = usPrices.length >= 2 ? stats.stddev(usPrices) : (fmv * 0.10);
  const margin = Math.max(sd, fmv * 0.05);
  const rangeLow  = +Math.max(0, fmv - margin).toFixed(2);
  const rangeHigh = +(fmv + margin).toFixed(2);

  // ── Buy / Sell decisions ──
  // #52: Sliding buy spread — higher-value coins need tighter margins.
  const { low: buyLow, mid: buyMid, high: buyHigh, recLabel } = buySpreadForValue(fmv);

  // #55: Sale context adjustment.
  // eBay prices include ~13% platform friction (fees + shipping).
  // LCS/Private = no platform friction → buy thresholds shift up, sell estimates shift down.
  // Dealer Wholesale = buying at wholesale → buy thresholds shift down significantly.
  const saleContext = opts.saleContext || 'ebay';
  const CONTEXT_ADJUSTMENTS = {
    'ebay':      { buyAdj: 0,     sellAdj: 0,     label: 'eBay Retail' },
    'private':   { buyAdj: 0.07,  sellAdj: -0.10, label: 'LCS / Private Sale' },
    'wholesale': { buyAdj: -0.10, sellAdj: -0.20, label: 'Dealer Wholesale' },
  };
  const ctxAdj = CONTEXT_ADJUSTMENTS[saleContext] || CONTEXT_ADJUSTMENTS['ebay'];

  const maxLow  = +(fmv * Math.min(buyLow + ctxAdj.buyAdj, 0.99)).toFixed(2);
  const maxMid  = +(fmv * Math.min(buyMid + ctxAdj.buyAdj, 0.99)).toFixed(2);
  const maxHigh = +(fmv * Math.min(buyHigh + ctxAdj.buyAdj, 0.99)).toFixed(2);

  const buyNotes = [];
  let recommendation = null;
  if (askingPrice != null) {
    if (askingPrice <= maxMid) { recommendation = 'BUY'; buyNotes.push(`Asking $${askingPrice} <= ${Math.round(buyMid * 100)}% FMV ($${maxMid}).`); }
    else if (askingPrice <= maxHigh) { recommendation = 'BUY'; buyNotes.push(`Asking $${askingPrice} <= ${Math.round(buyHigh * 100)}% FMV ($${maxHigh}) -- thin margin.`); }
    else { recommendation = 'PASS'; buyNotes.push(`Asking $${askingPrice} > ${Math.round(buyHigh * 100)}% FMV ($${maxHigh}).`); }
  }
  if (recLabel) buyNotes.push(recLabel);

  const medForSell = (ebayMedian ? ebayMedian * appealMultiplier : fmv);
  const p25 = usPrices.length >= 4 ? stats.percentile(usPrices, 25) : medForSell * 0.92;
  const isScarcePop = pcgs?.population?.thisGrade != null && pcgs.population.thisGrade < 200;

  const sellNotes = [];
  const premiumMult = isScarcePop ? 1.15 : 1.05;
  if (isScarcePop) sellNotes.push(`Low population (${pcgs.population.thisGrade}) supports premium pricing.`);

  const fast    = +(medForSell * (0.92 + ctxAdj.sellAdj)).toFixed(2);
  const normal  = +(medForSell * (1.00 + ctxAdj.sellAdj)).toFixed(2);
  const premium = +(medForSell * (premiumMult + ctxAdj.sellAdj)).toFixed(2);
  const offerFloor = +Math.min(p25 * (1 + ctxAdj.sellAdj), medForSell * (0.92 + ctxAdj.sellAdj)).toFixed(2);

  return {
    valuation: {
      fmvCore: fmv,
      rangeLow,
      rangeHigh,
      confidence,
      lowData: soldCount < 3,
      compCount: soldCount,
      explanation,
      dataSource: {
        soldCount,
        activeCount,
        totalComps,
        soldRatio: +soldRatio.toFixed(2),
        browseOnly,
        label: browseOnly ? 'asking-prices-only' : mostlyBrowse ? 'mostly-asking' : 'sold-data'
      },
      gradePool: {
        wantsGraded,
        wantsProof,
        usedPool: poolFallback ? 'raw (fallback)' : wantsProof ? 'proof' : wantsGraded ? 'graded' : 'raw',
        gradedCount: usGraded.length,
        rawCount: usRaw.length,
        proofCount: usProof.length,
        poolCount: usComps.length,
        totalCount: usCompsAll.length,
        poolFallback,
      },
      method,
      saleContext: ctxAdj.label,
      appealMultiplier: appealMultiplier > 1.0 ? appealMultiplier : null,
      greysheetSpread: gsSpreadPct != null ? {
        spreadPct: gsSpreadPct,
        liquidity: gsSpreadPct <= 15 ? 'high' : gsSpreadPct <= 30 ? 'moderate' : 'low',
        wholesale: gsData.greyVal,
        retail: gsData.cpgVal
      } : null,
      bullionSpot: method === 'bullion-spot-premium' ? {
        spotPrice: +spotPrice.toFixed(2),
        premiumPct: +((fmv / spotPrice - 1) * 100).toFixed(1),
        ebayMedian: +ebayMedian.toFixed(2),
      } : null
    },
    decisions: {
      buy: {
        max70: maxLow,
        max75: maxMid,
        max80: maxHigh,
        spreadTier: { low: buyLow, mid: buyMid, high: buyHigh },
        askingPrice: askingPrice || null,
        recommendation,
        notes: buyNotes
      },
      sell: {
        fast,
        normal,
        premium,
        offerFloor,
        notes: sellNotes
      }
    }
  };
}

// ── Helpers ─────────────────────────────────────────────────

// ── #51: Grade-tier weight tables for certified coins ───────
// High-grade coins (MS67+) trade at auction houses, not eBay commodity market.
// Low-grade circulated coins are best reflected by eBay street prices.
const GRADE_WEIGHTS = {
  low:  { ebay: 0.65, pcgs: 0.10, auction: 0.05, greysheet: 0.20 },
  mid:  { ebay: 0.55, pcgs: 0.15, auction: 0.10, greysheet: 0.20 },
  high: { ebay: 0.30, pcgs: 0.20, auction: 0.25, greysheet: 0.25 },
};

function parseGradeNumber(gradeStr) {
  if (!gradeStr) return null;
  const m = String(gradeStr).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function getGradeTier(gradeNum, isCertified) {
  if (!isCertified || gradeNum == null) return 'mid';
  if (gradeNum >= 67) return 'high';
  if (gradeNum <= 58) return 'low';   // AU58 and below
  return 'mid';                       // MS60-MS66
}

// ── #52: Sliding buy spread based on FMV value ──────────────
// Higher-value coins need tighter dealer margins — no one buys a $10k coin at 70%.
// Returns { low, mid, high } as decimal multipliers and a label.
function buySpreadForValue(fmv) {
  if (fmv <= 50)   return { low: 0.60, mid: 0.70, high: 0.75, recLabel: 'Buy spread: standard (FMV under $50).' };
  if (fmv <= 200)  return { low: 0.70, mid: 0.75, high: 0.80, recLabel: null };
  if (fmv <= 1000) return { low: 0.75, mid: 0.80, high: 0.85, recLabel: 'Buy spread: tightened for $200-$1k range.' };
  if (fmv <= 5000) return { low: 0.80, mid: 0.85, high: 0.90, recLabel: 'Buy spread: tight for $1k-$5k range.' };
  return              { low: 0.85, mid: 0.90, high: 0.95, recLabel: 'Buy spread: very tight for $5k+ range.' };
}

/**
 * Blend available sources with fallback weight renormalization.
 */
function blendSources(available, defaultWeights) {
  const keys = Object.keys(available);
  if (!keys.length) return null;
  let totalW = 0;
  let sum = 0;
  for (const k of keys) totalW += defaultWeights[k] || 0;
  if (totalW === 0) totalW = keys.length; // equal weight fallback
  for (const k of keys) {
    const w = (defaultWeights[k] || 0) / totalW;
    sum += available[k] * w;
  }
  return sum;
}

/**
 * Compute weighted median of comps using matchScore + recency.
 * Bullion coins use a steeper recency curve (30-day half-life vs 90-day)
 * because their values track underlying spot metal prices.
 */
function computeWeightedMedian(comps, { isBullion = false } = {}) {
  const valid = comps.filter(c => c.totalUsd != null);
  if (!valid.length) return null;

  // Bullion half-life: 30 days (rapid metal price tracking)
  // Numismatic half-life: 90 days (slower collector-market shifts)
  const halfLifeDays = isBullion ? 30 : 90;

  const now = Date.now();
  const values = [];
  const weights = [];
  for (const c of valid) {
    const daysSince = c.soldDate
      ? Math.max(1, (now - new Date(c.soldDate).getTime()) / 86_400_000)
      : 30;
    const recencyW = 1 / (1 + daysSince / halfLifeDays);
    const matchW = (c.matchScore || 50) / 100;
    values.push(c.totalUsd);
    weights.push(recencyW * matchW);
  }
  return stats.weightedMedian(values, weights);
}

/**
 * Scaled fallback penalty based on US comp count.
 * Strong sample (30+) = no penalty, decent (15-29) = half, weak (<15) = full.
 */
function fallbackPenalty(usCompCount) {
  if (usCompCount >= 30) return 0;
  if (usCompCount >= 15) return -7;
  return -15;
}

/**
 * Confidence 0–100.
 * When isBar is true, PCGS-related factors are redistributed to
 * sample size, dispersion, and match quality — things that matter for
 * commodity bullion.
 */
function computeConfidence({ verified, usCompCount, glCompCount, dispersion, avgMatchScore, usedFallback, hasPcgsGuide, hasAuction, hasGreysheet, isBar, pcgsFound, browseOnly, soldRatio, population, greysheetSpreadPct, filterAttritionPct, poolFallback }) {
  let c = 0;

  if (isBar) {
    // ── Bar scoring (no PCGS axis) ──────────────────────────
    c += Math.min(usCompCount / 12, 1) * 35;   // Sample size (up to 35 pts)
    c += Math.max(0, 1 - Math.min(dispersion, 1)) * 25; // Low dispersion (up to 25 pts)
    c += (avgMatchScore / 100) * 25;            // Match quality (up to 25 pts)
    if (usCompCount >= 20) c += 15;             // Sufficient comps bonus
    if (usedFallback) c -= 5;                   // Mild fallback penalty
    if (usCompCount < 5) c -= 10;
  } else if (!pcgsFound) {
    // ── Non-PCGS coin (foreign, tokens, etc.) ───────────────
    // PCGS doesn't cover this coin — redistribute PCGS pts
    // to sample size and match quality.
    c += Math.min(usCompCount / 15, 1) * 40;   // Sample size (up to 40 pts)
    c += Math.max(0, 1 - Math.min(dispersion, 1)) * 20; // Low dispersion (up to 20 pts)
    c += (avgMatchScore / 100) * 25;            // Match quality (up to 25 pts)
    if (usCompCount >= 20) c += 10;             // Sufficient comps bonus
    if (hasAuction) c += 5;
    if (usedFallback) c += fallbackPenalty(usCompCount);
    if (usCompCount < 5) c -= 10;
  } else {
    // ── Coin scoring (PCGS-covered) ─────────────────────────
    c += Math.min(usCompCount / 15, 1) * 30;   // Sample size (up to 30 pts)
    c += Math.max(0, 1 - Math.min(dispersion, 1)) * 20; // Low dispersion (up to 20 pts)
    c += (avgMatchScore / 100) * 15;            // Match quality (up to 15 pts)
    if (verified) c += 10;                      // Verified by PCGS
    if (hasPcgsGuide) c += 10;                  // PCGS guide available
    if (hasAuction) c += 5;
    if (hasGreysheet) c += 5;                    // Greysheet wholesale available
    if (usedFallback) c += fallbackPenalty(usCompCount);
    if (usCompCount < 5) c -= 10;
  }

  // ── Browse-only penalty: active listings are NOT sold prices ──
  // Asking prices are typically higher than sold prices and less reliable.
  if (browseOnly) {
    // Heavy penalty: all data is from for-sale listings
    c -= 30;
  } else if (soldRatio != null && soldRatio < 0.3) {
    // Mostly active listings, few sold — moderate penalty
    c -= 20;
  } else if (soldRatio != null && soldRatio < 0.6) {
    // Mixed bag — mild penalty
    c -= 10;
  }

  // ── #50: Low-population penalty ──
  // Thin markets mean one outlier sale can dominate the weighted median.
  // Scaled: pop < 50 → -15, pop 50-99 → -10, pop 100-199 → -5
  if (population != null && population < 200 && !isBar) {
    if (population < 50) c -= 15;
    else if (population < 100) c -= 10;
    else c -= 5;
  }

  // ── #54: Greysheet liquidity spread signal ──
  // Narrow wholesale-to-retail spread = liquid market = more reliable FMV.
  // Wide spread = illiquid, harder to sell, less reliable.
  if (greysheetSpreadPct != null) {
    if (greysheetSpreadPct <= 15) c += 5;        // Tight spread -- liquid
    else if (greysheetSpreadPct >= 40) c -= 5;   // Wide spread -- illiquid
  }

  // ── #176: Pool fallback penalty ──
  // When we fell back from graded to raw pool due to insufficient graded sold
  // comps, apply a mild penalty — raw comps are less precise for graded coins.
  if (poolFallback) c -= 10;

  // ── #160: Filter attrition penalty ──
  // High attrition means the query was too broad and surviving comps may be
  // less representative. Penalize confidence proportionally.
  if (filterAttritionPct != null && filterAttritionPct > 50) {
    if (filterAttritionPct > 90) c -= 20;
    else if (filterAttritionPct > 70) c -= 10;
    else c -= 5;  // 50-70%
  }

  return Math.max(0, Math.min(100, Math.round(c)));
}

function _emptyDecisions(askingPrice) {
  return {
    buy: { max70: null, max75: null, max80: null, spreadTier: null, askingPrice: askingPrice || null, recommendation: null, notes: ['Insufficient data'] },
    sell: { fast: null, normal: null, premium: null, offerFloor: null, notes: ['Insufficient data'] }
  };
}

module.exports = { computeValuation };
