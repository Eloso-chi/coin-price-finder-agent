#!/usr/bin/env node
// scripts/clean-csvs.js — One-time CSV cleaner
// Reads every Terapeak CSV, applies DENY_PATTERNS from filters.js,
// removes junk rows, and rewrites in-place.
// Usage:
//   node scripts/clean-csvs.js --dry-run   # report only, no changes
//   node scripts/clean-csvs.js --run       # actually rewrite files

const fs = require('fs');
const path = require('path');
const { isDenied } = require('../src/utils/filters');

const TERAPEAK_DIR = path.join(__dirname, '..', 'data', 'terapeak');
const dryRun = process.argv.includes('--dry-run');
const run = process.argv.includes('--run');

if (!dryRun && !run) {
  console.log('Usage: node scripts/clean-csvs.js --dry-run | --run');
  process.exit(1);
}

// Additional patterns specific to CSV cleanup beyond the standard deny list.
// These catch items that pass the general deny list but are clearly not coins
// when found in Terapeak sold data.
const EXTRA_DENY = [
  /\btopps\b/i, /\bpanini\b/i, /\bupper\s*deck\b/i, /\bbaseball\b/i,
  /\bfootball\b/i, /\bbasketball\b/i, /\bhockey\b/i, /\bsoccer\b/i,
  /\bpokemon\b/i, /\byugioh\b/i, /\bmagic\s*the\s*gathering\b/i,
  /\btrading\s*card/i, /\bsports?\s*card/i,
  /\benvelope\s*only\b/i, /\bno\s*coins?\b/i, /\bempty\b.*\b(?:box|holder|case)\b/i,
  /\bcommemorativ\w*\s*stamp/i, /\bpostage\b/i, /\bphilateli/i,
  /\bfirst\s*day\s*(?:of\s*)?(?:issue\s*)?cover\b/i,
  /\bbelt\s*buckle/i, /\bmoney\s*clip/i, /\bcigarette/i, /\blighter\b/i,
  /\bwatch\b/i, /\bclock\b/i, /\bfigur(?:ine|e)\b/i, /\bplush\b/i,
  /\bdie[\s-]*cast\b/i, /\bhot\s*wheels\b/i, /\btoy\b/i,
  /\bvinyl\b/i, /\brecord\b/i, /\bcd\b/i, /\bdvd\b/i, /\bblu[\s-]*ray\b/i,
  /\bvideo\s*game/i, /\bplaystation\b/i, /\bxbox\b/i, /\bnintendo\b/i,
];

function isJunk(title) {
  if (isDenied(title, { allowRoll: true })) return true;
  return EXTRA_DENY.some(p => p.test(title));
}

const files = fs.readdirSync(TERAPEAK_DIR)
  .filter(f => f.endsWith('.csv'))
  .sort();

let totalFiles = 0;
let totalRowsBefore = 0;
let totalRowsAfter = 0;
let filesChanged = 0;
const report = [];

for (const file of files) {
  const filePath = path.join(TERAPEAK_DIR, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  if (lines.length < 2) continue;

  const header = lines[0];
  const dataLines = lines.slice(1).filter(l => l.trim());
  const rowsBefore = dataLines.length;

  // Title is the first CSV field
  const clean = dataLines.filter(line => {
    // Handle quoted CSV fields
    let title;
    if (line.startsWith('"')) {
      const endQuote = line.indexOf('"', 1);
      title = endQuote > 0 ? line.substring(1, endQuote) : line.split(',')[0];
    } else {
      title = line.split(',')[0];
    }
    return !isJunk(title);
  });

  const rowsAfter = clean.length;
  const removed = rowsBefore - rowsAfter;
  totalFiles++;
  totalRowsBefore += rowsBefore;
  totalRowsAfter += rowsAfter;

  if (removed > 0) {
    const pct = ((removed / rowsBefore) * 100).toFixed(0);
    report.push({ file, rowsBefore, rowsAfter, removed, pct: +pct });
    filesChanged++;

    if (run) {
      const output = [header, ...clean].join('\n') + '\n';
      fs.writeFileSync(filePath, output, 'utf8');
    }
  }
}

// Sort report by removed count desc
report.sort((a, b) => b.removed - a.removed);

console.log(`\n${dryRun ? '=== DRY RUN ===' : '=== CLEANUP COMPLETE ==='}`);
console.log(`Files scanned:  ${totalFiles}`);
console.log(`Files changed:  ${filesChanged}`);
console.log(`Rows before:    ${totalRowsBefore}`);
console.log(`Rows after:     ${totalRowsAfter}`);
console.log(`Rows removed:   ${totalRowsBefore - totalRowsAfter} (${((totalRowsBefore - totalRowsAfter) / totalRowsBefore * 100).toFixed(1)}%)\n`);

if (report.length > 0) {
  console.log('File                                              Before  After  Removed  %');
  console.log('-'.repeat(85));
  for (const r of report) {
    const name = r.file.length > 48 ? r.file.slice(0, 45) + '...' : r.file;
    console.log(`${name.padEnd(50)} ${String(r.rowsBefore).padStart(5)}  ${String(r.rowsAfter).padStart(5)}  ${String(r.removed).padStart(7)}  ${String(r.pct).padStart(3)}%`);
  }
}
