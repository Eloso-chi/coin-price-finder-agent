// __tests__/authRoute.test.js — Integration tests for /api/auth/* endpoints
'use strict';

jest.mock('../src/services/authService');
const authService = require('../src/services/authService');

const express = require('express');
const http = require('http');
const authRoute = require('../src/routes/authRoute');

let app, server, baseUrl;

beforeAll((done) => {
  app = express();
  app.use(express.json());
  app.use('/api/auth', authRoute);
  server = app.listen(0, () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.resetAllMocks();
});

// ── Helper ──────────────────────────────────────────────────
function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ════════════════════════════════════════════════════════════
//  POST /api/auth/signup
// ════════════════════════════════════════════════════════════
describe('POST /api/auth/signup', () => {
  test('201-equivalent success (returns token)', async () => {
    authService.signup.mockResolvedValue({ userId: '1', username: 'alice', token: 'tok123' });
    const res = await req('POST', '/api/auth/signup', { username: 'alice', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('tok123');
    expect(authService.signup).toHaveBeenCalledWith('alice', 'pw');
  });

  test('409 when user already exists', async () => {
    authService.signup.mockRejectedValue(new Error('User already exists'));
    const res = await req('POST', '/api/auth/signup', { username: 'alice', password: 'pw' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  test('400 on generic error', async () => {
    authService.signup.mockRejectedValue(new Error('Password too short'));
    const res = await req('POST', '/api/auth/signup', { username: 'a', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Password too short/);
  });
});

// ════════════════════════════════════════════════════════════
//  POST /api/auth/login
// ════════════════════════════════════════════════════════════
describe('POST /api/auth/login', () => {
  test('success returns token', async () => {
    authService.login.mockResolvedValue({ userId: '1', username: 'bob', token: 'tok456' });
    const res = await req('POST', '/api/auth/login', { username: 'bob', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('tok456');
  });

  test('404 when user not found', async () => {
    authService.login.mockRejectedValue(new Error('User not found'));
    const res = await req('POST', '/api/auth/login', { username: 'nobody', password: 'pw' });
    expect(res.status).toBe(404);
  });

  test('401 on incorrect password', async () => {
    authService.login.mockRejectedValue(new Error('Incorrect password'));
    const res = await req('POST', '/api/auth/login', { username: 'bob', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('400 on generic error', async () => {
    authService.login.mockRejectedValue(new Error('Invalid input'));
    const res = await req('POST', '/api/auth/login', { username: '', password: '' });
    expect(res.status).toBe(400);
  });
});

// ════════════════════════════════════════════════════════════
//  GET /api/auth/me
// ════════════════════════════════════════════════════════════
describe('GET /api/auth/me', () => {
  test('returns user info for valid token', async () => {
    authService.verifyToken.mockReturnValue({ userId: '1', username: 'alice' });
    const res = await req('GET', '/api/auth/me', null, { Authorization: 'Bearer validtok' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: '1', username: 'alice' });
  });

  test('401 when no Authorization header', async () => {
    const res = await req('GET', '/api/auth/me', null);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Not authenticated/);
  });

  test('401 when token is invalid', async () => {
    authService.verifyToken.mockImplementation(() => { throw new Error('invalid'); });
    const res = await req('GET', '/api/auth/me', null, { Authorization: 'Bearer badtok' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or expired/);
  });
});

// ════════════════════════════════════════════════════════════
//  POST /api/auth/change-password
// ════════════════════════════════════════════════════════════
describe('POST /api/auth/change-password', () => {
  test('success returns ok', async () => {
    authService.verifyToken.mockReturnValue({ userId: '1', username: 'alice' });
    authService.changePassword.mockResolvedValue();
    const res = await req('POST', '/api/auth/change-password',
      { currentPassword: 'old', newPassword: 'new' },
      { Authorization: 'Bearer tok' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(authService.changePassword).toHaveBeenCalledWith('alice', 'old', 'new');
  });

  test('401 when no token', async () => {
    const res = await req('POST', '/api/auth/change-password',
      { currentPassword: 'old', newPassword: 'new' });
    expect(res.status).toBe(401);
  });

  test('401 on incorrect current password', async () => {
    authService.verifyToken.mockReturnValue({ userId: '1', username: 'alice' });
    authService.changePassword.mockRejectedValue(new Error('Incorrect current password'));
    const res = await req('POST', '/api/auth/change-password',
      { currentPassword: 'wrong', newPassword: 'new' },
      { Authorization: 'Bearer tok' });
    expect(res.status).toBe(401);
  });

  test('400 on generic error', async () => {
    authService.verifyToken.mockReturnValue({ userId: '1', username: 'alice' });
    authService.changePassword.mockRejectedValue(new Error('Password too short'));
    const res = await req('POST', '/api/auth/change-password',
      { currentPassword: 'old', newPassword: '' },
      { Authorization: 'Bearer tok' });
    expect(res.status).toBe(400);
  });
});
