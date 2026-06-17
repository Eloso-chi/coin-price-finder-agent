# Cosmos DB Gotchas (coinpricefinder-cosmos)

## terapeak-sold container
- **Partition key path: `/searchTerm` (RAW key, NOT the sanitized doc id)**
- Doc `id` is sanitized via `cosmosDocId(key) = key.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 200)`.
- Correct read/delete: `container.item(cosmosDocId(key), key).read()` -- pass raw key as partition key.
- Wrong: passing the sanitized id as both args -> Cosmos partition mismatch, doc never found.

## @azure/cosmos `.read()` does NOT throw on 404
- Returns `{ resource: undefined, statusCode: 404 }`.
- Always check `if (!result.resource)`, NOT `try { ... } catch (err) { if (err.code === 404) }`.
- The catch-404 pattern is dead code -- the SDK only throws on 401/403/429/5xx.

## Container partition keys (verified 2026-06)
- `terapeak-sold`: `/searchTerm`
- (Add others as discovered: users, audit, greysheet-history, market-prices)

## App Service migration safety
- `coinpricefinder` runs `hydrateMetaFromCosmos()` at startup AND has `importComps` write-through.
- For destructive Cosmos migrations: `az webapp stop` first, run, then `az webapp start` (~49s cold start).
- Resource group: `CoinPriceFinder_group-82d5`.

## Migration pattern
- Take fresh dump via `scripts/export-cosmos-terapeak-sold.js` before --apply.
- Dumps are 107MB, gitignored under `data/archive/cosmos-terapeak-sold-*.json`.
- Keep `/tmp/` copy as second backup until next refresh confirms health.
