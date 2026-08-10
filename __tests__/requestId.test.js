'use strict';

const express = require('express');
const request = require('supertest');
const { requestId, getRequestId, resolveRequestId } = require('../src/middleware/requestId');

function buildApp() {
  const app = express();
  app.use(requestId);
  app.get('/ok', (req, res) => res.json({ requestIdSeen: req.id, asyncRequestId: getRequestId() }));
  app.get('/async', (req, res) => {
    setImmediate(() => res.json({ requestIdSeen: req.id, asyncRequestId: getRequestId() }));
  });
  app.get('/error', (_req, res) => res.status(500).json({ error: 'failed' }));
  app.get('/thrown', (_req, _res, next) => next(new Error('thrown failure')));
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message, requestIdSeen: req.id, asyncRequestId: getRequestId() });
  });
  return app;
}

describe('requestId middleware', () => {
  test('echoes a provided request ID through the header and request context', async () => {
    const response = await request(buildApp())
      .get('/ok')
      .set('X-Request-ID', 'pricing-check-123');

    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBe('pricing-check-123');
    expect(response.body).toEqual({
      requestIdSeen: 'pricing-check-123',
      asyncRequestId: 'pricing-check-123',
    });
  });

  test('generates a UUID v4 when no request ID is provided', async () => {
    const response = await request(buildApp()).get('/ok');
    const generated = response.headers['x-request-id'];

    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(response.body.requestIdSeen).toBe(generated);
    expect(response.body.asyncRequestId).toBe(generated);
  });

  test('preserves the request ID across an asynchronous boundary', async () => {
    const response = await request(buildApp())
      .get('/async')
      .set('X-Request-ID', 'async-request-321');

    expect(response.body).toEqual({
      requestIdSeen: 'async-request-321',
      asyncRequestId: 'async-request-321',
    });
  });

  test('adds the request ID to JSON error bodies', async () => {
    const response = await request(buildApp())
      .get('/error')
      .set('X-Request-ID', 'failed-request-456');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'failed', requestId: 'failed-request-456' });
  });

  test('carries req.id and async context into Express error handlers', async () => {
    const response = await request(buildApp())
      .get('/thrown')
      .set('X-Request-ID', 'thrown-request-789');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'thrown failure',
      requestIdSeen: 'thrown-request-789',
      asyncRequestId: 'thrown-request-789',
      requestId: 'thrown-request-789',
    });
  });

  test('replaces unsafe request IDs instead of reflecting them', () => {
    expect(resolveRequestId('unsafe request id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});