// src/routes/coinHistoryRoute.js — Historical value time-series for charting
// CommonJS

const express = require('express');
const router = express.Router();

const terapeakService = require('../services/terapeakService');
const greysheetService = require('../services/greysheetService');
const greysheetHistory = require('../services/greysheetHistoryService');
const stats = require('../utils/stats');
const { getCoinMetalProfile } = require('../utils/coinMetalProfile');
const { getHistory, METAL_SYMBOLS } = require('../services/metalsHistoryService');
const { classifyGradeType } = require('../services/ebayService');
const { isDenied } = require('../utils/filters');

const VALID_RANGES = new Set([90, 180, 365]);

/**
 * GET /api/coin-history?query=...&rangeDays=90
 *
 * Returns a sparse time-series of sold prices grouped by date,
 * sourced from Terapeak sold comps.  When the coin is bullion or a
 * silver/gold US coin, includes a metalOverlay with the underlying
 * spot price history for the same date range.
 */
router.get('/', async (req, res) => {
  const query = (req.query.query || '').trim();
  if (!query) {
    return res.status(400).json({ error: 'query parameter is required' });
  }

  const rangeDays = VALID_RANGES.has(Number(req.query.rangeDays))
    ? Number(req.query.rangeDays)
    : 90;

  // Detect grade in the query (e.g. "MS-63", "AU-55", "VF-30", "PR-70")
  const GRADE_RE = /\b(MS|AU|XF|EF|VF|F|VG|G|AG|FR|PO|PR|PF)[\s-]?(\d{1,2})\b/i;
  const gradeMatch = query.match(GRADE_RE);
  const queryGrade = gradeMatch
    ? gradeMatch[1].toUpperCase() + '-' + gradeMatch[2]  // normalize to "MS-63"
    : null;

  // #254: Detect proof intent in the query string.  Mirrors the route-layer
  // intent extraction in priceRoute -- without this, a query like
  // "2019 Mexican Silver Libertad Proof" silently flips to the raw pool
  // (no grade matched -> wantsGraded=false -> raw filter applied).
  //
  // PR #3: Reverse Proof / Enhanced Reverse Proof get their own pool. Check
  // for RP intent BEFORE the generic proof check (RP titles also match the
  // generic \bproof\b). When neither RP nor a designation grade matched,
  // wantsProof picks up plain "Proof" / "Matte Proof" via PROOF_RE.
  const REVERSE_PROOF_RE = /\b(enhanced[\s-]+)?reverse[\s-]+proof\b/i;
  const PROOF_RE = /\b(proof|matte[\s-]?proof)\b/i;
  const wantsReverseProof = !queryGrade && REVERSE_PROOF_RE.test(query);
  const wantsProof = wantsReverseProof
    ? false
    : (!!queryGrade
        ? /^(PR|PF)/i.test(queryGrade)
        : PROOF_RE.test(query));
  const wantsGraded = !!queryGrade && !wantsProof && !wantsReverseProof;

  // Resolve query against Terapeak datasets
  const dataset = terapeakService.lookupComps(query);
  if (!dataset || !dataset.comps || dataset.comps.length === 0) {
    return res.status(404).json({
      error: 'No historical data found for this query',
      query,
      hint: 'Terapeak CSV data must be imported first. Upload via /api/terapeak/import or drop CSVs in data/terapeak/.'
    });
  }

  // Filter comps within the date range
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - rangeDays);

  let compsInRange = dataset.comps.filter(c => {
    if (!c.soldDate) return false;
    const d = new Date(c.soldDate);
    return !isNaN(d.getTime()) && d >= cutoff;
  });

  // ── Align with Price Discovery filtering ──
  // 1. Remove denied titles (lots, replicas, etc.)
  compsInRange = compsInRange.filter(c => !isDenied(c.title || ''));

  // 2. Grade-type split: pick the comp pool that matches user intent.
  //    reverse-proof: only reverse-proof / enhanced reverse-proof comps
  //    proof: only proof comps (strict, no fallback -- matches #244)
  //    graded: only certified/slabbed comps
  //    raw: only raw/BU comps (default when no grade or finish was specified)
  compsInRange = compsInRange.filter(c => {
    const gt = c.gradeType || classifyGradeType(c);
    if (wantsReverseProof) return gt === 'reverse-proof';
    if (wantsProof)        return gt === 'proof';
    if (wantsGraded)       return gt === 'graded';
    return gt === 'raw';
  });

  // 3. MAD outlier removal (same 3.5× threshold as Price Discovery)
  if (compsInRange.length >= 5) {
    const prices = compsInRange.map(c => c.totalUsd).sort((a, b) => a - b);
    const med = stats.median(prices);
    const deviations = prices.map(p => Math.abs(p - med));
    const mad = stats.median(deviations) || 1;
    compsInRange = compsInRange.filter(c =>
      Math.abs(c.totalUsd - med) <= 3.5 * mad
    );
  }

  // When a specific grade was requested, filter comps to that grade.
  // Match against the listing title (e.g. "PCGS MS-63", "NGC MS 63").
  let gradeFiltered = false;
  if (queryGrade && compsInRange.length > 0) {
    const gradePattern = new RegExp(
      queryGrade.replace('-', '[\\s-]?'),  // "MS-63" → "MS[\s-]?63"
      'i'
    );
    const filtered = compsInRange.filter(c => gradePattern.test(c.title || ''));
    if (filtered.length > 0) {
      compsInRange = filtered;
      gradeFiltered = true;
    }
    // If no comps match the grade, fall back to all comps (better than empty)
  }

  if (compsInRange.length === 0) {
    return res.json({
      displayName: dataset.searchTerm || query,
      currency: 'USD',
      rangeDays,
      source: 'ebay-sold',
      prices: [],
      totalComps: 0,
      metalOverlay: null
    });
  }

  // Group by date (YYYY-MM-DD) and compute daily stats
  const byDate = new Map();
  for (const comp of compsInRange) {
    const dateKey = comp.soldDate.substring(0, 10); // "2025-01-15"
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(comp.totalUsd);
  }

  // Build sorted daily stats: [date, median, avg, min, max, count]
  const prices = [];
  for (const [date, values] of byDate) {
    const med = stats.median(values);
    if (med != null) {
      const avg = stats.mean(values);
      const mn  = Math.min(...values);
      const mx  = Math.max(...values);
      prices.push([
        date,
        Math.round(med * 100) / 100,
        Math.round(avg * 100) / 100,
        Math.round(mn * 100) / 100,
        Math.round(mx * 100) / 100,
        values.length
      ]);
    }
  }
  prices.sort((a, b) => a[0].localeCompare(b[0]));

  // Determine if a metal overlay applies
  const profile = getCoinMetalProfile(query);
  let metalOverlay = null;

  if (profile.isMetalBased && profile.metal) {
    const sym = METAL_SYMBOLS[profile.metal]; // 'silver' → 'XAG'
    if (sym) {
      const metalPrices = getHistory(sym, rangeDays);
      if (metalPrices.length > 0) {
        metalOverlay = {
          metal: profile.metal,
          currency: 'USD',
          prices: metalPrices
        };
      } else {
        metalOverlay = null;
        // Metal history not yet accumulated — will build up over time
      }
    }
  }

  // Build display name: append grade if grade-filtered
  let displayName = dataset.searchTerm || query;
  if (gradeFiltered && queryGrade) {
    // Only append if not already in the name
    if (!new RegExp(queryGrade.replace('-', '[\\s-]?'), 'i').test(displayName)) {
      displayName += ' ' + queryGrade;
    }
  }

  // ── Greysheet reference prices (dealer values) ──
  // Try history first (trend line), fall back to current API value (flat reference line).
  // Non-blocking: if Greysheet is unavailable, chart still renders.
  let greysheetOverlay = null;
  try {
    const gradeNum = queryGrade
      ? parseInt(queryGrade.replace(/[^\d]/g, ''), 10) || null
      : null;

    // Provide weight + metal hints from the metal profile so Type GSID resolution
    // succeeds even when the query text lacks explicit weight (e.g. "Silver Eagle")
    const gs = await greysheetService.fetchTypePrice(query, gradeNum, {
      metal: profile.metal || undefined,
      weight: profile.pureOzt || undefined
    });
    const lookupId = gs?.gsid || null;

    if (gs && (gs.greyVal || gs.cpgVal)) {
      // Record today's snapshot (piggyback, zero extra API calls)
      const histKey = greysheetHistory.makeKey(lookupId, gradeNum);
      greysheetHistory.recordSnapshot(histKey, gs.greyVal, gs.cpgVal);

      // Get history for trend line
      const hist = greysheetHistory.getHistory(histKey, rangeDays);

      greysheetOverlay = {
        wholesale: hist.wholesale.length > 0 ? hist.wholesale : null,
        retail:    hist.retail.length > 0    ? hist.retail    : null,
        current: {
          wholesale: gs.greyVal || null,
          retail:    gs.cpgVal  || null
        },
        name:      gs.name || null,
        gradeLabel: gs.gradeLabel || null
      };
    }
  } catch (_) { /* non-fatal */ }

  res.json({
    displayName,
    currency: 'USD',
    rangeDays,
    source: 'ebay-sold',
    prices,
    totalComps: compsInRange.length,
    gradeFiltered: gradeFiltered || false,
    metalOverlay,
    greysheetOverlay
  });
});

module.exports = router;
