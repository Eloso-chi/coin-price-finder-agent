'use strict';

jest.mock('../src/services/authService', () => ({
  verifyToken: jest.fn((token) => {
    if (token === 'user-token') return { userId: 'user-a' };
    if (token === 'other-token') return { userId: 'user-b' };
    throw new Error('invalid');
  }),
}));

jest.mock('../src/services/coinStorageService', () => ({
  getAllCoins: jest.fn((userId) => userId === 'user-a' ? [
    { coinHash: 'a1', series: 'Morgan Dollar', year: '1921', grade: 'MS65', count: 2, costPer: 80 },
    { coinHash: 'a2', series: 'Unknown', count: 1 },
  ] : [
    { coinHash: 'b1', series: 'Kennedy Half Dollar', year: '1964', count: 1, costPer: 12 },
  ]),
}));

const request = require('supertest');
const express = require('express');
const route = require('../src/routes/aiCollectionRoute');
const { getAllCoins } = require('../src/services/coinStorageService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', route);
  return app;
}

describe('POST /api/ai/collection', () => {
  beforeEach(() => jest.clearAllMocks());

  test('requires authentication', async () => {
    const res = await request(createApp()).post('/api/ai/collection').send({ intent: 'summary' });
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  test('summarizes only the authenticated user collection', async () => {
    const res = await request(createApp())
      .post('/api/ai/collection')
      .set('Authorization', 'Bearer user-token')
      .send({ intent: 'summary', userId: 'user-b' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/3 coins across 2 types/i);
    expect(res.body.summary.costBasis).toBe(160);
    expect(res.body.summary.gaps).toHaveLength(1);
    expect(res.body.provenance.userDataOnly).toBe(true);
    expect(getAllCoins).toHaveBeenCalledWith('user-a');
  });

  test('returns actionable gaps for an empty collection', async () => {
    getAllCoins.mockReturnValueOnce([]);
    const res = await request(createApp())
      .post('/api/ai/collection')
      .set('Authorization', 'Bearer user-token')
      .send({ intent: 'gaps' });

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      coinTypes: 0,
      totalCount: 0,
      costedTypes: 0,
      costBasis: 0,
      gaps: [],
      uncertainty: 'collection metadata complete',
    });
    expect(res.body.answer).toMatch(/no detected metadata gaps/i);
  });

  test('normalizes unsupported intents to the safe summary tool', async () => {
    const res = await request(createApp())
      .post('/api/ai/collection')
      .set('Authorization', 'Bearer user-token')
      .send({ intent: 'delete-all', userId: 'user-b' });

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('summary');
    expect(getAllCoins).toHaveBeenCalledWith('user-a');
  });
});