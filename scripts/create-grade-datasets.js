#!/usr/bin/env node
// scripts/create-grade-datasets.js — Generate grade-suffixed Terapeak CSV stubs
//
// Creates empty CSV + .meta pairs for grade-specific Terapeak searches.
// These stubs are then filled by terapeak-export.py during scraping.
//
// Usage:
//   node scripts/create-grade-datasets.js --filter "Morgan" --grades MS63,MS64,MS65
//   node scripts/create-grade-datasets.js --filter "Peace" --grades MS63,MS64,MS65 --dry-run
//   node scripts/create-grade-datasets.js --filter "Walking" --grades VF35,XF45,AU55,MS63
//   node scripts/create-grade-datasets.js --list --filter "Morgan"   # show what exists
//
// Options:
//   --filter <regex>   Required. Regex to match dataset search terms (case-insensitive)
//   --grades <list>    Required (unless --list). Comma-separated grade list (e.g. MS63,MS64,MS65)
//   --dry-run          Show what would be created without writing files
//   --list             List matching datasets that could be grade-expanded
//   --include-generic  Also create grade stubs for Generic datasets (skipped by default)

'use strict';

const fs = require('fs');
const path = require('path');

const TERAPEAK_DIR = path.join(__dirname, '..', 'data', 'terapeak');
const CSV_HEADER = 'Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition,Seller,Format,Item URL,Quantity Sold\n';

// Grade token regex — matches formal grades like MS65, AU58, VF35, PR70, PF69, etc.
const GRADE_TOKEN_RE = /\b(MS|PR|PF|SP|AU|XF|EF|VF|VG|AG|FR|PO)\s*[-]?\s*\d{1,2}\+?\b/i;

// ── Helpers ────────────────────────────────────────────
function readSearchTerm(csvFile) {
  const metaPath = csvFile.replace(/\.csv$/i, '.meta');
  if (fs.existsSync(metaPath)) {
    return fs.readFileSync(metaPath, 'utf8').trim();
  }
  return path.basename(csvFile, '.csv').replace(/_/g, ' ').trim();
}

function hasGradeToken(text) {
  return GRADE_TOKEN_RE.test(text);
}

function isGenericDataset(text) {
  return /\bgeneric\b/i.test(text);
}

function safeFilename(term) {
  return term.replace(/[^\w\s\-]/g, '').replace(/\s+/g, '_').substring(0, 100);
}

// ── Main ───────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);

  const filterIdx = args.indexOf('--filter');
  const gradesIdx = args.indexOf('--grades');
  const dryRun = args.includes('--dry-run');
  const listMode = args.includes('--list');
  const includeGeneric = args.includes('--include-generic');

  if (filterIdx === -1 || !args[filterIdx + 1]) {
    console.error('Usage: node scripts/create-grade-datasets.js --filter <regex> --grades MS63,MS64,MS65 [--dry-run] [--list]');
    process.exit(1);
  }
  const filterPattern = new RegExp(args[filterIdx + 1], 'i');

  if (!listMode && (gradesIdx === -1 || !args[gradesIdx + 1])) {
    console.error('--grades required (e.g. --grades MS63,MS64,MS65). Use --list to see matching datasets.');
    process.exit(1);
  }
  const grades = listMode ? [] : args[gradesIdx + 1].split(',').map(g => g.trim()).filter(Boolean);

  // Validate grade format
  for (const g of grades) {
    if (!GRADE_TOKEN_RE.test(g)) {
      console.error(`Invalid grade format: "${g}". Expected format like MS63, AU58, VF35, PR70.`);
      process.exit(1);
    }
  }

  // Read all existing datasets
  if (!fs.existsSync(TERAPEAK_DIR)) {
    console.error(`Terapeak directory not found: ${TERAPEAK_DIR}`);
    process.exit(1);
  }

  const csvFiles = fs.readdirSync(TERAPEAK_DIR)
    .filter(f => f.endsWith('.csv'))
    .map(f => path.join(TERAPEAK_DIR, f));

  // Build list of base datasets (no grade in search term)
  const baseSets = [];
  const existingTerms = new Set();

  for (const csvPath of csvFiles) {
    const term = readSearchTerm(csvPath);
    existingTerms.add(term.toLowerCase());

    if (!filterPattern.test(term)) continue;
    if (hasGradeToken(term)) continue; // already grade-specific
    if (!includeGeneric && isGenericDataset(term)) continue;

    const rowCount = fs.readFileSync(csvPath, 'utf8').split('\n').filter(l => l.trim()).length - 1; // minus header
    baseSets.push({ csvPath, term, rowCount });
  }

  console.log(`Found ${baseSets.length} base dataset(s) matching /${args[filterIdx + 1]}/i\n`);

  if (listMode) {
    for (const ds of baseSets) {
      console.log(`  ${ds.term}  (${ds.rowCount} rows)`);
    }
    if (!baseSets.length) console.log('  (none)');
    return;
  }

  // Generate grade-suffixed stubs
  let created = 0;
  let skipped = 0;

  for (const ds of baseSets) {
    for (const grade of grades) {
      const gradedTerm = `${ds.term} ${grade}`;

      // Check if this grade-specific dataset already exists
      if (existingTerms.has(gradedTerm.toLowerCase())) {
        console.log(`  SKIP (exists): ${gradedTerm}`);
        skipped++;
        continue;
      }

      const filename = safeFilename(gradedTerm);
      const csvOut = path.join(TERAPEAK_DIR, `${filename}.csv`);
      const metaOut = path.join(TERAPEAK_DIR, `${filename}.meta`);

      // Double-check file doesn't exist (could differ by normalization)
      if (fs.existsSync(csvOut)) {
        console.log(`  SKIP (file exists): ${filename}.csv`);
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`  WOULD CREATE: ${filename}.csv  →  "${gradedTerm}"`);
      } else {
        fs.writeFileSync(csvOut, CSV_HEADER, 'utf8');
        fs.writeFileSync(metaOut, gradedTerm, 'utf8');
        console.log(`  CREATED: ${filename}.csv  →  "${gradedTerm}"`);
      }
      created++;
    }
  }

  console.log(`\n${dryRun ? 'Would create' : 'Created'}: ${created} file pairs, Skipped: ${skipped}`);
  if (created > 0 && !dryRun) {
    console.log(`\nNext step: run terapeak-export.py to fill these stubs with Terapeak data.`);
  }
}

main();
