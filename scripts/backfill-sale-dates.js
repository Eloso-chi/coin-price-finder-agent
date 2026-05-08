#!/usr/bin/env node
/**
 * One-time backfill: scan all CSVs in data/terapeak/, extract newestSaleDate,
 * oldestSaleDate, and compCount, then merge into data/terapeak-meta.json.
 *
 * Usage: node scripts/backfill-sale-dates.js [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeSearchKey } = require('../src/services/terapeakService');

const TERAPEAK_DIR = path.join(__dirname, '..', 'data', 'terapeak');
const META_PATH = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const DRY_RUN = process.argv.includes('--dry-run');

function deriveSearchTerm(filename) {
  // Mirror terapeakService.deriveSearchTerm: strip extension, replace _ with space
  const metaPath = path.join(TERAPEAK_DIR, filename.replace(/\.[^.]+$/, '.meta'));
  if (fs.existsSync(metaPath)) {
    return fs.readFileSync(metaPath, 'utf8').trim();
  }
  return filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

function parseSoldDate(dateStr) {
  // Format: "Mar 29, 2026" or "Jan 1, 2025"
  if (!dateStr) return null;
  const cleaned = dateStr.replace(/"/g, '').trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

function extractDatesFromCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;

  // Find Sold Date column index from header
  const header = lines[0];
  // CSV may have commas inside quoted fields, but Sold Date is usually clean
  const headerCols = header.split(',');
  const dateIdx = headerCols.findIndex(c => c.trim().toLowerCase().includes('sold date'));
  if (dateIdx === -1) return null;

  let newest = null;
  let oldest = null;
  let compCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Simple CSV parse: split by comma but respect quotes
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { cols.push(current); current = ''; continue; }
      current += ch;
    }
    cols.push(current);

    const dateStr = cols[dateIdx];
    const date = parseSoldDate(dateStr);
    if (!date) continue;

    compCount++;
    if (!newest || date > newest) newest = date;
    if (!oldest || date < oldest) oldest = date;
  }

  if (compCount === 0) return null;
  return { newestSaleDate: newest, oldestSaleDate: oldest, compCount };
}

// Main
const files = fs.readdirSync(TERAPEAK_DIR).filter(f => f.endsWith('.csv'));
console.log(`Scanning ${files.length} CSVs...`);

let meta = {};
try {
  meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
} catch (e) {
  console.warn('No existing meta sidecar, creating fresh.');
}

let updated = 0;
let skipped = 0;
let migrated = 0;

for (const file of files) {
  const searchTerm = deriveSearchTerm(file);
  const key = normalizeSearchKey(searchTerm);
  const filePath = path.join(TERAPEAK_DIR, file);
  const result = extractDatesFromCSV(filePath);

  if (!result) { skipped++; continue; }

  // Check if an old-format key exists (e.g. with hyphens) that should be migrated
  // to the canonical normalizeSearchKey format.
  const oldFormatKey = file.replace(/\.csv$/, '').replace(/_/g, ' ').toLowerCase();
  if (oldFormatKey !== key && meta[oldFormatKey] && !meta[key]) {
    // Migrate: move old entry to canonical key, merge data
    meta[key] = { ...meta[oldFormatKey] };
    delete meta[oldFormatKey];
    migrated++;
  }

  if (!meta[key]) meta[key] = {};
  meta[key].newestSaleDate = result.newestSaleDate;
  meta[key].oldestSaleDate = result.oldestSaleDate;
  meta[key].compCount = result.compCount;
  updated++;
}

console.log(`Updated: ${updated}, Skipped: ${skipped}, Migrated: ${migrated}`);

if (DRY_RUN) {
  // Show a sample
  const sample = Object.entries(meta).slice(0, 5);
  for (const [k, v] of sample) {
    console.log(`  ${k}: newest=${v.newestSaleDate}, oldest=${v.oldestSaleDate}, comps=${v.compCount}`);
  }
  console.log('(dry run -- not saved)');
} else {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');
  console.log(`Saved to ${META_PATH}`);
}
