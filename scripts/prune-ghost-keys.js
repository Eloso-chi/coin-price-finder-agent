#!/usr/bin/env node
/**
 * Cleanup: remove duplicate and ghost keys from data/terapeak-meta.json.
 *
 * Duplicates arise because different code paths normalize keys differently:
 *   - "1878-cc morgan silver dollar" (backfill) vs "1878 cc morgan silver dollar" (server)
 *   - "2011 mexico 1oz silver libertad" (Cosmos) vs "2011 mexican silver libertad 1oz" (CSV import)
 *   - "american silver eagle" vs "american silver eagle 1oz"
 *   - "14oz" (broken fraction) vs "quarter oz" (correct)
 *
 * The script keeps the key that matches the server's normalizeSearchKey()
 * output, merges timestamps and picks the higher compCount, then deletes
 * the duplicate.
 *
 * Usage:
 *   node scripts/prune-ghost-keys.js             # Prune and save
 *   node scripts/prune-ghost-keys.js --dry-run    # Preview only
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeSearchKey } = require('../src/services/terapeakService');

const META_PATH = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const DRY_RUN = process.argv.includes('--dry-run');

const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
const originalCount = Object.keys(meta).length;

const COUNTRY_MAP = {
  'mexico': 'mexican', 'canada': 'canadian', 'china': 'chinese',
  'australia': 'australian', 'austria': 'austrian', 'britain': 'british',
};

// ── Phase 1: Merge entries that normalize to the same server key ──────
// Group all meta keys by their normalizeSearchKey() output.
const groups = {};
for (const key of Object.keys(meta)) {
  const canonical = normalizeSearchKey(key);
  if (!groups[canonical]) groups[canonical] = [];
  groups[canonical].push(key);
}

let mergedDuplicates = 0;
const toDelete = new Set();

function mergeLoserIntoWinner(winner, loser) {
  const w = meta[winner];
  const l = meta[loser];
  if (l.deepAt && !w.deepAt) w.deepAt = l.deepAt;
  if (l.page1At && !w.page1At) w.page1At = l.page1At;
  if (l.lastRefreshAt && !w.lastRefreshAt) w.lastRefreshAt = l.lastRefreshAt;
  if (l.newestSaleDate && (!w.newestSaleDate || l.newestSaleDate > w.newestSaleDate)) {
    w.newestSaleDate = l.newestSaleDate;
  }
  if (l.oldestSaleDate && (!w.oldestSaleDate || l.oldestSaleDate < w.oldestSaleDate)) {
    w.oldestSaleDate = l.oldestSaleDate;
  }
  if ((l.compCount || 0) > (w.compCount || 0)) {
    w.compCount = l.compCount;
  }
  toDelete.add(loser);
}

for (const [canonical, keys] of Object.entries(groups)) {
  if (keys.length < 2) continue;

  // Pick the winner: prefer the key that equals the canonical form,
  // then prefer the one with the highest compCount.
  keys.sort((a, b) => {
    if (a === canonical && b !== canonical) return -1;
    if (b === canonical && a !== canonical) return 1;
    return (meta[b].compCount || 0) - (meta[a].compCount || 0);
  });

  const winner = keys[0];
  for (let i = 1; i < keys.length; i++) {
    mergeLoserIntoWinner(winner, keys[i]);
    mergedDuplicates++;
  }
}

// ── Phase 1b: Word-set dedup with country/adjective normalization ─────
// Catches duplicates like "2011 mexican silver libertad 1oz" vs
// "2011 mexico 1oz silver libertad" that normalizeSearchKey doesn't unify.
const DEMONYM_MAP = {
  'mexican': 'mexico', 'canadian': 'canada', 'chinese': 'china',
  'australian': 'australia', 'austrian': 'austria', 'british': 'britain',
};

function toWordSet(key) {
  let s = key.toLowerCase();
  for (const [adj, country] of Object.entries(DEMONYM_MAP)) {
    s = s.replace(new RegExp(`\\b${adj}\\b`, 'g'), country);
  }
  s = s.replace(/\bgreat britain\b/g, 'britain');
  return s.split(/\s+/).filter(Boolean).sort().join(' ');
}

const wsGroups = {};
const remainingAfterP1 = Object.keys(meta).filter(k => !toDelete.has(k));
for (const key of remainingAfterP1) {
  const ws = toWordSet(key);
  if (!wsGroups[ws]) wsGroups[ws] = [];
  wsGroups[ws].push(key);
}

let mergedWordSet = 0;
for (const [, keys] of Object.entries(wsGroups)) {
  if (keys.length < 2) continue;
  // Prefer the key that matches normalizeSearchKey output, then highest compCount
  keys.sort((a, b) => {
    const aNorm = normalizeSearchKey(a) === a ? -1 : 0;
    const bNorm = normalizeSearchKey(b) === b ? -1 : 0;
    if (aNorm !== bNorm) return aNorm - bNorm;
    return (meta[b].compCount || 0) - (meta[a].compCount || 0);
  });
  const winner = keys[0];
  for (let i = 1; i < keys.length; i++) {
    mergeLoserIntoWinner(winner, keys[i]);
    mergedWordSet++;
  }
}

// ── Phase 2: Handle ghost keys that don't merge via normalizeSearchKey ──
// These have different word order or country/adjective that normalizeSearchKey
// doesn't resolve (e.g. "2011 mexico 1oz silver libertad" -> still different
// from "2011 mexican silver libertad 1oz").
const remaining = Object.keys(meta).filter(k => !toDelete.has(k));
const realKeys = new Set(remaining.filter(k => meta[k].compCount && meta[k].compCount > 0));

let mergedCrossFormat = 0;
let deletedOrphan = 0;

for (const key of remaining) {
  if (toDelete.has(key)) continue;
  if (realKeys.has(key)) continue; // skip keys with data

  const val = meta[key];
  let realKey = null;

  // Type 1: Country -> adjective + word reorder
  const parts = key.split(' ');
  if (parts.length >= 5 && COUNTRY_MAP[parts[1]]) {
    const [year, country, weight, metal, ...series] = parts;
    const candidate = `${year} ${COUNTRY_MAP[country]} ${metal} ${series.join(' ')} ${weight}`;
    if (realKeys.has(candidate)) realKey = candidate;
  }

  // Type 2: Mint-mark space -> hyphen
  if (!realKey) {
    const mintMatch = key.match(/^(\d{4}) (cc|d|s|o|w|p) (.+)$/);
    if (mintMatch) {
      const candidate = `${mintMatch[1]}-${mintMatch[2]} ${mintMatch[3]}`;
      if (realKeys.has(candidate)) realKey = candidate;
    }
  }

  // Type 3: Missing weight suffix
  if (!realKey && !key.includes('oz')) {
    const candidate = key + ' 1oz';
    if (realKeys.has(candidate)) realKey = candidate;
  }

  if (realKey) {
    const real = meta[realKey];
    if (val.deepAt && !real.deepAt) real.deepAt = val.deepAt;
    if (val.page1At && !real.page1At) real.page1At = val.page1At;
    if (val.lastRefreshAt && !real.lastRefreshAt) real.lastRefreshAt = val.lastRefreshAt;
    toDelete.add(key);
    mergedCrossFormat++;
  } else {
    toDelete.add(key);
    deletedOrphan++;
  }
}

console.log(`\nPrune analysis (${originalCount} entries):`);
console.log(`  Phase 1  -- same normalizeSearchKey:   ${mergedDuplicates} duplicates merged`);
console.log(`  Phase 1b -- word-set dedup:            ${mergedWordSet} duplicates merged`);
console.log(`  Phase 2  -- cross-format ghosts:       ${mergedCrossFormat} merged, ${deletedOrphan} orphans deleted`);
console.log(`  Total to remove: ${toDelete.size}`);
console.log(`  Remaining after prune: ${originalCount - toDelete.size}`);

if (DRY_RUN) {
  console.log('\n(dry run -- not saved)');
  const sample = [...toDelete].slice(0, 10);
  console.log('\nSample deletions:');
  for (const k of sample) {
    console.log(`  "${k}"`);
  }
  if (toDelete.size > 10) console.log(`  ... and ${toDelete.size - 10} more`);
} else {
  for (const k of toDelete) {
    delete meta[k];
  }
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');
  console.log(`\nSaved to ${META_PATH}`);
}
