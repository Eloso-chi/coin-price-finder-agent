// src/routes/aiPriceRoute.js — Phase 1 conversational pricing shell
// CommonJS

'use strict';

const express = require('express');
const router = express.Router();
const { priceCoin } = require('../services/pricingService');
const { writeValuationAudit } = require('../services/auditService');
const { redactCompsForPublic } = require('../utils/redactForPublic');
const { orchestrate } = require('../services/aiOrchestratorService');
const { createLlmProvider } = require('../services/llmProviderAdapter');

function getHandoffInput(body) {
  const structuredContext = body && body.structuredContext && typeof body.structuredContext === 'object'
    ? body.structuredContext
    : {};
  const query = typeof body?.query === 'string' ? body.query : structuredContext.query;

  return {
    query,
    coinData: structuredContext.coinData || body?.coinData,
    weight: structuredContext.weight ?? body?.weight,
    options: structuredContext.options || body?.options,
    saleContext: structuredContext.saleContext || body?.saleContext,
    askingPrice: structuredContext.askingPrice ?? body?.askingPrice,
    appealMultiplier: structuredContext.appealMultiplier ?? body?.appealMultiplier,
  };
}

function buildDeterministicAnswer(query, valuation = {}) {
  const fmv = Number.isFinite(valuation.fmvCore) ? valuation.fmvCore : null;
  const low = Number.isFinite(valuation.rangeLow) ? valuation.rangeLow : null;
  const high = Number.isFinite(valuation.rangeHigh) ? valuation.rangeHigh : null;
  const comps = Number.isFinite(valuation.compCount) ? valuation.compCount : 0;

  if (fmv == null || comps === 0) {
    return `I couldn't find enough deterministic sold-comparable data to give ${query} a reliable numerical price. I won't invent one. Try adding the year, mint, grade, or exact finish.`;
  }

  const range = low != null && high != null ? ` A typical range is $${low.toFixed(2)}-$${high.toFixed(2)}.` : '';
  return `Based on ${comps} deterministic sold comparables, the estimated fair market value for ${query} is $${fmv.toFixed(2)}.${range}`;
}

router.post('/price', async (req, res) => {
  try {
    const { query, coinData, weight, options, saleContext, askingPrice, appealMultiplier } = getHandoffInput(req.body || {});
    const cleanedQuery = typeof query === 'string' ? query.trim() : '';

    if (!cleanedQuery) {
      return res.status(400).json({ ok: false, error: 'query field is required' });
    }

    const normalized = cleanedQuery.toLowerCase();
    const ambiguous = normalized === 'coin'
      || normalized === 'coin price'
      || normalized === 'silver coin'
      || normalized === 'coin question';

    if (ambiguous) {
      return res.status(422).json({
        ok: false,
        error: 'Need more detail to price this accurately. Please include the coin type, year, and denomination or a specific title.',
        suggestions: [
          '2024 American Silver Eagle',
          '1964 Kennedy Half Dollar',
          '2011 Mexican Silver Libertad Proof',
        ],
      });
    }

    const trustedContext = {
      isAdmin: req.isAdmin === true,
      audience: req.isAdmin === true ? 'admin' : 'public',
    };

    const llmProvider = createLlmProvider();
    if (llmProvider.enabled) {
      try {
        const conversation = await orchestrate({
          query: cleanedQuery,
          userMessage: cleanedQuery,
          context: req.body?.conversationContext,
          trustedContext,
          provider: llmProvider,
        });
        return res.json({
          ok: true,
          mode: 'ai',
          provider: conversation.provider,
          answer: conversation.answer,
          toolResults: conversation.toolResults,
          conversationContext: conversation.context,
          provenance: {
            provider: conversation.provider,
            audience: trustedContext.audience,
            tools: conversation.toolResults.map(tool => tool.name),
          },
          handoff: {
            query: cleanedQuery,
            coinData: coinData || null,
            weight: weight ?? null,
            options: options || {},
            askingPrice: askingPrice ?? null,
            saleContext: saleContext || null,
            appealMultiplier: appealMultiplier ?? null,
          },
        });
      } catch (llmError) {
        // Keep the non-AI pricing experience available when the provider fails.
        console.warn('[ai] LLM orchestration failed; using deterministic fallback:', llmError.message);
      }
    }

    const response = await priceCoin({
      query: cleanedQuery,
      coinData,
      weight,
      options,
      saleContext,
      askingPrice,
      appealMultiplier,
    }, trustedContext);

    redactCompsForPublic(response, trustedContext.isAdmin);

    void writeValuationAudit({
      query: cleanedQuery,
      fmv: response?.valuation?.fmvCore,
      method: response?.valuation?.method || null,
      confidence: response?.valuation?.confidence,
      algorithmVersion: response?.valuation?.algorithmVersion,
      configVersion: response?.valuation?.configVersion,
      computedAt: response?.valuation?.computedAt,
      requestId: req.id,
      actorId: trustedContext.isAdmin ? req.adminActor?.userId : undefined,
      ip: trustedContext.isAdmin ? req.ip : undefined,
    });

    const answerText = buildDeterministicAnswer(cleanedQuery, response?.valuation);
    const provenance = {
      provider: 'deterministic-boundary',
      mode: 'ai',
      audience: trustedContext.audience,
      valuation: {
        method: response?.valuation?.method || 'deterministic-boundary',
        algorithm: response?.valuation?.algorithm || response?.valuation?.method || 'deterministic-boundary',
        algorithmVersion: response?.valuation?.algorithmVersion || null,
        configVersion: response?.valuation?.configVersion || null,
        computedAt: response?.valuation?.computedAt || null,
        confidence: response?.valuation?.confidence ?? 'unknown',
        compCount: response?.valuation?.compCount ?? 0,
      },
      sources: {
        market: response?.ebay?.usedFallback ? 'ebay-fallback' : 'ebay',
        catalog: response?.numista ? 'numista' : null,
        priceGuide: response?.pcgs?.priceGuide ? 'pcgs' : null,
      },
      reproducibility: response?.reproducibility ? {
        pcgsVerified: Boolean(response.pcgs?.verified),
        usCompCount: response.reproducibility.ebay?.usItemIds?.length || 0,
        globalCompCount: response.reproducibility.ebay?.globalItemIds?.length || 0,
      } : null,
      history: {
        adjacentYears: response?.adjacentYears || [],
        auctionCount: response?.pcgs?.auction?.count || 0,
        auctionTrend: response?.pcgs?.auction?.trend || null,
      },
      audit: {
        requestId: req.id || null,
        retentionDays: 90,
      },
    };

    return res.json({
      ok: true,
      mode: 'ai',
      provider: 'deterministic-boundary',
      fallback: llmProvider.enabled ? 'llm-unavailable' : 'llm-disabled',
      answer: answerText,
      provenance,
      handoff: {
        query: cleanedQuery,
        coinData: coinData || null,
        weight: weight ?? null,
        options: options || {},
        askingPrice: askingPrice ?? null,
        saleContext: saleContext || null,
        appealMultiplier: appealMultiplier ?? null,
      },
      response,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: err && err.message ? err.message : 'pricing service unavailable',
    });
  }
});

module.exports = router;
