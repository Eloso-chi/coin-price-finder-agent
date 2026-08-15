# Finding API -- DEAD (Decommissioned)

## Status
- eBay Finding API (`findCompletedItems`) was **decommissioned February 4, 2025**
- Source: https://developer.ebay.com/develop/apis/api-deprecation-status
- No longer listed in eBay's API call limits table
- Returns error 10001 (rate limiter) or HTTP 500 on every call
- Official replacement: Browse API (but Browse CANNOT return sold items)

## Impact on This Codebase
- `ebayService.js` retains `findCompletedItems` compatibility code behind `EBAY_FINDING_ENABLED`; the default is `false`
- Terapeak imports are the primary sold-data source
- Any Finding-dependent auto-seed path is unavailable unless explicitly enabled and the upstream endpoint responds
- `scripts/seedFromEbay.js` bulk seed script depends on Finding API -- will NOT work
- Browse API (`/buy/browse/v1/item_summary/search`) only returns active/for-sale listings

## Alternatives
- **Marketplace Insights API** (`/buy/marketplace_insights/v1_beta`): Returns sold items. Requires eBay approval. Small developers unlikely to get access.
- **Manual Terapeak CSV export**: Go to eBay Seller Hub -> Research, search, export CSV, drop in `data/terapeak/`. This is the ONLY reliable path to real sold data now.
- **Browse API**: Active listings only. Used as last-resort fallback. Not a substitute for sold data.

## Action Items
- [x] Gate Finding API code behind `EBAY_FINDING_ENABLED=false` by default
- [ ] Consider applying for Marketplace Insights API access
- [ ] Focus on manual CSV import workflow as primary data source
- [x] parseCSV handles REAL Terapeak export columns (Title, Price, Sold date, Shipping, Total, Item number, Seller, Buyer country, Category) -- fixed April 2026
- [x] Added "Total" column support (price+shipping combined) for real exports
- [x] Added currency, country, bids column mappings
- [x] `data/terapeak/README.md` updated with real export and canonical operator instructions

## Data Authenticity
The synthetic-data purge completed on 2026-05-07. Current repository CSVs are
real exports; see [`synthetic-data-audit.md`](synthetic-data-audit.md) for the
purge evidence and historical generator inventory.
