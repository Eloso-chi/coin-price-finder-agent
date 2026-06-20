// src/services/valuationService.js -- FMV estimation + dealer buy/sell decisions
// CommonJS

const stats = require('../utils/stats');
const { isReverseProofFinish } = require('../utils/coinIntent');

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

  // #232 (Tier A) -- Audience gating for valuation reasoning.
  // 'admin' callers see full diagnostic detail (exact Greysheet/CPG dollar
  // amounts, comp-derived premium math, source brand names, blend weights).
  // 'public' callers (default) see a sanitized version that does not redistribute
  // licensed wholesale data (CDN/Greysheet TOS) and does not expose source-brand
  // attribution we have a license-restricted relationship with.
  // Tier B (competitive weighting math) is tracked separately in BACKLOG #233.
  const audience = opts.audience === 'admin' ? 'admin' : 'public';
  const isAdmin = audience === 'admin';

  // ── Gather eBay comps and separate graded vs raw pools ──
  const usCompsAll = ebay?.us?.comps || [];
  const glCompsAll = ebay?.global?.comps || [];
  const usedFallback = ebay?.usedFallback || false;

  // Determine if user wants graded or raw comps
  // Use the explicit user-supplied grade, NOT the PCGS-resolved grade.
  // pcgs.grade can be set by PCGS Search API even when the user didn't
  // specify a grade, which would incorrectly filter to graded comps.
  const wantsGraded = !!(userGrade);
  // #184 + #260W: proof / reverse-proof intent detection.  RP is a distinct
  // pool (PR #114).  Gate matches ebayService's pre-filter: RP requires proof
  // intent + RP-matching finish, OR an explicit isReverseProof flag.  RP then
  // suppresses generic proof so RP queries don't double-route.  See ADR or PR
  // body for the contract rationale (review M1).
  const proofIntent = !!(opts.isProof)
    || (wantsGraded && /^(proof|pr|pf)/i.test(String(userGrade || '').trim()));
  const wantsReverseProof = !!(opts.isReverseProof)
    || (proofIntent && isReverseProofFinish(opts.finish));
  const wantsProof = proofIntent && !wantsReverseProof;

  const usGraded   = usCompsAll.filter(c => c.gradeType === 'graded');
  const usRaw      = usCompsAll.filter(c => c.gradeType === 'raw');
  const usProof    = usCompsAll.filter(c => c.gradeType === 'proof');
  const usRevProof = usCompsAll.filter(c => c.gradeType === 'reverse-proof');
  const glGraded   = glCompsAll.filter(c => c.gradeType === 'graded');
  const glRaw      = glCompsAll.filter(c => c.gradeType === 'raw');
  const glProof    = glCompsAll.filter(c => c.gradeType === 'proof');
  const glRevProof = glCompsAll.filter(c => c.gradeType === 'reverse-proof');

  // Pick the pool matching user intent (need >= 3 comps to be usable)
  let usComps, glComps;
  let poolFallback = false;
  if (wantsReverseProof) {
    // #260W: Never mix non-RP comps into reverse-proof FMV -- RP is a
    // distinct product tier (mint-issued separately, often priced 2-5x the
    // regular proof). Mirrors the wantsProof "never mix in raw" rule below.
    // Flag lowData when thin; explain when non-RP comps were excluded.
    usComps = usRevProof;
    glComps = glRevProof;
    if (usRevProof.length === 0) {
      explanation.push(`\u26a0 No reverse-proof comps found -- cannot compute reverse-proof FMV. Proof / BU comps excluded to prevent incorrect valuation.`);
    } else if (usRevProof.length < 3) {
      explanation.push(`\u26a0 Only ${usRevProof.length} reverse-proof comp${usRevProof.length === 1 ? '' : 's'} -- low-data reverse-proof FMV (proof / BU comps excluded).`);
    } else {
      const excluded = usCompsAll.length - usRevProof.length;
      if (excluded > 0) explanation.push(`Using ${usRevProof.length} reverse-proof comps for FMV (${excluded} non-reverse-proof comps excluded).`);
    }
  } else if (wantsProof) {
    // #184: Never mix BU comps into proof FMV -- they are fundamentally different products.
    // Use proof pool regardless of count. Flag lowData when thin.
    usComps = usProof;
    glComps = glProof;
    if (usProof.length === 0) {
      explanation.push(`\u26a0 No proof comps found -- cannot compute proof FMV. BU comps excluded to prevent incorrect valuation.`);
    } else if (usProof.length < 3) {
      explanation.push(`\u26a0 Only ${usProof.length} proof comp${usProof.length === 1 ? '' : 's'} -- low-data proof FMV (BU comps excluded).`);
    } else {
      const excluded = usCompsAll.length - usProof.length;
      if (excluded > 0) explanation.push(`Using ${usProof.length} proof comps for FMV (${excluded} non-proof comps excluded).`);
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

  // Weighted median using match-score based weights + recency.
  // #283H -- pass proof / reverse-proof intent so the recency half-life is
  // computed correctly. Proof / RP bullion is collector-paced (mintage,
  // grade, date desirability) NOT metal-paced -- it must use the 90-day
  // numismatic half-life even though `isBullion` is true. See
  // `computeWeightedMedian` below for the dispatch.
  const isBullion = !!(opts.isBullion);
  const usWM   = computeWeightedMedian(usComps, { isBullion, wantsProof, wantsReverseProof });
  const glWM   = computeWeightedMedian(glComps, { isBullion, wantsProof, wantsReverseProof });
  const usMed  = stats.median(usPrices);
  const glMed  = stats.median(glPrices);

  const ebayMedian = usWM || usMed || glWM || glMed;

  // ── Gather PCGS guide ──
  const pcgsGuide    = pcgs?.priceGuide?.valueUsd || null;
  const auctionMedian = pcgs?.auction?.medianUsd || null;

  // ── Spot price for bullion premium calculation ──
  const spotPrice = opts.spotPrice || null;

  // ── Gather Greysheet wholesale ──
  const gsData = opts.greysheet || null;
  // #188: Discard Greysheet values that are clearly nominal or mismatched for bullion.
  // Guard 1: face value < 1% of spot (catches gold coins returning $2-$6 denom values).
  // Guard 2: GS < 5% of eBay median (catches wrong-coin PCGS number matches on silver).
  const rawGreysheetVal = gsData?.greyVal || null;
  const greysheetVal = (() => {
    if (rawGreysheetVal == null) return null;
    if (isBullion && spotPrice > 0 && rawGreysheetVal < spotPrice * 0.01) return null;
    if (isBullion && ebayMedian > 0 && rawGreysheetVal < ebayMedian * 0.05) return null;
    return rawGreysheetVal;
  })();

  // #54: Greysheet wholesale-to-retail spread as liquidity signal
  // Narrow spread = liquid (easy to buy/sell), wide = illiquid (hard to sell)
  const gsSpreadPct = (gsData?.greyVal > 0 && gsData?.cpgVal > 0)
    ? +((gsData.cpgVal - gsData.greyVal) / gsData.greyVal * 100).toFixed(1)
    : null;

  // ── Blend ──
  let fmv = null;
  let method;

  // #282H -- Skip spot+premium math entirely for proof / reverse-proof intent.
  //
  // Numismatic premium for proof and reverse-proof coins is structurally
  // decoupled from spot.  These are limited-mintage collector products whose
  // market price is driven by mintage, demand, slab grade, and key-date status
  // -- not by silver/gold spot.  The spot+premium model (FMV = spot * (1+pct),
  // pct clamped to 100% silver / 40% gold) silently truncates legitimate proof
  // premiums at ~$60-$130 for silver and ~$2,800 for gold, collapsing dozens
  // of distinct proof dates to the same number.  Pool isolation (above) already
  // gives us a clean proof-only ebayMedian; let the comp-blend path use it.
  // The wantsProof / wantsReverseProof gate above already raises a clear
  // explanation when the proof pool is empty (no fallback to BU comps).
  const skipSpotMath = wantsProof || wantsReverseProof;

  // #53: Bullion spot+premium FMV mode.
  // For bullion coins where we have both a spot price and eBay comps,
  // derive the current market premium from comps and anchor FMV to live spot.
  // This tracks metal price moves instantly instead of lagging with 30-day median.
  if (isBullion && spotPrice > 0 && ebayMedian != null && ebayMedian > spotPrice * 0.5 && !skipSpotMath) {
    const rawPremium = (ebayMedian - spotPrice) / spotPrice;
    // Clamp premium to reasonable bounds: -5% to +100% for silver, -5% to +40% for gold
    // (gold premiums are tighter; silver rounds/bars can carry 20-80% retail premium)
    const maxPremium = spotPrice > 500 ? 0.40 : 1.00;  // gold threshold ~$500/oz
    const premiumPct = Math.max(-0.05, Math.min(rawPremium, maxPremium));
    fmv = spotPrice * (1 + premiumPct);
    method = 'bullion-spot-premium';

    if (isAdmin) {
      explanation.push(
        `Bullion spot+premium: spot $${spotPrice.toFixed(2)}, `
        + `comp-derived premium ${(premiumPct * 100).toFixed(1)}%, `
        + `FMV = $${fmv.toFixed(2)}. `
        + `(eBay median $${ebayMedian.toFixed(2)} used to derive premium.)`
      );
    } else {
      explanation.push('Bullion valued from current spot price plus a market premium derived from recent sold comps.');
    }

    // If Greysheet is available, blend with adaptive weight based on comp count.
    // High-comp coins (20+) need minimal GS anchoring (5%); thin markets lean on GS more.
    if (greysheetVal != null) {
      const compCount = usPrices.length;
      const gsWeight = compCount >= 20 ? 0.05
        : compCount >= 10 ? 0.10
        : compCount >= 5 ? 0.15
        : 0.20;
      fmv = fmv * (1 - gsWeight) + greysheetVal * gsWeight;
      if (isAdmin) {
        explanation.push(`Greysheet blend: ${((1 - gsWeight) * 100).toFixed(0)}% spot-premium + ${(gsWeight * 100).toFixed(0)}% wholesale ($${greysheetVal.toFixed(2)}, ${compCount} comps).`);
      } else {
        explanation.push(`Wholesale guide lightly anchored (n=${compCount} comps).`);
      }
    }
  }

  // #188 + #282H: Bullion fallback ladder when no eBay comps survived filtering.
  //
  // Ladder (only fires for non-proof / non-reverse-proof bullion):
  //   1. Greysheet-anchor: wholesale guide >= 80% of spot -- 70% Greysheet + 30% spot.
  //      Greysheet is dealer wholesale (CDN), licensed and curated; when it sits
  //      meaningfully above spot it represents a real, defensible bullion FMV.
  //      The 30% spot weight keeps the number responsive to metal-price moves.
  //      The 80%-of-spot guard rejects nominal / stale Greysheet rows that would
  //      drag FMV well below current metal value.
  //   2. Bare spot: no comps AND no usable Greysheet -- spot with 0% premium
  //      remains the conservative floor (#188 behavior, retained).
  //
  // For proof / reverse-proof intent we skip this entire ladder: substituting
  // BU bullion math for a proof query (regardless of spot or Greysheet) gives
  // the wrong number, not a missing one.  The null-FMV return below handles
  // the proof-empty case with a clear explanation instead.
  if (fmv == null && isBullion && spotPrice > 0 && ebayMedian == null && !skipSpotMath) {
    if (greysheetVal != null && greysheetVal >= spotPrice * 0.8) {
      fmv = greysheetVal * 0.7 + spotPrice * 0.3;
      method = 'bullion-greysheet-anchor';
      if (isAdmin) {
        explanation.push(
          `Bullion Greysheet anchor (no eBay comps): wholesale $${greysheetVal.toFixed(2)} >= 80% of spot $${spotPrice.toFixed(2)}; `
          + `FMV = 70% Greysheet + 30% spot = $${fmv.toFixed(2)}.`
        );
      } else {
        explanation.push('No recent sold comps; wholesale guide used as primary anchor, lightly blended with current spot.');
      }
    } else {
      fmv = spotPrice;
      method = 'bullion-spot-only';
      if (isAdmin) {
        const gsNote = greysheetVal != null
          ? ` (Greysheet $${greysheetVal.toFixed(2)} below 80% of spot, not used as anchor)`
          : ' (no Greysheet available)';
        explanation.push(
          `Bullion spot fallback (no comps): spot $${spotPrice.toFixed(2)} used as FMV with 0% premium${gsNote}.`
        );
      } else {
        explanation.push('Bullion fallback: no comps available; FMV set to current spot price.');
      }
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
    if (isAdmin) {
      explanation.push(`Certified coin blend (${usedSources}), grade tier: ${gradeTier}. Weights: eBay ${pct('ebay')}%, PCGS Guide ${pct('pcgs')}%, Auction ${pct('auction')}%, Greysheet ${pct('greysheet')}%.`);
    } else {
      // #232 -- brand names (Greysheet/PCGS Guide) are gated; weighting math is Tier B (#233).
      explanation.push(`Certified coin blend across ${Object.keys(available).length} price sources, grade tier: ${gradeTier}.`);
    }
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
    if (isAdmin) {
      explanation.push(`Raw coin blend. Base weights: eBay 70%, PCGS 10%, Greysheet 20%.`);
    } else {
      // #232 -- brand names gated; weight schedule is Tier B (#233).
      explanation.push('Raw coin blend across available price sources.');
    }
  }
  } // end if (fmv == null) — bullion spot+premium may have set it above

  if (fmv == null) {
    // #282H -- when proof intent is set but no proof / RP comps and no guide
    // values existed, make the explanation explicit about why we did not fall
    // back to BU bullion math.  Avoids the silent "no FMV" result giving the
    // impression of a pipeline bug.
    if (wantsProof || wantsReverseProof) {
      const tier = wantsReverseProof ? 'reverse-proof' : 'proof';
      explanation.push(
        `NO DATA: no ${tier} comps, no PCGS price guide, no Greysheet for this ${tier} coin -- `
        + 'BU bullion comps and spot+premium math are not substituted (would give a wrong number, not a missing one).'
      );
    } else {
      explanation.push('NO DATA: unable to compute FMV -- no comps or guide prices available.');
    }
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
    if (isAdmin) {
      explanation.push(`${terapeakCount} Terapeak sold comps used (verified eBay sales data).`);
    } else {
      explanation.push(`${terapeakCount} verified sold comps used.`);
    }
  }
  if (greysheetVal != null) {
    if (isAdmin) {
      explanation.push(`Greysheet wholesale: $${greysheetVal.toFixed(2)}${gsData.cpgVal ? ` (retail CPG: $${gsData.cpgVal.toFixed(2)})` : ''}.`);
    } else {
      // Public callers see only that a wholesale guide informed the valuation
      // -- exact CDN/Greysheet dollar amounts are licensed and not redistributable.
      explanation.push('Wholesale price guide referenced.');
    }
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

  // #195: RRV (Retail Replacement Value) — insurance appraisal mode.
  // Uses Greysheet CPG retail when available; otherwise applies a markup to FMV
  // derived from the wholesale-to-retail spread or a default 20%.
  let rrv = null;
  if (fmv > 0) {
    if (gsData?.cpgVal > 0) {
      rrv = +gsData.cpgVal.toFixed(2);
    } else if (gsSpreadPct != null && gsSpreadPct > 0) {
      // Derive markup from known spread percentage
      rrv = +(fmv * (1 + gsSpreadPct / 100)).toFixed(2);
    } else {
      // Default 20% retail markup when no spread data
      rrv = +(fmv * 1.20).toFixed(2);
    }
  }

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
        wantsReverseProof,
        // #260W review m5: derived enum for log consumers.  wantsProof goes
        // false when wantsReverseProof fires (RP suppresses generic proof),
        // so anyone grep'ing for "proof intent" via wantsProof alone misses
        // RP coins.  proofIntent collapses both into a single axis.
        proofIntent: wantsReverseProof ? 'reverse-proof' : wantsProof ? 'proof' : null,
        usedPool: poolFallback ? 'raw (fallback)'
          : wantsReverseProof ? 'reverse-proof'
          : wantsProof ? 'proof'
          : wantsGraded ? 'graded'
          : 'raw',
        gradedCount: usGraded.length,
        rawCount: usRaw.length,
        proofCount: usProof.length,
        reverseProofCount: usRevProof.length,
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
      auctionData: auctionMedian != null ? {
        medianUsd: auctionMedian,
        count: pcgs?.auction?.count || null,
        trend: pcgs?.auction?.trend || null,
      } : null,
      bullionSpot: method === 'bullion-spot-premium' ? {
        spotPrice: +spotPrice.toFixed(2),
        premiumPct: +((fmv / spotPrice - 1) * 100).toFixed(1),
        ebayMedian: +ebayMedian.toFixed(2),
      } : method === 'bullion-spot-only' ? {
        spotPrice: +spotPrice.toFixed(2),
        premiumPct: 0,
        ebayMedian: null,
      } : method === 'bullion-greysheet-anchor' ? {
        // #282H -- expose anchor weights so admin clients can see how FMV was
        // composed (mirrors the diagnostic shape of the other two bullion modes).
        spotPrice: +spotPrice.toFixed(2),
        premiumPct: +((fmv / spotPrice - 1) * 100).toFixed(1),
        ebayMedian: null,
        greysheetVal: +greysheetVal.toFixed(2),
        greysheetWeight: 0.7,
        spotWeight: 0.3,
      } : null,
      rrv,
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
 * BU bullion coins use a steeper recency curve (30-day half-life vs 90-day)
 * because their values track underlying spot metal prices.  Proof and
 * reverse-proof bullion are explicitly excluded from the 30-day curve and
 * use the 90-day numismatic half-life -- see #283H.
 */
function computeWeightedMedian(comps, { isBullion = false, wantsProof = false, wantsReverseProof = false } = {}) {
  const valid = comps.filter(c => c.totalUsd != null);
  if (!valid.length) return null;

  // BU bullion half-life: 30 days (rapid metal price tracking)
  // Numismatic AND proof / RP bullion half-life: 90 days (collector-market
  //   shifts, mintage and grade desirability drive price -- not spot).
  // #283H -- proof / RP bullion is collector-paced, not metal-paced.
  // Failure modes when proof was using 30-day under the old logic:
  //   1. Thin pool + one fresh outlier dominated the weighted median.
  //   2. Stale-but-correct low-mintage comps were effectively discarded.
  //   3. Mid-metal-spike queries reported phantom proof premium that
  //      decayed once spot reverted.
  const halfLifeDays = (isBullion && !wantsProof && !wantsReverseProof) ? 30 : 90;

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

module.exports = {
  computeValuation,
  // #283H -- exported for unit tests pinning the proof / RP half-life
  // dispatch.  Not used by production callers.
  computeWeightedMedian,
};
