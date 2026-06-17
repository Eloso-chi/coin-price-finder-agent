# Terapeak Data Structure Analysis (April 12, 2026)

## Context
User asked for a deep analysis of how Terapeak data is structured after 2002 Libertad page 2 scrape returned 0 new rows despite Terapeak showing 102 different sellers.

## Key Findings

### 1. Page 2 Scraper Navigation: CONFIRMED WORKING
- Debug screenshots (`cache/terapeak_downloads/_debug_p2_page1_*.png` and `_debug_p2_page2_*.png`) show distinct listings on each page.
- **Default sort is Best Match (not chronological)** -- dates jump around within a page.
- Page 1 and Page 2 each contain 50 results ranked by keyword relevance.
- The 0-new-rows result was because the original page 2 enrichment run (#76-78) had already captured this data.
- **FIX APPLIED**: Both scripts now click "Date last sold" column header (descending) before scraping so pages are chronological (newest first).

### 2. CSV Structure: Multi-Quantity Listings Create Sub-Rows
- A single eBay listing that sold N times appears as:
  - 1 row WITH an Item ID (primary listing)
  - (N-1) sub-rows with BLANK Item IDs but different dates/prices
- Example: "2002 1 OZ SILVER .999 MEXICO LIBERTAD" sold 7 times = 1 ID row + 6 blank-ID sub-rows
- This is how Terapeak structures repeat/multi-quantity sales in the DOM table

### 3. 2002 Libertad CSV Breakdown (54 rows)

| Metric | Value |
|---|---|
| Total CSV rows | 54 |
| Unique listings (with Item ID) | 28 |
| Sub-rows (blank ID, repeat sales) | 26 |
| Unique titles | 26 |
| Date range | Oct 19, 2025 -- Apr 10, 2026 |

Content types in the CSV:
- Raw 1oz Libertads: ~17
- Non-1oz variants: 5 (1/2 oz x3, 1/4 oz NGC MS68, 1/10 oz)
- Graded coins: 6 (PCGS MS67, MS68, MS69; NGC PF69 UCAM)
- Wrong year: 1 ("2022 Mexico 1 oz .999 Silver Libertad")
- Multi-coin lot: 1 ("2002 and 2005 Mexico 1oz Silver Libertads")

### 4. Server Comp Funnel (post cache-fix, commit 92c80eb)

| Window | In Window | After Filters | Key Removals |
|---|---|---|---|
| 365 days | 54 | 34 comps | 4 weight, 2 year, 1 outlier |
| 90 days (UI default) | 26 | 13 comps | 3 weight, 1 year, 3 outlier |

FMV at 365d: $109.23, confidence 88%, bullion-spot-premium method

### 5. "102 Sellers" vs 34 Comps -- Why the Gap
- Terapeak Research tab "102 sellers" = all sellers across ALL time for the search term
- **Terapeak provides up to 3 years of historical sales data**
- Includes all denominations (1/20, 1/10, 1/4, 1/2, 1 oz)
- Includes all conditions (raw + graded)
- Sold Items pages use Best Match ordering by default (not chronological)
- We capture pages 1-6 for bullion (max 300 listings) and pages 1-2 for non-bullion (max 100); with date sorting, these are the most recent
- After filtering (correct year, 1oz, raw, time window), usable pool shrinks
- **Only paid transactions appear** -- cancelled/refunded sales are excluded
- **Sold Price = actual price paid** (includes accepted Best Offers and discounts)

### 6. Root Cause of Original 12-13 Comp Issue
The low comp count was caused by **stale eBay disk cache** (`cache/ebay_cache.json`), NOT a scraper failure.
- Cache survived server restarts with 1-hour TTL persistence
- Fixed by calling `ebayService.clearCache()` in `importComps()` when new data is added
- Dedup keys also tightened: `title|price|soldDate` (Node) and `title|id|date|price` (Python)
- All fixes committed in `92c80eb`

### 7. Dedup Key Reference
- **Node `importComps()`**: `title|price|soldDate` (was `title|price`)
- **Python `append_to_csv()`**: `title|itemId|soldDate|soldPrice` (was `id|date|price`)
- Old keys were too aggressive -- collapsed different listings with same price or blank IDs
