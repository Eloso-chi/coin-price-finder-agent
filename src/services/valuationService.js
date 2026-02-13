// src/services/valuationService.js — FMV estimation + dealer buy/sell decisions
// CommonJS

const stats = require('../utils/stats');

/**
 * Compute FMV and dealer decisions from PCGS data + eBay comps.
 *
 * @param {object} pcgs       – pcgsService result
 * @param {object} ebay       – ebayService result  { us, global, usedFallback }
 * @param {number|null} askingPrice
 * @param {string|null} userGrade – grade FROM USER INPUT (not PCGS-resolved)
 * @returns {object} { valuation, decisions }
 */
function computeValuation(pcgs, ebay, askingPrice = null, userGrade = null) {
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

  const usGraded = usCompsAll.filter(c => c.gradeType === 'graded');
  const usRaw    = usCompsAll.filter(c => c.gradeType !== 'graded');
  const glGraded = glCompsAll.filter(c => c.gradeType === 'graded');
  const glRaw    = glCompsAll.filter(c => c.gradeType !== 'graded');

  // Pick the pool matching user intent (need >= 3 comps to be usable)
  let usComps, glComps;
  if (wantsGraded) {
    usComps = usGraded.length >= 3 ? usGraded : usCompsAll;
    glComps = glGraded.length >= 3 ? glGraded : glCompsAll;
    if (usGraded.length >= 3 && usRaw.length > 0) {
      explanation.push(`Using ${usGraded.length} graded comps for FMV (${usRaw.length} raw comps excluded).`);
    } else if (usRaw.length > 0 && usGraded.length < 3) {
      explanation.push(`Only ${usGraded.length} graded comps — using all ${usCompsAll.length} comps (may include raw).`);
    }
  } else {
    usComps = usRaw.length >= 3 ? usRaw : usCompsAll;
    glComps = glRaw.length >= 3 ? glRaw : glCompsAll;
    if (usRaw.length >= 3 && usGraded.length > 0) {
      explanation.push(`Using ${usRaw.length} raw comps for FMV (${usGraded.length} graded comps excluded).`);
    } else if (usGraded.length > 0 && usRaw.length < 3) {
      explanation.push(`Only ${usRaw.length} raw comps — using all ${usCompsAll.length} comps (may include graded).`);
    }
  }

  const usPrices  = usComps.map(c => c.totalUsd).filter(p => p != null);
  const glPrices  = glComps.map(c => c.totalUsd).filter(p => p != null);

  // Weighted median using match-score based weights + recency
  const usWM   = computeWeightedMedian(usComps);
  const glWM   = computeWeightedMedian(glComps);
  const usMed  = stats.median(usPrices);
  const glMed  = stats.median(glPrices);

  const ebayMedian = usWM || usMed || glWM || glMed;

  // ── Gather PCGS guide ──
  const pcgsGuide    = pcgs?.priceGuide?.valueUsd || null;
  const auctionMedian = pcgs?.auction?.medianUsd || null;

  // ── Blend ──
  let fmv = null;
  let method;

  if (isCertified) {
    // Certified default: 0.65 eBay + 0.25 PCGS Guide + 0.10 Auction
    const weights = { ebay: 0.65, pcgs: 0.25, auction: 0.10 };
    const available = {};
    if (ebayMedian != null) available.ebay = ebayMedian;
    if (pcgsGuide != null) available.pcgs = pcgsGuide;
    if (auctionMedian != null) available.auction = auctionMedian;

    fmv = blendSources(available, weights);
    method = 'certified-blend';

    const usedSources = Object.keys(available).join('+');
    explanation.push(`Certified coin blend (${usedSources}). Base weights: eBay 65%, PCGS Guide 25%, Auction 10%.`);
  } else {
    // Raw coin: 0.80 eBay + 0.20 PCGS grade-band midpoint
    const weights = { ebay: 0.80, pcgs: 0.20 };
    const available = {};
    if (ebayMedian != null) available.ebay = ebayMedian;
    if (pcgsGuide != null) available.pcgs = pcgsGuide;

    fmv = blendSources(available, weights);
    method = 'raw-blend';
    explanation.push(`Raw coin blend. Base weights: eBay 80%, PCGS 20%.`);
  }

  if (fmv == null) {
    explanation.push('NO DATA: unable to compute FMV — no comps or guide prices available.');
    return {
      valuation: { fmvCore: null, rangeLow: null, rangeHigh: null, confidence: 0, explanation },
      decisions: _emptyDecisions(askingPrice)
    };
  }

  fmv = +fmv.toFixed(2);

  // ── Confidence ──
  const isBar = !!(pcgs?._isBar);
  const confidence = computeConfidence({
    verified: isCertified,
    usCompCount: usPrices.length,
    glCompCount: glPrices.length,
    dispersion: usPrices.length >= 2 ? stats.stddev(usPrices) / (usMed || 1) : 1,
    avgMatchScore: usComps.length ? usComps.reduce((s, c) => s + (c.matchScore || 50), 0) / usComps.length : 50,
    usedFallback,
    hasPcgsGuide: pcgsGuide != null,
    hasAuction: auctionMedian != null,
    isBar
  });
  explanation.push(`Confidence ${confidence}/100.`);

  if (usedFallback) {
    explanation.push('⚠ US comps below threshold; global/Browse API data used — confidence reduced.');
  }

  // ── Range ──
  const sd = usPrices.length >= 2 ? stats.stddev(usPrices) : (fmv * 0.10);
  const margin = Math.max(sd, fmv * 0.05);
  const rangeLow  = +Math.max(0, fmv - margin).toFixed(2);
  const rangeHigh = +(fmv + margin).toFixed(2);

  // ── Buy / Sell decisions ──
  const max70 = +(fmv * 0.70).toFixed(2);
  const max75 = +(fmv * 0.75).toFixed(2);
  const max80 = +(fmv * 0.80).toFixed(2);

  const buyNotes = [];
  let recommendation = null;
  if (askingPrice != null) {
    if (askingPrice <= max75) { recommendation = 'BUY'; buyNotes.push(`Asking $${askingPrice} ≤ 75% FMV ($${max75}).`); }
    else if (askingPrice <= max80) { recommendation = 'BUY'; buyNotes.push(`Asking $${askingPrice} ≤ 80% FMV ($${max80}) — thin margin.`); }
    else { recommendation = 'PASS'; buyNotes.push(`Asking $${askingPrice} > 80% FMV ($${max80}).`); }
  }

  const medForSell = ebayMedian || fmv;
  const p25 = usPrices.length >= 4 ? stats.percentile(usPrices, 25) : medForSell * 0.92;
  const isScarcePop = pcgs?.population?.thisGrade != null && pcgs.population.thisGrade < 200;

  const sellNotes = [];
  const premiumMult = isScarcePop ? 1.15 : 1.05;
  if (isScarcePop) sellNotes.push(`Low population (${pcgs.population.thisGrade}) supports premium pricing.`);

  const fast    = +(medForSell * 0.92).toFixed(2);
  const normal  = +medForSell.toFixed(2);
  const premium = +(medForSell * premiumMult).toFixed(2);
  const offerFloor = +Math.min(p25, medForSell * 0.92).toFixed(2);

  return {
    valuation: {
      fmvCore: fmv,
      rangeLow,
      rangeHigh,
      confidence,
      explanation
    },
    decisions: {
      buy: {
        max70,
        max75,
        max80,
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
 */
function computeWeightedMedian(comps) {
  const valid = comps.filter(c => c.totalUsd != null);
  if (!valid.length) return null;

  const now = Date.now();
  const values = [];
  const weights = [];
  for (const c of valid) {
    const daysSince = c.soldDate
      ? Math.max(1, (now - new Date(c.soldDate).getTime()) / 86_400_000)
      : 30;
    const recencyW = 1 / (1 + daysSince / 90);
    const matchW = (c.matchScore || 50) / 100;
    values.push(c.totalUsd);
    weights.push(recencyW * matchW);
  }
  return stats.weightedMedian(values, weights);
}

/**
 * Confidence 0–100.
 * When isBar is true, PCGS-related factors are redistributed to
 * sample size, dispersion, and match quality — things that matter for
 * commodity bullion.
 */
function computeConfidence({ verified, usCompCount, glCompCount, dispersion, avgMatchScore, usedFallback, hasPcgsGuide, hasAuction, isBar }) {
  let c = 0;

  if (isBar) {
    // ── Bar scoring (no PCGS axis) ──────────────────────────
    // Sample size (up to 35 pts) — commodity, sample is king
    c += Math.min(usCompCount / 12, 1) * 35;
    // Low dispersion (up to 25 pts) — bars should cluster
    c += Math.max(0, 1 - Math.min(dispersion, 1)) * 25;
    // Match quality (up to 25 pts)
    c += (avgMatchScore / 100) * 25;
    // Sufficient comps bonus (15 pts when ≥ 20)
    if (usCompCount >= 20) c += 15;
    // Fallback penalty (mild — bars are searchable)
    if (usedFallback) c -= 5;
    // Low comps penalty
    if (usCompCount < 5) c -= 10;
  } else {
    // ── Coin scoring (original) ─────────────────────────────
    // Sample size (up to 30 pts)
    c += Math.min(usCompCount / 15, 1) * 30;
    // Low dispersion (up to 20 pts)
    c += Math.max(0, 1 - Math.min(dispersion, 1)) * 20;
    // Match quality (up to 15 pts)
    c += (avgMatchScore / 100) * 15;
    // Verified by PCGS (10 pts)
    if (verified) c += 10;
    // PCGS guide available (10 pts)
    if (hasPcgsGuide) c += 10;
    // Auction data (5 pts)
    if (hasAuction) c += 5;
    // Global fallback penalty
    if (usedFallback) c -= 15;
    // Low comps penalty
    if (usCompCount < 5) c -= 10;
  }

  return Math.max(0, Math.min(100, Math.round(c)));
}

function _emptyDecisions(askingPrice) {
  return {
    buy: { max70: null, max75: null, max80: null, askingPrice: askingPrice || null, recommendation: null, notes: ['Insufficient data'] },
    sell: { fast: null, normal: null, premium: null, offerFloor: null, notes: ['Insufficient data'] }
  };
}

module.exports = { computeValuation };
