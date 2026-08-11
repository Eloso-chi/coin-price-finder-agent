'use strict';

const metals = require('../src/services/metalsSpotPrice');

describe('metals provider health status', () => {
  beforeEach(() => metals._reset());

  test('is degraded until a live provider succeeds', () => {
    const health = metals.getHealthStatus();

    expect(health.status).toBe('degraded');
    expect(health.lastSuccess).toBeNull();
    expect(Object.keys(health.providers)).toHaveLength(metals._providers.length);
    expect(Object.values(health.providers).every(item => item.status === 'unknown')).toBe(true);
  });

  test('reports a provider healthy only while its success is fresh', () => {
    const providerName = metals._providers[0].name;
    metals._providerLastSuccess.set(providerName, new Date().toISOString());

    expect(metals.getHealthStatus()).toMatchObject({
      status: 'ok',
      lastSuccess: expect.any(String),
      providers: { [providerName]: { status: 'ok', lastSuccess: expect.any(String) } },
    });

    metals._providerLastSuccess.set(providerName, '2000-01-01T00:00:00.000Z');
    expect(metals.getHealthStatus()).toMatchObject({
      status: 'degraded',
      lastSuccess: null,
      providers: { [providerName]: { status: 'stale', lastSuccess: '2000-01-01T00:00:00.000Z' } },
    });
  });
});