// __tests__/requireAdminOrKey.test.js -- middleware precedence + audit emission
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-mw';
process.env.ADMIN_API_KEY = 'test-admin-key-1234567890';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-admin-'));
process.env.CACHE_DIR = TMP;

// Mock auditService so we can assert what was emitted.
jest.mock('../src/services/auditService', () => ({
  audit: jest.fn().mockResolvedValue(undefined),
}));
const auditService = require('../src/services/auditService');

const express = require('express');
const http = require('http');
const authService = require('../src/services/authService');
const requireAdmin = require('../src/middleware/requireAdminOrKey');

let server, baseUrl;

beforeAll((done) => {
  const app = express();
  app.get('/admin', requireAdmin, (req, res) => {
    res.json({ ok: true, via: req.admin.via, actor: req.admin.actor });
  });
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(done);
});
beforeEach(() => {
  auditService.audit.mockClear();
});

function call(headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/admin');
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'GET', headers,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: body ? JSON.parse(body) : {} }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('requireAdminOrKey', () => {
  test('rejects request with no credentials', async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect(auditService.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin-denied' }));
  });

  test('accepts valid x-api-key and audits admin-key-use', async () => {
    const res = await call({ 'x-api-key': 'test-admin-key-1234567890' });
    expect(res.status).toBe(200);
    expect(res.body.via).toBe('api-key');
    expect(auditService.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin-key-use' }));
  });

  test('rejects wrong x-api-key', async () => {
    const res = await call({ 'x-api-key': 'wrong-key-of-some-length-here' });
    expect(res.status).toBe(401);
  });

  test('accepts isAdmin JWT and prefers it over x-api-key', async () => {
    authService._resetStore();
    await authService.signup('alice', 'password123');
    await authService.grantAdmin('alice');
    const { token } = await authService.login('alice', 'password123');

    const res = await call({ Authorization: 'Bearer ' + token });
    expect(res.status).toBe(200);
    expect(res.body.via).toBe('jwt');
    expect(res.body.actor.username).toBe('alice');
  });

  test('rejects non-admin JWT with 403', async () => {
    authService._resetStore();
    await authService.signup('bob', 'password123');
    const { token } = await authService.login('bob', 'password123');
    const res = await call({ Authorization: 'Bearer ' + token });
    expect(res.status).toBe(403);
    expect(auditService.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin-denied',
      meta: expect.objectContaining({ reason: 'not-admin' }),
    }));
  });

  test('revoked admin JWT falls through and is rejected', async () => {
    authService._resetStore();
    await authService.signup('carol', 'password123');
    await authService.grantAdmin('carol');
    const { token } = await authService.login('carol', 'password123');
    await authService.revokeAdmin('carol');
    const res = await call({ Authorization: 'Bearer ' + token });
    expect(res.status).toBe(401);
  });
});
