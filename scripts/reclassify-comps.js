#!/usr/bin/env node
// scripts/reclassify-comps.js -- One-time batch reclassification of mismatched comps
//
// Scans all datasets in the terapeak store, detects comps whose weight
// (detected from listing title) doesn't match the dataset's expected weight,
// and moves them to the correct dataset key.
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
let totalSkipped = 0;
const summary = [];   // { from, to, count }
const reroutes = {};  // targetKey -> comp[]

for (const key of keys) {
  const dataset = store[key];
  if (!dataset?.comps?.length) continue;

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
      if (targetToken && targetToken !== currentToken) {
        const targetKey = key.replace(currentToken, targetToken);
        if (targetKey !== key) {
          if (!reroutes[targetKey]) reroutes[targetKey] = [];
          reroutes[targetKey].push(comp);
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
    const targets = {};
    for (const [tk, comps] of Object.entries(reroutes)) {
      const count = comps.filter(() => true).length; // placeholder -- targets calc'd below
      if (count > 0) targets[tk] = count;
    }
  }
}

// Apply reroutes to target datasets
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
    if (!dryRun) {
      existing.push(comp);
      if (comp.itemId) existingIds.add(comp.itemId);
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

  // Find source keys for summary
  const sourceKeys = Object.keys(store).filter(k => {
    const ew = detectWeightFromQuery(k);
    if (ew == null) return false;
    const ct = weightToKeyToken(ew);
    return ct && k.replace(ct, weightToKeyToken(detectWeightFromQuery(targetKey))) === targetKey;
  });

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

// Save if applying
if (!dryRun && totalReclassified > 0) {
  console.log('\nSaving store...');
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  console.log('Done. Store saved to', STORE_PATH);
} else if (dryRun && totalReclassified > 0) {
  console.log('\n[dry-run] No changes written. Run with --apply to commit.');
}
