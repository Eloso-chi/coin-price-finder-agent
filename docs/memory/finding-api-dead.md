# Finding API -- DEAD (Decommissioned)

## Status
- eBay Finding API (`findCompletedItems`) was **decommissioned February 4, 2025**
- Source: https://developer.ebay.com/develop/apis/api-deprecation-status
- No longer listed in eBay's API call limits table
- Returns error 10001 (rate limiter) or HTTP 500 on every call
- Official replacement: Browse API (but Browse CANNOT return sold items)

## Impact on This Codebase
- `ebayService.js` calls `findCompletedItems` at `svcs.ebay.com/services/search/FindingService/v1`
- This is the ONLY source of real sold data from eBay APIs in the app
- The auto-seed bridge (lines ~1223-1326 in ebayService.js) depends on Finding API -- will NOT work
- `scripts/seedFromEbay.js` bulk seed script depends on Finding API -- will NOT work
- Browse API (`/buy/browse/v1/item_summary/search`) only returns active/for-sale listings

## Alternatives
- **Marketplace Insights API** (`/buy/marketplace_insights/v1_beta`): Returns sold items. Requires eBay approval. Small developers unlikely to get access.
- **Manual Terapeak CSV export**: Go to eBay Seller Hub -> Research, search, export CSV, drop in `data/terapeak/`. This is the ONLY reliable path to real sold data now.
- **Browse API**: Active listings only. Used as last-resort fallback. Not a substitute for sold data.

## Action Items
- [ ] Remove or gate Finding API code behind a feature flag (it's dead code now)
- [ ] Consider applying for Marketplace Insights API access
- [ ] Focus on manual CSV import workflow as primary data source
- [x] parseCSV handles REAL Terapeak export columns (Title, Price, Sold date, Shipping, Total, Item number, Seller, Buyer country, Category) -- fixed April 2026
- [x] Added "Total" column support (price+shipping combined) for real exports
- [x] Added currency, country, bids column mappings
- [x] data/terapeak/README.md updated with synthetic data warning + real export instructions

## Synthetic Data Problem
All 525 CSV files in `data/terapeak/` are **generated/fake**. See `/memories/repo/synthetic-data-audit.md`.
