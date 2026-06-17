# Key Normalization Fix (2026-05-08)

## Problem
4 different normalization functions produced incompatible keys for the same coin,
causing 438 ghost/duplicate entries in terapeak-meta.json and false "needs-data" counts.

## Root Causes
1. `terapeakService.normalizeSearchKey()` splits year-mint (`1878-CC` -> `1878 cc`)
2. `backfill-sale-dates.js` had its own simple normalizer (preserved hyphens: `1878-cc`)
3. Cosmos DB had keys in country-noun format (`2011 mexico 1oz silver libertad`)
4. CSV filenames use adjective form (`2011_Mexican_Silver_Libertad_1oz.csv`)
5. `normalizeSearchKey()` mangled fractions: `1/4 oz` -> `14oz`

## Fixes Applied (commit 26afb2f)
- **F1**: backfill-sale-dates.js now uses shared `normalizeSearchKey` from terapeakService
- **F2**: scripts/prune-ghost-keys.js -- 3-phase dedup (normalizeSearchKey, word-set, cross-format)
- **F3**: terapeak-export.py backlog uses word-set CSV lookup for filenames
- **F5**: normalizeSearchKey converts 1/2->half, 1/4->quarter, 1/10->tenth before oz collapsing
- **F7**: freshness report hasCSVOnDisk uses normalizeSearchKey + word-set fallback
- **F8**: autoImportFolder forces saveMetaSidecar after batch import

## Canonical Key Format (what normalizeSearchKey produces)
- Lowercase
- Year-mint split: `1878-CC` -> `1878 cc`
- Fractions to words: `1/4 oz` -> `quarter oz`, `1/2 oz` -> `half oz`
- Integer oz collapsed: `1 oz` -> `1oz`
- Roman numerals stripped: `Lunar III` -> `lunar`
- Non-alphanum stripped (except hyphens and spaces)

## Maintenance
- Run `node scripts/prune-ghost-keys.js` after any bulk data import to catch duplicates
- Run `node scripts/backfill-sale-dates.js` after adding new CSVs
- The backfill auto-migrates old-format keys to canonical format
