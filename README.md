# Coin Price Discovery Agent

A dealer-oriented pricing tool that calculates **Fair Market Value (FMV)** for US coins and bullion bars by combining PCGS catalog data, eBay sold-comp analysis, and Terapeak market data. It produces buy/sell recommendations with confidence scores — designed for quick, data-backed decisions at a coin show or behind a counter.

## What It Does

1. **Identifies the coin** — accepts a PCGS cert number, barcode, PCGS coin number, or free-text description (e.g. "1881-CC Morgan dollar MS 64").
2. **Enriches via PCGS** — fetches price guide value, population, auction history, mintage, and reference images from the PCGS CoinFacts API.
3. **Pulls eBay sold comps** — queries up to three eBay APIs (Marketplace Insights → Finding → Browse) to collect recent sold prices, then scores and filters them for relevance.
4. **Supplements with Terapeak data** — imports Terapeak CSV exports (manual upload or auto-import from `data/terapeak/`) for additional sold-comp coverage with daily quota tracking.
5. **Fetches Greysheet wholesale pricing** -- queries the CDN Public API V2 by PCGS coin number for wholesale (GreyVal), retail (CPG), PCGS, NGC, and Blue Book values.
6. **Computes FMV** -- blends PCGS, eBay, auction, and Greysheet data using a weighted median with outlier removal, producing a confidence-scored valuation.
6. **Generates buy/sell decisions** — outputs max-buy thresholds (70/75/80% of FMV) and sell tiers (fast/normal/premium) with a recommendation.
7. **Batch pricing** — prices up to 25 coins in a single request.
8. **Lot evaluator** — bulk-prices 50--500 coins via SSE streaming, applies lot-level discounts (size, confidence, concentration), and outputs three buy tiers (cherry-pick, fair lot, full retail).
9. **Price history charting** — returns time-series sold-price data with optional spot-price metal overlay.
10. **Live metals tracking** — background polling (every 30 min) with round-robin across providers, plus daily history snapshots.
11. **Market matrix** — year × mint grid of median completed prices and cheapest BIN listings, enriched with Numista rarity data.
12. **Azure infrastructure** — secrets in Key Vault (managed identity), dual-mode Cosmos DB write-through for all persistent data, Blob Storage for Terapeak CSVs, Azure Files for cache persistence.

Also supports **bullion bars** (any metal, any size), **proof/mint sets**, **rolls**, and **lunar series** with dedicated input flows and eBay keyword strategies.

---

## Frontend — Web UI

The browser UI is a single-page app served from `public/index.html` with a dark theme and eight tabbed panels. Client-side JavaScript is split across three modules loaded in order: `auth.js` → `storage.js` → `my-coins.js`. Authentication and coin storage are handled server-side via JWT + bcrypt.

### Tabs

| Tab | Description |
|-----|-------------|
| **Price Discovery** | Main search — two sub-modes: Coin (structured or quick-search entry) and Bar/Bullion. Submits to `/api/price` or `/api/bar-price`. Renders FMV hero card with image gallery, confidence score, buy/sell decisions, metadata chips, eBay stats, comp list, and raw JSON. |
| **Melt Calculator** | Offline calculator for 80+ US coin types and 20 bar sizes. Auto-fetches spot prices from `/api/metals` and polls every 5 minutes. Shows per-coin, per-roll, and total melt values at spot and spot+premium. |
| **Live eBay Tracker** | Market matrix from `/api/market/ebay`. Three display modes: Year × Mint (numismatic coins), Year × Grade (bullion), and Brand table (bars). Cells show median sold price, cheapest BIN link, key date badge, and Numista rarity. Color-coded legend. |
| **Lot Evaluator** | Bulk collection pricing tool. Accepts a text list (one coin per line, pipe-delimited fields), JSON array, or Excel upload. Submits to `POST /api/bulk-evaluate`, then streams results via SSE. Shows per-coin FMV table with progress bar, lot summary card (total FMV, melt, avg confidence, bullion %), and three buy tiers (cherry-pick, fair lot, full retail). Applies lot-level discounts for size, low confidence, and concentration risk. Export results as CSV or JSON. |
| **Sold Data** | Terapeak CSV import UI (drag-and-drop or file picker) with search term input. Datasets list with delete. Visual daily quota meter (250/day default) with manual logging and reset. Admin endpoints require `x-api-key`. |
| **My Coins** 🔒 | Auth-gated. Server-side coin collection (persisted in `cache/user_coins.json` + Azure Cosmos DB write-through). Shows portfolio summary (total FMV, total cost, unrealized P/L, coin count) and full table with per-coin FMV, confidence, Troy Oz, cost basis, P/L, melt value, eBay average, range, notes, date added, and remove button. Checkbox column with select-all for multi-select bulk delete. Export/Import backup buttons (JSON and Excel .xlsx), Change Password. |
| **Price History** 🔒 | Auth-gated. Canvas-drawn chart from `/api/coin-history`. Shows daily median prices with IQR band, outlier dots, and optional precious-metal spot overlay (dashed line). Supports 90/180/365-day ranges. |
| **About** | Confidence score key, privacy/security explanation, how login works, feature previews for logged-out users, and legal disclaimer. |

### Server-Side Auth (bcrypt + JWT)

Authentication is handled server-side. Accounts and coin data persist across browser restarts, cache clears, and device changes.

- **Signup** — `POST /api/auth/signup` with `{username, password}`. Server hashes the password with bcrypt (12 rounds), generates a UUID, stores the account in `cache/users.json`, and returns a signed JWT.
- **Login** — `POST /api/auth/login` with `{username, password}`. Server verifies bcrypt hash, returns a JWT (7-day expiry).
- **Session** — the JWT is held in memory on the client (not localStorage). Lost on page close/reload -- user must re-login, but all data persists server-side.
- **Password change** — `POST /api/auth/change-password` with Bearer token + `{currentPassword, newPassword}`. No coin re-encryption needed (coins are stored as plaintext on the server).
- **JWT secret** — set `JWT_SECRET` in your environment for persistent sessions across server restarts. If unset, a random secret is generated on startup (all sessions expire on restart).
- **Username rules** — lowercased, alphanumeric + dots/hyphens/underscores, max 50 chars. Password minimum 6 chars.

The previous zero-knowledge client-side auth system (PBKDF2 + AES-256-GCM with IndexedDB encryption) has been replaced. `crypto.js` is no longer loaded.

### Server-Side Coin Storage

- **Store:** `cache/user_coins.json` -- plaintext JSON keyed by userId. No client-side encryption (coins live on the user's own server).
- **API:** All CRUD via `/api/coins/*` endpoints with Bearer JWT auth. `GET /api/coins` (list), `POST /api/coins` (add), `PUT /api/coins/:hash` (update count/cost), `DELETE /api/coins/:hash` (remove), `GET /api/coins/export`, `POST /api/coins/import`, `POST /api/coins/bulk-delete`.
- **Deduplication:** Coins are hashed by `SHA-256(series|year|mint.upper|grade.upper|notes|label)` to prevent duplicates while allowing distinct lots.
- **"I Have This Coin" button:** Appears in Price Discovery results. If logged in, adds the coin to the server-side collection with one click. If logged out, shows a lock icon that opens the login dialog.

### Export & Import Backup

- **Export** — downloads a **plaintext JSON** file (`coin-collection-backup-YYYY-MM-DD.json`). The export contains `{format, exportedAt, count, coins[]}` with each coin's series, year, mint, grade, weight, query, and dateAdded.
- **Import** — reads the JSON backup, validates the `coin-price-agent-backup-v1` format header, and adds each coin to the server-side collection. Skips duplicates (by coinHash). Works across accounts — if a user loses their login and creates a new account, they can import a previous backup into the new account.
### Excel (.xlsx) Import

The app can import coin collections from Excel spreadsheets via `POST /api/import/excel`. The mapper (`src/utils/excelMapper.js`) handles:

- **Flexible header matching** -- recognizes common column name variations (e.g. "Troy oz", "Tory oz", "troy_oz"; "Mint Mark", "mint_mark", "mintmark")
- **Series normalization** -- maps informal names (e.g. "ASE" -> "American Silver Eagle", "canadian maple leaf" -> "Canadian Silver Maple Leaf") to canonical pricing engine names via a 20+ entry alias table
- **Smart parsing** -- extracts year, mint mark, and series from free-text "Coin Name" column; prefers dedicated Year/Mint Mark columns when present
- **Metal/weight detection** -- reads troy oz weight and maps to base metal (silver/gold) with fineness
- **Year validation** -- requires 4-digit year between 1600-2099; rejects partial years
- **Cost/notes/quantity pass-through** -- preserves cost basis, notes, and quantity from the spreadsheet

The endpoint accepts `.xlsx` files up to 10 MB and returns the mapped coins in the standard backup JSON format, ready for import into the server-side collection.

### Auto-Seed Test Account

On server startup, if the `testcollector` account does not exist in `cache/users.json`, the server creates it with 10 sample coins (Morgans, Peace, Kennedy, Walking Liberty, ASE, Washington, Roosevelt, Buffalo, Lincoln). The seed is server-side, so the account persists across browser clears and restarts. Credentials: `testcollector` / `Coins2026!`.
### Backup & Export

Since coins are now stored server-side, data survives browser clears. The Export button still downloads a JSON backup for offline safekeeping. The `BackupReminder` module is a no-op in server mode (coins are not at risk of browser-side data loss).

### Auth-Gated Tabs

The My Coins and Price History tabs are locked for logged-out users:

- Tab buttons show a lock icon and muted styling.
- Clicking a locked tab opens the login dialog instead of switching panels.
- A teaser banner below the tab bar reads "Unlock My Coins & Price History" with a login CTA.
- The About tab shows feature preview cards with mocked UI (sample portfolio table, sample price chart) and login buttons.
- All lock/teaser state updates reactively on login/logout.

### Cross-Tab Linkage

- **Price Discovery → Live eBay Tracker:** After pricing a coin, the tracker's series input is pre-populated. Switching to the tracker tab auto-loads the matrix.
- **Price Discovery → Price History:** A `CoinHistoryLink` object stores the query. Switching to the History tab auto-runs the chart.

---

## Quick Start

### Prerequisites

- **Node.js** 22+ (CommonJS)
- **eBay Developer** account — [developer.ebay.com](https://developer.ebay.com/)
- **PCGS Public API** key — [pcgs.com/publicapi/documentation](https://www.pcgs.com/publicapi/documentation)
- *(Optional)* Gold API or Metals API key for live spot prices
- *(Optional)* Numista API key for rarity/mintage enrichment

### Install

```bash
git clone https://github.com/Eloso-chi/coin-price-finder-agent.git
cd coin-price-finder-agent
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in your API keys:

```bash
cp .env.example .env
```

Required variables:

| Variable | Purpose |
|----------|---------|
| `PCGS_API_KEY` | PCGS CoinFacts API token |
| `EBAY_APP_ID` | eBay app ID (from Developer Portal) |
| `EBAY_CLIENT_SECRET` | eBay client secret (for OAuth) |

Optional variables:

| Variable | Purpose | Default |
|----------|---------|---------|
| `GOLDAPI_KEY` | Gold API key for spot prices | *(none)* |
| `METALS_API_KEY` | Metals API key (fallback provider) | *(none)* |
| `NUMISTA_API_KEY` | Numista API key for rarity/mintage data | *(none)* || `GREYSHEET_API_TOKEN` | Greysheet CDN Public API V2 token | *(none)* |
| `GREYSHEET_API_KEY` | Greysheet CDN Public API V2 key | *(none)* |
| `GREYSHEET_BASE_URL` | Greysheet API base URL override | `https://cpgpublicapiv2.greysheet.com/api` |
| `ADMIN_API_KEY` | API key for admin/destructive endpoints | *(none -- endpoints locked)* |
| `JWT_SECRET` | Secret key for signing JWTs (auth tokens) | *(random on startup -- sessions expire on restart)* |
| `PORT` | Server port | `3000` |
| `EBAY_CACHE_TTL_MS` | eBay cache lifetime | `3600000` (1 hour) |
| `EBAY_US_MIN_COMPS` | Minimum US comps before global fallback | `8` |
| `EBAY_DEFAULT_LOOKBACK_DAYS` | Default eBay sold-comp lookback window (auto-extends to 365 if too few comps) | `180` |
| `BLOB_REIMPORT_MS` | Periodic blob re-import interval (30 min default) | `1800000` |
| `CACHE_DIR` | Directory for persistent JSON caches (Azure Files mount point) | `./cache` |
| `COSMOS_ENDPOINT` | Azure Cosmos DB endpoint (enables dual-mode write-through) | *(none -- file-only)* |
| `COSMOS_KEY` | Azure Cosmos DB auth key | *(none)* |
| `TERAPEAK_BLOB_ACCOUNT` | Azure Storage account name for Terapeak CSV blobs | *(none -- local only)* |
| `TERAPEAK_BLOB_CONTAINER` | Blob container name for Terapeak CSVs | *(none)* |
| `EBAY_THROTTLE_MS` | eBay API throttle delay | `1100` |
| `EBAY_TIMEOUT_MS` | eBay API timeout | `10000` |
| `METALS_CACHE_TTL_MS` | Metals spot price cache lifetime | `2700000` (45 min) |
| `METALS_POLL_MS` | Background metals polling interval | `1800000` (30 min) |

### Run

```bash
npm start
# or with auto-reload:
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser for the web UI.

### Example API Call

```bash
curl -s -X POST http://localhost:3000/api/price \
  -H 'Content-Type: application/json' \
  -d '{"query": "1881-CC Morgan dollar MS 64", "askingPrice": 650}' | jq .
```

Response (abbreviated):

```json
{
  "pcgs": {
    "verified": true,
    "pcgsCoinNumber": 7126,
    "series": "Morgan Dollars 1878-1921",
    "grade": "MS64",
    "priceGuide": { "valueUsd": 900 },
    "population": { "thisGrade": 9515, "higher": 8974 }
  },
  "valuation": {
    "fmvCore": 835.00,
    "rangeLow": 780.00,
    "rangeHigh": 890.00,
    "confidence": 82
  },
  "greysheet": {
    "gsid": 7486,
    "name": "1881-CC $1 MS",
    "gradeLabel": "MS64",
    "wholesale": 775,
    "retail": 900,
    "pcgsVal": 900,
    "ngcVal": 850,
    "blueBookVal": 700
  },
  "decisions": {
    "buy": {
      "max70": 584.50,
      "max75": 626.25,
      "max80": 668.00,
      "askingPrice": 650,
      "recommendation": "BUY (thin margin)"
    },
    "sell": {
      "fast": 768.20,
      "normal": 835.00,
      "premium": 876.75
    }
  }
}
```

---

## Key Concepts

### FMV Core

Fair Market Value is a blended estimate from up to four data sources:

| Source | Weight (Certified) | Weight (Raw) |
|--------|-------------------|--------------|
| eBay Sold Comps | 55% | 70% |
| PCGS Price Guide | 15% | 10% |
| PCGS Auction History | 10% | -- |
| Greysheet Wholesale | 20% | 20% |

If a source is unavailable (e.g. no Greysheet credentials), weights are renormalized among the remaining sources.

The eBay component uses a **weighted median** that favors recent sales (recency decay: `1 / (1 + daysSince/90)`) and high-relevance matches (match score from `scoreMatch()`).

### US Comps vs Global Comps

The agent queries eBay US first. If US sold comps fall below the threshold (default: 8), it pulls global comps as a supplement. The valuation engine prefers US comps and applies a confidence penalty when relying on global data.

### Confidence Score

A 0–100 score reflecting how trustworthy the FMV estimate is:

| Factor | Points |
|--------|--------|
| Sample size | Up to 30–40 pts |
| Price dispersion (low spread) | Up to 20–25 pts |
| Match quality (avg score) | Up to 15–25 pts |
| PCGS verified | +10 |
| PCGS price guide available | +10 |
| Auction data available | +5 || Greysheet data available | +5 || 20+ comps bonus | +10–15 |
| Global fallback penalty | −5 to −15 |
| Fewer than 5 comps | −10 |

### Buy vs Sell Strategies

**Buy thresholds** — maximum prices a dealer should pay:

| Tier | Formula | Use When |
|------|---------|----------|
| 70% | FMV × 0.70 | Target for maximum margin |
| 75% | FMV × 0.75 | Standard dealer buy |
| 80% | FMV × 0.80 | Thin margin, high-demand items |

If an asking price is provided:
- ≤ 75% of FMV → **BUY**
- ≤ 80% of FMV → **BUY (thin margin)**
- \> 80% of FMV → **PASS**

**Sell tiers** — suggested list prices:

| Tier | Formula | Description |
|------|---------|-------------|
| Fast | eBay median × 0.92 | Quick sale, undercut market |
| Normal | eBay median | Market price |
| Premium | eBay median × 1.05 | Patient sell (1.15× if pop < 200) |
| Offer Floor | min(P25, fast) | Lowest acceptable offer |

---

## API Endpoints

### Core Pricing

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/price` | Price a coin (main endpoint) |
| `POST` | `/api/bar-price` | Price a bullion bar |
| `POST` | `/api/pricing-batch` | Batch-price up to 25 coins in one request |
| `POST` | `/api/import/excel` | Import a coin collection from .xlsx spreadsheet |
| `GET` | `/api/coin-variant` | Design-series metadata for a denomination + year |
| `GET` | `/api/coin-history` | Sold-price time-series (daily medians) with optional spot overlay |

### Bulk Lot Evaluator

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/bulk-evaluate` | Submit a lot for evaluation (returns `jobId`) |
| `GET` | `/api/bulk-evaluate/:jobId/stream` | SSE stream of per-coin results + lot summary |
| `GET` | `/api/bulk-evaluate/:jobId` | Poll job status and completed results |

**POST body formats:**

- **Text** -- `{ "text": "1921 Morgan Dollar | qty=5 | grade=MS-63\n2024 ASE" }` (one coin per line, pipe-delimited fields)
- **JSON** -- `{ "items": [{"query": "1921 Morgan Dollar", "qty": 5, "grade": "MS-63"}] }`
- **Excel** -- multipart form upload of `.xlsx` file (reuses the Excel mapper)

**SSE events:** `coin` (per-result with index/total), `summary` (lot-level analysis), `done`, `error`.

**Lot pricing formula:**

| Discount | Condition | Amount |
|----------|-----------|--------|
| Size | 11--50 coins: 5%, 51--100: 10%, 101--250: 15%, 251--500: 20% | 0--20% |
| Confidence | Avg confidence < 60 | 5% |
| Concentration | Any single coin > 50% of lot value | 3% |

**Buy tiers** (applied to total FMV after discounts):

| Tier | Range | Description |
|------|-------|-------------|
| Cherry-Pick | 55--65% | Max dealer profit |
| Fair Lot | 70--80% | Standard lot purchase |
| Full Retail | 85--90% minus fees | Near-retail, minus platform/seller fees |

**Limits:** 500 coins max per job, 10 coins evaluated in parallel, max 3 concurrent jobs server-wide, 1-hour result cache (keyed by SHA-256 of input).

### Authentication & Coin Collection

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/signup` | Create a new account |
| `POST` | `/api/auth/login` | Log in (returns JWT) |
| `GET` | `/api/auth/me` | Verify token + get user info |
| `POST` | `/api/auth/change-password` | Change password (requires Bearer token) |
| `GET` | `/api/coins` | List all coins for authenticated user |
| `POST` | `/api/coins` | Add a coin |
| `PUT` | `/api/coins/:hash` | Update coin count or cost |
| `DELETE` | `/api/coins/:hash` | Remove a coin |
| `GET` | `/api/coins/export` | Export collection as backup JSON |
| `POST` | `/api/coins/import` | Import coins from backup |
| `POST` | `/api/coins/bulk-delete` | Delete multiple coins by hash |
| `GET` | `/api/coins/count` | Get coin count |

All `/api/coins/*` endpoints require `Authorization: Bearer <jwt>` header.

### Market & Metals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/market/ebay` | Live eBay market matrix (year × mint grid) |
| `GET` | `/api/metals` | Get spot prices for multiple metals |
| `GET` | `/api/metals/:metal` | Get a single metal's spot price |
| `GET` | `/api/image-proxy` | Proxy coin images from allowlisted hosts (Numista) |

### Terapeak Data Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/terapeak/import` | Upload a Terapeak CSV (multipart) 🔒 |
| `POST` | `/api/terapeak/import-text` | Import CSV as pasted text 🔒 |
| `GET` | `/api/terapeak/datasets` | List all imported datasets |
| `GET` | `/api/terapeak/lookup` | Look up sold comps by search term |
| `DELETE` | `/api/terapeak/datasets/:key` | Delete a specific dataset 🔒 |
| `DELETE` | `/api/terapeak/datasets` | Clear all Terapeak data 🔒 |
| `POST` | `/api/terapeak/purge-stale-csvs` | Delete CSV files older than N days 🔒 |
| `POST` | `/api/terapeak/reimport` | Trigger manual blob re-import (supports `force=true`) 🔒 |

### Terapeak Quota

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/terapeak/quota` | Get current daily quota status |
| `POST` | `/api/terapeak/quota/record` | Record Terapeak queries 🔒 |
| `POST` | `/api/terapeak/quota/set-used` | Set the used count 🔒 |
| `POST` | `/api/terapeak/quota/reset` | Reset today's counter to 0 🔒 |
| `POST` | `/api/terapeak/quota/set-limit` | Change the daily limit 🔒 |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/clear-cache` | Flush all caches (eBay + PCGS + market + Numista + metals) 🔒 |
| `GET` | `/api/health` | Health check + uptime |

🔒 = requires `ADMIN_API_KEY` via `x-api-key` header.

### Live eBay Market Tracker

```bash
# Fetch a year × mint matrix of Franklin Half Dollar prices
curl -s 'http://localhost:3000/api/market/ebay?series=Franklin+Half+Dollar&grade=MS65&days=90' | jq .
```

Query parameters:

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `series` | Yes | — | Coin series name (e.g. "Morgan Dollar") |
| `grade` | No | `All` | Grade filter (e.g. "MS65", "PR69") |
| `days` | No | `90` | Lookback window for completed sales |

Response includes `years`, `mintMarks`, `summary`, and `cells[]` — each cell has `medianCompleted` (from sold comps), `cheapestBin` (active BIN link), and `keyDate`/`keyDateTier` flags.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed request/response schemas and the full data flow.

---

## Tests

```bash
npm test                                          # all suites
npx jest __tests__/coinSearch.relevance.test.js    # denomination relevance only
npx jest __tests__/coinSearch.ebayKeywords.test.js # eBay keyword quality only
npx jest __tests__/marketAggregator.test.js        # market matrix aggregator
npx jest __tests__/marketRoute.test.js             # market route integration
```

### Test Metrics & Monitoring

```bash
npm run test:metrics    # run tests + append metrics to .test-metrics/test-runs.jsonl
npm run test:summary    # print failure frequency, flaky tests, duration trends, slowest tests
```

The **Test Monitor** system records per-run metrics (timestamp, branch, commit, pass/fail counts, slowest files/tests, flake hints) to a JSONL log. The summary script surfaces:

- **Failure frequency** — tests ranked by how often they fail
- **Flaky test detection** — tests that pass and fail across runs
- **Duration trends** — avg/min/max over recent runs
- **Slowest tests** — tests exceeding the 500 ms budget
- **New failures** — tests that broke since the last green run

A Copilot agent persona (`.github/agents/test-monitor.agent.md`) can be invoked to diagnose failures, quarantine flaky tests, and suggest fixes. See [docs/testing/test-monitor.md](docs/testing/test-monitor.md) for full usage.

Runs **Jest** across 40 test suites:

| Suite | What it covers |
|---|---|
| `metalsSpotPrice.test.js` | Spot price service: TTL cache, round-robin rotation, fallback, error propagation, concurrency dedup |
| `halfDollarSeries.test.js` | Half Dollar design resolver: all 8 eras, overrides (Bicentennial, Semiquincentennial), composition |
| `coinSearch.relevance.test.js` | Denomination relevance: parseDescription, buildKeywords, scoreMatch, no cross-denomination contamination |
| `coinSearch.ebayKeywords.test.js` | eBay keyword quality: series fallback, weight injection, grade/designation pass-through |
| `coinSearch.fieldValidation.test.js` | Field shapes: required fields present & well-typed; regression guards |
| `marketAggregator.test.js` | Market matrix: extractYear/Mint/Grade helpers, median/BIN/key-date logic, caching |
| `marketRoute.test.js` | Route integration: 400/200/500 response shapes, parameter pass-through |
| `applyFilters.test.js` | Deny-list filtering, denomination detection, series conflict checking |
| `applyFiltersRegression.test.js` | Regression tests for filter edge cases |
| `cache.test.js` | TTLCache: get/set/eviction, JSON persistence, TTL expiry |
| `computeValuation.test.js` | FMV computation: weighting, outlier removal, confidence scoring |
| `constants.test.js` | Zodiac cycle, Perth Lunar series helpers |
| `gradeHandling.test.js` | Grade parsing, normalization, comparison logic |
| `keyDateCoverage.test.js` | Key date coverage across all series |
| `keyDates.test.js` | Key date / semi-key detection |
| `meltValue.test.js` | Melt value calculation for silver/gold coins |
| `mintSetFilters.test.js` | Proof/mint set filtering logic |
| `numistaService.test.js` | Numista API integration: search, type details, mintages, rarity, lookupCoin pipeline |
| `pcgsBullion.test.js` | PCGS bullion coin handling |
| `pricingBatchRoute.test.js` | Batch pricing endpoint integration |
| `responseValidator.test.js` | Response schema validation, numeric sanity, FMV reasonability |
| `rollSearch.test.js` | Roll search keyword generation |
| `seriesIntegrity.test.js` | Series data integrity across reference tables |
| `stats.test.js` | Statistical functions: median, MAD, weighted median |
| `terapeakFuzzyMatch.test.js` | Terapeak fuzzy comp matching |
| `terapeakQuotaService.test.js` | Terapeak daily quota tracking, reset, threshold warnings |
| `excelImport.test.js` | Excel mapper + route: header normalization, series aliases, year/mint parsing, error handling |
| `storage.costPer.test.js` | Cost basis: addCoin/updateCostPer validation, export/import round-trip, costPer sanitization |
| `priceRoute.test.js` | Price route integration: validation, label allowlist, proof detection, cert routing, bullion defaults, rolls, error handling |
| `pcgsService.test.js` | PCGS service: lookupByCert, lookupByCoinNumberAndGrade, resolveFromDescription, _mapResponse |
| `greysheetService.test.js` | Greysheet CDN API V2: fetchPriceByPcgsNumber, fetchPriceByGsid, fetchCollectible, caching, retry, CAC filtering |
| `ebayFetchSoldComps.test.js` | eBay orchestrator: Terapeak tier, Finding API, Browse fallback, caching, scoring, buildKeywords, classifyGradeType, detectWeightFromTitle, dedup |
| `filters.test.js` | Deny-list patterns, `isDenied()`, `detectDenomMismatch()` edge cases |
| `greysheetTypeMap.test.js` | Greysheet type-map series resolution, PCGS-to-GSID mapping |
| `imageProxyRoute.test.js` | SSRF prevention: allowlist enforcement, non-image rejection, size limits, upstream error forwarding |
| `mintages.test.js` | Mintage lookups: normalizeSeries, BU/proof routing, fractional weight (Gold Eagle 1/2, 1/4, 1/10 oz), BU/proof isolation |
| `terapeakService.test.js` | Terapeak CSV import: parseCSV, importComps, evictStaleComps, autoImportFolder, normalizeSearchKey, mapColumn, rowToComp |
| `bulkEvaluateService.test.js` | Lot evaluator engine: sizeDiscount tiers, confidencePenalty, concentrationPenalty, computeLotSummary, constants |
| `bulkEvaluateRoute.test.js` | Bulk-evaluate route: parseTextInput, parseJsonInput, POST validation, poll 404 handling |

Test helpers live in `__tests__/helpers/coinTestConstants.js` (shared token lists, normalization, compound-word-aware `containsNone`).

---

## Project Structure

```
server.js                          Express entry point
public/index.html                  Single-page frontend (dark theme)
src/
  routes/
    priceRoute.js                  POST /api/price -- coin pricing orchestrator
    barPriceRoute.js               POST /api/bar-price -- bullion bar pricing
    metalsRoute.js                 GET /api/metals -- spot price endpoints
    coinVariantRoute.js            GET /api/coin-variant -- design series resolver
    marketRoute.js                 GET /api/market/ebay -- year x mint market matrix
    coinHistoryRoute.js            GET /api/coin-history -- sold-price time-series
    excelImportRoute.js            POST /api/import/excel -- Excel spreadsheet import
    imageProxyRoute.js             GET /api/image-proxy -- proxied coin images
    pricingBatchRoute.js           POST /api/pricing-batch -- batch coin pricing
    bulkEvaluateRoute.js            POST /api/bulk-evaluate + SSE streaming (lot evaluator)
    terapeakRoute.js               /api/terapeak/* -- Terapeak data & quota management
    authRoute.js                   /api/auth/* -- signup, login, change-password (bcrypt + JWT)
    coinRoute.js                   /api/coins/* -- collection CRUD (requires Bearer JWT)
  services/
    pcgsService.js                 PCGS CoinFacts API integration + parser
    ebayService.js                 eBay sold comps (3-tier API cascade)
    valuationService.js            FMV computation + buy/sell decisions
    bulkEvaluateService.js          Bulk lot evaluator engine (per-coin FMV + lot summary)
    greysheetService.js            Greysheet CDN Public API V2 (wholesale pricing)
    metalsSpotPrice.js             Multi-provider spot price with round-robin
    MetalsSpotPriceError.js        Custom error class for metals failures
    metalsHistoryService.js        Daily spot price history snapshots
    marketAggregator.js            Year×mint market matrix builder + caching
    numistaService.js              Numista API — search, mintages, rarity
    terapeakService.js             Terapeak CSV import, lookup, eviction
    terapeakQuotaService.js        Daily Terapeak query quota tracker
    authService.js                 Server-side auth (bcrypt + JWT, dual-mode Cosmos + local JSON)
    coinStorageService.js          Server-side coin CRUD (dual-mode Cosmos + local JSON)
  data/
    halfDollarSeries.js            Half Dollar design eras + year-based resolver
    pcgsNumbers.js                 PCGS coin number lookup table (10 US series)
    keyDates.js                    Key date / semi-key detection
    mintages.js                    Static mintage reference data
    constants.js                   Zodiac cycle, Perth Lunar series helpers
    lunarReference.js              Lunar series cross-mint comparison
  utils/
    cache.js                       TTLCache with optional JSON file persistence
    stats.js                       Statistical functions (median, MAD, weighted median)
    coinMetalProfile.js            Metal detection for bullion/silver/gold coins
    filters.js                     Deny-list filtering, denomination & series checks
    responseValidator.js           /api/price response schema & sanity validation
    excelMapper.js                 Excel-to-backup converter (header aliases, series normalization)
    cachePath.js                   Centralized CACHE_DIR from env var
    cosmosClient.js                Azure Cosmos DB client singleton (env-var gated)
    blobClient.js                  Azure Blob Storage client (env-var gated, managed identity)
  greysheet/
    greysheetTypeMap.js            Series-to-GSID mapping for Greysheet API lookups
cache/
  ebay_cache.json                  Persisted eBay comp cache (1-hour TTL)
  pcgs_cache.json                  Persisted PCGS data cache (24-hour TTL)
  metals_spot.json                 Persisted metals spot prices (stale fallback)
  metals_history.json              Daily spot price snapshots
  terapeak_sold.json               Imported Terapeak comp data
  numista_cache.json               Persisted Numista data cache (24-hour TTL)
  users.json                       Server-side user accounts (bcrypt hashes)
  user_coins.json                  Server-side coin collections (plaintext JSON)
  greysheet_history.json           Daily Greysheet price snapshots
data/
  terapeak/                        Drop Terapeak CSV exports here for auto-import
public/
  index.html                       SPA frontend (dark theme, 8 tabs)
  js/
    auth.js                        CoinAuth -- server-backed signup/login/logout (JWT in memory)
    storage.js                     CoinStorage -- server-backed coin CRUD via /api/coins/*
    my-coins.js                    MyCoins -- portfolio rendering with parallel pricing
    test-my-coins.js               Client-side test harness for CoinStorage
  test-my-coins.html               Test runner page for storage/crypto tests
samples/
  test-collection.xlsx             Sample Excel import fixture
  no-collectors-sheet.xlsx         Error-case fixture (missing sheet)
__tests__/                         38 Jest test suites (see Tests section)
  helpers/
    coinTestConstants.js           Shared token lists & test utilities
docs/
  ARCHITECTURE.md                  Technical architecture reference
  testing/
    test-monitor.md                Test Monitor usage guide & command reference
.github/
  agents/
    test-monitor.agent.md          Copilot agent persona for test health monitoring
  copilot-instructions.md          Workspace-wide Copilot rules (testing, safety, conventions)
  workflows/
    main_coinpricefinder-*.yml     CI/CD: GitHub Actions OIDC → Azure App Service
scripts/
  terapeak-export.py               Semi-automated Terapeak CSV exporter (Playwright)
  terapeak-page2.py                Page 2 enrichment scraper (extends CSVs beyond 50 rows)
  clean-csvs.js                    CSV junk cleaner (deny-pattern purge across all CSVs)
  migrate-to-cosmos.js             One-time migration of history data to Azure Cosmos DB
  upload-csvs-to-blob.js           Upload Terapeak CSVs to Azure Blob Storage
  vnc-login.py                     VNC + eBay login helper for Playwright sessions
  seedFromEbay.js                  Bulk seed from Finding API (dead -- API decommissioned)
  test-metrics/
    run-with-metrics.cjs           Jest wrapper — captures metrics to JSONL
    summarize.cjs                  Summary reporter — failures, flakes, trends
.test-metrics/                     JSONL test-run logs (git-ignored)
```

---

## Recent Changes

### Scoring & Filtering Accuracy

- **Grade-type pool split** -- `classifyGradeType()` in `ebayService.js` separates eBay comps into graded vs raw pools. If the user specifies a grade, the valuation engine prefers graded comps; if no grade, it prefers raw. Falls back to all comps if the preferred pool has fewer than 3 entries. The `gradePool` field in the response shows which pool was used and counts for each.
- **Grade-number mismatch penalty** -- `scoreMatch()` now extracts numeric grades from comp titles (e.g. MS63, PF69) and penalizes comps whose grade differs from the search target (-20 to -40 points based on distance). Previously an MS63 comp could score 95 ("exact") against an MS65 search.
- **Grade-number hard filter** -- `applyFilters()` drops comps whose title explicitly states a different grade number than the expected grade. Comps with no grade stated are kept (benefit of the doubt).
- **Browse fallback restriction** -- Browse API active listings now only trigger when there are zero sold comps. Previously, partial Terapeak sold data (e.g. 5 of 8 needed) would be discarded in favor of active listings.

### Batch Pricing Parity

- **Enriched `pricingBatchRoute` expected object** -- now detects and passes `isProof`, `finish`, `isRoll`, `isSet`, `setType`, and `_rawQuery` to `fetchSoldComps()`, matching the main `/api/price` route. Proof/roll/set filtering now works correctly for My Coins batch pricing.

### Security & Hardening

- **Label allowlist** -- `priceRoute` validates `coinData.label` against a server-side `ALLOWED_LABELS` Set before using it in keyword building or the expected object.
- **Excel magic-byte check** -- upload endpoint verifies ZIP/PK header before parsing.
- **Sanitized Excel error messages** -- parse errors are logged server-side; client receives a generic message.
- **Removed query-param API key** -- `requireAdmin` only reads `x-api-key` header.
- **XSS hardening** -- switched `_esc()` to `_escAttr()` for HTML attribute contexts (alt, title, data-key, onclick).
- **Dedicated upload rate limiter** -- Excel import uses its own 5 req/min limiter instead of the shared API limiter.
- **Aria-labelledby** on confirm dialog for screen readers.

### Performance

- **Event delegation** -- My Coins tab wires a single set of delegated handlers on `init()` that survive re-renders, replacing per-element binding after every `_renderTable()` call.
- **Batch pricing** -- My Coins now uses `POST /api/pricing-batch` (chunks of 25) instead of individual `/api/price` calls per coin.
- **Spot price cache** -- 5-minute TTL cache prevents redundant `/api/metals` calls across re-renders.
- **Import hash prefetch** -- `importJSON()` prefetches all existing coin hashes into a `Set` for O(1) duplicate checks instead of per-coin IDB queries.

### Data Fixes

- **Proof mintage fallback** -- `lookupMintage()` returns `{ mintage: null }` when proof finish is requested but no proof table exists, instead of falling through to the BU mintage table.
- **`EBAY_DEFAULT_LOOKBACK_DAYS`** env var documented (default: 180, auto-extends to 365 if too few comps).

### Terapeak Data Pipeline

The project includes ~1,200 Terapeak CSV files in `data/terapeak/` containing real sold-comp data scraped from eBay Seller Hub Research. The data pipeline has three stages:

**Stage 1: Page 1 Scraping** -- `scripts/terapeak-export.py` uses Playwright to automate Terapeak searches and CSV downloads. It loops through all coin search terms, exports 50 rows per coin, and uploads CSVs directly to Azure Blob Storage via the Azure SDK (`upload_to_blob()`), falling back to HTTP POST to the local server if blob credentials are unavailable. Features: `--login` for manual eBay cookie capture, `--run` for headless batch execution, `--batch N` for safe incremental scraping, `--priority` for thin-data-first ordering, `--resume` to continue after interruption, browser recycling every 40 coins, and auto-recovery from crashes (up to 5). Requires VNC (Xtigervnc :1), Python 3.12+, and Playwright.

**Stage 2: Page 2 Enrichment** -- `scripts/terapeak-page2.py` extends existing CSVs beyond 50 rows by navigating to page 2 of Terapeak results. It identifies candidate coins (exactly 50 rows = likely truncated), clicks the Next pagination button, scrapes additional rows, and appends them with composite-key deduplication (itemId|soldDate|soldPrice). Enrichment brought many coins from 50 to 95--100 rows.

**Stage 3: CSV Cleanup** -- `scripts/clean-csvs.js` purges junk rows (stamps, sports cards, trading cards, toys, media) that contaminated CSV files due to generic search terms. Uses `isDenied()` from `src/utils/filters.js` plus extended deny patterns. Run with `--dry-run` to preview or `--run` to rewrite files in place. Initial cleanup removed 4,050 junk rows across 427 of 650 files.

**Auto-import** -- on server startup, `terapeakService.autoImportFolder()` scans `data/terapeak/*.csv` and imports any files newer than 7 days. If `TERAPEAK_BLOB_ACCOUNT` + `TERAPEAK_BLOB_CONTAINER` are set, `autoImportFromBlob()` reads CSVs from Azure Blob Storage first, then falls back to local folder. A 30-minute periodic timer re-polls blob storage for new uploads (configurable via `BLOB_REIMPORT_MS`), and `POST /api/terapeak/reimport` provides an admin endpoint for manual triggers. When new data is imported, the eBay comp cache is automatically cleared. The server currently loads ~1,218 datasets with ~68,000 total comps.

**Search term quality matters** -- generic terms like "US Mint Set" capture unrelated items (stamps, cards). Better terms include the full coin name (e.g. "2005 US Mint Uncirculated Coin Set" instead of "2005 US Mint Set"). Some mint set CSVs are thin after cleanup and need re-scraping with improved terms.

- **Finding API decommissioned** -- eBay shut down the Finding API on February 4, 2025. `seedFromEbay.js` and the auto-seed bridge in `ebayService.js` are dead code.

### Stale Encryption Cleanup (#105)

- **Removed stale client-side encryption references** -- the old IndexedDB + WebCrypto architecture was replaced by server-side storage, but ~8 stale remnants remained in the codebase. Cleaned up: misleading "encrypted locally in your browser" UI text, dead `reEncryptAll()` code path, `'Encrypting...'` button text during password change, stale `_key` params accepted but ignored in storage.js methods, and outdated JSDoc comments in coinStorageService.js. All user-facing text now consistently describes server-side plaintext storage.

### Scraper Blob Upload & Auto-Reimport (#106, #107)

- **Direct blob upload from scrapers** (#106) -- `terapeak-export.py` now uploads CSVs directly to Azure Blob Storage via the Azure SDK (`upload_to_blob()` using `DefaultAzureCredential`), bypassing the HTTP server. Falls back to `POST /api/terapeak/import` when blob credentials are unavailable. `terapeak-page2.py` inherits the same upload logic.
- **Periodic blob re-import** (#107) -- server.js runs a 30-minute timer that polls `autoImportFromBlob()` for new CSV uploads. `POST /api/terapeak/reimport` admin endpoint provides manual trigger (supports `force=true` to reimport all, not just new files). eBay comp cache is automatically cleared when new data is imported. Configurable via `BLOB_REIMPORT_MS` env var.

### Bulk Lot Evaluator (#108)

- **Lot evaluator tab** -- new "Lot Evaluator" tab in the UI for bulk collection pricing. Accepts text (one coin per line, pipe-delimited fields like `query | qty=N | grade=X`), JSON array paste, or Excel upload.
- **SSE streaming** -- `POST /api/bulk-evaluate` creates a job and returns a `jobId`. Clients connect to `GET /api/bulk-evaluate/:jobId/stream` for real-time Server-Sent Events: `coin` (per-result), `summary` (lot analysis), `done`, `error`. Late-connecting clients get replay of already-completed results.
- **Per-coin evaluation** -- each coin goes through the full pricing pipeline: PCGS resolve, metal profile detection, spot price lookup, eBay sold comps (1 page, 90 days), Greysheet type/number lookup, and FMV computation.
- **Lot pricing formula** -- size discount (0--20% based on coin count), confidence penalty (5% if avg < 60), concentration penalty (3% if any single coin > 50% of lot value). Three buy tiers: cherry-pick (55--65%), fair lot (70--80%), full retail (85--90% minus fees).
- **Concurrency** -- 10 coins evaluated in parallel per job, max 3 concurrent jobs server-wide. 500-coin limit per job.
- **Caching** -- 1-hour TTL cache keyed by SHA-256 hash of the input array. Identical re-submissions return cached results instantly.
- **Poll endpoint** -- `GET /api/bulk-evaluate/:jobId` returns job status and all completed results for clients that can't use SSE.
- **Export** -- CSV and JSON export buttons in the UI download full per-coin results plus lot summary.

### Greysheet API Integration

- **CDN Public API V2** -- `greysheetService.js` fetches wholesale pricing (GreyVal), retail (CPG), PCGS, NGC, and Blue Book values by PCGS coin number. Requires a Greysheet Dealer+ subscription and API credentials (`GREYSHEET_API_TOKEN`, `GREYSHEET_API_KEY`).
- **FMV blend updated** -- Greysheet wholesale is now the 4th data source at 20% weight. Certified blend: eBay 55% + PCGS Guide 15% + Auction 10% + Greysheet 20%. Raw blend: eBay 70% + PCGS 10% + Greysheet 20%. Weights renormalize automatically when Greysheet is unavailable.
- **Confidence boost** -- Greysheet data adds +5 confidence points to the valuation score.
- **Response enrichment** -- `/api/price` and `/api/pricing-batch` responses include a `greysheet` object with GSID, wholesale/retail values, and all five pricing sources.
- **Proof/finish support** (#109) -- `greysheetTypeMap.js` now stores Proof GSIDs alongside MS entries (73 total: 55 MS + 18 Proof). `_detectFinish(text)` identifies proof, reverse proof, burnished, and satin finishes from query text. `lookupTypeGsid()` is finish-aware: when a proof finish is detected, it tries `series|proof` keys first and falls back to MS. The `finish` hint is passed through from `priceRoute.js` to `fetchTypePrice()`.

### Azure Infrastructure

- **Key Vault** (#97) -- All 9 API secrets moved to `coinpricefinder-kv`. App Service reads them via `@Microsoft.KeyVault(SecretUri=...)` references. Managed identity (`0a61d4ad-36de-4b31-860a-eaaf4b3c86b7`) has Key Vault Secrets User role. No application code changes needed.
- **Cosmos DB** (#98) -- `coinpricefinder-cosmos` (serverless) with database `coinprice` and 5 containers: `users`, `user-coins`, `terapeak-sold`, `greysheet-history`, `metals-history`. Dual-mode write-through: all writes go to both local JSON and Cosmos. `src/utils/cosmosClient.js` provides a singleton gated by `COSMOS_ENDPOINT` env var. Migration script: `scripts/migrate-to-cosmos.js` (history data only -- no synthetic Terapeak or user data).
- **Blob Storage** (#99) -- `terapeak-csvs` container on `coinpricecache01`. `src/utils/blobClient.js` uses `DefaultAzureCredential` (managed identity in prod, `az login` locally). `autoImportFromBlob()` in terapeakService reads CSVs from blob first, local folder second. Upload script: `scripts/upload-csvs-to-blob.js`.
- **Azure Files** (#95) -- Storage account `coinpricecache01`, share `appcache` (1 GB) mounted at `/mnt/cache`. `CACHE_DIR=/mnt/cache` on App Service. `src/utils/cachePath.js` centralizes the path.

### Valuation Enhancements

- **Low-data indicator** (#40) -- When `soldCount < 5`, the response includes `lowData: true` and `compCount`. UI shows a red warning: "Low confidence -- only N sold comps."
- **Greysheet liquidity spread** (#54) -- `computeConfidence()` now factors in the wholesale-to-retail spread: tight spread (<=15%) adds +5 confidence, wide spread (>=40%) subtracts -5. Response includes `greysheetSpread: { spreadPct, liquidity, wholesale, retail }`. UI shows a color-coded chip (green/yellow/red).
- **Adjacent-year context** (#41) -- `buildAdjacentYearContext()` in priceRoute queries Terapeak for the same series +/- 2 years when `soldCount < 5`. Returns `adjacentYears: [{ year, median, compCount }]`. Displayed in both bar and coin UI paths as informational chips (not blended into FMV).
- **Image proxy SSRF fix** (#35) -- Fixed a bug where the 2 MB size limit handler called `upstream.destroy()` but never called `res.end()`, causing connection hang. Exposed `_allowedHosts` for testing.

---

## License

ISC
