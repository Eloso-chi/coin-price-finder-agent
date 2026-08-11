'use strict';

const express = require('express');
const request = require('supertest');
const { createHealthRouter } = require('../src/routes/healthRoute');

function dependencies(overrides = {}) {
  return {
    cosmos: {
      isEnabled: jest.fn(() => true),
      container: jest.fn(() => ({ read: jest.fn(async () => ({})) })),
    },
    pcgsQuota: {
      getStatus: jest.fn(() => ({
        upstreamAvailability: 'available',
        remaining: 900,
        lastProbeAt: '2026-08-10T20:00:00.000Z',
        lastProbeOutcome: 'succeeded',
      })),
    },
    metals: {
      getHealthStatus: jest.fn(() => ({
        status: 'ok',
        lastSuccess: '2026-08-10T21:00:00.000Z',
        providerCount: 4,
      })),
    },
    terapeak: {
      getHealthStatus: jest.fn(() => ({
        status: 'ok',
        lastSuccess: '2026-08-10T22:00:00.000Z',
        datasetCount: 2,
      })),
    },
    requireAdmin: jest.fn((_req, _res, next) => next()),
    ...overrides,
  };
}

function buildApp(services) {
  const app = express();
  app.use('/api/health', createHealthRouter(services));
  return app;
}

describe('deep health route', () => {
  test('preserves the public shallow health contract without running probes', async () => {
    const services = dependencies();
    const response = await request(buildApp(services)).get('/api/health').expect(200);

    expect(response.body).toEqual({ status: 'ok', uptime: expect.any(Number) });
    expect(services.requireAdmin).not.toHaveBeenCalled();
    expect(services.cosmos.isEnabled).not.toHaveBeenCalled();
  });

  test('requires admin authorization for deep health', async () => {
    const services = dependencies({
      requireAdmin: jest.fn((_req, res) => res.status(401).json({ error: 'Invalid or missing admin credentials' })),
    });

    const response = await request(buildApp(services)).get('/api/health?deep=1').expect(401);

    expect(response.body).toEqual({ error: 'Invalid or missing admin credentials' });
    expect(services.cosmos.isEnabled).not.toHaveBeenCalled();
  });

  test('returns bounded dependency state for an authorized deep check', async () => {
    const response = await request(buildApp(dependencies())).get('/api/health?deep=1').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      overall: 'ok',
      dependencies: {
        cosmos: { status: 'ok', latencyMs: expect.any(Number), lastSuccess: expect.any(String) },
        keyVault: { status: 'not_probed', latencyMs: 0, lastSuccess: null },
        metals: { status: 'ok', latencyMs: expect.any(Number) },
        pcgs: { status: 'ok', latencyMs: expect.any(Number), remaining: 900 },
        terapeak: { status: 'ok', latencyMs: expect.any(Number), datasetCount: 2 },
      },
    });
    expect(response.body).not.toHaveProperty('config');
    expect(response.body).not.toHaveProperty('error');
  });

  test('returns degraded with HTTP 200 when optional dependencies fail', async () => {
    const services = dependencies({
      metals: { getHealthStatus: jest.fn(() => { throw new Error('cache failed'); }) },
      pcgsQuota: {
        getStatus: jest.fn(() => ({
          upstreamAvailability: 'cooldown',
          remaining: 800,
          lastProbeAt: null,
          lastProbeOutcome: 'blocked',
        })),
      },
      terapeak: {
        getHealthStatus: jest.fn(() => ({ status: 'degraded', lastSuccess: null, datasetCount: 0 })),
      },
    });

    const response = await request(buildApp(services)).get('/api/health?deep=1').expect(200);

    expect(response.body.overall).toBe('degraded');
    expect(response.body.dependencies.metals).toEqual({
      status: 'down', latencyMs: expect.any(Number), lastSuccess: null,
    });
    expect(response.body.dependencies.pcgs.status).toBe('degraded');
    expect(response.body.dependencies.terapeak.status).toBe('degraded');
  });

  test('returns HTTP 503 when configured Cosmos is unreachable', async () => {
    const services = dependencies({
      cosmos: {
        isEnabled: jest.fn(() => true),
        container: jest.fn(() => ({ read: jest.fn(async () => { throw new Error('unreachable'); }) })),
      },
    });

    const response = await request(buildApp(services)).get('/api/health?deep=1').expect(503);

    expect(response.body.status).toBe('unavailable');
    expect(response.body.overall).toBe('down');
    expect(response.body.dependencies.cosmos).toEqual({
      status: 'down', latencyMs: expect.any(Number), lastSuccess: null,
    });
  });

  test('supports file-only mode without treating unconfigured Cosmos as down', async () => {
    const services = dependencies({
      cosmos: { isEnabled: jest.fn(() => false), container: jest.fn() },
    });

    const response = await request(buildApp(services)).get('/api/health?deep=1').expect(200);

    expect(response.body.overall).toBe('ok');
    expect(response.body.dependencies.cosmos.status).toBe('not_configured');
    expect(response.body.dependencies.keyVault.status).toBe('not_probed');
    expect(services.cosmos.container).not.toHaveBeenCalled();
  });

  test('aborts a Cosmos request when the probe deadline expires', async () => {
    let capturedSignal;
    const read = jest.fn(({ abortSignal }) => {
      capturedSignal = abortSignal;
      return new Promise(() => {});
    });
    const services = dependencies({
      cosmos: { isEnabled: jest.fn(() => true), container: jest.fn(() => ({ read })) },
      probeTimeoutMs: 10,
    });

    const response = await request(buildApp(services)).get('/api/health?deep=1').expect(503);

    expect(response.body.dependencies.cosmos.status).toBe('down');
    expect(read).toHaveBeenCalledTimes(1);
    expect(capturedSignal.aborted).toBe(true);
  });

  test('reuses a recent deep result instead of repeating dependency probes', async () => {
    const services = dependencies();
    const app = buildApp(services);

    await request(app).get('/api/health?deep=1').expect(200);
    await request(app).get('/api/health?deep=1').expect(200);

    expect(services.cosmos.container).toHaveBeenCalledTimes(1);
    expect(services.metals.getHealthStatus).toHaveBeenCalledTimes(1);
    expect(services.pcgsQuota.getStatus).toHaveBeenCalledTimes(1);
    expect(services.terapeak.getHealthStatus).toHaveBeenCalledTimes(1);
  });

  test('applies the dedicated limiter before authorization and probes', async () => {
    const services = dependencies({
      deepLimiter: jest.fn((_req, res) => res.status(429).json({ error: 'Too many deep health checks' })),
    });

    await request(buildApp(services)).get('/api/health?deep=1').expect(429);

    expect(services.requireAdmin).not.toHaveBeenCalled();
    expect(services.cosmos.isEnabled).not.toHaveBeenCalled();
  });
});