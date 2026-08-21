'use strict';

jest.mock('../src/services/llmProviderAdapter', () => ({
  createLlmProvider: jest.fn(() => ({
    enabled: true,
    complete: jest.fn()
      .mockResolvedValueOnce({
        role: 'assistant',
        tool_calls: [{
          id: 'price-call',
          function: { name: 'price_coin', arguments: '{"query":"1881-S Morgan MS65"}' },
        }],
      })
      .mockResolvedValueOnce({
        role: 'assistant',
        content: 'The deterministic result is $245 with 8 comps.',
      }),
  })),
}));

jest.mock('../src/services/pcgsService', () => ({
  parseDescription: jest.fn(() => ({ series: 'Morgan Dollar', year: 1881, mint: 'S', grade: 'MS65' })),
}));

jest.mock('../src/services/pricingService', () => ({
  priceCoin: jest.fn(async () => ({
    valuation: { fmvCore: 245, compCount: 8 },
    ebay: { us: { comps: [] }, global: { comps: [] } },
  })),
}));

jest.mock('../src/services/auditService', () => ({
  writeValuationAudit: jest.fn(() => Promise.resolve(false)),
}));

const request = require('supertest');
const express = require('express');
const route = require('../src/routes/aiPriceRoute');
const { priceCoin } = require('../src/services/pricingService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', route);
  return app;
}

describe('LLM-enabled AI pricing integration', () => {
  test('executes the real orchestrator and registry before rendering explanation', async () => {
    const res = await request(createApp())
      .post('/api/ai/price')
      .send({ query: 'What is an 1881-S Morgan MS65 worth?' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('azure-openai');
    expect(res.body.answer).toMatch(/245/);
    expect(res.body.toolResults[0].name).toBe('price_coin');
    expect(priceCoin).toHaveBeenCalledTimes(1);
  });
});