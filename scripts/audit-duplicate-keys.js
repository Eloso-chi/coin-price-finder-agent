#!/usr/bin/env node
'use strict';

/**
 * scripts/audit-duplicate-keys.js
 *
 * #246 phase 1 -- READ-ONLY audit of dataset-key duplication in
 * data/terapeak-meta.json. Identifies groups of keys that represent the
 * same coin under different naming forms (e.g. "1996 South Africa 1oz
 * Gold Krugerrand" vs "1996 Gold Krugerrand 1oz") so that phase 2 can
 * extend `normalizeSearchKey()` and phase 3 can run the merger.
 *
 * Output: cache/duplicate-keys-report.json + console summary.
 *
 * SAFETY:
 *  - Reads data/terapeak-meta.json only. NEVER writes to it.
 *  - Writes only to cache/duplicate-keys-report.json (a derived artifact).
 *  - Does NOT mutate Cosmos or any other persistent store.
 *  - Does NOT call into terapeakService runtime (no imports of the
 *    service module so we cannot accidentally trigger a save).
 *
 * Usage:
 *   node scripts/audit-duplicate-keys.js                 # full audit
 *   node scripts/audit-duplicate-keys.js --top 20        # console-print top N groups
 *   node scripts/audit-duplicate-keys.js --min-delta 5   # only groups with comp-count delta >= 5
 */

const fs = require('fs');
const path = require('path');

const META_PATH = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const REPORT_PATH = path.join(__dirname, '..', 'docs', 'reports', 'duplicate-keys-report.json');

// ── CLI flags ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const topN = parseInt(args[args.indexOf('--top') + 1], 10) || 20;
const minDelta = parseInt(args[args.indexOf('--min-delta') + 1], 10) || 0;
const showAllGroups = args.includes('--all');

// ── Alias maps (proposed for phase-2 normalizeSearchKey extension) ────
// These are intentionally local to the audit script. Phase 2 will move
// the validated subset into terapeakService.normalizeSearchKey() with
// unit-test coverage per the BACKLOG #246 plan.

// Country/region aliases -- left side gets normalized to right side (or removed).
// Order matters: longer phrases before shorter.
const COUNTRY_ALIASES = [
  // Long-form -> canonical form
  [/\bsouth africa(n)?\b/g, 'southafrica'],   // "South Africa" / "South African"
  [/\bgreat britain\b/g, 'british'],
  [/\bunited kingdom\b/g, 'british'],
  [/\bgreat britian\b/g, 'british'],          // common typo
  [/\broyal mint\b/g, 'royalmint'],
  [/\bperth mint\b/g, 'perth'],
  [/\bunited states( of america)?\b/g, 'us'],
  [/\bu\.s\.a\.\b/g, 'us'],
  [/\busa\b/g, 'us'],
];

// Series synonyms -- collapse variant series spellings.
const SERIES_ALIASES = [
  [/\bamerican silver eagle\b/g, 'ase'],
  [/\bsilver eagle\b/g, 'ase'],
  [/\bamerican gold eagle\b/g, 'age'],
  [/\bgold eagle\b/g, 'age'],
];

// Ounce notation -- everything reduces to `Noz` (matching normalizeSearchKey).
// Audit-only stricter pass: "one ounce" / "1 ounce" / "1 troy oz" all -> "1oz".
const OUNCE_ALIASES = [
  [/\bone ounce\b/g, '1oz'],
  [/\b1\s*troy\s*oz\b/g, '1oz'],
  [/\b1\s*ounce\b/g, '1oz'],
  [/\b1\s*oz\b/g, '1oz'],
];

// Country tokens that are pure noise once the canonical form has been
// adopted (e.g. "southafrica gold krugerrand" -> "gold krugerrand";
// Krugerrand IS South African by definition). Conservative list.
const REDUNDANT_TOKENS_BY_SERIES = {
  krugerrand: ['southafrica'],   // Krugerrand is always South African
  britannia: ['british'],         // Britannia is always British
  philharmonic: [],               // Austrian -- but no alias collision observed
};

/**
 * Compute a "deep canonical" key for grouping. Applies the proposed
 * phase-2 normalization on top of whatever the existing meta key already
 * represents (which is post-normalizeSearchKey).
 *
 * Steps:
 *   1. Apply country/series/ounce alias maps.
 *   2. Strip the series-redundant country token if both are present.
 *   3. Sort space-separated tokens alphabetically (collapses word-order
 *      variants like "1oz gold krugerrand" vs "gold krugerrand 1oz").
 *   4. Collapse whitespace.
 *
 * Read-only: does NOT mutate the meta file. The original key is preserved
 * as the group member identity.
 */
function deepCanonical(key) {
  let s = key.toLowerCase();

  for (const [re, to] of COUNTRY_ALIASES) s = s.replace(re, to);
  for (const [re, to] of SERIES_ALIASES) s = s.replace(re, to);
  for (const [re, to] of OUNCE_ALIASES) s = s.replace(re, to);

  // Strip redundant country tokens for series where the country is implied.
  for (const [series, redundant] of Object.entries(REDUNDANT_TOKENS_BY_SERIES)) {
    if (s.includes(series)) {
      for (const tok of redundant) {
        s = s.replace(new RegExp(`\\b${tok}\\b`, 'g'), '');
      }
    }
  }

  // Sort tokens alphabetically to collapse word-order variants.
  const tokens = s.split(/\s+/).filter(Boolean).sort();
  return tokens.join(' ');
}

/**
 * Classify a group of duplicate keys by populated-vs-empty mix.
 * Empty = compCount falsy (0 / null / undefined).
 */
function classifyGroup(group) {
  const populated = group.filter(m => (m.compCount || 0) > 0);
  const empty = group.filter(m => !(m.compCount || 0));
  if (populated.length === 0) return 'all-empty';
  if (empty.length === 0) return 'all-populated';
  return 'mixed-populated-and-empty';
}

/**
 * Pick the canonical-suggested form for a group. Heuristics:
 *   1. Prefer the key with the highest compCount.
 *   2. Tiebreak: shortest key (e.g. "1oz Gold Krugerrand" beats the
 *      country-prefixed form).
 *   3. Tiebreak: lexicographic.
 */
function suggestCanonical(group) {
  const sorted = [...group].sort((a, b) => {
    const aComp = a.compCount || 0;
    const bComp = b.compCount || 0;
    if (bComp !== aComp) return bComp - aComp;
    if (a.key.length !== b.key.length) return a.key.length - b.key.length;
    return a.key.localeCompare(b.key);
  });
  return sorted[0].key;
}

// ── Main ──────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(META_PATH)) {
    console.error(`[audit] meta file not found: ${META_PATH}`);
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  const allKeys = Object.keys(meta);

  // Group by deepCanonical
  const groups = new Map();
  for (const key of allKeys) {
    const canon = deepCanonical(key);
    if (!groups.has(canon)) groups.set(canon, []);
    groups.get(canon).push({
      key,
      compCount: meta[key].compCount || 0,
      refreshCount: meta[key].refreshCount || 0,
      newestSaleDate: meta[key].newestSaleDate || null,
      identifierSource: meta[key].identifiers?.identifier_source || null,
      identifierConfidence: meta[key].identifiers?.identifier_confidence || null,
    });
  }

  // Filter to duplicate groups (>= 2 members)
  const dupGroups = [];
  for (const [canon, members] of groups.entries()) {
    if (members.length < 2) continue;
    const totalComps = members.reduce((s, m) => s + (m.compCount || 0), 0);
    const maxComps = Math.max(...members.map(m => m.compCount || 0));
    const minComps = Math.min(...members.map(m => m.compCount || 0));
    const delta = maxComps - minComps;
    if (delta < minDelta) continue;

    dupGroups.push({
      canonical: canon,
      suggestedCanonicalKey: suggestCanonical(members),
      classification: classifyGroup(members),
      memberCount: members.length,
      totalComps,
      maxComps,
      minComps,
      compDelta: delta,
      members: members.sort((a, b) => (b.compCount || 0) - (a.compCount || 0)),
    });
  }

  // Sort: classification (mixed first), then by compDelta desc
  const classWeight = { 'mixed-populated-and-empty': 0, 'all-populated': 1, 'all-empty': 2 };
  dupGroups.sort((a, b) => {
    const cw = classWeight[a.classification] - classWeight[b.classification];
    if (cw !== 0) return cw;
    return b.compDelta - a.compDelta;
  });

  // Aggregate stats
  const byClass = { 'mixed-populated-and-empty': 0, 'all-populated': 0, 'all-empty': 0 };
  let totalDupKeys = 0;
  for (const g of dupGroups) {
    byClass[g.classification] += 1;
    totalDupKeys += g.memberCount;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    metaKeyCount: allKeys.length,
    canonicalGroupCount: groups.size,
    duplicateGroupCount: dupGroups.length,
    duplicateKeyCount: totalDupKeys,
    classification: byClass,
    aliasMapVersion: 1,
    aliasMapNote: 'Audit-only. Phase-2 normalizeSearchKey extension will validate each rule against unit tests before adoption.',
    duplicateGroups: dupGroups,
  };

  // Ensure cache/ exists
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');

  // ── Console summary ────────────────────────────────────────────────
  console.log('');
  console.log('================================================================');
  console.log('  Duplicate Key Audit Report -- #246 phase 1 (READ-ONLY)');
  console.log('================================================================');
  console.log(`  Meta keys total:             ${allKeys.length}`);
  console.log(`  Canonical groups (post-dedup): ${groups.size}`);
  console.log(`  Duplicate groups (>= 2 keys):  ${dupGroups.length}`);
  console.log(`  Total keys in dup groups:    ${totalDupKeys}`);
  console.log('');
  console.log('  Group classifications:');
  console.log(`    mixed (populated + empty):   ${byClass['mixed-populated-and-empty']}  <-- HIGH PRIORITY (data fragmentation)`);
  console.log(`    all populated:               ${byClass['all-populated']}              <-- merge candidates`);
  console.log(`    all empty:                   ${byClass['all-empty']}              <-- low priority`);
  console.log('');
  console.log(`  Report written: ${REPORT_PATH}`);
  console.log('');

  // Top N table
  const topToShow = showAllGroups ? dupGroups : dupGroups.slice(0, topN);
  console.log(`  Top ${topToShow.length} groups (sorted: mixed-class first, then by compDelta desc):`);
  console.log('  ----------------------------------------------------------------');
  for (const g of topToShow) {
    console.log(`  [${g.classification}]  Δ=${g.compDelta}  total=${g.totalComps}`);
    console.log(`    canonical-form: "${g.canonical}"`);
    console.log(`    suggested-key:  "${g.suggestedCanonicalKey}"`);
    for (const m of g.members) {
      const tag = m.key === g.suggestedCanonicalKey ? ' (canonical)' : '';
      const src = m.identifierSource ? ` [src=${m.identifierSource}]` : '';
      console.log(`      ${String(m.compCount).padStart(4)} comps  "${m.key}"${tag}${src}`);
    }
    console.log('');
  }

  if (dupGroups.length > topN && !showAllGroups) {
    console.log(`  ... ${dupGroups.length - topN} more groups in the JSON report. Use --all to print everything.`);
  }

  console.log('================================================================');
  console.log('  Next steps (per BACKLOG #246):');
  console.log('  1. Review duplicate-keys-report.json + commit it.');
  console.log('  2. Phase 2: extend normalizeSearchKey() with validated alias rules');
  console.log('     + unit tests in __tests__/normalizeSearchKey.test.js.');
  console.log('  3. Phase 3: scripts/merge-duplicate-keys.js (dry-run default,');
  console.log('     archives orphans, Cosmos write-through).');
  console.log('================================================================');
}

main();
