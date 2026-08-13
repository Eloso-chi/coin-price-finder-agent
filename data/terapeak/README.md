# Terapeak Sold Data

Drop your Terapeak CSV exports in this folder. They'll be auto-imported on server startup.

## IMPORTANT: Data Authenticity

CSV files in this folder are real eBay Seller Hub Research exports. The
synthetic-data audit completed its purge on 2026-05-07; see
[`docs/memory/synthetic-data-audit.md`](../../docs/memory/synthetic-data-audit.md).
Do not add generated price rows to this directory.

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

The parser maps known title, item-ID, sold-date, price/total, shipping,
condition, quantity, image, URL, seller, category, format, country, bid, and
currency aliases. If only `Total` is present, it is treated as the delivered
price. See `COLUMN_MAP` in `src/services/terapeakService.js` for the canonical
header contract.

## File naming

The filename (without extension) becomes the search term used for matching:
- `1892-S_Morgan_Silver_Dollar.csv` -> search term: "1892-S Morgan Silver Dollar"
- Underscores are converted to spaces automatically

**Optional:** Create a `.meta` file with the same name to specify a custom search term:
- `morgan_1892s.meta` containing: `1892-S Morgan Silver Dollar`

## Update schedule

Refresh priority is controlled by the freshness report and canonical operator,
not a blanket monthly schedule. Run `npm run freshness` to sync production
metadata and regenerate `cache/freshness-report.json`. Duplicate rows are
merged by item ID, falling back to title + total price + sold date.

## Semi-automated export with Playwright

Use the canonical operators rather than constructing ad-hoc exporter commands:

```bash
# H machine / Surface WSL
bash scripts/terapeak-operator.sh

# W machine / Codespace
bash scripts/terapeak-operator-codespace.sh --max-passes 1
```

They enforce preflight, cookie health, #284H risk states, immediate
hard-challenge stops, Cooldown recovery gates, and pass telemetry. The full
procedure is in [`docs/memory/terapeak-runbook.md`](../../docs/memory/terapeak-runbook.md).

### Setup

```bash
pip install playwright requests
python3 -m playwright install chromium
```

### Login (manual)

```bash
python3 scripts/terapeak-export.py --login
```

Opens a visible browser to eBay. Log in manually (including any 2FA). Once you reach
the eBay homepage, the script saves your session cookies to `COOKIE_FILE`
(default `cache/ebay_cookies.json`)
and closes the browser. Cookies typically last several hours.

### Exporter diagnostics

```bash
# Dry-run -- see what would be searched, no browser launched
python3 scripts/terapeak-export.py --dry-run

# Filter to specific coins
python3 scripts/terapeak-export.py --run --filter "Morgan"

# Resume after interruption (skips already-completed terms)
python3 scripts/terapeak-export.py --run --resume
```

The exporter saves CSVs under `data/terapeak/`. In `UPLOAD_MODE=api` it posts
to `APP_URL/api/terapeak/import`; `blob` uploads to configured Blob Storage;
`auto` retains the legacy preference behavior. Progress is saved to
`cache/terapeak_export_progress.json`.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `APP_URL` | `http://localhost:3000` | Server URL for API uploads |
| `ADMIN_API_KEY` | (none) | API key for the upload endpoint |
| `COOKIE_FILE` | `cache/ebay_cookies.json` | Per-machine cookie jar; prefer a host-local path outside the worktree |
| `UPLOAD_MODE` | `api` | `api`, `blob`, or legacy `auto` upload behavior |
| `TERAPEAK_BLOB_ACCOUNT` / `TERAPEAK_BLOB_CONTAINER` | (none) | Required for Blob uploads |

### Step-by-step walkthrough

1. **Start the server only when using API upload mode** (in a background terminal):
   ```bash
   npm start
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

5. **If the session expires mid-run**, the script stops and saves progress:
   ```bash
   python3 scripts/terapeak-export.py --login     # re-login
   python3 scripts/terapeak-export.py --run --resume  # pick up where you left off
   ```

CSVs are saved locally to `data/terapeak/` even if the upload fails -- nothing is lost.

### Safety features

- Human-like bounded delays, scrolls, breaks, and browser recycling
- Persisted Normal/Elevated/Cooldown state with pass-level telemetry
- Optional #280H pacing pilot; baseline remains the default
- Immediate stop on the first hard challenge; never automate CAPTCHA solving
- No credentials stored -- only session cookies
- Headed browser mode (visible) so you can monitor progress
- All temp files stored in `cache/` (git-ignored)

## Legacy Chain Scraping

`scripts/chain-aggregate.sh` is retained for legacy/manual sessions. Prefer the
canonical operators above. Any hard challenge must stop immediately under
[`docs/memory/anti-bot-operations.md`](../../docs/memory/anti-bot-operations.md);
do not wait for a three-failure threshold.

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
3. After each batch, `check_antibot` scans the log for a hard anti-bot signal
4. The first matching signal aborts the chain to avoid account flags

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
