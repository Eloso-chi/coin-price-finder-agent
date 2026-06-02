#!/usr/bin/env node
'use strict';

/**
 * scripts/export-cosmos-terapeak-sold.js
 *
 * #246 -- pre-migration safety net for `scripts/merge-duplicate-keys.js
 * --apply --migrate-cosmos`.
 *
 * Reads every document in the `terapeak-sold` Cosmos container and writes
 * them as a single JSON file under `data/archive/`. The dump is full-fidelity
 * (all fields, including `comps[]`, `aggregationMeta`, `_etag`, etc.) so a
 * subsequent `--migrate-cosmos` run that goes wrong can be rolled back by
 * upserting the dumped docs back into Cosmos.
 *
 * USAGE:
 *   node scripts/export-cosmos-terapeak-sold.js
 *     -> writes data/archive/cosmos-terapeak-sold-<ISO>.json
 *   node scripts/export-cosmos-terapeak-sold.js --out path/to/file.json
 *     -> writes to the given path
 *   node scripts/export-cosmos-terapeak-sold.js --pretty
 *     -> human-readable JSON (default is compact / one doc per line in array)
 *
 * EXIT CODES:
 *   0  success
 *   1  fatal (Cosmos not configured, query failed, write failed)
 *   2  bad CLI args
 *
 * Run this BEFORE any `--migrate-cosmos` invocation.
 */

const fs = require('fs');
const path = require('path');

// ── CLI ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error(`[export] ${name} requires a value`);
    process.exit(2);
  }
  return v;
}
const OUT = flagValue('--out');
const PRETTY = argv.includes('--pretty');

// ── Paths ────────────────────────────────────────────────────────────
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'archive');
function defaultOutPath() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ARCHIVE_DIR, `cosmos-terapeak-sold-${ts}.json`);
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const cosmos = require('../src/utils/cosmosClient');
  if (!cosmos.isEnabled()) {
    console.error('[export] Cosmos is not configured (COSMOS_ENDPOINT/COSMOS_KEY missing). Aborting.');
    process.exit(1);
  }

  const outPath = OUT || defaultOutPath();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  console.log(`[export] reading container 'terapeak-sold' ...`);
  const container = cosmos.container('terapeak-sold');

  // SELECT * keeps comps[], aggregationMeta, _etag, _rid, _self, _ts, _attachments.
  // We keep system fields so the dump is exact-replay-capable.
  const iterator = container.items.query({ query: 'SELECT * FROM c' });

  const docs = [];
  let pageCount = 0;
  while (iterator.hasMoreResults()) {
    const { resources } = await iterator.fetchNext();
    if (resources && resources.length) {
      docs.push(...resources);
      pageCount++;
      if (pageCount % 10 === 0) {
        console.log(`[export]   pages fetched: ${pageCount} | docs so far: ${docs.length}`);
      }
    }
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    container: 'terapeak-sold',
    docCount: docs.length,
    docs,
  };

  const json = PRETTY ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  fs.writeFileSync(outPath, json + '\n');

  const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  console.log('');
  console.log('================================================================');
  console.log(`  [export] container:    terapeak-sold`);
  console.log(`  [export] docs written: ${docs.length}`);
  console.log(`  [export] file:         ${path.relative(process.cwd(), outPath)}`);
  console.log(`  [export] size:         ${sizeMb} MB`);
  console.log('================================================================');
}

main().catch(err => {
  console.error('[export] fatal:', err.stack || err.message);
  process.exit(1);
});
