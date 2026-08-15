'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const cosmos = require('../utils/cosmosClient');
const pcgsQuota = require('../services/pcgsQuotaService');
const metals = require('../services/metalsSpotPrice');
const terapeak = require('../services/terapeakService');
const requireAdmin = require('../middleware/requireAdminOrKey');

const PROBE_TIMEOUT_MS = 2000;
const PROBE_CACHE_MS = 10000;

function elapsedMs(startedAt) {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6 * 100) / 100;
}

function withAbortTimeout(operation, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Health probe timed out'));
    }, timeoutMs);
  });
  return Promise.race([operation(controller.signal), timeout])
    .finally(() => clearTimeout(timer));
}

async function checkCosmos(cosmosClient, timeoutMs) {
  const startedAt = process.hrtime.bigint();
  if (!cosmosClient.isEnabled()) {
    return { status: 'not_configured', latencyMs: elapsedMs(startedAt), lastSuccess: null };
  }
  try {
    await withAbortTimeout(
      signal => cosmosClient.container('admin-audit').read({ abortSignal: signal }),
      timeoutMs
    );
    return { status: 'ok', latencyMs: elapsedMs(startedAt), lastSuccess: new Date().toISOString() };
  } catch {
    return { status: 'down', latencyMs: elapsedMs(startedAt), lastSuccess: null };
  }
}

function checkPcgs(quotaService) {
  const startedAt = process.hrtime.bigint();
  const quota = quotaService.getStatus();
  return {
    status: quota.upstreamAvailability === 'available' ? 'ok' : 'degraded',
    latencyMs: elapsedMs(startedAt),
    lastSuccess: quota.lastProbeOutcome === 'succeeded' ? quota.lastProbeAt : null,
    upstreamAvailability: quota.upstreamAvailability,
    remaining: quota.remaining,
  };
}

function checkMetals(metalsService) {
  const startedAt = process.hrtime.bigint();
  const state = metalsService.getHealthStatus();
  return { ...state, latencyMs: elapsedMs(startedAt) };
}

function checkTerapeak(terapeakService) {
  const startedAt = process.hrtime.bigint();
  return { ...terapeakService.getHealthStatus(), latencyMs: elapsedMs(startedAt) };
}

function checkKeyVault() {
  return {
    status: 'not_probed',
    latencyMs: 0,
    lastSuccess: null,
  };
}

async function safeCheck(check) {
  const startedAt = process.hrtime.bigint();
  try {
    return await check();
  } catch {
    return { status: 'down', latencyMs: elapsedMs(startedAt), lastSuccess: null };
  }
}

function createHealthRouter(dependencies = {}) {
  const router = express.Router();
  const deepLimiter = dependencies.deepLimiter || rateLimit({
    windowMs: 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 10 : 1000,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  let cachedDeepHealth = null;
  let deepHealthInFlight = null;
  const services = {
    cosmos: dependencies.cosmos || cosmos,
    pcgsQuota: dependencies.pcgsQuota || pcgsQuota,
    metals: dependencies.metals || metals,
    terapeak: dependencies.terapeak || terapeak,
    requireAdmin: dependencies.requireAdmin || requireAdmin,
    probeTimeoutMs: dependencies.probeTimeoutMs || PROBE_TIMEOUT_MS,
  };

  async function runDeepChecks() {
    if (cachedDeepHealth && Date.now() - cachedDeepHealth.checkedAt < PROBE_CACHE_MS) {
      return cachedDeepHealth.dependencies;
    }
    if (deepHealthInFlight) return deepHealthInFlight;
    deepHealthInFlight = Promise.all([
      safeCheck(() => checkCosmos(services.cosmos, services.probeTimeoutMs)),
      safeCheck(() => checkMetals(services.metals)),
      safeCheck(() => checkPcgs(services.pcgsQuota)),
      safeCheck(() => checkTerapeak(services.terapeak)),
    ]).then(([cosmosStatus, metalsStatus, pcgsStatus, terapeakStatus]) => {
      const dependenciesStatus = {
        cosmos: cosmosStatus,
        keyVault: checkKeyVault(),
        metals: metalsStatus,
        pcgs: pcgsStatus,
        terapeak: terapeakStatus,
      };
      cachedDeepHealth = { checkedAt: Date.now(), dependencies: dependenciesStatus };
      return dependenciesStatus;
    }).finally(() => {
      deepHealthInFlight = null;
    });
    return deepHealthInFlight;
  }

  router.get('/', (req, res, next) => {
    if (req.query.deep !== '1') {
      return res.json({ status: 'ok', uptime: process.uptime() });
    }
    return deepLimiter(req, res, next);
  }, services.requireAdmin, async (_req, res) => {
    const dependenciesStatus = await runDeepChecks();
    const criticalDown = dependenciesStatus.cosmos.status === 'down';
    const degraded = Object.values(dependenciesStatus)
      .some(item => item.status === 'degraded' || item.status === 'down');
    return res.status(criticalDown ? 503 : 200).json({
      status: criticalDown ? 'unavailable' : 'ok',
      overall: criticalDown ? 'down' : (degraded ? 'degraded' : 'ok'),
      uptime: process.uptime(),
      dependencies: dependenciesStatus,
    });
  });

  return router;
}

module.exports = createHealthRouter();
module.exports.createHealthRouter = createHealthRouter;