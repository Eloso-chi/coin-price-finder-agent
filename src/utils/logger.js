'use strict';

const pino = require('pino');
const { getRequestId } = require('../middleware/requestId');

const REDACT_PATHS = [
  'ADMIN_API_KEY',
  'apiKey',
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'headers.Authorization',
  'headers.Cookie',
  'headers.authorization',
  'headers.cookie',
  '*.ADMIN_API_KEY',
  '*.apiKey',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.secret',
  '*.token',
];

const SECRET_FIELD = /^(?:admin_api_key|api_?key|authorization|cookie|password|secret|token)$/i;

function sanitizeError(err) {
  const safeError = {
    type: err.name || 'Error',
    message: err.message,
    stack: err.stack,
  };
  if (err.code !== undefined) safeError.code = err.code;
  const status = err.status ?? err.response?.status;
  if (status !== undefined) safeError.status = status;
  return safeError;
}

function sanitizeValue(value, seen = new WeakSet()) {
  if (value instanceof Error) return sanitizeError(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map(item => sanitizeValue(item, seen));

  const sanitized = {};
  for (const [key, child] of Object.entries(value)) {
    sanitized[key] = SECRET_FIELD.test(key) ? '[REDACTED]' : sanitizeValue(child, seen);
  }
  return sanitized;
}

function createLogger(options = {}, destination) {
  const configuredLevel = options.level || process.env.LOG_LEVEL || 'info';
  return pino({
    base: { service: 'coin-price-finder-agent' },
    level: configuredLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: label => ({ level: label }),
      log: sanitizeValue,
    },
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    serializers: {
      err: value => value instanceof Error ? sanitizeError(value) : value,
    },
    hooks: {
      logMethod(args, method) {
        const requestId = getRequestId();
        if (requestId) {
          if (args[0] && typeof args[0] === 'object' && !(args[0] instanceof Error)) {
            args[0] = { ...args[0], requestId };
          } else {
            args.unshift({ requestId });
          }
        }
        method.apply(this, args);
      },
    },
    ...options,
  }, destination);
}

const logger = createLogger();

module.exports = logger;
module.exports.createLogger = createLogger;