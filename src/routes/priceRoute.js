// src/routes/priceRoute.js — POST /api/price
// CommonJS

const express = require('express');
const router = express.Router();

const pcgsService = require('../services/pcgsService');
const ebayService = require('../services/ebayService');
const { computeValuation } = require('../services/valuationService');

router.post('/', async (req, res) => {
  try {
    const { query, askingPrice, options } = req.body || {};
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
    } else {
      pcgs = await pcgsService.resolveFromDescription(String(query));
    }

    const identification = {
      inputQuery: query,
      resolvedVia: pcgs.verified ? 'pcgs-api' : 'description-parse',
      parsed: pcgs.parsed || pcgsService.parseDescription(String(query))
    };

    // ── 2. Build eBay keywords ──
    const ebayKeywords = ebayService.buildKeywords(pcgs, String(query));

    // ── 3. Fetch eBay comps (US + Global) ──
    const expected = {
      year: pcgs.year || identification.parsed?.year,
      mint: pcgs.mint || identification.parsed?.mint,
      series: pcgs.series || identification.parsed?.series,
      grade: pcgs.grade || identification.parsed?.grade,
      designation: pcgs.designation || identification.parsed?.designation
    };
    const ebay = await ebayService.fetchSoldComps(ebayKeywords, opts, expected);

    // ── 4. Valuation + Decisions ──
    const { valuation, decisions } = computeValuation(pcgs, ebay, askingPrice || null);

    // ── 5. Reproducibility ──
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
      query: { input: query, askingPrice: askingPrice || null, options: opts },
      identification,
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
        trueViewUrl: pcgs.trueViewUrl
      },
      ebay: {
        keywords: ebayKeywords,
        us: ebay.us,
        global: ebay.global,
        usedFallback: ebay.usedFallback
      },
      valuation,
      decisions,
      reproducibility
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
