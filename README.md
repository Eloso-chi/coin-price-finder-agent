# Coin Price Discovery Agent

A dealer-oriented pricing tool that calculates **Fair Market Value (FMV)** for US coins and bullion bars by combining PCGS catalog data, eBay sold-comp analysis, and Terapeak market data. It produces buy/sell recommendations with confidence scores — designed for quick, data-backed decisions at a coin show or behind a counter.

## What It Does

1. **Identifies the coin** — accepts a PCGS cert number, barcode, PCGS coin number, or free-text description (e.g. "1881-CC Morgan dollar MS 64").
2. **Enriches via PCGS** — fetches price guide value, population, auction history, mintage, and reference images from the PCGS CoinFacts API.
3. **Pulls eBay sold comps** — queries up to three eBay APIs (Marketplace Insights → Finding → Browse) to collect recent sold prices, then scores and filters them for relevance.
4. **Supplements with Terapeak data** — imports Terapeak CSV exports (manual upload or auto-import from `data/terapeak/`) for additional sold-comp coverage with daily quota tracking.
5. **Computes FMV** — blends PCGS and eBay data using a weighted median with outlier removal, producing a confidence-scored valuation.
6. **Generates buy/sell decisions** — outputs max-buy thresholds (70/75/80% of FMV) and sell tiers (fast/normal/premium) with a recommendation.
7. **Batch pricing** — prices up to 25 coins in a single request.
8. **Price history charting** — returns time-series sold-price data with optional spot-price metal overlay.
9. **Live metals tracking** — background polling (every 30 min) with round-robin across providers, plus daily history snapshots.
10. **Market matrix** — year × mint grid of median completed prices and cheapest BIN listings, enriched with Numista rarity data.

Also supports **bullion bars** (any metal, any size), **proof/mint sets**, **rolls**, and **lunar series** with dedicated input flows and eBay keyword strategies.

---

## Frontend — Web UI

The browser UI is a single-page app served from `public/index.html` with a dark theme and seven tabbed panels. All client-side JavaScript is split across four modules loaded in order: `crypto.js` → `auth.js` → `storage.js` → `my-coins.js`.

### Tabs

| Tab | Description |
|-----|-------------|
| **Price Discovery** | Main search — two sub-modes: Coin (structured or quick-search entry) and Bar/Bullion. Submits to `/api/price` or `/api/bar-price`. Renders FMV hero card with image gallery, confidence score, buy/sell decisions, metadata chips, eBay stats, comp list, and raw JSON. |
| **Melt Calculator** | Offline calculator for 80+ US coin types and 20 bar sizes. Auto-fetches spot prices from `/api/metals` and polls every 5 minutes. Shows per-coin, per-roll, and total melt values at spot and spot+premium. |
| **Live eBay Tracker** | Market matrix from `/api/market/ebay`. Three display modes: Year × Mint (numismatic coins), Year × Grade (bullion), and Brand table (bars). Cells show median sold price, cheapest BIN link, key date badge, and Numista rarity. Color-coded legend. |
| **Sold Data** | Terapeak CSV import UI (drag-and-drop or file picker) with search term input. Datasets list with delete. Visual daily quota meter (250/day default) with manual logging and reset. Admin endpoints require `x-api-key`. |
| **My Coins** 🔒 | Auth-gated. Encrypted coin collection stored in IndexedDB. Shows portfolio summary (total FMV, coin count) and table with per-coin FMV, confidence, range, eBay average, date added, and remove button. Export/Import backup buttons and Change Password. |
| **Price History** 🔒 | Auth-gated. Canvas-drawn chart from `/api/coin-history`. Shows daily median prices with IQR band, outlier dots, and optional precious-metal spot overlay (dashed line). Supports 90/180/365-day ranges. |
| **About** | Confidence score key, privacy/security explanation, how login works, feature previews for logged-out users, and legal disclaimer. |

### Zero-Knowledge Auth System

The authentication system is **entirely client-side** — the server has zero knowledge of accounts, passwords, or collection data.

- **Signup** — generates a UUID user ID, derives an AES-256-GCM encryption key from username + password via PBKDF2 (600,000 iterations, SHA-256), encrypts a known plaintext as a password verifier, and stores `{userId, salt, verifier}` in `localStorage`.
- **Login** — re-derives the key from the stored salt and checks the verifier. The `CryptoKey` lives only in memory.
- **Page reload** — the in-memory key is lost. The UI detects the stale session via `pendingReauth()` and auto-opens the login dialog pre-filled with the username.
- **Password change** — derives a new key with a fresh salt, updates the verifier, and re-encrypts all coins in IndexedDB via `CoinStorage.reEncryptAll()`.

No passwords, keys, or collection data ever leave the browser. The server cannot read, access, or reconstruct any user data.

### Encrypted Coin Storage

- **Database:** IndexedDB database `CoinVault`, object store `inventory`, composite key `[userId, coinHash]`.
- **Per-coin encryption:** Each coin record is JSON-serialized and encrypted with AES-256-GCM using a random 12-byte IV. Only the encrypted ciphertext + IV are stored.
- **Deduplication:** Coins are hashed by `SHA-256(series|year|mint|grade)` to prevent duplicates.
- **"I Have This Coin" button:** Appears in Price Discovery results. If logged in, adds the coin to the encrypted collection with one click. If logged out, shows a lock icon that opens the login dialog.

### Export & Import Backup

- **Export** — decrypts all coins and downloads a **plaintext JSON** file (`coin-collection-backup-YYYY-MM-DD.json`). The export contains `{format, exportedAt, count, coins[]}` with each coin's series, year, mint, grade, weight, query, and dateAdded. No encryption in the file — it's a portable backup.
- **Import** — reads the JSON backup, validates the `coin-price-agent-backup-v1` format header, and re-encrypts each coin under the current user's key. Skips duplicates (by coinHash). Works across accounts — if a user loses their login and creates a new account, they can import a previous backup into the new account.

### Backup Reminder

The `BackupReminder` module (in `storage.js`) tracks coin additions and time since last backup in `localStorage`. It shows a yellow banner in the My Coins tab prompting the user to export:

| Trigger | Message |
|---------|---------|
| First coin ever added | "You added your first coin! Export a backup so you never lose your collection." |
| 10+ coins added since last backup | "You've added several coins since your last backup. Time to save a copy!" |
| 30+ days since last backup | "It's been a while since your last backup. Export one to stay safe." |

Dismissing snoozes the prompt for 7 days. Exporting resets all counters.

### Auth-Gated Tabs

The My Coins and Price History tabs are locked for logged-out users:

- Tab buttons show a 🔒 lock icon and muted styling.
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
| `NUMISTA_API_KEY` | Numista API key for rarity/mintage data | *(none)* |
| `ADMIN_API_KEY` | API key for admin/destructive endpoints | *(none — endpoints locked)* |
| `PORT` | Server port | `3000` |
| `EBAY_CACHE_TTL_MS` | eBay cache lifetime | `3600000` (1 hour) |
| `EBAY_US_MIN_COMPS` | Minimum US comps before global fallback | `8` |
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

Fair Market Value is a blended estimate from up to three data sources:

| Source | Weight (Certified) | Weight (Raw) |
|--------|-------------------|--------------|
| eBay Sold Comps | 65% | 80% |
| PCGS Price Guide | 25% | 20% |
| PCGS Auction History | 10% | — |

If a source is unavailable, weights are renormalized among the remaining sources.

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
| Auction data available | +5 |
| 20+ comps bonus | +10–15 |
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
| `GET` | `/api/coin-variant` | Design-series metadata for a denomination + year |
| `GET` | `/api/coin-history` | Sold-price time-series (daily medians) with optional spot overlay |

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

🔒 = requires `ADMIN_API_KEY` via `x-api-key` header or `apiKey` query param.

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

Runs **Jest** across 26 test suites:

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
| `numistaService.test.js` | Numista API integration: search, type details, mintages, rarity |
| `pcgsBullion.test.js` | PCGS bullion coin handling |
| `pricingBatchRoute.test.js` | Batch pricing endpoint integration |
| `responseValidator.test.js` | Response schema validation, numeric sanity, FMV reasonability |
| `rollSearch.test.js` | Roll search keyword generation |
| `seriesIntegrity.test.js` | Series data integrity across reference tables |
| `stats.test.js` | Statistical functions: median, MAD, weighted median |
| `terapeakFuzzyMatch.test.js` | Terapeak fuzzy comp matching |
| `terapeakQuotaService.test.js` | Terapeak daily quota tracking, reset, threshold warnings |

Test helpers live in `__tests__/helpers/coinTestConstants.js` (shared token lists, normalization, compound-word-aware `containsNone`).

---

## Project Structure

```
server.js                          Express entry point
public/index.html                  Single-page frontend (dark theme)
src/
  routes/
    priceRoute.js                  POST /api/price — coin pricing orchestrator
    barPriceRoute.js               POST /api/bar-price — bullion bar pricing
    metalsRoute.js                 GET /api/metals — spot price endpoints
    coinVariantRoute.js            GET /api/coin-variant — design series resolver
    marketRoute.js                 GET /api/market/ebay — year×mint market matrix
    coinHistoryRoute.js            GET /api/coin-history — sold-price time-series
    imageProxyRoute.js             GET /api/image-proxy — proxied coin images
    pricingBatchRoute.js           POST /api/pricing-batch — batch coin pricing
    terapeakRoute.js               /api/terapeak/* — Terapeak data & quota management
  services/
    pcgsService.js                 PCGS CoinFacts API integration + parser
    ebayService.js                 eBay sold comps (3-tier API cascade)
    valuationService.js            FMV computation + buy/sell decisions
    metalsSpotPrice.js             Multi-provider spot price with round-robin
    MetalsSpotPriceError.js        Custom error class for metals failures
    metalsHistoryService.js        Daily spot price history snapshots
    marketAggregator.js            Year×mint market matrix builder + caching
    numistaService.js              Numista API — search, mintages, rarity
    terapeakService.js             Terapeak CSV import, lookup, eviction
    terapeakQuotaService.js        Daily Terapeak query quota tracker
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
cache/
  ebay_cache.json                  Persisted eBay comp cache (1-hour TTL)
  pcgs_cache.json                  Persisted PCGS data cache (24-hour TTL)
  metals_spot.json                 Persisted metals spot prices (stale fallback)
  metals_history.json              Daily spot price snapshots
  terapeak_sold.json               Imported Terapeak comp data
  numista_cache.json               Persisted Numista data cache (24-hour TTL)
data/
  terapeak/                        Drop Terapeak CSV exports here for auto-import
public/
  index.html                       SPA frontend (dark theme, 7 tabs)
  js/
    crypto.js                      CoinCrypto — WebCrypto wrapper (PBKDF2 + AES-256-GCM)
    auth.js                        CoinAuth — client-only signup/login/logout/changePassword
    storage.js                     CoinStorage (IndexedDB) + BackupReminder (localStorage)
    my-coins.js                    MyCoins — portfolio rendering with parallel pricing
__tests__/                         26 Jest test suites (see Tests section)
  helpers/
    coinTestConstants.js           Shared token lists & test utilities
docs/
  ARCHITECTURE.md                  Technical architecture reference
.github/workflows/
  main_coinpricefinder-*.yml       CI/CD: GitHub Actions OIDC → Azure App Service
```

---

## License

ISC
