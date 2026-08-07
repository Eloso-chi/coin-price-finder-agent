#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeSearchKey } = require('../src/services/terapeakService');

const ROOT = path.join(__dirname, '..');
const DEFAULT_LEDGER_PATH = path.join(ROOT, 'cache', 'terapeak-runs', 'coins.jsonl');
const DEFAULT_META_PATH = path.join(ROOT, 'data', 'terapeak-meta.json');
const DEFAULT_RUN_ID = '20260807T014217Z-2334';
const DORMANT_MIN_NO_DATA_COUNT = 2;

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
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
    if (!grouped.has(row.coin)) grouped.set(row.coin, []);
    grouped.get(row.coin).push(row);
  }

  const plan = [];
  for (const [coin, events] of grouped) {
    const dormantEvents = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.status === 'empty' && event.dormant === true);
    const latestDormant = dormantEvents.at(-1);
    if (!latestDormant) continue;

    const laterDirectSuccess = events
      .slice(latestDormant.index + 1)
      .some(event => event.status === 'ok');
    if (laterDirectSuccess) continue;

    const key = normalizeSearchKey(coin);
    const entry = meta[key];
    if (!entry) {
      plan.push({ coin, key, action: 'blocked', reason: 'metadata entry missing' });
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
      noDataAt: latestTimestamp(entry.noDataAt, latestDormant.event.ts),
      evidencePass: latestDormant.event.pass,
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
  for (const repair of repairs) {
    const item = container.item(cosmosDocId(repair.key), repair.key);
    const { resource } = await item.read();
    if (!resource) throw new Error(`Cosmos document missing for ${repair.key}`);

    const currentMeta = resource.aggregationMeta || {};
    if ((currentMeta.noDataCount || 0) >= DORMANT_MIN_NO_DATA_COUNT) continue;

    resource.aggregationMeta = {
      ...currentMeta,
      noDataCount: repair.noDataCount,
      noDataAt: latestTimestamp(currentMeta.noDataAt, repair.noDataAt),
    };
    await item.replace(resource);
  }
}

function applySidecarRepairs(meta, repairs, metaPath) {
  for (const repair of repairs) {
    meta[repair.key] = {
      ...meta[repair.key],
      noDataCount: repair.noDataCount,
      noDataAt: repair.noDataAt,
    };
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
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

  const rows = readJsonLines(ledgerPath);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const plan = buildRepairPlan(rows, meta, runId);
  const repairs = plan.filter(item => item.action === 'repair');
  const blocked = plan.filter(item => item.action === 'blocked');

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', runId, repairs: repairs.length, plan }, null, 2));

  if (!apply) return;
  if (blocked.length > 0) throw new Error(`Repair blocked for ${blocked.length} missing metadata entries`);
  if (repairs.length === 0) return;

  const cosmos = require('../src/utils/cosmosClient');
  await applyCosmosRepairs(repairs, cosmos);
  applySidecarRepairs(meta, repairs, metaPath);
  console.log(`Applied ${repairs.length} proven dormancy repair(s) to Cosmos and ${metaPath}`);
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
  buildRepairPlan,
  cosmosDocId,
  latestTimestamp,
};
