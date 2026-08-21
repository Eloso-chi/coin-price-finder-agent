'use strict';

const { createLlmProvider, providerEnabled } = require('../src/services/llmProviderAdapter');

describe('LLM provider adapter', () => {
  test('is disabled unless the complete Azure configuration is present', () => {
    expect(providerEnabled({ LLM_PROVIDER: 'azure-openai' })).toBe(false);
    expect(providerEnabled({
      LLM_PROVIDER: 'azure-openai',
      AZURE_OPENAI_ENDPOINT: 'https://example.test',
      AZURE_OPENAI_DEPLOYMENT: 'coin-model',
      AZURE_OPENAI_API_KEY: 'placeholder',
    })).toBe(true);
  });

  test('parses a provider message without exposing the API key to the caller', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    }));
    const provider = createLlmProvider({
      env: {
        LLM_PROVIDER: 'azure-openai',
        AZURE_OPENAI_ENDPOINT: 'https://example.test/',
        AZURE_OPENAI_DEPLOYMENT: 'coin-model',
        AZURE_OPENAI_API_KEY: 'placeholder',
      },
      fetchImpl,
    });
    const result = await provider.complete({ messages: [], tools: [] });
    expect(result.content).toBe('ok');
    expect(fetchImpl.mock.calls[0][0]).toMatch(/deployments\/coin-model/);
    expect(result).not.toHaveProperty('apiKey');
  });
});