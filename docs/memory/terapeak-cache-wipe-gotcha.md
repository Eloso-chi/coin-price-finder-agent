# Terapeak cache wipe gotcha

Migrated from `/memories/repo/` to `docs/memory/` on 2026-07-05.

If `cache/terapeak_sold.json` is `{}` (e.g., after a deliberate operator shutdown reset, cluster of runtime caches all wiped at the same mtime), a CSV-only re-import will produce a `data/terapeak-meta.json` snapshot with **degraded `compCount`** for any key that was previously deep-paginated (no cumulative store to dedupe-merge against). Working as designed -- not a bug. Prod self-heals via `_mergeAggregationMeta` / `maxNumOrNull` (`src/services/terapeakService.js` L201) on next hydration, and the scraper loop resyncs the meta from Azure before every run (`scripts/run-surface-freshness-loop.sh` L244-277, fix #253). Observed: 2026-06-30 PR #217 (commit `5a3e39b`).
