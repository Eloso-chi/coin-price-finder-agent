'use strict';

const mockResult = {
  query: '1921 Morgan Dollar',
  fmv: 52,
  method: 'sold-data',
  confidence: 72,
  algorithmVersion: '1.0.0',
  configVersion: `sha256:${'c'.repeat(64)}`,
  computedAt: '2026-08-11T12:34:56.000Z',
};

jest.mock('../src/services/bulkEvaluateService', () => ({
  MAX_COINS: 500,
  runBulkEvaluation: jest.fn(async (_coins, onResult) => {
    onResult(mockResult, 0, 1);
    return { results: [mockResult], lotSummary: { totalFmv: 52 } };
  }),
}));

jest.mock('../src/services/auditService', () => ({
  writeValuationAudit: jest.fn(async () => {}),
}));

const express = require('express');
const request = require('supertest');
const bulkEvaluateRoute = require('../src/routes/bulkEvaluateRoute');
const { writeValuationAudit } = require('../src/services/auditService');

test('bulk evaluation audits each successful background result', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'bulk-request-1';
    next();
  });
  app.use('/api/bulk-evaluate', bulkEvaluateRoute);

  const response = await request(app)
    .post('/api/bulk-evaluate')
    .send({ items: [{ query: '1921 Morgan Dollar' }] });

  expect(response.status).toBe(202);
  expect(writeValuationAudit).toHaveBeenCalledWith({
    ...mockResult,
    requestId: 'bulk-request-1',
    actorId: undefined,
    ip: undefined,
  });
});