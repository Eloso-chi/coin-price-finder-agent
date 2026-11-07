// __tests__/adminMetalsHistoryRoute.test.js -- #333H: POST /api/admin/metals-history/import
'use strict';

jest.mock('../src/services/adminService');
jest.mock('../src/services/metalsHistoryService');
const metalsHistory = require('../src/services/metalsHistoryService');

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const adminRoute = require('../src/routes/adminRoute');

const TEST_KEY = 'test-admin-key-12345';
let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', (req, res, next) => {
    const provided = req.headers['x-api-key'] || '';
    if (provided.length !== TEST_KEY.length || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TEST_KEY))) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
  }, adminRoute);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});

afterAll((done) => { server.close(done); });
beforeEach(() => { jest.clearAllMocks(); });

function post(body, headers = { 'x-api-key': TEST_KEY }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const url = new URL(`${baseUrl}/api/admin/metals-history/import`);
    const r = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    r.on('error', reject);
    r.end(data);
  });
}

describe('POST /api/admin/metals-history/import', () => {
  test('without the admin key it is refused and nothing is imported', async () => {
    const res = await post({ history: { XAU: { '2026-01-01': 1 } } }, {});
    expect(res.status).toBe(401);
    expect(metalsHistory.importHistory).not.toHaveBeenCalled();
  });

  test('passes the history and replaceDays to the service and returns its summary', async () => {
    const summary = { XAU: { added: 1, replaced: 0, kept: 0, skippedOld: 0 } };
    metalsHistory.importHistory.mockReturnValue(summary);
    const res = await post({ history: { XAU: { '2026-01-01': 5 } }, replaceDays: ['2026-01-01'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, summary });
    expect(metalsHistory.importHistory).toHaveBeenCalledWith({ XAU: { '2026-01-01': 5 } }, { replaceDays: ['2026-01-01'] });
  });

  test('replaceDays defaults to an empty list', async () => {
    metalsHistory.importHistory.mockReturnValue({});
    await post({ history: { XAU: {} } });
    expect(metalsHistory.importHistory).toHaveBeenCalledWith({ XAU: {} }, { replaceDays: [] });
  });

  test('a validation failure from the service is a 400 with its message', async () => {
    const err = new Error('unknown metal in history');
    err.name = 'ImportError';
    metalsHistory.importHistory.mockImplementation(() => { throw err; });
    const res = await post({ history: { DOGE: {} } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown metal in history' });
  });

  test('an unexpected failure is a 500 that does not leak the cause', async () => {
    metalsHistory.importHistory.mockImplementation(() => { throw new Error('disk path /secret/location failed'); });
    const res = await post({ history: { XAU: {} } });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to import metals history' });
  });

  test('a body without history reaches the service, which rejects it', async () => {
    const err = new Error('history must be an object keyed by metal');
    err.name = 'ImportError';
    metalsHistory.importHistory.mockImplementation(() => { throw err; });
    const res = await post({});
    expect(res.status).toBe(400);
    expect(metalsHistory.importHistory).toHaveBeenCalledWith(undefined, { replaceDays: [] });
  });
});
