// __tests__/envFallbackMatrix.test.js -- cross-module env-config fallback behavior
//
// Asserts the system's degraded-mode contract:
//   - authService throws when JWT_SECRET is missing AND NODE_ENV=production
//   - authService warns (does not throw) in non-production when JWT_SECRET is missing
//   - When Cosmos and Blob are BOTH disabled, isEnabled() returns false on each
//     -- this is the canonical "file-only" deployment shape
//
// Intentionally complementary to:
//   - __tests__/cosmosClientInit.test.js (cosmos init permutations)
//   - __tests__/blobClientInit.test.js (blob init permutations)
//   - __tests__/requireAdminOrKey.test.js (middleware happy/sad paths)
//
// Strategy: jest.isolateModules() per case to re-evaluate top-level env reads.
'use strict';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

function withEnv(envOverrides, fn) {
  process.env = { ...ORIGINAL_ENV };
  // Wipe the variables we care about
  delete process.env.JWT_SECRET;
  delete process.env.NODE_ENV;
  delete process.env.ADMIN_API_KEY;
  delete process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_KEY;
  delete process.env.TERAPEAK_BLOB_ACCOUNT;
  delete process.env.TERAPEAK_BLOB_CONTAINER;
  Object.assign(process.env, envOverrides);
  let result;
  jest.isolateModules(() => {
    result = fn();
  });
  return result;
}

describe('envFallbackMatrix -- production safety', () => {
  test('authService throws when JWT_SECRET is unset AND NODE_ENV=production', () => {
    expect(() => withEnv({ NODE_ENV: 'production' }, () => {
      require('../src/services/authService');
    })).toThrow(/JWT_SECRET environment variable is required in production/);
  });

  test('authService throws when JWT_SECRET is empty string AND NODE_ENV=production', () => {
    expect(() => withEnv({ NODE_ENV: 'production', JWT_SECRET: '' }, () => {
      require('../src/services/authService');
    })).toThrow(/JWT_SECRET environment variable is required in production/);
  });

  test('authService loads in development when JWT_SECRET is unset (warns, does not throw)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const svc = withEnv({ NODE_ENV: 'development' }, () => {
        return require('../src/services/authService');
      });
      expect(typeof svc.signup).toBe('function');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/JWT_SECRET not set/));
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('authService loads in test when JWT_SECRET is set explicitly', () => {
    const svc = withEnv({ NODE_ENV: 'test', JWT_SECRET: 'explicit-secret' }, () => {
      return require('../src/services/authService');
    });
    expect(typeof svc.signup).toBe('function');
  });
});

describe('envFallbackMatrix -- storage degraded mode', () => {
  test('both cosmos and blob disabled when no env set -> file-only mode', () => {
    const { cosmos, blob } = withEnv({}, () => {
      // Mock the SDK constructors so we never need real packages
      jest.doMock('@azure/cosmos', () => ({ CosmosClient: jest.fn() }));
      jest.doMock('@azure/storage-blob', () => ({ BlobServiceClient: jest.fn() }));
      jest.doMock('@azure/identity', () => ({ DefaultAzureCredential: jest.fn() }));
      return {
        cosmos: require('../src/utils/cosmosClient'),
        blob: require('../src/utils/blobClient'),
      };
    });
    expect(cosmos.isEnabled()).toBe(false);
    expect(blob.isEnabled()).toBe(false);
  });

  test('cosmos enabled, blob disabled is a valid combination', () => {
    const { cosmos, blob } = withEnv({
      COSMOS_ENDPOINT: 'https://example.documents.azure.com:443/',
      COSMOS_KEY: 'k',
    }, () => {
      jest.doMock('@azure/cosmos', () => ({ CosmosClient: jest.fn().mockImplementation(() => ({
        database: jest.fn().mockReturnValue({}),
      })) }));
      jest.doMock('@azure/storage-blob', () => ({ BlobServiceClient: jest.fn() }));
      jest.doMock('@azure/identity', () => ({ DefaultAzureCredential: jest.fn() }));
      return {
        cosmos: require('../src/utils/cosmosClient'),
        blob: require('../src/utils/blobClient'),
      };
    });
    expect(cosmos.isEnabled()).toBe(true);
    expect(blob.isEnabled()).toBe(false);
  });

  test('blob enabled, cosmos disabled is a valid combination', () => {
    const { cosmos, blob } = withEnv({
      TERAPEAK_BLOB_ACCOUNT: 'acct',
      TERAPEAK_BLOB_CONTAINER: 'comps',
    }, () => {
      jest.doMock('@azure/cosmos', () => ({ CosmosClient: jest.fn() }));
      jest.doMock('@azure/storage-blob', () => ({ BlobServiceClient: jest.fn() }));
      jest.doMock('@azure/identity', () => ({ DefaultAzureCredential: jest.fn() }));
      return {
        cosmos: require('../src/utils/cosmosClient'),
        blob: require('../src/utils/blobClient'),
      };
    });
    expect(cosmos.isEnabled()).toBe(false);
    expect(blob.isEnabled()).toBe(true);
  });
});

describe('envFallbackMatrix -- admin auth degraded mode', () => {
  test('requireAdminOrKey loads when ADMIN_API_KEY is unset (warns at request time only)', () => {
    // Module load must not throw -- the warning is per-request, not init.
    const mw = withEnv({ JWT_SECRET: 'present', NODE_ENV: 'test' }, () => {
      return require('../src/middleware/requireAdminOrKey');
    });
    expect(typeof mw).toBe('function');
  });

  test('requireAdminOrKey loads when ADMIN_API_KEY is empty string', () => {
    const mw = withEnv({ JWT_SECRET: 'present', NODE_ENV: 'test', ADMIN_API_KEY: '' }, () => {
      return require('../src/middleware/requireAdminOrKey');
    });
    expect(typeof mw).toBe('function');
  });
});
