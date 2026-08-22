'use strict';

jest.mock('../src/services/aiOrchestratorService', () => ({
  orchestrate: jest.fn(),
}));
jest.mock('../src/services/llmProviderAdapter', () => ({
  createLlmProvider: jest.fn(() => ({ enabled: true })),
}));
jest.mock('../src/services/pricingService', () => ({
  priceCoin: jest.fn(async () => ({ valuation: { fmvCore: 100, confidence: 50, compCount: 1 } })),
}));
jest.mock('../src/services/auditService', () => ({
  writeValuationAudit: jest.fn(() => Promise.resolve(false)),
}));

const request = require('supertest');
const express = require('express');
const route = require('../src/routes/aiPriceRoute');
const { orchestrate } = require('../src/services/aiOrchestratorService');
const { priceCoin } = require('../src/services/pricingService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', route);
  return app;
}

describe('LLM-enabled POST /api/ai/price', () => {
  beforeEach(() => jest.clearAllMocks());

  test('renders the orchestrated explanation and tool results', async () => {
    orchestrate.mockResolvedValueOnce({
      answer: 'The deterministic result supports this estimate.',
      toolResults: [{ name: 'price_coin', result: { valuation: { fmvCore: 100 } } }],
      context: [{ role: 'assistant', content: 'The deterministic result supports this estimate.' }],
      provider: 'azure-openai',
    });

    const res = await request(createApp()).post('/api/ai/price').send({ query: '1881-S Morgan MS65' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('azure-openai');
    expect(res.body.answer).toMatch(/deterministic result/i);
    expect(priceCoin).not.toHaveBeenCalled();
  });

  test('preserves a structured single-comp warning from deterministic tool results', async () => {
    orchestrate.mockResolvedValueOnce({
      answer: 'The deterministic tool returned a thin-data estimate.',
      toolResults: [{
        name: 'price_coin',
        result: {
          result: { valuation: { fmvCore: 700, confidence: 0, compCount: 1, lowData: true } },
          provenance: { source: 'deterministic-pricing-service', observed: true },
        },
      }],
      context: [],
      provider: 'azure-openai',
    });

    const res = await request(createApp()).post('/api/ai/price').send({
      query: '2016 Mexican Silver Libertad Proof 5 oz',
    });

    expect(res.status).toBe(200);
    expect(res.body.provenance.valuation).toEqual({
      method: null,
      confidence: 0,
      lowData: true,
      compCount: 1,
      dataSource: null,
      compositeBasis: null,
      warning: expect.stringMatching(/single-comp estimate/i),
    });
  });

  test('preserves composite provenance from deterministic tool results', async () => {
    const compositeBasis = {
      usedCohort: true,
      cohortYears: [2018, 2019, 2021, 2022],
      cohortCompCount: 4,
      exactYearCompCount: 1,
      populationGateApplied: false,
    };
    orchestrate.mockResolvedValueOnce({
      answer: 'The deterministic tool returned a composite estimate.',
      toolResults: [{
        name: 'price_coin',
        result: {
          result: {
            valuation: {
              fmvCore: 500,
              method: 'raw-blend (composite)',
              confidence: 30,
              compCount: 5,
              lowData: false,
              dataSource: { label: 'cross-year-composite' },
              gradePool: { compositeBasis },
            },
          },
        },
      }],
      context: [],
      provider: 'azure-openai',
    });

    const res = await request(createApp()).post('/api/ai/price').send({
      query: '2020 Mexican Silver Libertad Proof 5 oz',
    });

    expect(res.body.provenance.valuation).toEqual({
      method: 'raw-blend (composite)',
      confidence: 30,
      lowData: false,
      compCount: 5,
      dataSource: { label: 'cross-year-composite' },
      compositeBasis,
      warning: expect.stringMatching(/composite estimate/i),
    });
  });

  test('falls back to deterministic pricing when orchestration fails', async () => {
    orchestrate.mockRejectedValueOnce(new Error('provider unavailable'));

    const res = await request(createApp()).post('/api/ai/price').send({ query: '1881-S Morgan MS65' });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('deterministic-boundary');
    expect(res.body.fallback).toBe('llm-unavailable');
    expect(priceCoin).toHaveBeenCalledTimes(1);
  });
});