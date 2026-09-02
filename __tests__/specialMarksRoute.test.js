'use strict';

const express = require('express');
const request = require('supertest');
const specialMarksRoute = require('../src/routes/specialMarksRoute');

function createApp() {
  const app = express();
  app.use('/api/special-marks', specialMarksRoute);
  return app;
}

describe('GET /api/special-marks', () => {
  test('returns only marks applicable to the complete product context', async () => {
    const res = await request(createApp()).get('/api/special-marks').query({
      program: 'Canadian Maple Leaf', year: 2015, metal: 'silver', weight: 1, finish: 'Reverse Proof',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      registryVersion: '1.0.0',
      marks: [expect.objectContaining({ markId: 'rcm.maple.emc2', canonicalName: 'E=mc2', location: 'reverse' })],
    });
    expect(res.body.marks[0]).not.toHaveProperty('aliases');
  });

  test('does not offer an inapplicable mark', async () => {
    const res = await request(createApp()).get('/api/special-marks').query({
      program: 'Canadian Maple Leaf', year: 2016, metal: 'silver', weight: 1, finish: 'Reverse Proof',
    });
    expect(res.status).toBe(200);
    expect(res.body.marks).toEqual([]);
  });

  test('does not offer a mark for an explicit mismatched denomination', async () => {
    const res = await request(createApp()).get('/api/special-marks').query({
      program: 'Canadian Maple Leaf', year: 2015, metal: 'silver', weight: 1,
      denomination: 1, finish: 'Reverse Proof',
    });
    expect(res.status).toBe(200);
    expect(res.body.marks).toEqual([]);
  });

  test.each([
    [{ year: ['2015', '2016'] }],
    [{ year: '20x5' }],
    [{ weight: ['1', '2'] }],
    [{ weight: 'Infinity' }],
    [{ weight: '101' }],
  ])('rejects malformed scalar lookup context %p', async (query) => {
    const res = await request(createApp()).get('/api/special-marks').query({ program: 'Maple Leaf', ...query });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Special-mark lookup context is invalid' });
  });
});
