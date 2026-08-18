'use strict';

function providerEnabled(env = process.env) {
  return String(env.LLM_PROVIDER || '').toLowerCase() === 'azure-openai'
    && Boolean(env.AZURE_OPENAI_ENDPOINT)
    && Boolean(env.AZURE_OPENAI_DEPLOYMENT)
    && Boolean(env.AZURE_OPENAI_API_KEY);
}

let activeRequests = 0;
const MAX_ACTIVE_REQUESTS = 2;

function createLlmProvider({ env = process.env, fetchImpl = global.fetch } = {}) {
  const enabled = providerEnabled(env);
  return {
    enabled,
    async complete(payload) {
      if (!enabled) throw new Error('LLM provider is disabled');
      if (typeof fetchImpl !== 'function') throw new Error('LLM provider fetch is unavailable');
      if (activeRequests >= MAX_ACTIVE_REQUESTS) throw new Error('LLM provider concurrency limit reached');
      activeRequests += 1;
      const endpoint = `${String(env.AZURE_OPENAI_ENDPOINT).replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(env.AZURE_OPENAI_DEPLOYMENT)}/chat/completions?api-version=${encodeURIComponent(env.AZURE_OPENAI_API_VERSION || '2024-10-21')}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': env.AZURE_OPENAI_API_KEY },
          body: JSON.stringify({ ...payload, max_tokens: Math.min(Number(payload.max_tokens) || 700, 1000) }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`LLM provider returned HTTP ${response.status}`);
        const data = await response.json();
        if (!data?.choices?.[0]?.message) throw new Error('LLM provider returned a malformed response');
        return data.choices[0].message;
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('LLM provider timed out', { cause: error });
        throw error;
      } finally {
        clearTimeout(timeout);
        activeRequests -= 1;
      }
    },
  };
}

module.exports = { createLlmProvider, providerEnabled };