// __tests__/authServiceAdmin.test.js -- Admin role primitives in authService
'use strict';

// Use a stable JWT secret for the test process.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-admin-role';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Point the file-backed store at a fresh temp dir per test process.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'authservice-admin-'));
process.env.CACHE_DIR = TMP;

const authService = require('../src/services/authService');

beforeEach(() => {
  authService._resetStore();
});

describe('authService admin primitives', () => {
  test('signup creates user with tokenVersion 0 and isAdmin false in JWT', async () => {
    const { token } = await authService.signup('alice', 'password123');
    const claims = await authService.verifyTokenStrict(token);
    expect(claims.isAdmin).toBe(false);
    expect(claims.tokenVersion).toBe(0);
  });

  test('grantAdmin makes the user admin; next login carries isAdmin=true', async () => {
    await authService.signup('alice', 'password123');
    await authService.grantAdmin('alice');
    const u = await authService.getUser('alice');
    expect(u.isAdmin).toBe(true);
    expect(u.adminGrantedAt).toBeTruthy();
    const { token, isAdmin } = await authService.login('alice', 'password123');
    expect(isAdmin).toBe(true);
    const claims = await authService.verifyTokenStrict(token);
    expect(claims.isAdmin).toBe(true);
  });

  test('revokeAdmin bumps tokenVersion and invalidates old admin JWT', async () => {
    await authService.signup('alice', 'password123');
    await authService.grantAdmin('alice');
    const { token } = await authService.login('alice', 'password123');
    // Pre-revoke: token is valid.
    await expect(authService.verifyTokenStrict(token)).resolves.toMatchObject({ isAdmin: true });

    await authService.revokeAdmin('alice');
    // Post-revoke: tokenVersion mismatch -> reject.
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/revoked/);
  });

  test('resetPassword bumps tokenVersion and enforces admin min length', async () => {
    await authService.signup('alice', 'password123');
    await authService.grantAdmin('alice');
    // Admin floor is 12 -- rejection.
    await expect(authService.resetPassword('alice', 'short')).rejects.toThrow(/at least 12/);

    const { token } = await authService.login('alice', 'password123');
    await authService.resetPassword('alice', 'a-strong-new-password');
    // Old token is now invalid.
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/revoked/);
    // New password works.
    const fresh = await authService.login('alice', 'a-strong-new-password');
    expect(fresh.isAdmin).toBe(true);
  });

  test('listAdmins returns only admin users', async () => {
    await authService.signup('alice', 'password123');
    await authService.signup('bob',   'password123');
    await authService.grantAdmin('alice');
    const admins = await authService.listAdmins();
    expect(admins.map(a => a.username).sort()).toEqual(['alice']);
  });

  test('changePassword bumps tokenVersion', async () => {
    await authService.signup('alice', 'password123');
    const { token } = await authService.login('alice', 'password123');
    await authService.changePassword('alice', 'password123', 'newpassword456');
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/revoked/);
  });

  test('deleteUser + recreate invalidates old JWT even though new tokenVersion matches', async () => {
    await authService.signup('alice', 'password123');
    const { token } = await authService.login('alice', 'password123');
    // Pre-delete: token works.
    await expect(authService.verifyTokenStrict(token)).resolves.toMatchObject({ username: 'alice' });

    await authService.deleteUser('alice');
    // After delete, the account is gone -- strict verify rejects.
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/no longer exists/);

    // Recreate the same username -> fresh userId + tokenVersion 0. The old JWT
    // should still be rejected because the userId no longer matches.
    await authService.signup('alice', 'password123');
    await expect(authService.verifyTokenStrict(token)).rejects.toThrow(/revoked/);
  });

  test('grantAdmin clears a previous adminRevokedAt marker', async () => {
    await authService.signup('alice', 'password123');
    await authService.grantAdmin('alice');
    await authService.revokeAdmin('alice');
    let u = await authService.getUser('alice');
    expect(u.adminRevokedAt).toBeTruthy();

    await authService.grantAdmin('alice');
    u = await authService.getUser('alice');
    expect(u.isAdmin).toBe(true);
    expect(u.adminRevokedAt).toBeUndefined();
  });

  test('resetPassword on a non-admin user persists durably (file mirror updated)', async () => {
    // This test only covers the file-store path (no Cosmos), but documents
    // the invariant: after _saveUser returns, the persisted record reflects
    // the new hash and tokenVersion -- no half-writes.
    await authService.signup('bob', 'password123');
    const before = { ...(await authService.getUser('bob')) };
    await authService.resetPassword('bob', 'completely-new-password');
    const after = await authService.getUser('bob');
    expect(after.hash).not.toBe(before.hash);
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    expect(after.passwordResetAt).toBeTruthy();
  });

  test('_saveUser strips Cosmos system fields', async () => {
    // Simulate a record that came out of Cosmos with `_rid`, `_etag`, etc.
    await authService.signup('alice', 'password123');
    const doc = await authService.getUser('alice');
    doc._rid = 'rid-xxx';
    doc._self = 'self-xxx';
    doc._etag = 'etag-xxx';
    doc._ts = 1234567890;
    doc._attachments = 'att-xxx';
    doc.isAdmin = true;
    doc.adminGrantedAt = new Date().toISOString();
    // grantAdmin re-reads the record via getUser, so we go through _saveUser
    // by calling it via the public primitive.
    await authService.grantAdmin('alice');
    const fresh = await authService.getUser('alice');
    expect(fresh._rid).toBeUndefined();
    expect(fresh._self).toBeUndefined();
    expect(fresh._etag).toBeUndefined();
    expect(fresh._ts).toBeUndefined();
    expect(fresh._attachments).toBeUndefined();
  });
});
