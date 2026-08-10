'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');

const requestIdStorage = new AsyncLocalStorage();
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function resolveRequestId(headerValue) {
  const provided = typeof headerValue === 'string' ? headerValue.trim() : '';
  return SAFE_REQUEST_ID.test(provided) ? provided : randomUUID();
}

function requestId(req, res, next) {
  const id = resolveRequestId(req.get('X-Request-ID'));
  req.id = id;
  res.set('X-Request-ID', id);

  const originalJson = res.json.bind(res);
  res.json = body => {
    if (body && !Array.isArray(body) && typeof body === 'object' &&
        Object.prototype.hasOwnProperty.call(body, 'error') && body.requestId === undefined) {
      return originalJson({ ...body, requestId: id });
    }
    return originalJson(body);
  };

  requestIdStorage.run(id, next);
}

function getRequestId() {
  return requestIdStorage.getStore() || null;
}

module.exports = { requestId, getRequestId, resolveRequestId };