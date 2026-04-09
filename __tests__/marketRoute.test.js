// __tests__/marketRoute.test.js — Integration tests for GET /api/market/ebay
// Tests the Express route with mocked dependencies using a real HTTP server.

'use strict';

// Mock the dependencies before requiring the route
jest.mock('../src/services/marketAggregator', () => ({
  fetchMarketMatrix: jest.fn(),
}));
jest.mock('../src/services/ebayService', () => ({}));
jest.mock('../src/data/keyDates', () => ({
  lookupKeyDate: jest.fn(() => ({ isKeyDate: false })),
}));

const http = require('http');
const { fetchMarketMatrix } = require('../src/services/marketAggregator');
const express = require('express');
const marketRoute = require('../src/routes/marketRoute');

let app, server, baseUrl;

beforeAll((done) => {
  app = express();
  app.use('/api/market/ebay', marketRoute);
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
  fetchMarketMatrix.mockReset();
});

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + path, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    }).on('error', reject);
  });
}

describe('GET /api/market/ebay', () => {
  test('returns 400 when series is missing', async () => {
    const { status, body } = await get('/api/market/ebay');
    expect(status).toBe(400);
    expect(body).toHaveProperty('error', 'Missing required parameter: series');
  });

  test('returns matrix data for valid series', async () => {
    const matrixData = {
      series: 'Franklin Half Dollar',
      grade: 'All',
      keywords: 'Franklin Half Dollar',
      years: [1955, 1956],
      mintMarks: ['P', 'D'],
      summary: { totalCells: 3, cellsWithPriceData: 3, yearMin: 1955, yearMax: 1956, mintCount: 2 },
      cells: [
        { year: 1955, mint: 'P', keyDate: true, keyDateTier: 'semi-key', medianCompleted: { value: 120, currency: 'USD', sampleSize: 3, lookbackDays: 90 }, cheapestBin: null },
        { year: 1956, mint: 'D', keyDate: false, keyDateTier: null, medianCompleted: { value: 27.5, currency: 'USD', sampleSize: 2, lookbackDays: 90 }, cheapestBin: { value: 28, currency: 'USD', url: 'http://bin' } },
      ],
    };

    fetchMarketMatrix.mockResolvedValueOnce(matrixData);

    const { status, body } = await get('/api/market/ebay?series=Franklin+Half+Dollar');
    expect(status).toBe(200);
    expect(body).toHaveProperty('series', 'Franklin Half Dollar');
    expect(body.cells).toHaveLength(2);
    expect(body.summary.totalCells).toBe(3);
  });

  test('passes grade and days parameters to fetchMarketMatrix', async () => {
    fetchMarketMatrix.mockResolvedValueOnce({
      grade: 'MS65',
      years: [],
      mintMarks: [],
      summary: { totalCells: 0, cellsWithPriceData: 0 },
      cells: [],
    });

    await get('/api/market/ebay?series=Morgan+Dollar&grade=MS65&days=30');

    expect(fetchMarketMatrix).toHaveBeenCalledWith(
      expect.objectContaining({
        series: 'Morgan Dollar',
        grade: 'MS65',
        timeWindowDays: 30,
      })
    );
  });

  test('returns 500 when fetchMarketMatrix throws', async () => {
    fetchMarketMatrix.mockRejectedValueOnce(new Error('eBay API failed'));

    const { status, body } = await get('/api/market/ebay?series=Test');
    expect(status).toBe(500);
    expect(body).toHaveProperty('error', 'Internal server error');
  });
});
