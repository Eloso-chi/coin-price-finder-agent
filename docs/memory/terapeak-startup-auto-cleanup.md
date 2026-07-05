# Terapeak Auto-Cleanup on Server Startup

Migrated from `/memories/repo/` to `docs/memory/` on 2026-07-05.

> Lesson learned 2026-06-30 after the agent mistakenly framed a normal stale-CSV purge
> as suspicious "uncommitted drift." User correctly pointed out it was already
> resolved by a previous architectural change. Recording to avoid repeat.

## What runs automatically on every `node server.js` boot

`server.js` lines 247-265 invoke (in order):

1. `terapeakService.evictStaleComps(180)`
   - Evicts in-memory comps with `soldDate` older than 180 days from ALL datasets
   - On 2026-06-30 boot: evicted 3897 comps from 4526 datasets

2. `terapeakService.purgeStaleCSVs(TERAPEAK_DATA_DIR, 180)`
   - Deletes any `.csv` file in `data/terapeak/` where EVERY comp is older
     than 180 days
   - Also deletes the companion `.meta` file
   - Logged as `[terapeak] Purged stale CSV: <file> (all N comps older than 180d)`
   - Kept-vs-deleted: a single fresh comp (or any comp with missing `soldDate`)
     keeps the file alive

3. `terapeakService.loadMetaSidecar()` -- restores meta markers from `data/terapeak-meta.json`

4. `terapeakService.hydrateMetaFromCosmos()` -- merges Cosmos DB meta into the in-process map

5. `terapeakService.autoImportFromBlob()` (if blob enabled)

6. `terapeakService.autoImportFolder(TERAPEAK_DATA_DIR)`
   - Scans `data/terapeak/` for CSVs not yet in the in-process index
   - Imports them and updates `data/terapeak-meta.json` accordingly
   - Logged as `[terapeak] Auto-imported <file>: N new comps for "<term>" (M total)`

## Symptoms this produces (LEGITIMATE drift, do NOT panic about)

After a fresh `node server.js`, `git status` may show:
- `M data/terapeak-meta.json` -- because step 6 auto-imported orphan CSVs
- `D data/terapeak/<file>.csv` -- because step 2 purged stale CSVs
- `D data/terapeak/<file>.meta` -- companion delete from step 2

**This is correct, designed behavior. The drift should be committed in the next
data checkpoint, NOT reverted.** Restoring purged CSVs is pointless -- the next
`node server.js` will re-purge them within ~20 seconds of boot.

## How to verify drift is from this auto-cleanup (not something else)

1. Check server startup log for `[terapeak] Evicted ... stale comps` and
   `[terapeak] Purged stale CSV` lines -- if present, the deletions are
   explained.
2. Check the deleted CSV: if the file has 1 row dated >180d ago, that's why.
3. Check `data/terapeak/` directory mtime -- if it changed shortly after the
   last server start, the auto-cleanup is the actor.

## How to disable / tune (if ever needed)

- The 180-day threshold is hardcoded in `server.js` lines 252 and 258 as the
  second argument to `evictStaleComps()` and `purgeStaleCSVs()`. To change,
  edit both call sites; there is no env var override today.
- To skip the auto-purge entirely, comment out the `purgeStaleCSVs` call.
  Stale CSV files would then accumulate forever (probably undesirable).
- For one-off ad-hoc purge with custom maxDays: `POST /api/terapeak/purge-stale-csvs`
  with admin key and `{ "maxDays": N }`.

## What the agent almost did wrong (debugging note)

The agent almost recommended `git checkout` to restore the Philharmonic CSV
because it treated the deletion as suspicious. The clue missed was the dir
mtime (02:51:24 UTC) being seconds after server start (02:51:01 UTC). When
you see a recent dir mtime + a `D` in git status for files under
`data/terapeak/`, **always check the server startup log first** -- the
auto-purge is the most likely explanation.

## Related files

- `src/services/terapeakService.js` lines ~1370-1430 (`purgeStaleCSVs`)
- `src/services/terapeakService.js` (search `evictStaleComps`)
- `server.js` lines 247-265 (startup wiring)
- `src/routes/terapeakRoute.js` lines ~263-273 (`POST /purge-stale-csvs` admin route)
