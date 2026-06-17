# Cache Invalidation Fix (April 11, 2026)

## Problem
- eBay results cached to disk (`cache/ebay_cache.json`) with TTLCache file persistence
- After Terapeak data imports (e.g., page 2 enrichment), stale cached results still served
- Browser UI uses `timeWindowDays: 90` by default (not 180)
- Stale 13-comp result persisted across server restarts

## Fix Applied
- `terapeakService.importComps()` now calls `ebayService.clearCache()` when `newCount > 0`
- Uses lazy `require('./ebayService')` to avoid circular dependency (ebayService requires terapeakService)

## 2002 Libertad Comp Pipeline (timeWindowDays=90)
- CSV: 54 rows → Store: 52 (dedup) → 90-day window: 28 → Raw only: 22 → After filters: 13
- With 180-day window: 40 raw → 32 after filters
- 13 is correct given the data -- not a bug, just sparse recent data

## Key Facts
- Browser UI default: `timeWindowDays: 90` (set in public/index.html line 3048)
- Disk caches: ebay_cache.json, greysheet_cache.json, pcgs_cache.json, metals_spot.json
- Clear-cache API: `POST /api/clear-cache` with `x-api-key` header (ADMIN_API_KEY)
- Clear-cache button exists in the UI
