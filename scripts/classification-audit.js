#!/usr/bin/env node
/**
 * classification-audit.js -- Filter Correctness Audit Tool (#192)
 *
 * Samples Terapeak comps from CSV data, runs classifyGradeType() on each,
 * and verifies classification correctness by cross-referencing title + conditionId
 * against known ground truth rules.
 *
 * Usage:
 *   node scripts/classification-audit.js              # default 500 sample
 *   node scripts/classification-audit.js --count 1000 # larger sample
 *   node scripts/classification-audit.js --verbose    # show all mismatches
 *
 * Does NOT require a running server -- works directly on CSV data + code.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const SAMPLE_SIZE = args.includes('--count') ? parseInt(args[args.indexOf('--count') + 1]) : 500;
const VERBOSE = args.includes('--verbose') || args.includes('-v');

// ── Load modules under test ─────────────────────────────────
const { classifyGradeType } = require('../src/services/ebayService');
const terapeakService = require('../src/services/terapeakService');

// ── Ground Truth Classifier ─────────────────────────────────
// Independent implementation based on numismatic terminology rules.
// Used as the "expected" answer to compare against classifyGradeType.

const PROOF_LIKE_RE = /\bproof[\s-]*like\b|\bPL[-\s]?\d|\bDMPL\b/i;
const PROOF_KEYWORDS = /\bproof\b|\bPR[-\s]?\d{1,2}\b|\bPF[-\s]?\d{1,2}\b/i;
const GRADED_RE = /\b(PCGS|NGC|ANACS|ICG|CAC)\b|\bMS[-\s]?\d{1,2}\b|\bAU[-\s]?\d{1,2}\b|\bVF[-\s]?\d{1,2}\b|\bXF[-\s]?\d{1,2}\b|\bEF[-\s]?\d{1,2}\b/i;
const BURNISHED_RE = /\b(burnished|satin\s*finish|enhanced\s*reverse)\b/i;

function groundTruthClassify(comp) {
  const title = comp.title || '';
  const cid = comp.conditionId ? String(comp.conditionId) : null;

  // Rule 1: Proof-Like NEVER enters proof pool
  if (PROOF_LIKE_RE.test(title)) {
    // PL coins are graded if they have a TPG grade, otherwise raw
    if (cid === '2000') return 'graded';
    if (GRADED_RE.test(title)) return 'graded';
    return 'raw';
  }

  // Rule 2: Burnished/Satin/Enhanced NEVER enters proof pool
  if (BURNISHED_RE.test(title) && !PROOF_KEYWORDS.test(title)) {
    if (cid === '2000') return 'graded';
    if (GRADED_RE.test(title)) return 'graded';
    return 'raw';
  }

  // Rule 3: conditionId is authoritative for graded/raw split
  if (cid === '2000') {
    if (PROOF_KEYWORDS.test(title)) return 'proof';
    return 'graded';
  }
  if (cid === '3000' || cid === '4000') {
    if (PROOF_KEYWORDS.test(title)) return 'proof';
    return 'raw';
  }
  if (cid === '1000' || cid === '1500') return 'raw';

  // Rule 4: Title-only fallback
  if (PROOF_KEYWORDS.test(title)) return 'proof';
  if (GRADED_RE.test(title)) return 'graded';
  return 'raw';
}

// ── Collect Comps from CSV Store ────────────────────────────
function collectComps() {
  // Get all available datasets from the Terapeak meta
  const metaPath = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    console.error('Cannot read data/terapeak-meta.json. Run from project root.');
    process.exit(1);
  }

  const allComps = [];
  const datasets = Object.entries(meta);

  // Shuffle datasets for random sampling
  for (let i = datasets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [datasets[i], datasets[j]] = [datasets[j], datasets[i]];
  }

  // Collect comps from datasets until we have enough
  for (const [key, info] of datasets) {
    if (allComps.length >= SAMPLE_SIZE * 2) break; // collect 2x for safety

    const csvPath = info.csvPath || path.join(__dirname, '..', 'data', 'terapeak', `${key}.csv`);
    if (!fs.existsSync(csvPath)) continue;

    try {
      // Use terapeakService to parse CSV properly (handles column mapping)
      const comps = terapeakService.lookupComps
        ? terapeakService._loadCsvSync?.(csvPath)
        : null;

      if (comps && comps.length > 0) {
        allComps.push(...comps.slice(0, 10)); // max 10 per dataset for diversity
      }
    } catch {
      // If internal method not available, parse manually
      try {
        const raw = fs.readFileSync(csvPath, 'utf8');
        const lines = raw.trim().split('\n');
        if (lines.length < 2) continue;

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const titleIdx = headers.findIndex(h => h === 'title' || h === 'item title');
        const condIdx = headers.findIndex(h => h === 'condition' || h === 'conditionid');
        const priceIdx = headers.findIndex(h => h === 'price' || h === 'total');

        if (titleIdx < 0) continue;

        for (let li = 1; li < Math.min(lines.length, 11); li++) {
          const cols = lines[li].split(',');
          const title = (cols[titleIdx] || '').replace(/^"|"$/g, '');
          if (!title) continue;

          const condRaw = condIdx >= 0 ? (cols[condIdx] || '').replace(/^"|"$/g, '') : '';
          let conditionId = null;
          if (/2000|certified/i.test(condRaw)) conditionId = '2000';
          else if (/3000|unCirculated/i.test(condRaw)) conditionId = '3000';
          else if (/4000|circulated/i.test(condRaw)) conditionId = '4000';
          else if (/1000|new/i.test(condRaw)) conditionId = '1000';

          allComps.push({
            title,
            conditionId,
            price: parseFloat(cols[priceIdx]) || 0,
            _source: 'csv-manual-parse',
          });
        }
      } catch { /* skip bad CSV */ }
    }

    if (allComps.length >= SAMPLE_SIZE * 2) break;
  }

  // Shuffle and take sample
  for (let i = allComps.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allComps[i], allComps[j]] = [allComps[j], allComps[i]];
  }

  return allComps.slice(0, SAMPLE_SIZE);
}

// ── Main Audit ──────────────────────────────────────────────
function main() {
  console.log(`\n  Classification Audit (sample=${SAMPLE_SIZE})\n`);

  const comps = collectComps();
  console.log(`  Collected ${comps.length} comps from CSV data\n`);

  if (comps.length === 0) {
    console.error('  No comps found. Ensure data/terapeak-meta.json and CSVs exist.');
    process.exit(1);
  }

  let correct = 0;
  let total = 0;
  const mismatches = [];
  const stats = { graded: 0, proof: 0, raw: 0 };
  const falseProof = []; // classified as proof but shouldn't be
  const missedProof = []; // should be proof but classified differently

  for (const comp of comps) {
    if (!comp.title) continue;
    total++;

    const actual = classifyGradeType(comp);
    const expected = groundTruthClassify(comp);
    stats[actual] = (stats[actual] || 0) + 1;

    if (actual === expected) {
      correct++;
    } else {
      const entry = {
        title: comp.title.slice(0, 80),
        conditionId: comp.conditionId,
        actual,
        expected,
      };
      mismatches.push(entry);

      if (actual === 'proof' && expected !== 'proof') falseProof.push(entry);
      if (expected === 'proof' && actual !== 'proof') missedProof.push(entry);
    }
  }

  const accuracy = total > 0 ? (correct / total * 100).toFixed(1) : '0.0';

  // Report
  console.log(`  Accuracy: ${accuracy}% (${correct}/${total})`);
  console.log(`  Distribution: graded=${stats.graded || 0}, proof=${stats.proof || 0}, raw=${stats.raw || 0}`);
  console.log(`  Mismatches: ${mismatches.length}`);
  console.log(`    False-positive proofs (PL classified as proof): ${falseProof.length}`);
  console.log(`    False-negative proofs (proof classified as other): ${missedProof.length}`);

  if (VERBOSE && mismatches.length > 0) {
    console.log('\n  Mismatch details:');
    for (const m of mismatches.slice(0, 30)) {
      console.log(`    [${m.actual} vs ${m.expected}] cid=${m.conditionId || 'null'} "${m.title}"`);
    }
    if (mismatches.length > 30) console.log(`    ... and ${mismatches.length - 30} more`);
  }

  // Pass/fail
  const passed = parseFloat(accuracy) >= 99.0;
  console.log(`\n  Verdict: ${passed ? 'PASS' : 'FAIL'} (threshold: 99.0%)\n`);

  if (falseProof.length > 0) {
    console.log('  WARNING: False-positive proofs detected (PL/DMPL/Burnished in proof pool):');
    for (const fp of falseProof.slice(0, 5)) {
      console.log(`    "${fp.title}" (cid=${fp.conditionId})`);
    }
  }

  process.exit(passed ? 0 : 1);
}

main();
