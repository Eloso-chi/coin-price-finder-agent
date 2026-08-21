'use strict';

jest.mock('../src/services/marketAggregator', () => ({
  fetchMarketMatrix: jest.fn(async ({ series }) => ({
    series,
    grade: 'All',
    summary: { yearMin: 1921, yearMax: 1923 },
    cells: [
      { year: 1921, mint: 'D', medianCompleted: { value: series.includes('Morgan') ? 100 : 50, sampleSize: 4 } },
      { year: 1922, mint: 'P', medianCompleted: { value: series.includes('Morgan') ? 120 : null, sampleSize: series.includes('Morgan') ? 2 : 0 } },
      { year: 1923, mint: 'S', medianCompleted: null },
    ],
  })),
}));

const request = require('supertest');
const express = require('express');
const route = require('../src/routes/aiMarketRoute');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', route);
  return app;
}

describe('POST /api/ai/market', () => {
  test('returns coverage with observed and derived classifications', async () => {
    const res = await request(createApp()).post('/api/ai/market').send({
      intent: 'coverage',
      series: 'Morgan Dollar',
    });

    expect(res.status).toBe(200);
    expect(res.body.classifications).toEqual({
      source: 'observed-completed-sales',
      metrics: 'derived-from-matrix',
    });
    expect(res.body.result.observed).toMatchObject({ cells: 3, pricedCells: 2, sampleSize: 6 });
    expect(res.body.result.derived.coverageRate).toBe(66.7);
    expect(res.body.result.missing).toEqual([]);
  });

  test('returns a bounded comparison for at most three series', async () => {
    const res = await request(createApp()).post('/api/ai/market').send({
      intent: 'compare',
      series: ['Morgan Dollar', 'Kennedy Half Dollar'],
    });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].derived.medianOfCellMedians).toBe(120);
  });

  test('returns an explicit missing result for sparse year-series data', async () => {
    const res = await request(createApp()).post('/api/ai/market').send({
      intent: 'year-series',
      series: 'Morgan Dollar',
    });

    expect(res.status).toBe(200);
    expect(res.body.result.classification).toBe('observed-by-year');
    expect(res.body.result.points).toHaveLength(2);
    expect(res.body.result.note).toMatch(/not a daily time trend/i);
  });

  test('rejects unbounded comparisons and missing series', async () => {
    const tooMany = await request(createApp()).post('/api/ai/market').send({
      intent: 'compare', series: ['a', 'b', 'c', 'd'],
    });
    const missing = await request(createApp()).post('/api/ai/market').send({ intent: 'coverage' });
    expect(tooMany.status).toBe(400);
    expect(missing.status).toBe(400);
  });
});