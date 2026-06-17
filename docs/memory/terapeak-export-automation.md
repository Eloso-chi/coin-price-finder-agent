# Terapeak Export Automation

## Two Scripts

### 1. scripts/terapeak-export.py (Page 1)
Semi-automated Playwright script that exports page 1 of sold data from eBay Seller Hub Research (Terapeak). Gets up to 50 results per coin.

### 2. scripts/sales-aggregator.py (Pages 2-6 + Dashboard)
Deep pagination script that enriches existing CSVs with additional pages. Imports `get_search_terms` from terapeak-export.py. Bullion coins auto-detect to pages 2-6 (max 300 results); non-bullion gets page 2 only (max 100).

**Dashboard mode:** Run without `--run` or `--dry-run` to get an interactive priority menu. Queries `GET /api/terapeak/aggregation-status` and shows needs-deep, stale, and thin categories for user selection.

## Key Commands
```bash
# Page 1 (terapeak-export.py)
python3 scripts/terapeak-export.py --login                    # Manual browser login (needs display)
python3 scripts/terapeak-export.py --login-manual             # Interactive cookie paste (no display)
python3 scripts/terapeak-export.py --run                      # Export all coins
python3 scripts/terapeak-export.py --run --filter "Morgan"    # Regex filter on search term
python3 scripts/terapeak-export.py --run --limit 10           # First 10 only
python3 scripts/terapeak-export.py --run --resume             # Continue after interruption
python3 scripts/terapeak-export.py --dry-run                  # Show what would export
python3 scripts/terapeak-export.py --check                    # Cookie freshness check

# Page 2+ (sales-aggregator.py)
python3 scripts/sales-aggregator.py                                       # Dashboard mode (interactive)
python3 scripts/sales-aggregator.py --dry-run --filter "Eagle" --min-rows 25
python3 scripts/sales-aggregator.py --run --filter "Eagle" --min-rows 25
python3 scripts/sales-aggregator.py --run --filter "Libertad" --min-rows 0 --max-pages 3
```

## How Search Terms Work
- `get_search_terms()` scans `data/terapeak/*.csv` files
- If a `.meta` file exists alongside the CSV, its content is the search term
- Otherwise, the filename (with underscores replaced by spaces) is the search term
- To add a new coin: create `COIN_NAME.csv` (header-only) + `COIN_NAME.meta` (search term)

## CSV Format (10 columns, as of April 2026)
```
Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition,Format,Seller,Item URL,Quantity Sold
```
- "Quantity Sold" column added April 2026
- terapeakService.js parses it as `quantitySold` field on comp objects

## Date Sorting (April 2026 fix)
Both scripts click the "Date last sold" column header before scraping to ensure results are chronological (newest first). The default Terapeak sort is "Best Match" which returns results in relevance order with dates jumping around.

## Dedup Keys
- **Node `importComps()`**: `title|price|soldDate`
- **Python `append_to_csv()`**: `title|itemId|soldDate|soldPrice`

## Anti-Detection Features
- **Shuffled order** -- coins processed in random order
- **Human typing** -- 50-120ms/char, ~4% typo rate with backspace
- **Human click/scroll** -- random offset, incremental pixel scrolling
- **Page delays** -- p1: 8-18s between searches; p2+: 2.5-6s between pages
- **Reading pauses** -- occasional 4-10s pauses every 2-3 pages
- **Micro-breaks** -- 30% chance of 15-45s break between coins (deep pagination)
- **Browser recycling** -- every 40 coins

## Bullion Detection (sales-aggregator.py)
18 BULLION_PATTERNS regexes: Libertad, Silver/Gold Eagle, Panda, Perth (Kookaburra, Kangaroo, Lunar, Koala), RCM (Maple Leaf, Polar Bear), Britannia, Krugerrand, Philharmonic, Gold Buffalo, Platinum/Palladium Eagle.

`is_bullion_term(term)` → True = pages 2-6, False = page 2 only.

## Flow: CSV → App
1. Results collected from Terapeak DOM table (JS executed in page)
2. Appended to `data/terapeak/{filename}.csv` (deduped by key)
3. POSTed to `POST /api/terapeak/import` (requires ADMIN_API_KEY header)
4. Parsed by `terapeakService.parseCSV()` → `terapeakService.importComps()`
5. `importComps()` calls `ebayService.clearCache()` when new data added (fixes stale cache)
6. Available immediately for pricing via `fetchSoldComps()` Terapeak tier

## Key Files
- `cache/ebay_cookies.json` -- saved session cookies for Playwright (gitignored)
- `cache/terapeak_export_progress.json` -- tracks completed/failed for --resume
- `cache/terapeak_downloads/` -- temp download staging + debug screenshots
- `scripts/vnc-login.py` -- opens eBay in VNC browser for manual login

## Environment Variables
- `APP_URL` -- app endpoint (default: http://localhost:3000)
- `ADMIN_API_KEY` -- required for upload. Stored in local `.env` (gitignored) and Azure Key Vault secret `ADMIN-API-KEY` (prod). Bootstrap a fresh machine with `bash scripts/load-secrets.sh`. Never commit the value.
- `DISPLAY` -- must be set to `:1` for VNC-based collection

## Dependencies
```bash
pip install playwright requests
python3 -m playwright install chromium
```
