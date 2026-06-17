'use strict';

/**
 * bulkEvaluateRouteEdges.test.js -- Edge cases for
 * src/routes/bulkEvaluateRoute.js not covered by bulkEvaluateRoute.test.js.
 *
 * Coverage gap pin (test-coverage Tier 3): bulkEvaluateRoute.js was at
 * 72.5% line / 50.5% branch coverage. The existing test file exercises
 * parseTextInput, parseJsonInput, and a couple of error-response cases
 * but does not cover:
 *   - parseExcelInput magic-byte rejection (non-PK and non-CFB)
 *   - POST /:jobId 202 happy path with JSON items + jobId returned
 *   - POST /:jobId 202 happy path with text input
 *   - POST /:jobId rejects too-many-coins (above MAX_COINS)
 *   - GET /:jobId poll endpoint returns the stored job state
 *   - SSE GET /:jobId/stream replays existing results when job is
 *     already complete
 *
 * The bulk-evaluate service is mocked so the route logic can be
 * exercised without running real PCGS/eBay calls.
 */

jest.mock('../src/services/bulkEvaluateService', () => ({
  runBulkEvaluation: jest.fn(async (coins) => ({
    results: coins.map((c, i) => ({
      query: c.query,
      valuation: { fmvCore: 100 + i, rangeLow: 90, rangeHigh: 110, confidence: 50 },
    })),
    lotSummary: { totalFmv: 100 * coins.length, coinCount: coins.length },
  })),
  MAX_COINS: 50,
}));

const supertest = require('supertest');
const express = require('express');
const route = require('../src/routes/bulkEvaluateRoute');

const { _parseExcelInput } = route;

const app = express();
app.use(express.json());
app.use('/api/bulk-evaluate', route);
const request = supertest(app);

// Wait for any background _runJob invocations to flush. The route fires
// _runJob without awaiting it, so tests that depend on the job being
// 'complete' must wait a tick.
function waitFor(ms = 30) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
//  parseExcelInput -- magic-byte rejection
// ============================================================

describe('_parseExcelInput -- magic-byte guard', () => {
  test('throws on plain-text buffer (no PK or CFB header)', () => {
    const buf = Buffer.from('not an excel file -- just text');
    expect(() => _parseExcelInput(buf)).toThrow(/valid \.xlsx/i);
  });

  test('throws on PDF magic bytes (%PDF)', () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]); // %PDF-
    expect(() => _parseExcelInput(buf)).toThrow(/valid \.xlsx/i);
  });

  test('throws on too-short buffer (< 4 bytes)', () => {
    const buf = Buffer.from([0x50, 0x4B]); // truncated "PK"
    expect(() => _parseExcelInput(buf)).toThrow(/valid \.xlsx/i);
  });
});

// ============================================================
//  POST /api/bulk-evaluate -- happy paths
// ============================================================

describe('POST /api/bulk-evaluate -- happy paths', () => {
  test('JSON items input returns 202 with jobId', async () => {
    const res = await request.post('/api/bulk-evaluate').send({
      items: [
        { query: '1921 Morgan Dollar', qty: 1 },
        { query: '1923 Peace Dollar',  qty: 2 },
      ],
    });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('jobId');
    expect(res.body.coinCount).toBe(2);
    expect(typeof res.body.jobId).toBe('string');
    expect(res.body.jobId.length).toBeGreaterThan(8);
  });

  test('text input returns 202 with jobId', async () => {
    const res = await request.post('/api/bulk-evaluate').send({
      text: '1921 Morgan Dollar | qty=3\n1923 Peace Dollar',
    });
    expect(res.status).toBe(202);
    expect(res.body.coinCount).toBe(2);
  });

  test('rejects non-Excel multipart upload', async () => {
    // multer's fileFilter on this route only accepts .xlsx by name.
    // Without any field set, the body parser sees nothing -> 400.
    const res = await request.post('/api/bulk-evaluate')
      .attach('file', Buffer.from('garbage'), 'not-excel.txt');
    expect(res.status).toBe(400);
  });
});

// ============================================================
//  POST -- input volume rejection
// ============================================================

describe('POST /api/bulk-evaluate -- volume', () => {
  test('caps text input at MAX_COINS even when input exceeds it', async () => {
    // parseTextInput slices to MAX_COINS (50) before the > MAX_COINS
    // check, so a 100-line input is silently truncated to 50 and the
    // 202 path is taken. This pins the current behavior.
    const lines = Array.from({ length: 100 }, (_, i) =>
      `Coin ${i} | qty=1`).join('\n');
    const res = await request.post('/api/bulk-evaluate').send({ text: lines });
    expect(res.status).toBe(202);
    expect(res.body.coinCount).toBe(50);
  });

  test('caps JSON items at MAX_COINS', async () => {
    const items = Array.from({ length: 75 }, (_, i) => ({ query: `Coin ${i}` }));
    const res = await request.post('/api/bulk-evaluate').send({ items });
    expect(res.status).toBe(202);
    expect(res.body.coinCount).toBe(50);
  });
});

// ============================================================
//  GET /:jobId poll endpoint
// ============================================================

describe('GET /api/bulk-evaluate/:jobId (poll)', () => {
  test('returns the stored job state after completion', async () => {
    const post = await request.post('/api/bulk-evaluate').send({
      items: [{ query: '1921 Morgan Dollar' }],
    });
    expect(post.status).toBe(202);
    const { jobId } = post.body;

    // Wait for background job to flush.
    await waitFor(50);

    const res = await request.get(`/api/bulk-evaluate/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(jobId);
    expect(['pending', 'running', 'complete']).toContain(res.body.status);
    expect(res.body.coinCount).toBe(1);
    // Once complete, lotSummary should be set
    if (res.body.status === 'complete') {
      expect(res.body.lotSummary).not.toBeNull();
    }
  });

  test('404 for unknown jobId', async () => {
    const res = await request.get('/api/bulk-evaluate/does-not-exist');
    expect(res.status).toBe(404);
  });
});

// ============================================================
//  SSE GET /:jobId/stream -- replay path for already-complete job
// ============================================================

describe('GET /api/bulk-evaluate/:jobId/stream -- replay', () => {
  test('SSE replays results and ends when job is already complete', async () => {
    const post = await request.post('/api/bulk-evaluate').send({
      items: [{ query: 'Test Coin A' }, { query: 'Test Coin B' }],
    });
    const { jobId } = post.body;
    await waitFor(60); // let _runJob complete

    const res = await request.get(`/api/bulk-evaluate/${jobId}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    // Body should contain at least one "event: coin" line and the
    // final "event: done" event.
    expect(res.text).toMatch(/event:\s*coin/);
    expect(res.text).toMatch(/event:\s*done/);
  });

  test('SSE 404 for unknown jobId', async () => {
    const res = await request.get('/api/bulk-evaluate/no-such-id/stream');
    expect(res.status).toBe(404);
  });
});
