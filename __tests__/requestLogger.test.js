'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../src/utils/logger', () => ({ info: jest.fn() }));

const logger = require('../src/utils/logger');
const { requestId } = require('../src/middleware/requestId');
const requestLogger = require('../src/middleware/requestLogger');

describe('requestLogger middleware', () => {
  beforeEach(() => logger.info.mockClear());

  test('logs API completion fields inside the request-ID context', async () => {
    const app = express();
    app.use(requestId);
    app.use(requestLogger);
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

    await request(app).get('/api/health').set('X-Request-ID', 'http-log-123').expect(200);

    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'http_request_completed',
      method: 'GET',
      path: '/api/health',
      statusCode: 200,
      durationMs: expect.any(Number),
    }), 'HTTP request completed');
  });

  test('does not log static requests', async () => {
    const app = express();
    app.use(requestId);
    app.use(requestLogger);
    app.get('/asset.js', (_req, res) => res.send('ok'));

    await request(app).get('/asset.js').expect(200);

    expect(logger.info).not.toHaveBeenCalled();
  });
});