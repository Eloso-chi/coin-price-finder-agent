// __tests__/bulkEvaluate.test.js -- Tests for Bulk Collection Evaluator (service + route)
'use strict';

// ── Mock dependencies ────────────────────────────────────────

jest.mock('../src/services/pcgsService', () => ({
  parseDescription: jest.fn((q) => ({
    series: 'Morgan Dollar',
    year: 1921,
    mint: null,
    grade: 'MS-65',
    gradeNum: 65,
    weight: null,
    finish: null,
    metal: null,
    isRoll: false,
  })),
  resolveFromDescription: jest.fn(async () => ({ verified: false })),
}));

jest.mock('../src/services/ebayService', () => ({
  buildKeywords: jest.fn((_pcgs, query) => query),
  fetchSoldComps: jest.fn(async () => ({
    us: {
      comps: [
        { itemId: 'c1', title: 'Test', totalUsd: 50, matchScore: 80, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'terapeak' },
        { itemId: 'c2', title: 'Test 2', totalUsd: 55, matchScore: 75, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'terapeak' },
        { itemId: 'c3', title: 'Test 3', totalUsd: 48, matchScore: 70, gradeType: 'raw', soldDate: new Date().toISOString(), _source: 'terapeak' },
      ],
      stats: { count: 3, median: 50, mean: 51 },
    },
    global: { comps: [], stats: { count: 0 } },
    usedFallback: false,
  })),
}));

jest.mock('../src/services/greysheetService', () => ({
  fetchPriceByPcgsNumber: jest.fn(async () => null),
  fetchTypePrice: jest.fn(async () => null),
}));

jest.mock('../src/services/valuationService', () => ({
  computeValuation: jest.fn(() => ({
    valuation: { fmvCore: 52.00, rangeLow: 45.00, rangeHigh: 58.00, confidence: 72, method: 'certified' },
    decisions: { buy: {}, sell: {} },
  })),
}));

jest.mock('../src/services/metalsSpotPrice', () => ({
  getMetalsSpotPrice: jest.fn(async () => ({ price: 30.50, currency: 'USD' })),
}));

jest.mock('../src/utils/coinMetalProfile', () => ({
  getCoinMetalProfile: jest.fn(() => ({ isMetalBased: true, metal: 'silver' })),
}));

jest.mock('../src/data/constants', () => ({
  ...jest.requireActual('../src/data/constants'),
  zodiacForYear: jest.fn(() => null),
  perthLunarSeries: jest.fn(() => null),
  getRollQuantity: jest.fn(() => 20),
}));

jest.mock('../src/utils/excelMapper', () => ({
  mapExcelToBackup: jest.fn(async () => ({
    payload: { coins: [{ name: '1921 Morgan Dollar', count: 1, grade: 'MS-65' }] },
  })),
  parseCoinString: jest.fn(() => ({})),
}));

// ── Imports ──────────────────────────────────────────────────

const {
  runBulkEvaluation,
  evaluateOneCoin,
  computeLotSummary,
  sizeDiscount,
  confidencePenalty,
  concentrationPenalty,
  _cache,
  MAX_COINS,
  MAX_ACTIVE_JOBS,
} = require('../src/services/bulkEvaluateService');

const greysheetService = require('../src/services/greysheetService');

// ── Service: sizeDiscount ────────────────────────────────────
describe('bulkEvaluateService', () => {

  beforeEach(() => {
    _cache.clear();
    jest.clearAllMocks();
  });

  describe('sizeDiscount', () => {
    it('returns 0 for 1-10 coins', () => {
      expect(sizeDiscount(1)).toBe(0);
      expect(sizeDiscount(10)).toBe(0);
    });
    it('returns 5% for 11-50', () => {
      expect(sizeDiscount(11)).toBe(0.05);
      expect(sizeDiscount(50)).toBe(0.05);
    });
    it('returns 10% for 51-100', () => {
      expect(sizeDiscount(51)).toBe(0.10);
      expect(sizeDiscount(100)).toBe(0.10);
    });
    it('returns 15% for 101-250', () => {
      expect(sizeDiscount(101)).toBe(0.15);
      expect(sizeDiscount(250)).toBe(0.15);
    });
    it('returns 20% for 251+', () => {
      expect(sizeDiscount(251)).toBe(0.20);
      expect(sizeDiscount(500)).toBe(0.20);
    });
  });

  // ── Service: confidencePenalty ──────────────────────────────
  describe('confidencePenalty', () => {
    it('returns 5% when avgConfidence < 60', () => {
      expect(confidencePenalty(50)).toBe(0.05);
      expect(confidencePenalty(0)).toBe(0.05);
    });
    it('returns 0 when avgConfidence >= 60', () => {
      expect(confidencePenalty(60)).toBe(0);
      expect(confidencePenalty(90)).toBe(0);
    });
  });

  // ── Service: concentrationPenalty ──────────────────────────
  describe('concentrationPenalty', () => {
    it('flags coin > 50% of lot', () => {
      const results = [
        { query: 'big coin', totalFmv: 600 },
        { query: 'small coin', totalFmv: 100 },
      ];
      const { penalty, flags } = concentrationPenalty(results);
      expect(penalty).toBe(0.03);
      expect(flags).toHaveLength(1);
      expect(flags[0].risk).toBe('high');
    });

    it('flags coin > 25% of lot as moderate', () => {
      const results = [
        { query: 'a', totalFmv: 200 },
        { query: 'b', totalFmv: 300 },
        { query: 'c', totalFmv: 200 },
        { query: 'd', totalFmv: 200 },
        { query: 'e', totalFmv: 100 },
      ];
      const { penalty, flags } = concentrationPenalty(results);
      expect(penalty).toBe(0);
      expect(flags).toHaveLength(1);
      expect(flags[0].query).toBe('b');
      expect(flags[0].risk).toBe('moderate');
    });

    it('returns no penalty when well-distributed', () => {
      const results = Array.from({ length: 10 }, (_, i) => ({
        query: `coin ${i}`,
        totalFmv: 100,
      }));
      const { penalty, flags } = concentrationPenalty(results);
      expect(penalty).toBe(0);
      expect(flags).toHaveLength(0);
    });

    it('handles empty/zero-total gracefully', () => {
      expect(concentrationPenalty([])).toEqual({ penalty: 0, flags: [] });
      expect(concentrationPenalty([{ query: 'x', totalFmv: 0 }])).toEqual({ penalty: 0, flags: [] });
    });
  });

  // ── Service: computeLotSummary ─────────────────────────────
  describe('computeLotSummary', () => {
    it('computes summary for priced results', () => {
      const results = [
        { query: 'a', fmv: 100, totalFmv: 200, confidence: 80, isBullion: true, meltValue: 60 },
        { query: 'b', fmv: 50, totalFmv: 50, confidence: 70, isBullion: false, meltValue: 30 },
      ];
      const summary = computeLotSummary(results);
      expect(summary.pricedCount).toBe(2);
      expect(summary.totalFmv).toBe(250);
      expect(summary.totalMelt).toBe(90);
      expect(summary.avgConfidence).toBe(75);
      expect(summary.bullionCount).toBe(1);
      expect(summary.buyTiers).toHaveProperty('cherryPick');
      expect(summary.buyTiers).toHaveProperty('fairLot');
      expect(summary.buyTiers).toHaveProperty('fullRetail');
      expect(summary.buyTiers.cherryPick).toBeLessThan(summary.buyTiers.fairLot);
      expect(summary.buyTiers.fairLot).toBeLessThan(summary.buyTiers.fullRetail);
    });

    it('handles mix of priced and failed results', () => {
      const results = [
        { query: 'good', fmv: 100, totalFmv: 100, confidence: 80, isBullion: false, meltValue: 0 },
        { query: 'bad', error: 'not found' },
      ];
      const summary = computeLotSummary(results);
      expect(summary.pricedCount).toBe(1);
      expect(summary.failedCount).toBe(1);
      expect(summary.coinCount).toBe(2);
    });

    it('handles all-failed gracefully', () => {
      const results = [{ query: 'x', error: 'fail' }];
      const summary = computeLotSummary(results);
      expect(summary.pricedCount).toBe(0);
      expect(summary.failedCount).toBe(1);
      expect(summary.totalFmv).toBe(0);
      expect(summary.avgConfidence).toBe(0);
    });
  });

  // ── Service: evaluateOneCoin ───────────────────────────────
  describe('evaluateOneCoin', () => {
    it('returns result with expected fields', async () => {
      const result = await evaluateOneCoin({ query: '1921 Morgan Dollar MS-65', qty: 2 });
      expect(result).toHaveProperty('query', '1921 Morgan Dollar MS-65');
      expect(result).toHaveProperty('qty', 2);
      expect(result).toHaveProperty('fmv', 52.00);
      expect(result).toHaveProperty('totalFmv', 104.00);
      expect(result).toHaveProperty('confidence', 72);
      expect(result).toHaveProperty('method', 'certified');
      expect(result).toHaveProperty('avgEbay', 50);
      expect(result).toHaveProperty('compCount', 3);
    });

    it('defaults qty to 1', async () => {
      const result = await evaluateOneCoin({ query: '1921 Morgan Dollar MS-65' });
      expect(result.qty).toBe(1);
      expect(result.totalFmv).toBe(52.00);
    });

    it('returns error for empty query', async () => {
      const result = await evaluateOneCoin({ query: '' });
      expect(result).toHaveProperty('error', 'missing query');
    });

    it('returns error for missing query', async () => {
      const result = await evaluateOneCoin({});
      expect(result).toHaveProperty('error', 'missing query');
    });

    it('clamps qty to valid range', async () => {
      const result = await evaluateOneCoin({ query: '1921 Morgan Dollar', qty: 99999 });
      expect(result.qty).toBe(9999);
    });

    it('passes finish hint to fetchTypePrice for proof coins', async () => {
      const pcgsService = require('../src/services/pcgsService');
      pcgsService.parseDescription.mockReturnValueOnce({
        series: 'Silver Eagle', year: 2024, mint: null, grade: 'PR-70',
        gradeNum: 70, weight: 1, finish: 'Proof', metal: 'silver', isRoll: false,
      });
      await evaluateOneCoin({ query: '2024 Silver Eagle Proof PR-70' });
      expect(greysheetService.fetchTypePrice).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Number),
        expect.objectContaining({ finish: 'Proof' })
      );
    });
  });

  // ── Service: runBulkEvaluation ─────────────────────────────
  describe('runBulkEvaluation', () => {
    it('evaluates multiple coins and returns lot summary', async () => {
      const coins = [
        { query: '1921 Morgan Dollar MS-65' },
        { query: '1964 Kennedy Half Dollar PR-69' },
      ];
      const onProgress = jest.fn();
      const { results, lotSummary } = await runBulkEvaluation(coins, onProgress);
      expect(results).toHaveLength(2);
      expect(lotSummary).toHaveProperty('totalFmv');
      expect(lotSummary).toHaveProperty('buyTiers');
      expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it('calls onProgress with index and total', async () => {
      const coins = [{ query: 'coin 1' }, { query: 'coin 2' }, { query: 'coin 3' }];
      const calls = [];
      await runBulkEvaluation(coins, (result, index, total) => {
        calls.push({ index, total });
      });
      expect(calls).toHaveLength(3);
      calls.forEach(c => expect(c.total).toBe(3));
      const indices = calls.map(c => c.index).sort();
      expect(indices).toEqual([0, 1, 2]);
    });

    it('rejects empty array', async () => {
      await expect(runBulkEvaluation([], jest.fn())).rejects.toThrow('coins array is required');
    });

    it('rejects over MAX_COINS', async () => {
      const coins = Array.from({ length: MAX_COINS + 1 }, (_, i) => ({ query: `coin ${i}` }));
      await expect(runBulkEvaluation(coins, jest.fn())).rejects.toThrow(/Maximum/);
    });

    it('caches results and replays on second call', async () => {
      const coins = [{ query: 'cached coin' }];
      const progress1 = jest.fn();
      const progress2 = jest.fn();
      const r1 = await runBulkEvaluation(coins, progress1);
      const r2 = await runBulkEvaluation(coins, progress2);
      expect(r1.results).toEqual(r2.results);
      expect(progress2).toHaveBeenCalledTimes(1); // replayed from cache
    });
  });
});

// ── Route tests ──────────────────────────────────────────────

const http = require('http');
const express = require('express');
const bulkEvaluateRoute = require('../src/routes/bulkEvaluateRoute');

let app, server, baseUrl;

beforeAll((done) => {
  app = express();
  app.use(express.json());
  app.use('/api/bulk-evaluate', bulkEvaluateRoute);
  server = app.listen(0, () => {
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(baseUrl + path);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sseStream(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const events = [];
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        // Parse SSE events
        const parts = buf.split('\n\n');
        buf = parts.pop(); // keep incomplete
        for (const part of parts) {
          const evtMatch = part.match(/^event:\s*(.+)/m);
          const dataMatch = part.match(/^data:\s*(.+)/m);
          if (evtMatch && dataMatch) {
            try {
              events.push({ event: evtMatch[1], data: JSON.parse(dataMatch[1]) });
            } catch { /* skip unparseable */ }
          }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('POST /api/bulk-evaluate (route)', () => {

  test('returns 400 when no input provided', async () => {
    const { status, body } = await post('/api/bulk-evaluate', {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/Provide items/);
  });

  test('returns 400 for empty items array', async () => {
    const { status, body } = await post('/api/bulk-evaluate', { items: [] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/No valid coins/);
  });

  test('accepts JSON items and returns jobId', async () => {
    const { status, body } = await post('/api/bulk-evaluate', {
      items: [{ query: '1921 Morgan Dollar' }],
    });
    expect(status).toBe(202);
    expect(body).toHaveProperty('jobId');
    expect(body.coinCount).toBe(1);
  });

  test('accepts text input', async () => {
    const { status, body } = await post('/api/bulk-evaluate', {
      text: '1921 Morgan Dollar\n1964 Kennedy Half Dollar',
    });
    expect(status).toBe(202);
    expect(body.coinCount).toBe(2);
  });

  test('text input supports pipe-delimited fields', async () => {
    const { status, body } = await post('/api/bulk-evaluate', {
      text: '1921 Morgan Dollar | qty=5 | grade=MS-63',
    });
    expect(status).toBe(202);
    expect(body.coinCount).toBe(1);
  });

  test('text input ignores comments and blank lines', async () => {
    const { status, body } = await post('/api/bulk-evaluate', {
      text: '# header comment\n\n1921 Morgan Dollar\n\n# another comment',
    });
    expect(status).toBe(202);
    expect(body.coinCount).toBe(1);
  });

  test('accepts up to MAX_COINS (500) items', async () => {
    // parseJsonInput clips to MAX_COINS, so 501 becomes 500 and succeeds
    const items = Array.from({ length: 500 }, (_, i) => ({ query: `coin ${i}` }));
    const { status, body } = await post('/api/bulk-evaluate', { items });
    expect(status).toBe(202);
    expect(body.coinCount).toBe(500);
  });
});

describe('GET /api/bulk-evaluate/:jobId (poll)', () => {

  test('returns 404 for unknown jobId', async () => {
    const { status, body } = await get('/api/bulk-evaluate/nonexistent-id');
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  test('returns job status after creation', async () => {
    const { body: createBody } = await post('/api/bulk-evaluate', {
      items: [{ query: '1921 Morgan Dollar' }],
    });
    // Wait a bit for async processing
    await new Promise(r => setTimeout(r, 200));
    const { status, body } = await get(`/api/bulk-evaluate/${createBody.jobId}`);
    expect(status).toBe(200);
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('coinCount', 1);
    expect(['pending', 'running', 'complete']).toContain(body.status);
  });
});

describe('GET /api/bulk-evaluate/:jobId/stream (SSE)', () => {

  test('returns 404 for unknown jobId', async () => {
    const { status, body } = await get('/api/bulk-evaluate/no-such-job/stream');
    expect(status).toBe(404);
  });

  test('streams coin and summary events', async () => {
    const { body: createBody } = await post('/api/bulk-evaluate', {
      items: [{ query: '1921 Morgan Dollar' }],
    });
    // Wait for job to complete
    await new Promise(r => setTimeout(r, 500));
    const events = await sseStream(`/api/bulk-evaluate/${createBody.jobId}/stream`);
    const coinEvents = events.filter(e => e.event === 'coin');
    const summaryEvents = events.filter(e => e.event === 'summary');
    const doneEvents = events.filter(e => e.event === 'done');
    expect(coinEvents.length).toBeGreaterThanOrEqual(1);
    expect(summaryEvents).toHaveLength(1);
    expect(doneEvents).toHaveLength(1);
    expect(coinEvents[0].data).toHaveProperty('fmv');
    expect(summaryEvents[0].data).toHaveProperty('totalFmv');
    expect(summaryEvents[0].data).toHaveProperty('buyTiers');
  });
});

describe('bulkEvaluateRoute input parsers', () => {
  const { _parseTextInput, _parseJsonInput } = require('../src/routes/bulkEvaluateRoute');

  describe('_parseTextInput', () => {
    it('parses simple lines', () => {
      const coins = _parseTextInput('1921 Morgan Dollar\n1964 Kennedy Half');
      expect(coins).toHaveLength(2);
      expect(coins[0].query).toBe('1921 Morgan Dollar');
    });

    it('parses pipe fields', () => {
      const coins = _parseTextInput('1921 Morgan Dollar | qty=3 | grade=MS-63');
      expect(coins).toHaveLength(1);
      expect(coins[0].qty).toBe(3);
      expect(coins[0].grade).toBe('MS-63');
    });

    it('skips comments and blanks', () => {
      const coins = _parseTextInput('# comment\n\nMorgan Dollar\n  \n# end');
      expect(coins).toHaveLength(1);
    });

    it('returns empty for null/undefined', () => {
      expect(_parseTextInput(null)).toEqual([]);
      expect(_parseTextInput(undefined)).toEqual([]);
      expect(_parseTextInput('')).toEqual([]);
    });

    it('supports weight and year fields', () => {
      const coins = _parseTextInput('Libertad | weight=0.5 | year=2020');
      expect(coins[0].weight).toBe(0.5);
      expect(coins[0].year).toBe('2020');
    });
  });

  describe('_parseJsonInput', () => {
    it('parses array of objects', () => {
      const coins = _parseJsonInput([
        { query: 'Morgan Dollar', qty: 2, grade: 'MS-65' },
      ]);
      expect(coins).toHaveLength(1);
      expect(coins[0].query).toBe('Morgan Dollar');
      expect(coins[0].qty).toBe(2);
    });

    it('parses array of strings', () => {
      const coins = _parseJsonInput(['Morgan Dollar', 'Peace Dollar']);
      expect(coins).toHaveLength(2);
      expect(coins[0].query).toBe('Morgan Dollar');
    });

    it('respects MAX_COINS limit', () => {
      const items = Array.from({ length: 600 }, (_, i) => `coin ${i}`);
      const coins = _parseJsonInput(items);
      expect(coins.length).toBeLessThanOrEqual(500);
    });

    it('returns empty for non-array', () => {
      expect(_parseJsonInput(null)).toEqual([]);
      expect(_parseJsonInput('string')).toEqual([]);
    });

    it('truncates long query strings', () => {
      const coins = _parseJsonInput([{ query: 'x'.repeat(500) }]);
      expect(coins[0].query.length).toBeLessThanOrEqual(300);
    });
  });
});
