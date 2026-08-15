'use strict';

const logger = require('../utils/logger');

function createRequestLogger(targetLogger) {
  return function requestLogger(req, res, next) {
    if (!req.path.startsWith('/api')) return next();

    const startedAt = process.hrtime.bigint();
    res.once('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      targetLogger.info({
        event: 'http_request_completed',
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      }, 'HTTP request completed');
    });
    next();
  };
}

module.exports = createRequestLogger(logger);
module.exports.createRequestLogger = createRequestLogger;