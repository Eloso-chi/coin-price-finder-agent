// src/routes/priceRoute.js - POST /api/price
// CommonJS

'use strict';

const express = require('express');
const { priceCoin } = require('../services/pricingService');
const { writeValuationAudit } = require('../services/auditService');
const { redactCompsForPublic } = require('../utils/redactForPublic');
const {
  isValidFinishInput,
  isValidVariantDetailInput,
  isValidSpecialMarkInput,
  MAX_FINISH_LENGTH,
  MAX_VARIANT_DETAIL_LENGTH,
} = require('../utils/coinIntent');

const router = express.Router();

function toLegacyResponse(result, input) {
  const coin = result.coin || {};
  const mintage = result.mintage || {};

  return {
    query: {
      input: input.query,
      askingPrice: input.askingPrice || null,
      weight: coin.weight,
      setType: coin.setType,
      specialMarks: result.reproducibility?.productIdentity?.specialMarks || [],
      specialMarkMode: result.reproducibility?.productIdentity?.specialMarkMode || 'unspecified',
      options: result.options,
    },
    coinData: input.coinData || null,
    keyDate: result.keyDate,
    identification: coin.identification,
    mintageData: {
      mintage: mintage.value,
      source: mintage.source,
    },
    pcgs: result.pcgs,
    ebay: result.ebay,
    spotPrice: result.spotPrice,
    greysheet: result.greysheet,
    valuation: result.valuation,
    decisions: result.decisions,
    rollInfo: result.rollInfo || undefined,
    adjacentYears: result.adjacentYears || undefined,
    numista: result.numista || null,
    reproducibility: result.reproducibility,
    trackerSeries: coin.trackerSeries || null,
    lunarComparison: result.lunarComparison || null,
    coinVariant: coin.coinVariant || null,
  };
}

router.post('/', async (req, res) => {
  try {
    const input = req.body || {};
    const { query, coinData } = input;

    if (!query) {
      return res.status(400).json({ error: 'query field is required' });
    }
    if (String(query).length > 300) {
      return res.status(400).json({ error: 'query must be 300 characters or fewer' });
    }
    if (!isValidFinishInput(coinData?.finish)) {
      return res.status(400).json({ error: `coinData.finish must be a string of ${MAX_FINISH_LENGTH} characters or fewer` });
    }
    if (!isValidVariantDetailInput(coinData?.variantDetail)) {
      return res.status(400).json({ error: `coinData.variantDetail must contain only letters, numbers, spaces, ._+=-, and be ${MAX_VARIANT_DETAIL_LENGTH} characters or fewer` });
    }
    if (!isValidSpecialMarkInput(coinData?.specialMarks, coinData?.specialMarkMode)) {
      return res.status(400).json({ error: 'coinData.specialMarks or coinData.specialMarkMode is invalid', code: 'INVALID_SPECIAL_MARK' });
    }

    const trustedContext = {
      isAdmin: req.isAdmin === true,
      audience: req.isAdmin === true ? 'admin' : 'public',
    };
    const result = await priceCoin(input, trustedContext);

    void writeValuationAudit({
      query,
      fmv: result.valuation.fmvCore,
      method: result.valuation.method || result.valuation.dataSource?.label || null,
      confidence: result.valuation.confidence,
      algorithmVersion: result.valuation.algorithmVersion,
      configVersion: result.valuation.configVersion,
      computedAt: result.valuation.computedAt,
      requestId: req.id,
      actorId: trustedContext.isAdmin ? req.adminActor?.userId : undefined,
      ip: trustedContext.isAdmin ? req.ip : undefined,
    });

    return res.json(redactCompsForPublic(toLegacyResponse(result, input), trustedContext.isAdmin));
  } catch (err) {
    if (err?.code === 'AMBIGUOUS_PRODUCT_IDENTITY' || err?.code === 'INVALID_SPECIAL_MARK') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err?.code === 'UNVERIFIED_SPECIAL_MARK') {
      return res.status(422).json({ error: err.message, code: err.code });
    }
    console.error('[/api/price] Unhandled error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
