// Evidence normalization, filtering, and FMV estimation for CoinPriceDiscoveryAgent

// ── Lot / multi-coin patterns ──────────────────────────────────────────────
const LOT_PATTERNS = [
  /\b(\d+)\s*(coin|pc|piece)/i,
  /\broll\b/i,
  /\blot\b/i,
  /\bset\b/i,
  /\bcollection\b/i,
  /\bcomplete\b/i,
  /\balbum\b/i,
  /\bdansco\b/i,
  /\bwhitman\b/i
];

function isLikelyLot(title) {
  return LOT_PATTERNS.some(p => p.test(title));
}

// ── Normalize a single comp ───────────────────────────────────────────────
function normalizeComp(comp, query) {
  const price = comp.sold_price || comp.price || 0;
  if (!price || price <= 0) return null;

  // Skip multi-coin lots
  if (comp.title && isLikelyLot(comp.title)) {
    return null;
  }

  const shipping = comp.shipping || 0;
  const all_in_price = price + shipping;

  // Match quality heuristic
  let match_quality = 'Weak';
  const titleLower = (comp.title || '').toLowerCase();
  const nameLower = (query.coin_name || '').toLowerCase();
  const gradeLower = (query.grade || '').toLowerCase();

  const nameTokens = nameLower.split(/\s+/);
  const nameHits = nameTokens.filter(t => t.length > 2 && titleLower.includes(t)).length;
  const nameRatio = nameTokens.length ? nameHits / nameTokens.length : 0;
  const gradeMatch = titleLower.includes(gradeLower) || (comp.grade && comp.grade.toLowerCase() === gradeLower);

  if (nameRatio >= 0.6 && gradeMatch) match_quality = 'Exact';
  else if (nameRatio >= 0.6 || gradeMatch) match_quality = 'Close';

  return {
    ...comp,
    sold_price: price,
    all_in_price,
    source: comp.source || 'manual',
    match_quality,
    excluded: false,
    url: comp.url || null
  };
}

// ── Statistical helpers ───────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function stddev(arr) {
  const m = mean(arr);
  if (m === null || arr.length < 2) return 0;
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / (arr.length - 1));
}

/** Remove outliers via IQR method (1.5× fence) */
function removeOutliers(prices) {
  if (prices.length < 4) return prices;
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return sorted.filter(p => p >= lo && p <= hi);
}

// ── Compute metrics from normalized comps ─────────────────────────────────
function computeMetrics(comps) {
  const used = comps.filter(c => !!c && !c.excluded);
  const prices = used.map(c => c.all_in_price);
  const cleanPrices = removeOutliers(prices);

  return {
    total_found: comps.length,
    total_after_lot_filter: used.length,
    total_after_outlier_filter: cleanPrices.length,
    median_price: median(cleanPrices),
    mean_price: mean(cleanPrices) !== null ? +mean(cleanPrices).toFixed(2) : null,
    std_dev: cleanPrices.length >= 2 ? +stddev(cleanPrices).toFixed(2) : null,
    low: cleanPrices.length ? Math.min(...cleanPrices) : null,
    high: cleanPrices.length ? Math.max(...cleanPrices) : null
  };
}

// ── FMV Estimator ─────────────────────────────────────────────────────────
/**
 * Compute a Fair Market Value estimate from all available comps.
 * Uses match-quality weighted average, median, and confidence scoring.
 *
 * @param {Array} comps – normalized comps (manual + eBay etc.)
 * @param {Object} [anchorPrices] – optional { greysheet_bid, greysheet_ask, pcgs_price }
 * @returns {Object} { fmv, low, high, confidence, method, reasoning, comp_count }
 */
function estimateFMV(comps, anchorPrices = {}) {
  const valid = comps.filter(c => c && !c.excluded);
  if (!valid.length) {
    return { fmv: null, low: null, high: null, confidence: 0, method: 'none', reasoning: 'No usable comps available.', comp_count: 0 };
  }

  // Match-quality weights
  const WEIGHTS = { Exact: 3, Close: 2, Weak: 1 };
  const prices = valid.map(c => c.all_in_price);
  const clean = removeOutliers(prices);
  const cleanComps = valid.filter(c => clean.includes(c.all_in_price));

  // Weighted average
  let weightSum = 0, valueSum = 0;
  for (const c of cleanComps) {
    const w = WEIGHTS[c.match_quality] || 1;
    valueSum += c.all_in_price * w;
    weightSum += w;
  }
  const weightedAvg = weightSum > 0 ? valueSum / weightSum : null;
  const med = median(clean);
  const avg = mean(clean);
  const sd = stddev(clean);

  // Anchor price (Greysheet midpoint or PCGS)
  let anchor = null;
  if (anchorPrices.greysheet_bid && anchorPrices.greysheet_ask) {
    anchor = (anchorPrices.greysheet_bid + anchorPrices.greysheet_ask) / 2;
  } else if (anchorPrices.pcgs_price) {
    anchor = anchorPrices.pcgs_price;
  }

  // Blend: if anchor available, 40% anchor + 30% weighted avg + 30% median
  //        otherwise 60% weighted avg + 40% median
  let fmv;
  let method;
  if (anchor) {
    fmv = anchor * 0.4 + weightedAvg * 0.3 + med * 0.3;
    method = 'blended (anchor + weighted-avg + median)';
  } else {
    fmv = weightedAvg * 0.6 + med * 0.4;
    method = 'blended (weighted-avg + median)';
  }
  fmv = +fmv.toFixed(2);

  // Confidence: based on sample size, spread, and match quality
  const exactCount = cleanComps.filter(c => c.match_quality === 'Exact').length;
  const sampleScore = Math.min(cleanComps.length / 10, 1);       // 0-1
  const spreadScore = med > 0 ? Math.max(0, 1 - sd / med) : 0;  // 0-1 lower spread = better
  const qualityScore = cleanComps.length > 0 ? exactCount / cleanComps.length : 0; // 0-1
  const confidence = +(sampleScore * 0.4 + spreadScore * 0.4 + qualityScore * 0.2).toFixed(2);

  // Range: ±1 std-dev (or 10% floor)
  const margin = Math.max(sd, fmv * 0.1);
  const low = +Math.max(0, fmv - margin).toFixed(2);
  const high = +(fmv + margin).toFixed(2);

  const reasoning = [
    `Analyzed ${cleanComps.length} comps after removing ${valid.length - cleanComps.length} outlier(s) and lot listings.`,
    `Match quality breakdown: ${exactCount} Exact, ${cleanComps.filter(c => c.match_quality === 'Close').length} Close, ${cleanComps.filter(c => c.match_quality === 'Weak').length} Weak.`,
    `Weighted avg $${weightedAvg?.toFixed(2)}, median $${med?.toFixed(2)}, std-dev $${sd?.toFixed(2)}.`,
    anchor ? `Anchor price (Greysheet/PCGS) $${anchor.toFixed(2)} blended in at 40% weight.` : 'No anchor price available; estimate based on market comps only.',
    `Confidence ${(confidence * 100).toFixed(0)}% — sample ${(sampleScore * 100).toFixed(0)}%, spread ${(spreadScore * 100).toFixed(0)}%, quality ${(qualityScore * 100).toFixed(0)}%.`
  ].join(' ');

  return { fmv, low, high, confidence, method, reasoning, comp_count: cleanComps.length };
}

module.exports = {
  normalizeComp,
  computeMetrics,
  estimateFMV,
  removeOutliers,
  isLikelyLot
};
