# Terapeak Sold Data

Drop your Terapeak CSV exports in this folder. They'll be auto-imported on server startup.

## IMPORTANT: Data Authenticity

**Most CSV files in this folder are REAL data** exported from eBay Seller Hub
Research (Terapeak) via the automated aggregator (`scripts/terapeak-export.py`).
A small number of legacy files may still contain synthetic data from early
development -- these are being replaced as scraping continues.

CSVs can also be stored in Azure Blob Storage (`coinpricecache01/terapeak-csvs`)
and auto-imported at startup when `TERAPEAK_BLOB_ACCOUNT` + `TERAPEAK_BLOB_CONTAINER`
env vars are set.

## How to get REAL data

1. Go to [eBay Seller Hub -> Research](https://www.ebay.com/sh/research) (Terapeak)
2. Search for a coin (e.g. "1892-S Morgan Silver Dollar")
3. Set filters: Sold Items, date range, condition, etc.
4. Click **Export** to download the CSV
5. Rename the file to match the search term: `1892-S_Morgan_Silver_Dollar.csv`
6. Drop it in this folder
7. Restart the server (or upload via the Sold Data tab in the UI)

## Supported CSV column formats

The parser auto-detects columns by header name. All of these work:

**eBay Seller Hub Research (current format):**
```
Title, Price, Sold date, Shipping, Total, Item number, Seller, Buyer country, Category
```

**Older Terapeak standalone export:**
```
Listing Title, Sold For, Sold Date, Shipping Cost, Quantity Sold, Item ID, Seller
```

**Our generated format (synthetic data):**
```
Item Title, Item ID, Sold Date, Sold Price, Shipping, Condition, Seller, Format, Item URL
```

The parser handles all variations. If only a "Total" column is present (no
separate Price/Shipping), it uses Total as the price. Currency defaults to USD.

## File naming

The filename (without extension) becomes the search term used for matching:
- `1892-S_Morgan_Silver_Dollar.csv` -> search term: "1892-S Morgan Silver Dollar"
- Underscores are converted to spaces automatically

**Optional:** Create a `.meta` file with the same name to specify a custom search term:
- `morgan_1892s.meta` containing: `1892-S Morgan Silver Dollar`

## Update schedule

Terapeak data is relatively static -- **monthly updates** are sufficient.
Just replace the CSV files and restart the server. Duplicate items are automatically skipped.

## Semi-automated export with Playwright

Instead of manually exporting each coin, use `scripts/terapeak-export.py` to automate
the process. It drives a real Chromium browser via Playwright.

### Setup

```bash
pip install playwright requests
python3 -m playwright install chromium
```

### Phase 1: Login (manual, one-time)

```bash
python3 scripts/terapeak-export.py --login
```

Opens a visible browser to eBay. Log in manually (including any 2FA). Once you reach
the eBay homepage, the script saves your session cookies to `cache/terapeak_cookies.json`
and closes the browser. Cookies typically last several hours.

### Phase 2: Automated export

```bash
# Dry-run -- see what would be searched, no browser launched
python3 scripts/terapeak-export.py --dry-run

# Run all 525 search terms
python3 scripts/terapeak-export.py --run

# Filter to specific coins
python3 scripts/terapeak-export.py --run --filter "Morgan"

# Resume after interruption (skips already-completed terms)
python3 scripts/terapeak-export.py --run --resume
```

The script searches each coin term on eBay Seller Hub Research, clicks Export,
downloads the CSV, and uploads it to the running server via `POST /api/terapeak/import`.
Progress is saved to `cache/terapeak_progress.json` for resume support.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:3000` | Server URL for CSV upload |
| `ADMIN_API_KEY` | (none) | API key for the upload endpoint |

### Step-by-step walkthrough

1. **Start the server** (in a separate terminal):
   ```bash
   export ADMIN_API_KEY="your-key-here"
   node src/server.js
   ```

2. **Login** -- opens a real browser window:
   ```bash
   python3 scripts/terapeak-export.py --login
   ```
   - Log in to eBay manually (email, password, CAPTCHA, 2FA -- all you)
   - Once you see the eBay homepage, switch back to the terminal and press ENTER
   - The script verifies your session and saves cookies (~12 hours lifespan)

3. **Dry run** (optional, recommended first time):
   ```bash
   python3 scripts/terapeak-export.py --dry-run
   ```

4. **Test with a small batch**:
   ```bash
   export ADMIN_API_KEY="your-key-here"
   python3 scripts/terapeak-export.py --run --filter "Morgan" --limit 5
   ```

5. **Full export** (all 525 coins, ~2 hours):
   ```bash
   python3 scripts/terapeak-export.py --run
   ```

6. **If the session expires mid-run**, the script stops and saves progress:
   ```bash
   python3 scripts/terapeak-export.py --login     # re-login
   python3 scripts/terapeak-export.py --run --resume  # pick up where you left off
   ```

CSVs are saved locally to `data/terapeak/` even if the upload fails -- nothing is lost.

### Safety features

- Human-like delays (5--10s between searches) to avoid rate limits
- Session health check every 25 searches
- No credentials stored -- only session cookies
- Headed browser mode (visible) so you can monitor progress
- All temp files stored in `cache/` (git-ignored)

## Chain Scraping

For multi-series batch runs, use `scripts/chain-aggregate.sh`:

```bash
# Source the helper functions
source scripts/chain-aggregate.sh

# Run batches sequentially with anti-bot monitoring
run_batch "morgan_grades" "Morgan.*Dollar.*MS"
run_batch "barber_dimes" "Barber.*Dime"
run_batch "walking_liberty" "Walking Liberty.*Half"
```

The `run_batch()` function:
1. Runs `terapeak-export.py --run --resume --filter REGEX`
2. Logs to `cache/terapeak_<name>.log`
3. After each batch, `check_antibot` tails the log for 3+ consecutive bot-detection failures
4. If detected, aborts the chain to avoid account flags

Write session-specific chain scripts (e.g. `chain-aggregate-session2.sh`) for large multi-batch runs.

## Biweekly Stale Refresh

Use `scripts/refresh-stale.sh` to automatically refresh datasets older than a threshold:

```bash
# Preview what would be refreshed (default: 14 days)
bash scripts/refresh-stale.sh --dry-run

# Run the refresh
bash scripts/refresh-stale.sh

# Full cold-start refresh (all datasets)
bash scripts/refresh-stale.sh --full

# Custom staleness threshold
bash scripts/refresh-stale.sh --days 30

# Include empty datasets (zero comps)
bash scripts/refresh-stale.sh --include-empty

# Limit number of terms
bash scripts/refresh-stale.sh --limit 50
```

The script queries `GET /api/admin/stale-datasets?days=N`, builds a filter regex from the stale search terms, writes it to a temp file (avoids shell escaping issues with `eval`), and passes it to the aggregator.

## Why not use the Finding API?

The eBay Finding API (`findCompletedItems`) was **decommissioned on February 4, 2025**.
It no longer returns sold data. The Browse API (its replacement) only returns active
listings. Manual Terapeak CSV export is currently the only reliable source of real
sold data for small developers without Marketplace Insights API access.
