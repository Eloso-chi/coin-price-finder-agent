#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_OUT = 'cache/lot-estimator-health.json';

const COIN_POOL = [
  '1964 Kennedy Half Dollar',
  '1921 Morgan Silver Dollar MS63',
  '1923 Peace Dollar',
  '1955 Franklin Half Dollar',
  '1932 S Washington Quarter',
  '1937 Buffalo Nickel',
  '2024 American Silver Eagle',
  '2023 American Gold Eagle 1 oz',
  '2024 American Gold Eagle 1/10 oz',
  '2024 American Platinum Eagle 1 oz',
  '2024 Canadian Silver Maple Leaf 1 oz',
  '2023 Mexican Silver Libertad 1 oz',
  '2024 British Silver Britannia 1 oz',
  '2024 Austrian Silver Philharmonic 1 oz',
  '2023 Chinese Silver Panda 30g',
  '2024 South African Krugerrand 1 oz',
  '2024 Australian Gold Kangaroo 1 oz',
  '2024 Canadian Gold Maple Leaf 1 oz',
  '2023 Mexican Gold Libertad 1 oz',
  '1986 American Silver Eagle',
  '2021 American Silver Eagle Type 2',
  '2011 Silver Libertad 1 oz',
  '2014 Silver Libertad 1 oz',
  '2016 Silver Libertad 1 oz',
  '2020 Silver Libertad 1 oz',
  '2024 Silver Libertad 1 oz',
];

function getArg(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) ? n : fallback;
}

function toNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeSeed(seedRaw) {
  if (seedRaw == null) return Date.now() >>> 0;
  const n = Number(seedRaw);
  if (Number.isFinite(n)) return n >>> 0;
  let hash = 2166136261;
  const str = String(seedRaw);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomInt(min, max, rand) {
  return min + Math.floor(rand() * (max - min + 1));
}

function pick(array, rand) {
  return array[Math.floor(rand() * array.length)];
}

function classifyDelta(deltaPct) {
  if (deltaPct <= 1.0) return 'green';
  if (deltaPct <= 2.5) return 'warn';
  return 'fail';
}

function classifyCoinDelta(deltaPct) {
  if (deltaPct <= 2.0) return 'green';
  if (deltaPct <= 5.0) return 'warn';
  return 'fail';
}

async function httpJson(baseUrl, method, route, body) {
  const res = await fetch(baseUrl + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  if (!res.ok) {
    const err = json && json.error ? json.error : `HTTP ${res.status}`;
    throw new Error(`${method} ${route} failed: ${err}`);
  }

  return json;
}

async function waitForBulk(baseUrl, jobId, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await httpJson(baseUrl, 'GET', `/api/bulk-evaluate/${jobId}`);
    if (state.status === 'complete') return state;
    if (state.status === 'error') {
      throw new Error(`bulk job ${jobId} failed: ${state.error || 'unknown error'}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`bulk job ${jobId} timed out after ${timeoutMs}ms`);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const out = new Array(items.length);
  let idx = 0;

  async function runOne() {
    while (idx < items.length) {
      const current = idx++;
      out[current] = await worker(items[current], current);
    }
  }

  const lanes = Array.from({ length: Math.max(1, concurrency) }, () => runOne());
  await Promise.all(lanes);
  return out;
}

async function run() {
  const baseUrl = getArg('base-url', DEFAULT_BASE_URL);
  const seed = normalizeSeed(getArg('seed', process.env.LOT_HEALTH_SEED));
  const lotCount = toInt(getArg('lots', 8), 8);
  const minSize = toInt(getArg('min-size', 5), 5);
  const maxSize = toInt(getArg('max-size', 10), 10);
  const maxQty = toInt(getArg('max-qty', 3), 3);
  const repeat = toInt(getArg('repeat', 2), 2);
  const perCoinConcurrency = toInt(getArg('coin-concurrency', 4), 4);
  const outFile = getArg('out', DEFAULT_OUT);

  try {
    await httpJson(baseUrl, 'GET', '/api/health');
  } catch (err) {
    console.error(`Server is not healthy at ${baseUrl}: ${err.message}`);
    process.exit(1);
  }

  const rand = mulberry32(seed);

  const lots = [];
  for (let i = 0; i < lotCount; i++) {
    const size = randomInt(minSize, maxSize, rand);
    const items = [];
    for (let j = 0; j < size; j++) {
      items.push({
        query: pick(COIN_POOL, rand),
        qty: randomInt(1, maxQty, rand),
      });
    }
    lots.push({ id: `lot-${i + 1}`, items });
  }

  const startedAt = new Date().toISOString();
  const lotReports = [];

  for (const lot of lots) {
    const indiv = await mapWithConcurrency(lot.items, perCoinConcurrency, async (item) => {
      const r = await httpJson(baseUrl, 'POST', '/api/price', { query: item.query });
      const fmv = r?.valuation?.fmvCore;
      return {
        query: item.query,
        qty: item.qty,
        fmv: typeof fmv === 'number' ? fmv : null,
        confidence: r?.valuation?.confidence ?? null,
      };
    });

    const individualTotal = +indiv.reduce((sum, row) => {
      if (row.fmv == null) return sum;
      return sum + row.fmv * row.qty;
    }, 0).toFixed(2);

    const runStates = [];
    for (let i = 0; i < repeat; i++) {
      const submit = await httpJson(baseUrl, 'POST', '/api/bulk-evaluate', { items: lot.items });
      const state = await waitForBulk(baseUrl, submit.jobId);
      runStates.push(state);
    }

    const first = runStates[0];
    const bulkTotal = +(first?.lotSummary?.totalFmv || 0).toFixed(2);
    const lotDeltaPct = individualTotal > 0
      ? +((Math.abs(bulkTotal - individualTotal) / individualTotal) * 100).toFixed(2)
      : 0;

    const repeatTotals = runStates.map((s) => +(s?.lotSummary?.totalFmv || 0).toFixed(2));
    const maxRepeat = Math.max(...repeatTotals);
    const minRepeat = Math.min(...repeatTotals);
    const consistencyDriftPct = individualTotal > 0
      ? +(((maxRepeat - minRepeat) / individualTotal) * 100).toFixed(2)
      : 0;

    const perCoin = [];
    for (let i = 0; i < lot.items.length; i++) {
      const one = indiv[i];
      const bulkRow = first.results[i] || {};
      const deltaPct = (one.fmv != null && bulkRow.fmv != null && one.fmv > 0)
        ? +((Math.abs(bulkRow.fmv - one.fmv) / one.fmv) * 100).toFixed(2)
        : null;
      perCoin.push({
        query: one.query,
        qty: one.qty,
        individualFmv: one.fmv,
        bulkFmv: bulkRow.fmv ?? null,
        bulkComps: bulkRow.compCount ?? null,
        deltaPct,
        bucket: deltaPct == null ? 'unknown' : classifyCoinDelta(deltaPct),
      });
    }

    lotReports.push({
      lotId: lot.id,
      coinCount: lot.items.length,
      individualTotal,
      bulkTotal,
      lotDeltaPct,
      lotBucket: classifyDelta(lotDeltaPct),
      repeatTotals,
      consistencyDriftPct,
      consistencyOk: consistencyDriftPct <= 1.5,
      perCoin,
    });
  }

  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl,
    seed,
    lotCount,
    thresholds: {
      lot: { greenMax: 1.0, warnMax: 2.5 },
      coin: { greenMax: 2.0, warnMax: 5.0 },
      consistencyDriftMaxPct: 1.5,
    },
    totals: {
      greenLots: lotReports.filter((r) => r.lotBucket === 'green').length,
      warnLots: lotReports.filter((r) => r.lotBucket === 'warn').length,
      failLots: lotReports.filter((r) => r.lotBucket === 'fail').length,
      consistencyFailures: lotReports.filter((r) => !r.consistencyOk).length,
      avgLotDeltaPct: +(
        lotReports.reduce((sum, r) => sum + r.lotDeltaPct, 0) /
        Math.max(1, lotReports.length)
      ).toFixed(2),
      worstLotDeltaPct: +Math.max(...lotReports.map((r) => r.lotDeltaPct)).toFixed(2),
    },
    lots: lotReports,
  };

  const outPath = path.resolve(outFile);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  console.log('Lot Estimator Health');
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Seed: ${seed}`);
  console.log(`Lots: ${lotCount}`);
  console.log('----------------------------------------');
  for (const lot of lotReports) {
    console.log(
      `${lot.lotId} coins=${lot.coinCount} ` +
      `delta=${lot.lotDeltaPct.toFixed(2)}% (${lot.lotBucket}) ` +
      `consistencyDrift=${lot.consistencyDriftPct.toFixed(2)}%`
    );
  }
  console.log('----------------------------------------');
  console.log(
    `Summary green=${summary.totals.greenLots} warn=${summary.totals.warnLots} ` +
    `fail=${summary.totals.failLots} consistencyFailures=${summary.totals.consistencyFailures}`
  );
  console.log(`Report written: ${outPath}`);

  if (summary.totals.failLots > 0 || summary.totals.consistencyFailures > 0) {
    process.exit(2);
  }
}

run().catch((err) => {
  console.error(`lot-estimator-health failed: ${err.message}`);
  process.exit(1);
});
