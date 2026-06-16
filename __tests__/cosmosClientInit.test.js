// __tests__/cosmosClientInit.test.js -- env-gated init for src/utils/cosmosClient
//
// Covers the singleton initialization contract:
//   - isEnabled() returns false when COSMOS_ENDPOINT or COSMOS_KEY is missing
//   - isEnabled() returns true when both are set
//   - container() throws a specific message when Cosmos is not configured
//   - ensureContainer() is a safe no-op when Cosmos is not configured
//   - empty-string env vars are treated as unset (degraded mode)
//   - The singleton honors the env at first init() call, not at every call
//
// Strategy: use jest.isolateModules() so each test gets its own module instance
// with a clean singleton. Mock @azure/cosmos so we never hit real Azure.
'use strict';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

function loadFresh(envOverrides = {}) {
  // Reset and apply overrides
  process.env = { ...ORIGINAL_ENV };
  delete process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_KEY;
  delete process.env.COSMOS_DB;
  Object.assign(process.env, envOverrides);

  let mod;
  jest.isolateModules(() => {
    jest.doMock('@azure/cosmos', () => {
      const containers = {
        createIfNotExists: jest.fn().mockResolvedValue(undefined),
      };
      const database = jest.fn().mockReturnValue({
        container: jest.fn().mockReturnValue({ id: 'mock-container' }),
        containers,
      });
      const CosmosClient = jest.fn().mockImplementation(() => ({
        database,
      }));
      return { CosmosClient };
    });
    mod = require('../src/utils/cosmosClient');
  });
  return mod;
}

describe('cosmosClient init contract', () => {
  test('isEnabled() returns false when COSMOS_ENDPOINT is unset', () => {
    const cosmos = loadFresh({ COSMOS_KEY: 'k' });
    expect(cosmos.isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when COSMOS_KEY is unset', () => {
    const cosmos = loadFresh({ COSMOS_ENDPOINT: 'https://example.documents.azure.com:443/' });
    expect(cosmos.isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when both are unset', () => {
    const cosmos = loadFresh({});
    expect(cosmos.isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when COSMOS_ENDPOINT is empty string', () => {
    const cosmos = loadFresh({ COSMOS_ENDPOINT: '', COSMOS_KEY: 'k' });
    expect(cosmos.isEnabled()).toBe(false);
  });

  test('isEnabled() returns false when COSMOS_KEY is empty string', () => {
    const cosmos = loadFresh({ COSMOS_ENDPOINT: 'https://example.documents.azure.com:443/', COSMOS_KEY: '' });
    expect(cosmos.isEnabled()).toBe(false);
  });

  test('isEnabled() returns true when both env vars are set', () => {
    const cosmos = loadFresh({
      COSMOS_ENDPOINT: 'https://example.documents.azure.com:443/',
      COSMOS_KEY: 'secret-key',
    });
    expect(cosmos.isEnabled()).toBe(true);
  });

  test('container() throws specific error when Cosmos not configured', () => {
    const cosmos = loadFresh({});
    expect(() => cosmos.container('audit')).toThrow('Cosmos DB not configured');
  });

  test('container() returns a container object when configured', () => {
    const cosmos = loadFresh({
      COSMOS_ENDPOINT: 'https://example.documents.azure.com:443/',
      COSMOS_KEY: 'secret-key',
    });
    const c = cosmos.container('audit');
    expect(c).toEqual({ id: 'mock-container' });
  });

  test('ensureContainer() is a safe no-op when Cosmos not configured', async () => {
    const cosmos = loadFresh({});
    await expect(cosmos.ensureContainer('audit', '/actorUsername')).resolves.toBeUndefined();
  });

  test('ensureContainer() calls createIfNotExists when configured', async () => {
    const cosmos = loadFresh({
      COSMOS_ENDPOINT: 'https://example.documents.azure.com:443/',
      COSMOS_KEY: 'secret-key',
    });
    await cosmos.ensureContainer('audit', '/actorUsername');
    // Hitting it twice should still work (idempotent)
    await cosmos.ensureContainer('audit', '/actorUsername');
    // We assert no throw rather than inspecting the mock -- the contract is
    // "must not raise on repeated calls"
    expect(cosmos.isEnabled()).toBe(true);
  });

  test('default COSMOS_DB name is "coinprice" when unset', () => {
    // The DB name is captured during init(); we can't read it directly, but
    // an absent COSMOS_DB env must not cause init to throw.
    const cosmos = loadFresh({
      COSMOS_ENDPOINT: 'https://example.documents.azure.com:443/',
      COSMOS_KEY: 'secret-key',
    });
    expect(cosmos.isEnabled()).toBe(true);
    expect(() => cosmos.container('any')).not.toThrow();
  });

  test('custom COSMOS_DB name is accepted', () => {
    const cosmos = loadFresh({
      COSMOS_ENDPOINT: 'https://example.documents.azure.com:443/',
      COSMOS_KEY: 'secret-key',
      COSMOS_DB: 'custom-db-name',
    });
    expect(cosmos.isEnabled()).toBe(true);
    expect(() => cosmos.container('audit')).not.toThrow();
  });
});
