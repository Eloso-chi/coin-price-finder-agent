// __tests__/adminMetalsHistoryRoute.test.js -- #333H: POST /api/admin/metals-history/import
'use strict';

jest.mock('../src/services/adminService');
jest.mock('../src/services/metalsHistoryService');
jest.mock('../src/services/auditService', () => ({ audit: jest.fn(() => Promise.resolve()) }));
const metalsHistory = require('../src/services/metalsHistoryService');
const auditService = require('../src/services/auditService');

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
    req.admin = { actor: { userId: 'admin-key', username: 'admin-key' }, via: 'api-key' };
    next();
  }, adminRoute);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});

afterAll((done) => { server.close(done); });
beforeEach(() => { jest.clearAllMocks(); auditService.audit.mockImplementation(() => Promise.resolve()); });

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

const SUMMARY = { XAU: { added: 1, replaced: 1, kept: 0, skippedOld: 0, previous: { '2026-03-03': 5071.5 } } };

describe('POST /api/admin/metals-history/import', () => {
  test('without the admin key it is refused and nothing is imported or audited', async () => {
    const res = await post({ history: { XAU: { '2026-01-01': 1 } } }, {});
    expect(res.status).toBe(401);
    expect(metalsHistory.importHistory).not.toHaveBeenCalled();
    expect(auditService.audit).not.toHaveBeenCalled();
  });

  test('passes the history and replaceDays to the service and returns summary and persistence', async () => {
    const persisted = { file: 'ok', cosmos: 'disabled' };
    metalsHistory.importHistory.mockResolvedValue({ summary: SUMMARY, persisted });
    const res = await post({ history: { XAU: { '2026-01-01': 5 } }, replaceDays: ['2026-03-03'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, summary: SUMMARY, persisted });
    expect(metalsHistory.importHistory).toHaveBeenCalledWith({ XAU: { '2026-01-01': 5 } }, { replaceDays: ['2026-03-03'] });
  });

  test('every import is audited with the actor, counts, replaced days and the previous prices', async () => {
    const persisted = { file: 'ok', cosmos: 'ok' };
    metalsHistory.importHistory.mockResolvedValue({ summary: SUMMARY, persisted });
    await post({ history: { XAU: { '2026-01-01': 5 } }, replaceDays: ['2026-03-03'] });
    expect(auditService.audit).toHaveBeenCalledTimes(1);
    expect(auditService.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'metals-history-import',
      actor: { userId: 'admin-key', username: 'admin-key' },
      meta: {
        counts: { XAU: { added: 1, replaced: 1, kept: 0, skippedOld: 0 } },
        replaceDays: ['2026-03-03'],
        persisted,
        previous: { XAU: { '2026-03-03': 5071.5 } },
      },
    }));
  });

  test('a failing audit write does not fail the import', async () => {
    metalsHistory.importHistory.mockResolvedValue({ summary: SUMMARY, persisted: { file: 'ok', cosmos: 'disabled' } });
    auditService.audit.mockImplementation(() => Promise.reject(new Error('audit down')));
    const res = await post({ history: { XAU: {} } });
    expect(res.status).toBe(200);
  });

  test('replaceDays defaults to an empty list', async () => {
    metalsHistory.importHistory.mockResolvedValue({ summary: {}, persisted: { file: 'unchanged', cosmos: 'unchanged' } });
    await post({ history: { XAU: {} } });
    expect(metalsHistory.importHistory).toHaveBeenCalledWith({ XAU: {} }, { replaceDays: [] });
  });

  test('a store file that could not be written is a 500 that still reports what was applied', async () => {
    const persisted = { file: 'failed', cosmos: 'disabled' };
    metalsHistory.importHistory.mockResolvedValue({ summary: SUMMARY, persisted });
    const res = await post({ history: { XAU: { '2026-01-01': 5 } } });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'Imported in memory but the store file could not be written', summary: SUMMARY, persisted });
  });

  test('a validation failure is a 400 with its message and is audited as rejected', async () => {
    const err = new Error('implausible XAG price on 2026-01-01');
    err.name = 'ImportError';
    metalsHistory.importHistory.mockRejectedValue(err);
    const res = await post({ history: { XAG: { '2026-01-01': 9999 } } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'implausible XAG price on 2026-01-01' });
    expect(auditService.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'metals-history-import-rejected',
      meta: { reason: 'implausible XAG price on 2026-01-01' },
    }));
  });

  test('an unexpected failure is a 500 that does not leak the cause', async () => {
    metalsHistory.importHistory.mockRejectedValue(new Error('disk path /secret/location failed'));
    const res = await post({ history: { XAU: {} } });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to import metals history' });
  });

  test('a body without history reaches the service, which rejects it', async () => {
    const err = new Error('history must be an object keyed by metal');
    err.name = 'ImportError';
    metalsHistory.importHistory.mockRejectedValue(err);
    const res = await post({});
    expect(res.status).toBe(400);
    expect(metalsHistory.importHistory).toHaveBeenCalledWith(undefined, { replaceDays: [] });
  });
});
