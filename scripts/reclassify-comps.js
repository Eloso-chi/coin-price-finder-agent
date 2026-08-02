#!/usr/bin/env node
// scripts/reclassify-comps.js -- One-time batch reclassification of mismatched comps
//
// Scans Libertad datasets in the terapeak store, detects comps whose
// fractional weight (from the listing title) doesn't match the dataset's
// expected weight, and moves them to the correct dataset key.
//
// Usage:
//   node scripts/reclassify-comps.js              # dry-run (default)
//   node scripts/reclassify-comps.js --apply       # apply changes
//
// This is Option B from the reclassification plan -- cleanup existing data.

'use strict';

const path = require('path');
const fs = require('fs');

// Load the store directly to avoid import overhead
const CACHE_DIR = require(path.join(__dirname, '..', 'src', 'utils', 'cachePath')).CACHE_DIR;
const STORE_PATH = path.join(CACHE_DIR, 'terapeak_sold.json');

const { detectWeightFromTitle, weightToKeyToken } = require(path.join(__dirname, '..', 'src', 'utils', 'coinMetalProfile'));
const { detectWeightFromQuery, normalizeSearchKey, detectMetal } = require(path.join(__dirname, '..', 'src', 'services', 'terapeakService'));

const dryRun = !process.argv.includes('--apply');

console.log(dryRun
  ? '[dry-run] Scanning for mismatched comps (use --apply to commit changes)'
  : '[apply] Reclassifying mismatched comps...');

// Load the raw store
let store;
try {
  store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
} catch (err) {
  console.error('Failed to load store:', err.message);
  process.exit(1);
}

const keys = Object.keys(store);
console.log(`Scanning ${keys.length} datasets...\n`);

let totalReclassified = 0;
const reroutes = {};  // targetKey -> comp[]
const routeCounts = new Map();
const FRACTIONAL_TOKENS = new Set(['twentieth oz', 'tenth oz', 'quarter oz', 'half oz']);

for (const key of keys) {
  const dataset = store[key];
  if (!dataset?.comps?.length) continue;
  if (!/\blibertad\b/i.test(key)) continue;

  const expectedWeight = detectWeightFromQuery(key);
  if (expectedWeight == null) continue;   // can't determine expected weight

  const expectedMetal = detectMetal(key);
  const currentToken = weightToKeyToken(expectedWeight);
  if (!currentToken) continue;

  const keep = [];
  let movedFromThisKey = 0;

  for (const comp of dataset.comps) {
    const actualWeight = detectWeightFromTitle(comp.title);
    const actualMetal  = detectMetal(comp.title);

    // Metal mismatch -- leave in place (meltFloor handles these)
    if (expectedMetal && actualMetal && actualMetal !== expectedMetal) {
      keep.push(comp);
      continue;
    }

    if (actualWeight != null && Math.abs(actualWeight - expectedWeight) >= 0.01) {
      const targetToken = weightToKeyToken(actualWeight);
      if (FRACTIONAL_TOKENS.has(targetToken) && targetToken !== currentToken) {
        const targetKey = key.replace(currentToken, targetToken);
        if (targetKey !== key) {
          if (!reroutes[targetKey]) reroutes[targetKey] = [];
          reroutes[targetKey].push(comp);
          const route = `${key} -> ${targetKey}`;
          routeCounts.set(route, (routeCounts.get(route) || 0) + 1);
          movedFromThisKey++;
          totalReclassified++;
          continue;
        }
      }
    }
    keep.push(comp);
  }

  if (movedFromThisKey > 0) {
    // Update comps in source dataset
    if (!dryRun) {
      dataset.comps = keep;
      if (dataset.aggregationMeta) {
        dataset.aggregationMeta.compCount = keep.length;
      }
    }
  }
}

// Apply reroutes to target datasets
const summary = [];
for (const [targetKey, comps] of Object.entries(reroutes)) {
  const existing = store[targetKey]?.comps || [];
  const existingIds = new Set(existing.map(c => c.itemId).filter(Boolean));
  let added = 0;
  let duped = 0;

  for (const comp of comps) {
    if (comp.itemId && existingIds.has(comp.itemId)) {
      duped++;
      continue;
    }
    if (comp.itemId) existingIds.add(comp.itemId);
    if (!dryRun) {
      existing.push(comp);
    }
    added++;
  }

  if (!dryRun) {
    if (!store[targetKey]) {
      store[targetKey] = {
        searchTerm: targetKey,
        comps: existing,
        lastImport: new Date().toISOString(),
        importCount: 1,
        aggregationMeta: { compCount: existing.length }
      };
    } else {
      store[targetKey].comps = existing;
      store[targetKey].lastImport = new Date().toISOString();
      if (store[targetKey].aggregationMeta) {
        store[targetKey].aggregationMeta.compCount = existing.length;
      }
    }
  }

  summary.push({
    target: targetKey,
    added,
    duplicates: duped,
    total: comps.length
  });
}

// Print summary
console.log('=== Reclassification Summary ===');
console.log(`Total comps reclassified: ${totalReclassified}`);
console.log(`Datasets scanned: ${keys.length}\n`);

if (summary.length > 0) {
  console.log('Target Dataset'.padEnd(55) + 'Added  Dupes  Total');
  console.log('-'.repeat(80));
  for (const row of summary) {
    console.log(
      row.target.padEnd(55) +
      String(row.added).padStart(5) + '  ' +
      String(row.duplicates).padStart(5) + '  ' +
      String(row.total).padStart(5)
    );
  }
} else {
  console.log('No mismatched comps found.');
}

if (routeCounts.size > 0) {
  console.log('\nSource -> Target Routes');
  console.log('-'.repeat(80));
  for (const [route, count] of routeCounts) {
    console.log(`${String(count).padStart(5)}  ${route}`);
  }
}

// Save if applying
if (!dryRun && totalReclassified > 0) {
  console.log('\nSaving store...');
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  console.log('Done. Store saved to', STORE_PATH);
} else if (dryRun && totalReclassified > 0) {
  console.log('\n[dry-run] No changes written. Run with --apply to commit.');
}
