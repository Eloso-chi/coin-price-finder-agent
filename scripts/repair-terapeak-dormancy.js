#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeSearchKey } = require('../src/services/terapeakService');

const ROOT = path.join(__dirname, '..');
const DEFAULT_LEDGER_PATH = path.join(ROOT, 'cache', 'terapeak-runs', 'coins.jsonl');
const DEFAULT_META_PATH = path.join(ROOT, 'data', 'terapeak-meta.json');
const DEFAULT_JOURNAL_PATH = path.join(ROOT, 'cache', 'terapeak-dormancy-repair.json');
const DEFAULT_RUN_ID = '20260807T014217Z-2334';
const DEFAULT_LEDGER_SHA256 = '8b6252950723c80ce9e73950829fc41d1d88cc2d5139e26c2c1d4554e3d2ff02';
const DORMANT_MIN_NO_DATA_COUNT = 2;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function acquireSidecarLock(metaPath) {
  const lockPath = `${metaPath}.lock`;
  let handle;
  try {
    handle = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Sidecar is locked: ${lockPath}`);
    throw error;
  }
  return () => {
    fs.closeSync(handle);
    fs.rmSync(lockPath, { force: true });
  };
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tempPath, filePath);
}

function readJsonLines(filePath) {
  const rows = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row.run_id !== 'string' || typeof row.coin !== 'string' ||
        typeof row.status !== 'string' || typeof row.dormant !== 'boolean' ||
        !Number.isFinite(new Date(row.ts).getTime())) {
      throw new Error(`Invalid ledger row ${index + 1}`);
    }
  }
  return rows;
}

function latestTimestamp(first, second) {
  const candidates = [first, second]
    .map(value => ({ value, time: value ? new Date(value).getTime() : NaN }))
    .filter(candidate => Number.isFinite(candidate.time));
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, candidate) => candidate.time > latest.time ? candidate : latest).value;
}

function buildRepairPlan(rows, meta, runId) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.run_id !== runId || !row.coin) continue;
    const key = normalizeSearchKey(row.coin);
    if (!grouped.has(key)) grouped.set(key, { coin: row.coin, events: [] });
    grouped.get(key).events.push(row);
  }

  const plan = [];
  for (const [key, { coin, events }] of grouped) {
    const dormantEvents = events
      .filter(event => event.status === 'empty' && event.dormant === true)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));
    const latestDormant = dormantEvents.at(-1);
    if (!latestDormant) continue;

    const dormantTime = new Date(latestDormant.ts).getTime();
    const laterDirectSuccess = rows.some(row =>
      normalizeSearchKey(row.coin || '') === key &&
      row.status === 'ok' &&
      new Date(row.ts).getTime() > dormantTime
    );
    if (laterDirectSuccess) continue;

    const entry = meta[key];
    if (!entry) {
      plan.push({ coin, key, action: 'blocked', reason: 'metadata entry missing' });
      continue;
    }

    const currentRefreshAt = latestTimestamp(entry.page1At, entry.lastRefreshAt);
    if (currentRefreshAt && new Date(currentRefreshAt).getTime() > dormantTime) {
      plan.push({
        coin,
        key,
        action: 'skip',
        reason: 'metadata has a later direct refresh',
        currentRefreshAt,
      });
      continue;
    }

    const previousCount = entry.noDataCount || 0;
    if (previousCount >= DORMANT_MIN_NO_DATA_COUNT) {
      plan.push({
        coin,
        key,
        action: 'skip',
        reason: 'already dormant',
        previousCount,
        previousNoDataAt: entry.noDataAt || null,
      });
      continue;
    }

    plan.push({
      coin,
      key,
      action: 'repair',
      reason: 'direct empty result reached dormancy with no later direct success',
      previousCount,
      previousNoDataAt: entry.noDataAt || null,
      noDataCount: DORMANT_MIN_NO_DATA_COUNT,
      noDataAt: latestTimestamp(entry.noDataAt, latestDormant.ts),
      evidenceAt: latestDormant.ts,
      evidencePass: latestDormant.pass,
    });
  }

  return plan.sort((a, b) => a.key.localeCompare(b.key));
}

function cosmosDocId(key) {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 200);
}

async function applyCosmosRepairs(repairs, cosmos) {
  if (!cosmos.isEnabled()) {
    throw new Error('Cosmos is not configured; refusing a partial metadata repair');
  }

  const container = cosmos.container('terapeak-sold');
  const preflight = [];
  for (const repair of repairs) {
    if (!Number.isFinite(new Date(repair.evidenceAt).getTime())) {
      throw new Error(`Repair has no valid evidence timestamp for ${repair.key}`);
    }
    const item = container.item(cosmosDocId(repair.key), repair.key);
    const { resource } = await item.read();
    if (!resource) throw new Error(`Cosmos document missing for ${repair.key}`);
    if (!resource._etag) throw new Error(`Cosmos document has no ETag for ${repair.key}`);
    if (!resource.aggregationMeta) throw new Error(`Cosmos document has no aggregationMeta for ${repair.key}`);

    const currentRefreshAt = latestTimestamp(resource.aggregationMeta.page1At, resource.aggregationMeta.lastRefreshAt);
    if (currentRefreshAt && new Date(currentRefreshAt) > new Date(repair.evidenceAt)) {
      continue;
    }
    preflight.push({ item, resource, repair });
  }

  const reconciled = [];
  const errors = [];
  for (const { item, resource, repair } of preflight) {
    const currentMeta = resource.aggregationMeta;
    const noDataCount = Math.max(currentMeta.noDataCount || 0, repair.noDataCount);
    const noDataAt = latestTimestamp(currentMeta.noDataAt, repair.noDataAt);
    if ((currentMeta.noDataCount || 0) >= DORMANT_MIN_NO_DATA_COUNT) {
      reconciled.push({ ...repair, noDataCount, noDataAt });
      continue;
    }

    try {
      await item.patch([
        { op: 'set', path: '/aggregationMeta/noDataCount', value: noDataCount },
        { op: 'set', path: '/aggregationMeta/noDataAt', value: noDataAt },
      ], {
        accessCondition: { type: 'IfMatch', condition: resource._etag },
      });
      reconciled.push({ ...repair, noDataCount, noDataAt });
    } catch (error) {
      errors.push({ key: repair.key, error });
    }
  }
  return { reconciled, errors };
}

function applySidecarRepairs(repairs, metaPath, expectedHash) {
  const source = fs.readFileSync(metaPath, 'utf8');
  if (expectedHash && sha256(source) !== expectedHash) {
    throw new Error('Sidecar changed after repair planning; rerun to reconcile safely');
  }
  const meta = JSON.parse(source);
  const originalKeyCount = Object.keys(meta).length;
  for (const repair of repairs) {
    if (!meta[repair.key]) throw new Error(`Sidecar metadata entry missing for ${repair.key}`);
    meta[repair.key] = {
      ...meta[repair.key],
      noDataCount: Math.max(meta[repair.key].noDataCount || 0, repair.noDataCount),
      noDataAt: latestTimestamp(meta[repair.key].noDataAt, repair.noDataAt),
    };
  }
  if (Object.keys(meta).length !== originalKeyCount) throw new Error('Sidecar key count changed during repair');

  writeJsonAtomic(metaPath, meta);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const runIdArg = args.find(arg => arg.startsWith('--run-id='));
  const ledgerArg = args.find(arg => arg.startsWith('--ledger='));
  const metaArg = args.find(arg => arg.startsWith('--meta='));
  const runId = runIdArg ? runIdArg.slice('--run-id='.length) : DEFAULT_RUN_ID;
  const ledgerPath = ledgerArg ? path.resolve(ledgerArg.slice('--ledger='.length)) : DEFAULT_LEDGER_PATH;
  const metaPath = metaArg ? path.resolve(metaArg.slice('--meta='.length)) : DEFAULT_META_PATH;

  if (apply && (ledgerPath !== DEFAULT_LEDGER_PATH || metaPath !== DEFAULT_META_PATH)) {
    throw new Error('--apply requires the canonical ledger and metadata paths');
  }
  if (apply && runId !== DEFAULT_RUN_ID) {
    throw new Error(`--apply is pinned to audited run ${DEFAULT_RUN_ID}`);
  }
  const expectedDatabase = process.env.COSMOS_DB || 'coinprice';
  if (apply && !args.includes(`--confirm-cosmos=${expectedDatabase}`)) {
    throw new Error(`--apply requires --confirm-cosmos=${expectedDatabase}`);
  }

  const endpoint = process.env.COSMOS_ENDPOINT;
  const expectedAccount = endpoint ? new URL(endpoint).hostname : null;
  if (apply && (!expectedAccount || !args.includes(`--confirm-cosmos-account=${expectedAccount}`))) {
    throw new Error(`--apply requires --confirm-cosmos-account=${expectedAccount || '<configured-account>'}`);
  }

  const ledgerSource = fs.readFileSync(ledgerPath, 'utf8');
  if (apply && sha256(ledgerSource) !== DEFAULT_LEDGER_SHA256) {
    throw new Error('Canonical ledger does not match the audited evidence digest');
  }
  const rows = readJsonLines(ledgerPath);
  const metaSource = fs.readFileSync(metaPath, 'utf8');
  const meta = JSON.parse(metaSource);
  const plan = buildRepairPlan(rows, meta, runId);
  const repairs = plan.filter(item => item.action === 'repair');
  const blocked = plan.filter(item => item.action === 'blocked');

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', runId, repairs: repairs.length, plan }, null, 2));

  if (!apply) return;
  if (blocked.length > 0) throw new Error(`Repair blocked for ${blocked.length} missing metadata entries`);
  if (repairs.length === 0) return;

  const releaseLock = acquireSidecarLock(metaPath);
  const journal = { runId, status: 'pending', repairs, updatedAt: new Date().toISOString() };
  try {
    if (sha256(fs.readFileSync(metaPath, 'utf8')) !== sha256(metaSource)) {
      throw new Error('Sidecar changed before repair lock was acquired; rerun the repair');
    }
    writeJsonAtomic(DEFAULT_JOURNAL_PATH, journal);
    const cosmos = require('../src/utils/cosmosClient');
    const result = await applyCosmosRepairs(repairs, cosmos);
    journal.status = 'cosmos-complete';
    journal.reconciled = result.reconciled;
    journal.errors = result.errors.map(item => ({ key: item.key, message: item.error.message }));
    journal.updatedAt = new Date().toISOString();
    writeJsonAtomic(DEFAULT_JOURNAL_PATH, journal);
    applySidecarRepairs(result.reconciled, metaPath, sha256(metaSource));
    journal.status = result.errors.length > 0 ? 'partial' : 'complete';
    journal.updatedAt = new Date().toISOString();
    writeJsonAtomic(DEFAULT_JOURNAL_PATH, journal);
    if (result.errors.length > 0) {
      throw new Error(`Cosmos repair failed for ${result.errors.map(item => item.key).join(', ')}; successful writes were reconciled to the sidecar`);
    }
    console.log(`Applied ${result.reconciled.length} proven dormancy repair(s) to Cosmos and ${metaPath}`);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[repair-terapeak-dormancy] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DORMANT_MIN_NO_DATA_COUNT,
  applyCosmosRepairs,
  applySidecarRepairs,
  acquireSidecarLock,
  buildRepairPlan,
  cosmosDocId,
  latestTimestamp,
};
