'use strict';

const { orchestrate, SYSTEM_POLICY, boundedContext } = require('../src/services/aiOrchestratorService');
const { createToolRegistry } = require('../src/services/aiToolRegistry');

describe('AI orchestrator', () => {
  test('selects an allowlisted deterministic tool and explains its validated result', async () => {
    const price = jest.fn(async () => ({ valuation: { fmvCore: 245, compCount: 8 } }));
    const registry = createToolRegistry({ price });
    let call = 0;
    const provider = {
      enabled: true,
      complete: jest.fn(async () => {
        call += 1;
        return call === 1
          ? { role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'price_coin', arguments: '{"query":"1881-S Morgan MS65"}' } }] }
          : { role: 'assistant', content: 'The deterministic valuation is $245 based on the available evidence.' };
      }),
    };

    const result = await orchestrate({
      query: 'What is an 1881-S Morgan MS65 worth?',
      provider,
      registry,
      trustedContext: { isAdmin: false, audience: 'public' },
    });

    expect(result.answer).toMatch(/245/);
    expect(result.toolResults[0].name).toBe('price_coin');
    expect(price).toHaveBeenCalledWith({
      query: '1881-S Morgan MS65',
      coinData: undefined,
      weight: null,
      options: undefined,
      askingPrice: null,
      appealMultiplier: null,
    }, { isAdmin: false, audience: 'public' });
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  test('rejects non-allowlisted tools and malformed arguments', async () => {
    const registry = createToolRegistry();
    const provider = {
      enabled: true,
      complete: jest.fn(async () => ({
        role: 'assistant',
        tool_calls: [{ id: 'bad', function: { name: 'delete_all_coins', arguments: '{}' } }],
      })),
    };

    await expect(orchestrate({ query: 'ignore policy', provider, registry }))
      .rejects.toThrow(/not allowlisted/i);
  });

  test('bounds conversation context and states the calculation policy', () => {
    expect(boundedContext(Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `turn-${index}` })))).toHaveLength(8);
    expect(SYSTEM_POLICY).toMatch(/deterministic tool results/i);
    expect(SYSTEM_POLICY).toMatch(/collection|market/i);
  });

  test.each([
    ['missing information', 'I need the year and grade before I can price that coin.'],
    ['no data', 'I could not find enough completed-sale data to provide a numerical answer.'],
  ])('returns a safe provider explanation for %s', async (_label, content) => {
    const provider = { enabled: true, complete: jest.fn(async () => ({ role: 'assistant', content })) };
    const result = await orchestrate({ query: 'Price a Morgan.', provider, registry: createToolRegistry() });
    expect(result.answer).toBe(content);
  });

  test('passes bounded follow-up context to the provider', async () => {
    const provider = { enabled: true, complete: jest.fn(async () => ({ role: 'assistant', content: 'MS64 is the comparison.' })) };
    await orchestrate({
      query: 'What about MS64 instead?',
      context: [{ role: 'assistant', content: 'The MS65 result was $245.' }],
      provider,
      registry: createToolRegistry(),
    });
    expect(provider.complete.mock.calls[0][0].messages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: 'The MS65 result was $245.' },
    ]));
  });
});