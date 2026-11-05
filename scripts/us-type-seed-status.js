#!/usr/bin/env node
/**
 * us-type-seed-status.js (#334H)
 *
 * Reports, per seed group, how the US type seed terms in
 * data/research/us-type-seed.json are doing in data/terapeak-meta.json:
 * pending (no data and no no-data report yet), no-data, thin (1-9 comps) and
 * viable (10 or more comps). Use it to decide which phase to enable next.
 *
 * Usage:
 *   node scripts/us-type-seed-status.js              # table for every phase
 *   node scripts/us-type-seed-status.js --phase 0    # only terms up to phase 0
 *   node scripts/us-type-seed-status.js --json       # machine-readable output
 *
 * META_PATH and US_TYPE_SEED_PATH override the input files (used by tests).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeSearchKey } = require('../src/services/terapeakService');
const { DEFAULT_SEED_PATH, MAX_PHASE, loadSeedTerms, selectSeedTerms } = require('../src/utils/usTypeSeed');

const META_PATH = process.env.META_PATH || path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const SEED_PATH = process.env.US_TYPE_SEED_PATH || DEFAULT_SEED_PATH;
const VIABLE_COMPS = 10;

function classify(entry) {
  if (!entry) return 'pending';
  const comps = entry.compCount || 0;
  if (comps >= VIABLE_COMPS) return 'viable';
  if (comps > 0) return 'thin';
  if ((entry.noDataCount || 0) > 0) return 'no-data';
  return 'pending';
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function buildStatus(terms, meta) {
  const groups = new Map();
  for (const item of terms) {
    const entry = meta[normalizeSearchKey(item.term)] || null;
    const status = classify(entry);
    if (!groups.has(item.group)) {
      groups.set(item.group, { group: item.group, rank: item.rank, terms: 0, pending: 0, noData: 0, thin: 0, viable: 0, comps: [] });
    }
    const g = groups.get(item.group);
    g.terms++;
    if (status === 'pending') g.pending++;
    else if (status === 'no-data') g.noData++;
    else if (status === 'thin') g.thin++;
    else g.viable++;
    if (entry && entry.compCount) g.comps.push(entry.compCount);
  }
  return [...groups.values()]
    .sort((a, b) => a.rank - b.rank || a.group.localeCompare(b.group))
    .map(({ comps, ...g }) => ({ ...g, medianComps: median(comps) }));
}

function main() {
  const args = process.argv.slice(2);
  const phaseIdx = args.indexOf('--phase');
  let phase = MAX_PHASE;
  if (phaseIdx >= 0) {
    const raw = args[phaseIdx + 1];
    if (!/^[0-9]+$/.test(raw || '') || Number(raw) > MAX_PHASE) {
      console.error(`ERROR: --phase must be an integer 0-${MAX_PHASE}`);
      process.exit(2);
    }
    phase = Number(raw);
  }
  const loaded = loadSeedTerms(SEED_PATH);
  if (loaded.missing) {
    console.error(`ERROR: seed file not found: ${SEED_PATH}`);
    process.exit(1);
  }
  for (const problem of loaded.errors) console.error(`WARNING: ${problem}`);
  const meta = fs.existsSync(META_PATH) ? JSON.parse(fs.readFileSync(META_PATH, 'utf8')) : {};
  const rows = buildStatus(selectSeedTerms(loaded.terms, phase), meta);

  if (args.includes('--json')) {
    console.log(JSON.stringify({ phase, groups: rows }, null, 2));
    return;
  }
  console.log(`US type seed status (#334H), terms up to phase ${phase}`);
  console.log('rank  group                              terms pending no-data thin viable medianComps');
  for (const r of rows) {
    console.log(
      `${String(r.rank).padStart(4)}  ${r.group.padEnd(34)} ${String(r.terms).padStart(5)} ${String(r.pending).padStart(7)} ${String(r.noData).padStart(7)} ${String(r.thin).padStart(4)} ${String(r.viable).padStart(6)} ${r.medianComps === null ? '-' : r.medianComps}`,
    );
  }
}

if (require.main === module) main();

module.exports = { classify, buildStatus };
