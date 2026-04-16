#!/usr/bin/env node
// scripts/migrate-to-cosmos.js -- One-time migration of REAL data to Cosmos DB
// Migrates ONLY:
//   - greysheet_history.json (592 real coin price snapshots)
//   - metals_history.json (91 days of real spot prices)
// Does NOT migrate:
//   - users.json (test accounts only)
//   - user_coins.json (test data only)
//   - terapeak_sold.json (empty)
//   - Any synthetic/fake data

'use strict';

const fs = require('fs');
const path = require('path');

const CACHE_DIR = process.env.CACHE_DIR || path.resolve(__dirname, '..', 'cache');

async function main() {
  const endpoint = process.env.COSMOS_ENDPOINT;
  const key = process.env.COSMOS_KEY;
  const dbName = process.env.COSMOS_DB || 'coinprice';

  if (!endpoint || !key) {
    console.error('ERROR: COSMOS_ENDPOINT and COSMOS_KEY env vars required.');
    console.error('Usage: COSMOS_ENDPOINT=... COSMOS_KEY=... node scripts/migrate-to-cosmos.js');
    process.exit(1);
  }

  const { CosmosClient } = require('@azure/cosmos');
  const client = new CosmosClient({ endpoint, key });
  const db = client.database(dbName);

  // ── 1. Migrate greysheet_history.json ──
  const gsPath = path.join(CACHE_DIR, 'greysheet_history.json');
  if (fs.existsSync(gsPath)) {
    console.log('\n── Migrating greysheet_history.json ──');
    const gsData = JSON.parse(fs.readFileSync(gsPath, 'utf8'));
    const gsContainer = db.container('greysheet-history');
    const keys = Object.keys(gsData);
    console.log(`  ${keys.length} coin keys to migrate`);

    let success = 0, failed = 0;
    for (const coinKey of keys) {
      const docId = coinKey.replace(/[^a-zA-Z0-9_-]/g, '_');
      try {
        await gsContainer.items.upsert({
          id: docId,
          coinKey,
          snapshots: gsData[coinKey],
        });
        success++;
      } catch (err) {
        console.error(`  FAIL: ${coinKey}: ${err.message}`);
        failed++;
      }
    }
    console.log(`  Done: ${success} migrated, ${failed} failed`);
  } else {
    console.log('  greysheet_history.json not found -- skipping');
  }

  // ── 2. Migrate metals_history.json ──
  const mhPath = path.join(CACHE_DIR, 'metals_history.json');
  if (fs.existsSync(mhPath)) {
    console.log('\n── Migrating metals_history.json ──');
    const mhData = JSON.parse(fs.readFileSync(mhPath, 'utf8'));
    const mhContainer = db.container('metals-history');
    const metals = Object.keys(mhData);
    console.log(`  ${metals.length} metals to migrate`);

    let success = 0, failed = 0;
    for (const metal of metals) {
      try {
        await mhContainer.items.upsert({
          id: metal,
          metal,
          prices: mhData[metal],
        });
        success++;
      } catch (err) {
        console.error(`  FAIL: ${metal}: ${err.message}`);
        failed++;
      }
    }
    console.log(`  Done: ${success} migrated, ${failed} failed`);
  } else {
    console.log('  metals_history.json not found -- skipping');
  }

  console.log('\n✓ Migration complete. Only real data was migrated.');
  console.log('  Skipped: users.json (test accounts), user_coins.json (test data), terapeak_sold.json (empty)');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
