#!/usr/bin/env node
'use strict';

/**
 * scripts/merge-duplicate-keys.js
 *
 * #246 PR C -- merge the duplicate-key groups identified by the phase-1
 * audit (scripts/audit-duplicate-keys.js) into a single canonical key.
 *
 * For each group of meta keys whose deepCanonical() form is the same,
 * picks a winner (matches normalizeSearchKey -> highest compCount ->
 * shortest), merges aggregationMeta into the winner using the
 * _mergeAggregationMeta helper introduced in PR B', archives the loser
 * entries to data/archive/, and deletes the losers.
 *
 * Optionally (--migrate-cosmos) the same dedup is applied in the
 * Cosmos `terapeak-sold` container so the next hydrateMetaFromCosmos()
 * does not silently re-introduce the loser keys at startup.
 *
 * USAGE:
 *   node scripts/merge-duplicate-keys.js                     # dry-run (default)
 *   node scripts/merge-duplicate-keys.js --apply             # mutate terapeak-meta.json
 *   node scripts/merge-duplicate-keys.js --apply --migrate-cosmos
 *                                                            # ALSO mutate Cosmos
 *
 * SAFETY:
 *  - Dry-run is the default. --apply is required to mutate anything.
 *  - --apply ALWAYS writes data/archive/terapeak-meta-orphans-<ISO>.json
 *    with the full deleted entries before deletion (recoverable).
 *  - --migrate-cosmos requires --apply and additionally requires Cosmos
 *    credentials in the environment.
 *  - When --migrate-cosmos and the local cache contains comps for both
 *    winner and loser, they are merged and dedup'd (itemId, then
 *    title+price+date -- same logic as importComps).
 *  - Prints the full plan before any mutation.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeSearchKey,
  _mergeAggregationMeta,
} = require('../src/services/terapeakService');

// ── Paths ────────────────────────────────────────────────────────────
const META_PATH = path.join(__dirname, '..', 'data', 'terapeak-meta.json');
const STORE_PATH = path.join(__dirname, '..', 'cache', 'terapeak_sold.json');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'archive');
const PLAN_DIR = path.join(__dirname, '..', 'docs', 'reports');

// ── CLI flags ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const MIGRATE_COSMOS = argv.includes('--migrate-cosmos');
const VERBOSE = argv.includes('--verbose');
const QUIET = argv.includes('--quiet');

if (MIGRATE_COSMOS && !APPLY) {
  console.error('[merge] --migrate-cosmos requires --apply. Aborting.');
  process.exit(2);
}

// ── deepCanonical (alias map -- copied verbatim from audit script) ───
const COUNTRY_ALIASES = [
  [/\bsouth africa(n)?\b/g, 'southafrica'],
  [/\bgreat britain\b/g, 'british'],
  [/\bunited kingdom\b/g, 'british'],
  [/\bgreat britian\b/g, 'british'],
  [/\broyal mint\b/g, 'royalmint'],
  [/\bperth mint\b/g, 'perth'],
  [/\bunited states( of america)?\b/g, 'us'],
  [/\bu\.s\.a\.\b/g, 'us'],
  [/\busa\b/g, 'us'],
];
const SERIES_ALIASES = [
  [/\bamerican silver eagle\b/g, 'ase'],
  [/\bsilver eagle\b/g, 'ase'],
  [/\bamerican gold eagle\b/g, 'age'],
  [/\bgold eagle\b/g, 'age'],
];
const OUNCE_ALIASES = [
  [/\bone ounce\b/g, '1oz'],
  [/\b1\s*troy\s*oz\b/g, '1oz'],
  [/\b1\s*ounce\b/g, '1oz'],
  [/\b1\s*oz\b/g, '1oz'],
];
const REDUNDANT_TOKENS_BY_SERIES = {
  krugerrand: ['southafrica'],
  britannia: ['british'],
  philharmonic: [],
};

function deepCanonical(key) {
  let s = key.toLowerCase();
  for (const [re, to] of COUNTRY_ALIASES) s = s.replace(re, to);
  for (const [re, to] of SERIES_ALIASES) s = s.replace(re, to);
  for (const [re, to] of OUNCE_ALIASES) s = s.replace(re, to);
  for (const [series, redundant] of Object.entries(REDUNDANT_TOKENS_BY_SERIES)) {
    if (s.includes(series)) {
      for (const tok of redundant) {
        s = s.replace(new RegExp(`\\b${tok}\\b`, 'g'), '');
      }
    }
  }
  return s.split(/\s+/).filter(Boolean).sort().join(' ');
}

// ── Cosmos doc id mirrors terapeakService.importComps write-through ──
function cosmosDocId(normalizedKey) {
  return normalizedKey.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 200);
}

// ── Winner selection ─────────────────────────────────────────────────
// Per group of duplicate keys: prefer the key that already matches the
// runtime's normalizeSearchKey(), then highest compCount, then shortest,
// then lexicographic.
function pickWinner(keys, meta) {
  const sorted = [...keys].sort((a, b) => {
    const aSelf = normalizeSearchKey(a) === a ? 0 : 1;
    const bSelf = normalizeSearchKey(b) === b ? 0 : 1;
    if (aSelf !== bSelf) return aSelf - bSelf;
    const aComp = meta[a].compCount || 0;
    const bComp = meta[b].compCount || 0;
    if (aComp !== bComp) return bComp - aComp;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });
  return sorted[0];
}

// ── Comp dedup (mirrors importComps dedup logic) ─────────────────────
function compFingerprint(comp) {
  const title = (comp.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 80);
  return title + '|' + Math.round(comp.totalUsd || 0) + '|' + (comp.soldDate || '');
}

function mergeComps(winnerComps, loserComps) {
  const out = [...(winnerComps || [])];
  const seenIds = new Set(out.map(c => c.itemId).filter(Boolean));
  const seenPrints = new Set(out.map(compFingerprint));
  let added = 0, dup = 0;
  for (const c of (loserComps || [])) {
    if (c.itemId && seenIds.has(c.itemId)) { dup++; continue; }
    const fp = compFingerprint(c);
    if (seenPrints.has(fp)) { dup++; continue; }
    out.push(c);
    if (c.itemId) seenIds.add(c.itemId);
    seenPrints.add(fp);
    added++;
  }
  return { merged: out, added, dup };
}

// ── Plan computation ─────────────────────────────────────────────────
function buildPlan(meta) {
  const groups = new Map();
  for (const key of Object.keys(meta)) {
    const canon = deepCanonical(key);
    if (!groups.has(canon)) groups.set(canon, []);
    groups.get(canon).push(key);
  }

  const merges = [];
  for (const [canon, keys] of groups.entries()) {
    if (keys.length < 2) continue;
    const winner = pickWinner(keys, meta);
    const losers = keys.filter(k => k !== winner);
    merges.push({
      canonical: canon,
      winner,
      winnerCompCount: meta[winner].compCount || 0,
      winnerMatchesNormalizer: normalizeSearchKey(winner) === winner,
      losers: losers.map(l => ({
        key: l,
        compCount: meta[l].compCount || 0,
        page1At: meta[l].page1At || null,
        deepAt: meta[l].deepAt || null,
        lastRefreshAt: meta[l].lastRefreshAt || null,
      })),
    });
  }

  // Sort: groups with the largest data movement first
  merges.sort((a, b) => {
    const aMov = a.losers.reduce((s, l) => s + l.compCount, 0);
    const bMov = b.losers.reduce((s, l) => s + l.compCount, 0);
    return bMov - aMov;
  });

  return merges;
}

// ── Output helpers ───────────────────────────────────────────────────
function printPlan(merges, meta) {
  const totalLosers = merges.reduce((s, m) => s + m.losers.length, 0);
  const totalCompsMoved = merges.reduce(
    (s, m) => s + m.losers.reduce((s2, l) => s2 + l.compCount, 0),
    0,
  );
  const winnersNeedingRename = merges.filter(m => !m.winnerMatchesNormalizer).length;

  console.log('');
  console.log('================================================================');
  console.log(`  #246 PR C -- Duplicate-Key Merge Plan ${APPLY ? '[APPLY]' : '[DRY-RUN]'}`);
  console.log('================================================================');
  console.log(`  Meta keys total:                ${Object.keys(meta).length}`);
  console.log(`  Duplicate groups (>= 2 keys):   ${merges.length}`);
  console.log(`  Loser keys to merge + delete:   ${totalLosers}`);
  console.log(`  Comps in loser entries (moved): ${totalCompsMoved}`);
  console.log(`  Winners not matching normalizer: ${winnersNeedingRename}  (kept as-is to preserve compCount; will renormalize on next CSV import)`);
  console.log(`  Cosmos migration:               ${MIGRATE_COSMOS ? 'YES' : 'no (--migrate-cosmos to enable)'}`);
  console.log('');

  const showAll = VERBOSE;
  const sample = showAll ? merges : merges.slice(0, 15);
  console.log(`  ${showAll ? 'All' : 'Top ' + sample.length} merge groups (sorted by comps-moved desc):`);
  console.log('  ----------------------------------------------------------------');
  for (const m of sample) {
    console.log(`  canonical: "${m.canonical}"`);
    console.log(`    WINNER  [${String(m.winnerCompCount).padStart(4)}c]  "${m.winner}"${m.winnerMatchesNormalizer ? '' : '  (does not match normalizeSearchKey)'}`);
    for (const l of m.losers) {
      const tags = [
        l.compCount ? `${l.compCount}c` : '0c',
        l.deepAt ? 'deepAt' : null,
        l.page1At ? 'page1At' : null,
      ].filter(Boolean).join(',');
      console.log(`    loser   [${tags.padEnd(20)}]  "${l.key}"`);
    }
  }
  if (!showAll && merges.length > sample.length) {
    console.log(`  ... ${merges.length - sample.length} more groups. Use --verbose to print all.`);
  }
  console.log('');
}

// ── Mutation ────────────────────────────────────────────────────────-
function applyMetaMerge(meta, merges) {
  const archive = {
    archivedAt: new Date().toISOString(),
    reason: '#246 PR C duplicate-key merge',
    schemaVersion: 1,
    entries: {},   // loserKey -> { winner, entry: <full loser meta> }
  };

  for (const m of merges) {
    const winner = meta[m.winner];
    for (const l of m.losers) {
      const loser = meta[l.key];
      archive.entries[l.key] = { winner: m.winner, entry: { ...loser } };
      winner.aggregationMeta = _mergeAggregationMeta(
        winner.aggregationMeta || winner,
        loser.aggregationMeta || loser,
      );
      // The legacy meta sidecar has both shapes -- some entries store
      // markers at the top level (page1At, deepAt, etc.) and some nest
      // them under aggregationMeta. Mirror the merged markers up to the
      // top level so both shapes stay consistent.
      const am = winner.aggregationMeta;
      if (am.page1At) winner.page1At = am.page1At;
      if (am.deepAt) winner.deepAt = am.deepAt;
      if (am.lastRefreshAt) winner.lastRefreshAt = am.lastRefreshAt;
      if (am.newestSaleDate) winner.newestSaleDate = am.newestSaleDate;
      if (am.oldestSaleDate) winner.oldestSaleDate = am.oldestSaleDate;
      if (am.compCount && (!winner.compCount || am.compCount > winner.compCount)) {
        winner.compCount = am.compCount;
      }
      delete meta[l.key];
    }
  }

  // Write archive
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = path.join(ARCHIVE_DIR, `terapeak-meta-orphans-${stamp}.json`);
  fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2) + '\n');

  // Write meta
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + '\n');

  return { archivePath, deletedCount: Object.keys(archive.entries).length };
}

// ── Cosmos migration ─────────────────────────────────────────────────
async function applyCosmosMigration(merges) {
  const cosmos = require('../src/utils/cosmosClient');
  if (!cosmos.isEnabled()) {
    console.error('[merge] --migrate-cosmos requested but Cosmos is not configured. Aborting.');
    process.exit(3);
  }
  const container = cosmos.container('terapeak-sold');

  // Load local store for comp data (Cosmos is canonical for comps via write-through)
  let localStore = {};
  try {
    localStore = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    console.warn('[merge] local store not present; relying solely on Cosmos docs for comps');
  }

  const result = { upserts: 0, deletes: 0, missing: 0, errors: 0, totalCompsAdded: 0 };

  for (const m of merges) {
    const winnerId = cosmosDocId(m.winner);
    let winnerDoc = null;
    try {
      const { resource } = await container.item(winnerId, winnerId).read();
      winnerDoc = resource;
    } catch (err) {
      if (err.code === 404 || err.statusCode === 404) {
        // Winner has no Cosmos doc yet -- build a skeleton from local store
        winnerDoc = {
          id: winnerId,
          searchTerm: m.winner,
          comps: (localStore[m.winner] && localStore[m.winner].comps) || [],
          aggregationMeta: (localStore[m.winner] && localStore[m.winner].aggregationMeta) || {},
        };
      } else {
        console.error(`[merge] read winner ${winnerId} failed:`, err.message);
        result.errors++;
        continue;
      }
    }

    // Seed winner comps from local store if Cosmos doc was thin
    if ((!winnerDoc.comps || winnerDoc.comps.length === 0) && localStore[m.winner]?.comps?.length) {
      winnerDoc.comps = [...localStore[m.winner].comps];
    }

    let didChange = false;
    let totalAdded = 0;

    for (const l of m.losers) {
      const loserId = cosmosDocId(l.key);
      let loserDoc = null;
      try {
        const { resource } = await container.item(loserId, loserId).read();
        loserDoc = resource;
      } catch (err) {
        if (err.code === 404 || err.statusCode === 404) {
          result.missing++;
          loserDoc = null;
        } else {
          console.error(`[merge] read loser ${loserId} failed:`, err.message);
          result.errors++;
          continue;
        }
      }

      // Source-of-truth comps for loser: Cosmos doc + local store
      const loserComps = [
        ...((loserDoc && loserDoc.comps) || []),
        ...((localStore[l.key] && localStore[l.key].comps) || []),
      ];
      const loserMeta = (loserDoc && loserDoc.aggregationMeta)
        || (localStore[l.key] && localStore[l.key].aggregationMeta)
        || {};

      if (loserComps.length > 0) {
        const { merged, added } = mergeComps(winnerDoc.comps, loserComps);
        if (added > 0) {
          winnerDoc.comps = merged;
          totalAdded += added;
          didChange = true;
        }
      }
      if (loserMeta && Object.keys(loserMeta).length > 0) {
        winnerDoc.aggregationMeta = _mergeAggregationMeta(
          winnerDoc.aggregationMeta || {},
          loserMeta,
        );
        didChange = true;
      }

      // Delete loser doc
      if (loserDoc) {
        try {
          await container.item(loserId, loserId).delete();
          result.deletes++;
          if (VERBOSE) console.log(`    [cosmos] deleted ${loserId} (${loserComps.length} comps merged into winner)`);
        } catch (err) {
          console.error(`[merge] delete loser ${loserId} failed:`, err.message);
          result.errors++;
        }
      }
    }

    if (didChange) {
      try {
        await container.items.upsert(winnerDoc);
        result.upserts++;
        result.totalCompsAdded += totalAdded;
        if (VERBOSE) console.log(`    [cosmos] upserted ${winnerId} (+${totalAdded} comps)`);
      } catch (err) {
        console.error(`[merge] upsert winner ${winnerId} failed:`, err.message);
        result.errors++;
      }
    }
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────────-
async function main() {
  if (!fs.existsSync(META_PATH)) {
    console.error(`[merge] meta file not found: ${META_PATH}`);
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  const merges = buildPlan(meta);

  if (merges.length === 0) {
    console.log('[merge] No duplicate groups found. Nothing to do.');
    return;
  }

  if (!QUIET) printPlan(merges, meta);

  // Always write the plan as a JSON artifact (cheap, useful for review)
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  const planPath = path.join(PLAN_DIR, 'merge-duplicate-keys-plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: APPLY ? (MIGRATE_COSMOS ? 'apply+migrate-cosmos' : 'apply') : 'dry-run',
    metaKeyCount: Object.keys(meta).length,
    duplicateGroupCount: merges.length,
    merges,
  }, null, 2) + '\n');
  console.log(`  Plan written: ${planPath}`);

  if (!APPLY) {
    console.log('');
    console.log('  (dry-run -- no changes written. Re-run with --apply to mutate.)');
    console.log('================================================================');
    return;
  }

  // Apply meta merge
  const metaResult = applyMetaMerge(meta, merges);
  console.log('');
  console.log(`  [meta] archived ${metaResult.deletedCount} loser entries -> ${path.relative(process.cwd(), metaResult.archivePath)}`);
  console.log(`  [meta] rewrote ${path.relative(process.cwd(), META_PATH)} (${Object.keys(meta).length} keys remain)`);

  if (MIGRATE_COSMOS) {
    console.log('');
    console.log('  Starting Cosmos migration...');
    const cosmosResult = await applyCosmosMigration(merges);
    console.log('');
    console.log(`  [cosmos] winner upserts:   ${cosmosResult.upserts}`);
    console.log(`  [cosmos] loser deletes:    ${cosmosResult.deletes}`);
    console.log(`  [cosmos] losers missing:   ${cosmosResult.missing}  (no doc to delete)`);
    console.log(`  [cosmos] comps added:      ${cosmosResult.totalCompsAdded}`);
    console.log(`  [cosmos] errors:           ${cosmosResult.errors}`);
  } else {
    console.log('');
    console.log('  NOTE: --migrate-cosmos was NOT passed. Cosmos still has the loser docs.');
    console.log('  The next hydrateMetaFromCosmos() will re-introduce the loser keys at startup.');
    console.log('  Run again with --apply --migrate-cosmos to make this durable.');
  }
  console.log('================================================================');
}

main().catch(err => {
  console.error('[merge] fatal:', err.stack || err.message);
  process.exit(1);
});
