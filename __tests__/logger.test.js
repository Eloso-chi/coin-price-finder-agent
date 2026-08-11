'use strict';

const { Writable } = require('stream');
const { requestId } = require('../src/middleware/requestId');

function captureDestination(lines) {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
}

describe('structured logger', () => {
  test('emits parseable JSON with configured level filtering', () => {
    const lines = [];
    const { createLogger } = require('../src/utils/logger');
    const logger = createLogger({ level: 'warn' }, captureDestination(lines));

    logger.info({ event: 'ignored' }, 'ignored');
    logger.warn({ event: 'kept', count: 2 }, 'kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      service: 'coin-price-finder-agent',
      event: 'kept',
      count: 2,
      msg: 'kept',
    });
    expect(lines[0].time).toEqual(expect.any(String));
  });

  test('redacts common secret fields', () => {
    const lines = [];
    const { createLogger } = require('../src/utils/logger');
    const logger = createLogger({}, captureDestination(lines));

    logger.info({
      ADMIN_API_KEY: 'admin-secret',
      token: 'secret-value',
      headers: { authorization: 'Bearer credential' },
      nested: { password: 'hidden' },
    }, 'redacted');

    expect(lines[0].ADMIN_API_KEY).toBe('[REDACTED]');
    expect(lines[0].token).toBe('[REDACTED]');
    expect(lines[0].headers.authorization).toBe('[REDACTED]');
    expect(lines[0].nested.password).toBe('[REDACTED]');
  });

  test('does not serialize credentials or response bodies from rich errors', () => {
    const lines = [];
    const { createLogger } = require('../src/utils/logger');
    const logger = createLogger({}, captureDestination(lines));
    const err = new Error('upstream failed');
    err.code = 'ERR_BAD_RESPONSE';
    err.config = { headers: { Authorization: 'Bearer credential' } };
    err.response = { status: 503, data: { customer: 'private response body' } };

    logger.error({ err, outer: { nested: { token: 'deep-secret' } } }, 'failed');

    expect(lines[0].err).toMatchObject({
      type: 'Error',
      message: 'upstream failed',
      code: 'ERR_BAD_RESPONSE',
      status: 503,
    });
    expect(lines[0].err).not.toHaveProperty('config');
    expect(lines[0].err).not.toHaveProperty('response');
    expect(lines[0].outer.nested.token).toBe('[REDACTED]');
    expect(JSON.stringify(lines[0])).not.toContain('credential');
    expect(JSON.stringify(lines[0])).not.toContain('private response body');
  });

  test('injects the active request ID into request-scoped logs', () => {
    const lines = [];
    const { createLogger } = require('../src/utils/logger');
    const logger = createLogger({}, captureDestination(lines));
    const req = { get: () => 'log-request-123' };
    const res = { set: jest.fn(), json: jest.fn() };

    requestId(req, res, () => logger.info({
      event: 'request_test',
      requestId: 'caller-supplied-id',
    }, 'request log'));

    expect(lines[0].requestId).toBe('log-request-123');
  });
});