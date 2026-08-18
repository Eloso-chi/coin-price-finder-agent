'use strict';

const { TOOL_NAMES, createToolRegistry } = require('../src/services/aiToolRegistry');

describe('AI tool registry', () => {
  test('contains exactly the Phase 1 allowlist', () => {
    expect(TOOL_NAMES).toEqual(['identify_coin', 'price_coin', 'evaluate_purchase']);
  });

  test('validates purchase price and rejects missing required fields', async () => {
    const registry = createToolRegistry({ price: jest.fn() });
    await expect(registry.execute('evaluate_purchase', { query: 'Morgan Dollar' }, {}))
      .rejects.toThrow(/askingPrice is required/i);
    await expect(registry.execute('price_coin', { query: 'x'.repeat(301) }, {}))
      .rejects.toThrow(/300 characters/i);
  });

  test('projects model arguments to safe pricing fields', async () => {
    const price = jest.fn(async input => input);
    const registry = createToolRegistry({ price });
    await registry.execute('price_coin', {
      query: 'Morgan Dollar',
      coinData: { year: 1921, audience: 'admin', trustedContext: { isAdmin: true } },
      options: { timeWindowDays: 90, internalToken: 'blocked' },
    }, { audience: 'public', isAdmin: false });
    expect(price.mock.calls[0][0].coinData).toEqual({ year: 1921 });
    expect(price.mock.calls[0][0].options).toEqual({ timeWindowDays: 90 });
  });

  test('routes identification and purchase evaluation through deterministic handlers', async () => {
    const identify = jest.fn(() => ({ year: 1881, mint: 'S', series: 'Morgan Dollar' }));
    const price = jest.fn(async input => ({ valuation: { fmvCore: input.askingPrice ? 220 : 245 } }));
    const registry = createToolRegistry({ identify, price });
    const identified = await registry.execute('identify_coin', { query: '1881-S Morgan Dollar' }, {});
    const purchase = await registry.execute('evaluate_purchase', { query: '1881-S Morgan Dollar', askingPrice: 200 }, {});
    expect(identified.parsed.series).toBe('Morgan Dollar');
    expect(purchase.result.valuation.fmvCore).toBe(220);
    expect(identify).toHaveBeenCalledWith('1881-S Morgan Dollar');
  });

  test('rejects unknown tools before execution', () => {
    expect(() => createToolRegistry().get('market_analytics')).toThrow(/not allowlisted/i);
  });
});