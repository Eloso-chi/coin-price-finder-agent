// src/routes/priceRoute.js — POST /api/price
// CommonJS

const express = require('express');
const router = express.Router();

const pcgsService = require('../services/pcgsService');
const ebayService = require('../services/ebayService');
const { computeValuation } = require('../services/valuationService');
const { lookupKeyDate } = require('../data/keyDates');
const { lookupMintage } = require('../data/mintages');

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
    } else {
      pcgs = await pcgsService.resolveFromDescription(String(query));
    }

    const identification = {
      inputQuery: query,
      resolvedVia: pcgs.verified ? 'pcgs-api' : 'description-parse',
      parsed: pcgs.parsed || pcgsService.parseDescription(String(query))
    };

    // ── 2. Build eBay keywords ──
    const resolvedWeight = coinData?.weight || bodyWeight || identification.parsed?.weight || null;
    const ebayKeywords = ebayService.buildKeywords(pcgs, String(query), resolvedWeight);

    // ── 3. Fetch eBay comps (US + Global) ──
    const expected = {
      year: pcgs.year || identification.parsed?.year,
      mint: pcgs.mint || identification.parsed?.mint,
      series: pcgs.series || identification.parsed?.series,
      grade: pcgs.grade || identification.parsed?.grade,
      designation: pcgs.designation || identification.parsed?.designation
    };
    const ebay = await ebayService.fetchSoldComps(ebayKeywords, opts, expected);

    // ── 4. Key Date Detection ──
    const keyDateSeries = coinData?.name || pcgs.series || identification.parsed?.series || '';
    const keyDateYear   = coinData?.year || pcgs.year || identification.parsed?.year;
    const keyDateMint   = coinData?.mintMark || pcgs.mint || identification.parsed?.mint || '';
    const keyDateInfo   = lookupKeyDate(keyDateSeries, keyDateYear, keyDateMint);

    // ── 5. Valuation + Decisions ──
    const { valuation, decisions } = computeValuation(pcgs, ebay, askingPrice || null);

    // ── 6. Static Mintage Fallback ──
    let mintSeries = coinData?.name || pcgs.series || identification.parsed?.series || '';
    const mintYear   = coinData?.year || pcgs.year || identification.parsed?.year;
    let   mintMark   = coinData?.mintMark || pcgs.mint || identification.parsed?.mint || '';
    const mintWeight = resolvedWeight;

    // For proof/mint sets, build the correct lookup key
    if (coinData?.setType) {
      if (coinData.setType === 'mint-uncirculated') {
        mintSeries = 'us mint set';
        mintMark = mintMark || 'P'; // mint sets have P&D, use P as default
      } else {
        mintSeries = 'us proof set ' + coinData.setType;
        mintMark = mintMark || 'S'; // proof sets are always S mint
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
      query: { input: query, askingPrice: askingPrice || null, weight: resolvedWeight, setType: coinData?.setType || null, options: opts },
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
        mintage: pcgs.mintage || null,
        metalContent: pcgs.metalContent || null,
        country: pcgs.country || null
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
