// __tests__/authServiceStrictCache.test.js
// Coverage for the verifyTokenStrict TTL cache (backlog #218).
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-strict-cache';
process.env.STRICT_TOKEN_CACHE_TTL_MS = process.env.STRICT_TOKEN_CACHE_TTL_MS || '5000';

const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'authservice-strict-'));
process.env.CACHE_DIR = TMP;

const authService = require('../src/services/authService');

beforeEach(() => {
  authService._resetStore();
  authService._strictCacheClear();
});

describe('verifyTokenStrict TTL cache (#218)', () => {
  test('populates cache on first verify and reuses it', async () => {
    const { token } = await authService.signup('alice', 'password123');
    expect(authService._strictCacheSize()).toBe(0);
    const claims = await authService.verifyTokenStrict(token);
    expect(claims.username).toBe('alice');
    expect(authService._strictCacheSize()).toBe(1);
    for (let i = 0; i < 3; i++) await authService.verifyTokenStrict(token);
    expect(authService._strictCacheSize()).toBe(1);
  });

  test('grantAdmin invalidates the cache entry', async () => {
    const { token } = await authService.signup('bob', 'password123');
    await authService.verifyTokenStrict(token);
    expect(authService._strictCacheSize()).toBe(1);
    await authService.grantAdmin('bob');
    expect(authService._strictCacheSize()).toBe(0);
    const claims = await authService.verifyTokenStrict(token);
    expect(claims.isAdmin).toBe(true);
  });

  test('revokeAdmin invalidates cache; stale admin token then fails', async () => {
    await authService.signup('carol', 'password123');
    await authService.grantAdmin('carol');
    const { token } = await authService.login('carol', 'password123');
    expect((await authService.verifyTokenStrict(token)).isAdmin).toBe(true);
    expect(authService._strictCacheSize()).toBe(1);
    await authService.revokeAdmin('carol');
    expect(authService._strictCacheSize()).toBe(0);
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/revoked/);
  });

  test('changePassword invalidates cache and revokes token', async () => {
    const { token } = await authService.signup('dave', 'password123');
    await authService.verifyTokenStrict(token);
    expect(authService._strictCacheSize()).toBe(1);
    await authService.changePassword('dave', 'password123', 'newpass789');
    expect(authService._strictCacheSize()).toBe(0);
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/revoked/);
  });

  test('resetPassword invalidates cache', async () => {
    const { token } = await authService.signup('erin', 'password123');
    await authService.verifyTokenStrict(token);
    expect(authService._strictCacheSize()).toBe(1);
    await authService.resetPassword('erin', 'brandNewSecret9');
    expect(authService._strictCacheSize()).toBe(0);
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/revoked/);
  });

  test('deleteUser invalidates cache', async () => {
    const { token } = await authService.signup('frank', 'password123');
    await authService.verifyTokenStrict(token);
    expect(authService._strictCacheSize()).toBe(1);
    await authService.deleteUser('frank');
    expect(authService._strictCacheSize()).toBe(0);
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/no longer exists/);
  });

  
  test('rejects token when userId mismatches (account recreated)', async () => {
    const { token } = await authService.signup('ivy', 'password123');
    await authService.verifyTokenStrict(token);
    await authService.deleteUser('ivy');
    await authService.signup('ivy', 'password123');
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/revoked|no longer/);
  });

  test('STRICT_TOKEN_CACHE_TTL_MS=0 disables caching', async () => {
    jest.resetModules();
    process.env.STRICT_TOKEN_CACHE_TTL_MS = '0';
    const disabled = require('../src/services/authService');
    disabled._resetStore();
    disabled._strictCacheClear();
    const { token } = await disabled.signup('hank', 'password123');
    await disabled.verifyTokenStrict(token);
    await disabled.verifyTokenStrict(token);
    await disabled.verifyTokenStrict(token);
    expect(disabled._strictCacheSize()).toBe(0);
    process.env.STRICT_TOKEN_CACHE_TTL_MS = '5000';
    jest.resetModules();
  });

  test('TTL expiry causes re-population on next verify', async () => {
    jest.resetModules();
    process.env.STRICT_TOKEN_CACHE_TTL_MS = '20';
    const fresh = require('../src/services/authService');
    fresh._resetStore();
    fresh._strictCacheClear();
    const { token } = await fresh.signup('gina', 'password123');
    await fresh.verifyTokenStrict(token);
    expect(fresh._strictCacheSize()).toBe(1);
    await new Promise(r => setTimeout(r, 40));
    await fresh.verifyTokenStrict(token);
    expect(fresh._strictCacheSize()).toBe(1);
    process.env.STRICT_TOKEN_CACHE_TTL_MS = '5000';
    jest.resetModules();
  });
});
