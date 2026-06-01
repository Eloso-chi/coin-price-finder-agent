// __tests__/optionalAdminContext.test.js -- non-blocking admin detection
//
// Verifies #232 middleware: sets req.isAdmin without ever rejecting.
// Also pins down the defense-in-depth rule that a valid (non-admin) JWT
// must NOT fall through to the x-api-key path.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-opt';
process.env.ADMIN_API_KEY = 'test-admin-key-opt-1234567890';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-opt-admin-'));
process.env.CACHE_DIR = TMP;

const express = require('express');
const http = require('http');
const authService = require('../src/services/authService');
const optionalAdminContext = require('../src/middleware/optionalAdminContext');

let server, baseUrl;

beforeAll((done) => {
  const app = express();
  app.get('/probe', optionalAdminContext, (req, res) => {
    res.json({ isAdmin: req.isAdmin === true, via: req.adminActor?.via || null });
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

function call(headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/probe');
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

describe('optionalAdminContext', () => {
  test('anonymous request passes through with isAdmin=false (never 401/403)', async () => {
    const res = await call({});
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(false);
    expect(res.body.via).toBeNull();
  });

  test('valid ADMIN_API_KEY grants admin via api-key', async () => {
    const res = await call({ 'x-api-key': 'test-admin-key-opt-1234567890' });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
    expect(res.body.via).toBe('api-key');
  });

  test('wrong ADMIN_API_KEY stays anonymous (no rejection)', async () => {
    const res = await call({ 'x-api-key': 'wrong-key-of-some-length-here' });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(false);
  });

  test('valid admin JWT grants admin via jwt', async () => {
    authService._resetStore();
    await authService.signup('admin-alice', 'password123');
    await authService.grantAdmin('admin-alice');
    const { token } = await authService.login('admin-alice', 'password123');
    const res = await call({ Authorization: 'Bearer ' + token });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
    expect(res.body.via).toBe('jwt');
  });

  test('valid non-admin JWT stays anonymous (isAdmin=false)', async () => {
    authService._resetStore();
    await authService.signup('user-bob', 'password123');
    const { token } = await authService.login('user-bob', 'password123');
    const res = await call({ Authorization: 'Bearer ' + token });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(false);
  });

  test('invalid JWT stays anonymous and does NOT throw', async () => {
    const res = await call({ Authorization: 'Bearer not-a-real-jwt' });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(false);
  });

  // Defense-in-depth: established JWT identity must not be silently
  // overridden by a shared secret leaked into the same request.
  test('valid non-admin JWT prevents x-api-key escalation', async () => {
    authService._resetStore();
    await authService.signup('user-carol', 'password123');
    const { token } = await authService.login('user-carol', 'password123');
    const res = await call({
      Authorization: 'Bearer ' + token,
      'x-api-key': 'test-admin-key-opt-1234567890',
    });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(false);
  });

  test('invalid JWT + valid x-api-key still grants admin (api-key fallback)', async () => {
    const res = await call({
      Authorization: 'Bearer garbage-token',
      'x-api-key': 'test-admin-key-opt-1234567890',
    });
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
    expect(res.body.via).toBe('api-key');
  });
});
