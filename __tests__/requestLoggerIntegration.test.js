'use strict';

const { Writable } = require('stream');
const express = require('express');
const request = require('supertest');
const { createLogger } = require('../src/utils/logger');
const { requestId } = require('../src/middleware/requestId');
const { createRequestLogger } = require('../src/middleware/requestLogger');

describe('requestLogger integration', () => {
  test('emits the active request ID through the real structured logger', async () => {
    const lines = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()));
        callback();
      },
    });
    const app = express();
    app.use(requestId);
    app.use(createRequestLogger(createLogger({}, destination)));
    app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

    await request(app).get('/api/health').set('X-Request-ID', 'http-log-real-123').expect(200);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'http_request_completed',
      requestId: 'http-log-real-123',
      path: '/api/health',
      statusCode: 200,
    });
  });
});