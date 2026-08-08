#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeSearchKey } = require('../src/services/terapeakService');

const ROOT = path.join(__dirname, '..');
const DEFAULT_LEDGER_PATH = path.join(ROOT, 'cache', 'terapeak-runs', 'coins.jsonl');
const DEFAULT_META_PATH = path.join(ROOT, 'data', 'terapeak-meta.json');

function latestTime(...values) {
  const times = values.map(Date.parse).filter(Number.isFinite);
  return times.length ? Math.max(...times) : -Infinity;
}

function auditDormancy(rows, meta) {
  const byKey = new Map();
  for (const row of rows) {
    const key = normalizeSearchKey(row.coin || '');
    const time = Date.parse(row.ts);
    if (!key || !Number.isFinite(time) || !['ok', 'empty'].includes(row.status)) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ ...row, time });
  }

  const missingDormancy = [];
  const staleDormancy = [];
  for (const [key, events] of byKey) {
    events.sort((first, second) => first.time - second.time);
    const successes = events.filter(event => event.status === 'ok');
    const latestSuccessAt = successes.at(-1)?.time ?? -Infinity;
    const emptyAfterSuccess = events.filter(event => event.status === 'empty' && event.time > latestSuccessAt);
    const latestEmpty = emptyAfterSuccess.at(-1);
    const current = meta[key] || {};
    const currentRefreshAt = latestTime(current.page1At, current.lastRefreshAt);
    const runCount = new Set(events.map(event => event.run_id)).size;

    if (emptyAfterSuccess.length >= 2 && latestEmpty && currentRefreshAt <= latestEmpty.time &&
        (current.noDataCount || 0) < 2) {
      missingDormancy.push({
        key,
        attempts: events.length,
        runCount,
        emptyAfterSuccess: emptyAfterSuccess.length,
        latestEmptyAt: latestEmpty.ts,
        noDataCount: current.noDataCount || 0,
      });
    }

    const noDataAt = Date.parse(current.noDataAt) || -Infinity;
    const laterSuccess = successes.find(event => event.time > noDataAt);
    if ((current.noDataCount || 0) >= 2 && laterSuccess) {
      staleDormancy.push({
        key,
        attempts: events.length,
        runCount,
        noDataCount: current.noDataCount,
        noDataAt: current.noDataAt || null,
        latestSuccessAt: successes.at(-1).ts,
      });
    }
  }

  return {
    ledgerRows: rows.length,
    normalizedKeys: byKey.size,
    missingDormancy: missingDormancy.sort((a, b) => a.key.localeCompare(b.key)),
    staleDormancy: staleDormancy.sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function main() {
  const ledgerPath = process.argv.find(arg => arg.startsWith('--ledger='))?.slice('--ledger='.length) || DEFAULT_LEDGER_PATH;
  const metaPath = process.argv.find(arg => arg.startsWith('--meta='))?.slice('--meta='.length) || DEFAULT_META_PATH;
  const rows = fs.readFileSync(path.resolve(ledgerPath), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const meta = JSON.parse(fs.readFileSync(path.resolve(metaPath), 'utf8'));
  const report = auditDormancy(rows, meta);
  console.log(JSON.stringify(report, null, 2));
  if (report.missingDormancy.length || report.staleDormancy.length) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = { auditDormancy };