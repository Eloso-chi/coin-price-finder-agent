/**
 * coinHistoryRoute.test.js — Integration tests for GET /api/coin-history
 *
 * Covers: parameter validation, Terapeak dataset lookup, date filtering,
 * grade filtering, MAD outlier removal, metal overlay, greysheet overlay,
 * daily stats output shape.
 */

'use strict';

const express = require('express');
const request = require('supertest');

// ── Mocks ────────────────────────────────────────────────────

jest.mock('../src/services/terapeakService', () => ({
  lookupComps: jest.fn(),
}));

jest.mock('../src/services/greysheetService', () => ({
  fetchTypePrice: jest.fn(),
}));

jest.mock('../src/services/greysheetHistoryService', () => ({
  makeKey: jest.fn((id, grade) => `${id}:${grade || 'all'}`),
  recordSnapshot: jest.fn(),
  getHistory: jest.fn(() => ({ wholesale: [], retail: [] })),
}));

jest.mock('../src/services/metalsHistoryService', () => ({
  getHistory: jest.fn(() => []),
  METAL_SYMBOLS: { silver: 'XAG', gold: 'XAU', platinum: 'XPT', palladium: 'XPD' },
}));

jest.mock('../src/services/ebayService', () => ({
  classifyGradeType: jest.fn((c) => c.gradeType || 'raw'),
}));

jest.mock('../src/utils/coinMetalProfile', () => ({
  getCoinMetalProfile: jest.fn(() => ({ isMetalBased: false, metal: null, pureOzt: null })),
}));

jest.mock('../src/utils/filters', () => ({
  isDenied: jest.fn(() => false),
}));

const terapeakService = require('../src/services/terapeakService');
const greysheetService = require('../src/services/greysheetService');
const { getCoinMetalProfile } = require('../src/utils/coinMetalProfile');
const { getHistory: getMetalsHistory } = require('../src/services/metalsHistoryService');
const { isDenied } = require('../src/utils/filters');

const coinHistoryRoute = require('../src/routes/coinHistoryRoute');

// ── App setup ────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use('/api/coin-history', coinHistoryRoute);
  return app;
}

// ── Helpers ──────────────────────────────────────────────────

const today = new Date().toISOString().substring(0, 10);
const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().substring(0, 10); })();

function makeComp(overrides = {}) {
  return {
    title: '1881-CC Morgan Silver Dollar',
    totalUsd: 150,
    soldDate: `${today}T12:00:00Z`,
    gradeType: 'raw',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Parameter validation
// ═══════════════════════════════════════════════════════════════

describe('GET /api/coin-history', () => {
  const app = buildApp();

  test('returns 400 if query is missing', async () => {
    const res = await request(app).get('/api/coin-history');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  test('returns 400 if query is empty string', async () => {
    const res = await request(app).get('/api/coin-history?query=');
    expect(res.status).toBe(400);
  });

  test('returns 404 if no Terapeak data found', async () => {
    terapeakService.lookupComps.mockReturnValue(null);
    const res = await request(app).get('/api/coin-history?query=unknown+coin');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no historical data/i);
  });

  test('returns 404 if dataset has empty comps', async () => {
    terapeakService.lookupComps.mockReturnValue({ comps: [], searchTerm: 'test' });
    const res = await request(app).get('/api/coin-history?query=test');
    expect(res.status).toBe(404);
  });

  // ═══════════════════════════════════════════════════════════
  //  Successful responses
  // ═══════════════════════════════════════════════════════════

  test('returns daily stats for valid query', async () => {
    terapeakService.lookupComps.mockReturnValue({
      comps: [
        makeComp({ totalUsd: 100, soldDate: `${today}T10:00:00Z` }),
        makeComp({ totalUsd: 120, soldDate: `${today}T14:00:00Z` }),
        makeComp({ totalUsd: 110, soldDate: `${yesterday}T10:00:00Z` }),
      ],
      searchTerm: '1881-CC Morgan Silver Dollar',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=1881-CC+Morgan+Silver+Dollar');
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('1881-CC Morgan Silver Dollar');
    expect(res.body.currency).toBe('USD');
    expect(res.body.rangeDays).toBe(90);
    expect(res.body.source).toBe('terapeak');
    expect(res.body.prices.length).toBeGreaterThanOrEqual(1);
    // Each price entry: [date, median, avg, min, max, count]
    const entry = res.body.prices[0];
    expect(entry).toHaveLength(6);
    expect(typeof entry[0]).toBe('string'); // date
    expect(typeof entry[1]).toBe('number'); // median
  });

  test('defaults rangeDays to 90', async () => {
    terapeakService.lookupComps.mockReturnValue({
      comps: [makeComp()],
      searchTerm: 'test',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=test');
    expect(res.body.rangeDays).toBe(90);
  });

  test('accepts valid rangeDays (180, 365)', async () => {
    terapeakService.lookupComps.mockReturnValue({
      comps: [makeComp()],
      searchTerm: 'test',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=test&rangeDays=180');
    expect(res.body.rangeDays).toBe(180);
  });

  test('rejects invalid rangeDays (falls back to 90)', async () => {
    terapeakService.lookupComps.mockReturnValue({
      comps: [makeComp()],
      searchTerm: 'test',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=test&rangeDays=999');
    expect(res.body.rangeDays).toBe(90);
  });

  // ═══════════════════════════════════════════════════════════
  //  Filtering
  // ═══════════════════════════════════════════════════════════

  test('filters denied titles', async () => {
    isDenied.mockImplementation((title) => title.includes('LOT'));
    terapeakService.lookupComps.mockReturnValue({
      comps: [
        makeComp({ title: 'LOT of 5 Morgan Dollars', totalUsd: 500 }),
        makeComp({ title: '1881-CC Morgan Dollar', totalUsd: 150 }),
      ],
      searchTerm: 'Morgan',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=Morgan');
    expect(res.status).toBe(200);
    expect(res.body.totalComps).toBe(1);
    isDenied.mockReturnValue(false); // reset
  });

  test('filters by grade type (raw by default)', async () => {
    terapeakService.lookupComps.mockReturnValue({
      comps: [
        makeComp({ gradeType: 'raw', totalUsd: 100 }),
        makeComp({ gradeType: 'graded', totalUsd: 300 }),
      ],
      searchTerm: 'Morgan',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=Morgan');
    expect(res.body.totalComps).toBe(1); // only raw
  });

  test('uses graded comps when grade in query', async () => {
    terapeakService.lookupComps.mockReturnValue({
      comps: [
        makeComp({ gradeType: 'raw', totalUsd: 100 }),
        makeComp({ gradeType: 'graded', totalUsd: 300, title: '1881-CC Morgan MS-63 PCGS' }),
      ],
      searchTerm: 'Morgan MS-63',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=1881-CC+Morgan+MS-63');
    expect(res.body.totalComps).toBe(1); // only graded
    expect(res.body.gradeFiltered).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════
  //  Metal overlay
  // ═══════════════════════════════════════════════════════════

  test('includes metal overlay for bullion coins', async () => {
    getCoinMetalProfile.mockReturnValue({ isMetalBased: true, metal: 'silver', pureOzt: 1 });
    getMetalsHistory.mockReturnValue([
      ['2026-05-01', 30.5],
      ['2026-05-02', 31.0],
    ]);
    terapeakService.lookupComps.mockReturnValue({
      comps: [makeComp({ totalUsd: 35 })],
      searchTerm: 'ASE',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=Silver+Eagle');
    expect(res.body.metalOverlay).not.toBeNull();
    expect(res.body.metalOverlay.metal).toBe('silver');
    expect(res.body.metalOverlay.prices).toHaveLength(2);

    // Reset
    getCoinMetalProfile.mockReturnValue({ isMetalBased: false, metal: null, pureOzt: null });
    getMetalsHistory.mockReturnValue([]);
  });

  test('metalOverlay is null for non-bullion coins', async () => {
    getCoinMetalProfile.mockReturnValue({ isMetalBased: false, metal: null, pureOzt: null });
    terapeakService.lookupComps.mockReturnValue({
      comps: [makeComp()],
      searchTerm: 'Morgan',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=Morgan');
    expect(res.body.metalOverlay).toBeNull();
  });

  // ═══════════════════════════════════════════════════════════
  //  Greysheet overlay
  // ═══════════════════════════════════════════════════════════

  test('includes greysheet overlay when data available', async () => {
    terapeakService.lookupComps.mockReturnValue({
      comps: [makeComp()],
      searchTerm: 'Morgan',
    });
    greysheetService.fetchTypePrice.mockResolvedValue({
      gsid: '12345',
      greyVal: 140,
      cpgVal: 165,
      name: 'Morgan Dollar',
      gradeLabel: 'MS-63',
    });
    const gsHistory = require('../src/services/greysheetHistoryService');
    gsHistory.getHistory.mockReturnValue({
      wholesale: [['2026-05-01', 138]],
      retail: [['2026-05-01', 162]],
    });

    const res = await request(app).get('/api/coin-history?query=Morgan');
    expect(res.body.greysheetOverlay).not.toBeNull();
    expect(res.body.greysheetOverlay.current.wholesale).toBe(140);
    expect(res.body.greysheetOverlay.current.retail).toBe(165);

    // Reset
    gsHistory.getHistory.mockReturnValue({ wholesale: [], retail: [] });
    greysheetService.fetchTypePrice.mockResolvedValue(null);
  });

  // ═══════════════════════════════════════════════════════════
  //  Empty result after filtering
  // ═══════════════════════════════════════════════════════════

  test('returns empty prices array when all comps filtered', async () => {
    // All comps are old (outside 90-day range)
    terapeakService.lookupComps.mockReturnValue({
      comps: [
        makeComp({ soldDate: '2020-01-01T10:00:00Z' }),
      ],
      searchTerm: 'Old Coin',
    });
    greysheetService.fetchTypePrice.mockResolvedValue(null);

    const res = await request(app).get('/api/coin-history?query=Old+Coin');
    expect(res.status).toBe(200);
    expect(res.body.prices).toHaveLength(0);
    expect(res.body.totalComps).toBe(0);
  });
});
