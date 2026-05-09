# Architecture

Technical reference for the Coin Price Discovery Agent. Covers module layout, data flow, caching strategy, and API schemas.

---

## Module Map

```
server.js                              Express entry point (port 3000)
│
├─ src/routes/
│   ├─ priceRoute.js                   POST /api/price  -- coin pricing orchestrator
│   ├─ barPriceRoute.js                POST /api/bar-price -- bullion bar pricing
│   │                                  GET  /api/bar-price/options -- brand/series list for dropdowns
│   ├─ pricingBatchRoute.js            POST /api/pricing-batch -- batch pricing (up to 25)
│   ├─ bulkEvaluateRoute.js            POST /api/bulk-evaluate + SSE streaming (lot evaluator)
│   ├─ metalsRoute.js                  GET /api/metals[/:metal] -- spot prices
│   ├─ marketRoute.js                  GET /api/market/ebay -- year x mint market matrix
│   ├─ coinHistoryRoute.js             GET /api/coin-history -- sold-price time-series
│   ├─ coinVariantRoute.js             GET /api/coin-variant -- design series resolver
│   ├─ excelImportRoute.js             POST /api/import/excel -- Excel spreadsheet import
│   ├─ imageProxyRoute.js              GET /api/image-proxy -- proxied coin images
│   ├─ terapeakRoute.js                /api/terapeak/* -- Terapeak data, quota, aggregation-status
│   ├─ adminRoute.js                   /api/admin/* -- dashboard, stale datasets, data health
│   ├─ authRoute.js                    /api/auth/* -- signup, login, me, change-password
│   └─ coinRoute.js                    /api/coins/* -- collection CRUD (JWT-protected)
│
├─ src/services/
│   ├─ pcgsService.js                  PCGS CoinFacts API (cert, coin#, description)
│   ├─ ebayService.js                  eBay sold comps (3-tier API cascade + grade-type pool split)
│   ├─ valuationService.js             FMV blend + buy/sell decision engine
│   ├─ greysheetService.js             Greysheet CDN Public API V2 (wholesale pricing)
│   ├─ bulkEvaluateService.js           Bulk lot evaluator engine (per-coin FMV + lot summary)
│   ├─ metalsSpotPrice.js              Multi-provider spot price (round-robin)
│   ├─ MetalsSpotPriceError.js         Custom error class
│   ├─ metalsHistoryService.js         Daily spot price history snapshots + getSpotOnDate()
│   ├─ marketAggregator.js             Year x mint market matrix builder + caching
│   ├─ numistaService.js               Numista API -- search, mintages, rarity
│   ├─ terapeakService.js              Terapeak CSV import, fuzzy lookup, eviction, auto-import, aggregationMeta tracking (Cosmos write-through + hydration + git-tracked sidecar)
│   ├─ terapeakQuotaService.js         Daily Terapeak query quota tracker
│   ├─ adminService.js                 Admin dashboard aggregation (stats, stale detection, data health)
│   ├─ greysheetHistoryService.js      Daily Greysheet price history snapshots
│   ├─ authService.js                  Server-side auth (bcrypt + JWT, dual-mode Cosmos + local JSON)
│   │                                  JWT_SECRET REQUIRED in production (FATAL throw if unset)
│   └─ coinStorageService.js           Server-side coin CRUD (dual-mode Cosmos + local JSON)
│
├─ src/data/
│   ├─ pcgsNumbers.js                  Static PCGS coin number lookup (10 US series)
│   ├─ keyDates.js                     Key date / semi-key detection tables
│   ├─ mintages.js                     Mintage reference data by series/year/mint
│   ├─ halfDollarSeries.js             Half Dollar design eras + year-based resolver
│   ├─ constants.js                    Zodiac cycle + Perth Lunar series helpers
│   ├─ barSeries.js                    Bar brand/series data (7 brands, 40+ series) + detection helpers
│   └─ lunarReference.js               Perth / Royal / RAMint lunar comparison
│
├─ src/utils/
│   ├─ cache.js                        TTLCache class (in-memory + optional file persistence)
│   ├─ stats.js                        Statistical functions (median, MAD, weighted median, etc.)
│   ├─ filters.js                      Deny-list filtering, denomination & series checks
│   ├─ coinMetalProfile.js             Metal detection for bullion/silver/gold coins
│   ├─ responseValidator.js            /api/price response schema & sanity validation
│   ├─ excelMapper.js                  Excel-to-backup converter (header aliases, series normalization)
│   ├─ cachePath.js                    Centralized CACHE_DIR from env var
│   ├─ cosmosClient.js                 Azure Cosmos DB client singleton (env-var gated)
│   └─ blobClient.js                   Azure Blob Storage client (managed identity)
│
├─ src/greysheet/
│   └─ greysheetTypeMap.js             Series-to-GSID mapping (55 MS + 18 Proof) + finish detection
│
├─ public/
│   ├─ index.html                      SPA frontend (dark theme, 9 tabs)
│   └─ js/
│       ├─ auth.js                     CoinAuth -- server-backed login/signup (JWT in memory)
│       ├─ storage.js                  CoinStorage -- server-backed coin CRUD via /api/coins/*
│       └─ my-coins.js                 MyCoins -- portfolio rendering with batch pricing
│
├─ cache/
│   ├─ ebay_cache.json                 Persisted eBay comp cache (1h TTL)
│   ├─ pcgs_cache.json                 Persisted PCGS data cache (24h TTL)
│   ├─ greysheet_cache.json            Persisted Greysheet pricing cache (24h TTL)
│   ├─ numista_cache.json              Persisted Numista data cache (24h TTL)
│   ├─ metals_spot.json                Persisted metals spot prices (stale fallback)
│   ├─ metals_history.json             Daily spot price snapshots
│   ├─ greysheet_history.json          Daily Greysheet price snapshots
│   ├─ terapeak_sold.json              Imported Terapeak comp data (~2,326 datasets, ~119K comps)
│   ├─ users.json                      Server-side user accounts (bcrypt hashes + UUIDs)
│   └─ user_coins.json                 Server-side coin collections (plaintext JSON by userId)
│
├─ data/
│   ├─ terapeak/                       ~2,700+ Terapeak CSV exports (real sold data)
│   └─ terapeak-meta.json              Git-tracked aggregation metadata sidecar (see below)
│
├─ docs/
│   ├─ ARCHITECTURE.md                 This file -- technical architecture reference
│   ├─ BACKLOG.md                      Canonical backlog (single source of truth)
│   ├─ BACKLOG.rules.md                Backlog governance rules & PR hygiene expectations
│   └─ testing/
│       └─ test-monitor.md             Test Monitor usage guide & command reference
│
├─ scripts/
│   ├─ terapeak-export.py              Semi-automated Terapeak CSV exporter (Playwright + blob upload)
│   ├─ sales-aggregator.py               Sales data aggregator (deep pagination) (extends CSVs beyond 50 rows)
│   ├─ chain-aggregate.sh                 Chain multiple collect batches with anti-bot monitoring
│   ├─ refresh-stale.sh                One-command biweekly stale data refresh
│   ├─ greysheet-refresh.js            Bulk Greysheet price snapshot collector (all PCGS + type GSIDs)
│   ├─ clean-csvs.js                   CSV junk cleaner (deny-pattern purge)
│   ├─ backfill-sale-dates.js          One-time backfill of newestSaleDate/oldestSaleDate/compCount into meta sidecar
│   ├─ migrate-to-cosmos.js            One-time migration of history data to Cosmos DB
│   ├─ upload-csvs-to-blob.js          Upload Terapeak CSVs to Azure Blob Storage
│   ├─ vnc-login.py                    VNC + eBay login helper for Playwright sessions
│   ├─ pricing-health-full.js          Pricing health check runner (--full, --filter, --limit, --concurrency, --out)
│   └─ test-metrics/                   Jest metrics capture + summary reporter
│
└─ __tests__/                          55 Jest test suites
    ├─ fixtures/
    │   └─ golden_coins.json           Curated golden set (14 deterministic test coins)
    └─ helpers/
        └─ coinTestConstants.js        Shared token lists, PRNG, coin catalog, golden set loader, selectCoins()
```

---

## End-to-End Data Flow

### Coin Pricing — `POST /api/price`

```
Request
  │
  ├── 1. PCGS Identification ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   ├─ Cert number (7–9 digits)  → lookupByCert(certNum)
  │   ├─ coinData.pcgsNumber       → lookupByCoinNumberAndGrade(pcgsNo, gradeNum)
  │   └─ Free-text query           → resolveFromDescription(query)
  │       Resolution cascade:
  │       ① cert regex → lookupByCert
  │       ② /coindetail/Search (by keyword) — if PCGS has endpoint
  │       ③ Static table lookup (pcgsNumbers.js)
  │           → lookupPCGSNumber(series, year, mint)
  │           → lookupByCoinNumberAndGrade(pcgsNo, gradeNo)
  │       ④ parseDescription → build minimal result from text
  │
  ├── 2. eBay Keyword Construction ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   ├─ Proof/mint sets → special labels ("US proof set", "US silver proof set", etc.)
  │   ├─ Lunar coins → append zodiac animal + Perth series number
  │   └─ Standard coins → buildKeywords(pcgs, rawQuery, weight)
  │
  ├── 3. eBay Sold Comps ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   fetchSoldComps(keywords, opts, expected)
  │   ├─ Tier 0: Terapeak local store (terapeakService.lookupComps)
  │   │   Fuzzy-matches imported CSV data; no API call needed
  │   │   If enough comps found → skip live API tiers entirely
  │   │
  │   ├─ US query (EBAY-US) ─┐
  │   │                      │  Each query runs the 3-tier API cascade:
  │   │   ① Marketplace Insights API (sold data, best quality)
  │   │   ② Finding API (completedItems, sold=true) -- DECOMMISSIONED Feb 2025
  │   │   ③ Browse API (active listings, last resort -- only if zero sold comps)
  │   │                      │
  │   │   Each result → dedup → deny-list filter → metal filter
  │   │   → scoreMatch(item, expected) → sort → limit
  │   │
  │   ├─ Check: US comps >= usMinComps (default 8)?
  │   │   └─ NO → Global query (EBAY-US + international)
  │   │
  │   └─ Return { us: { comps, stats }, global: { ... }, usedFallback }
  │
  ├── 4. Key Date Detection ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   lookupKeyDate(series, year, mint) → { isKeyDate, tier?, note? }
  │
  ├── 5. Greysheet Wholesale Lookup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   greysheetService.fetchPriceByPcgsNumber(pcgsCoinNumber, grade)
  │   ├─ Returns: { greyVal, cpgVal, pcgsVal, ngcVal, blueBookVal, gsid, name }
  │   ├─ Non-fatal: returns null if no credentials or API unavailable
  │   ├─ Cached 24h with file persistence (cache/greysheet_cache.json)
  │   └─ Type fallback (world coins without PCGS numbers):
  │       greysheetService.fetchTypePrice(queryText, { finish })
  │       ├─ greysheetTypeMap.lookupTypeGsid(queryText, hints)
  │       ├─ _detectFinish(text) → proof / reverse proof / burnished / satin / null
  │       ├─ Finish-aware: tries `series|proof` GSID keys first, falls back to MS
  │       └─ 73 total type GSIDs: 55 MS + 18 Proof
  │
  ├── 6. Valuation + Decisions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   computeValuation(pcgs, ebay, askingPrice, userGrade, { greysheet })
  │   ├─ Split comps into graded / proof / raw pools (3-way classification)
  │   ├─ Select pool by user intent (proof > graded > raw)
  │   ├─ Compute weighted median (recency + match score weights)
  │   ├─ Blend: certified (55/15/10/20) or raw (70/10/20) weights
  │   │   eBay + PCGS Guide + Auction + Greysheet wholesale
  │   │   (renormalizes if any source is missing)
  │   ├─ Confidence score (0-100, +5 for Greysheet)
  │   ├─ Range = FMV +/- max(stddev, FMV x 0.05)
  │   ├─ Buy thresholds: 70% / 75% / 80% of FMV
  │   └─ Sell tiers: fast(0.92x) / normal / premium(1.05x or 1.15x) / offerFloor
  │
  ├── 7. Mintage Lookup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   PCGS mintage available? → use it (source: "pcgs")
  │   Else → lookupMintage(series, year, mint, weight) (source: "static")
  │
  ├── 8. Reproducibility Metadata ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   { pcgs: { certNumber, pcgsCoinNumber }, ebay: { timeWindowDays, itemIds } }
  │
  └── 9. Response ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      JSON with: query, identification, pcgs, ebay, greysheet, valuation,
      decisions, keyDate, mintageData, lunarComparison, reproducibility
```

### Bar Pricing — `POST /api/bar-price`

```
Request { metal, size, brand?, series?, year?, condition?, askingPrice? }
  │
  ├── 1. Normalize size (".5 gram" → "0.5 gram", whitespace trim)
  ├── 2. Detect bar series (barSeries.detectBarSeries(brand, series))
  │   └─ Matches against BAR_SERIES registry: series name, aliases, regex
  │      7 brands: Geiger (11), PAMP (22), Perth Mint (5), Scottsdale (3),
  │      Valcambi (1), Heraeus (1), Credit Suisse (2)
  ├── 3. Build eBay keywords (year + brand + series keywords + size + metal + "bar")
  ├── 4. fetchSoldComps with bar-specific scoring:
  │   ├─ Brand match (+20) / mismatch (-25)
  │   ├─ Series match (+10) / mismatch (-15)
  │   ├─ Size match (+15), metal match (+10), bar keyword (+5)
  │   └─ Relevance gate: 45 (brand specified) vs 20 (generic)
  ├── 5. computeValuation with pcgs = { _isBar: true }
  └── Response { keywords, bar, comps stats, valuation, decisions }
```

### Bar Options — `GET /api/bar-price/options`

```
Response { brands: [{ brand, series: [{ name, aliases }] }] }

Returns the full BAR_SERIES registry for frontend dropdowns.
The frontend fetches this on page load, then dynamically populates
the series <select> when the user picks a brand.
```

### Spot Prices — `GET /api/metals`

```
Request (valid metals: XAU, XAG, XPT, XPD)
  │
  ├── getMetalsSpotPrices(metals[], currency)
  │   └── Per metal → getMetalsSpotPrice(metal, currency)
  │       ├── Check in-memory cache → HIT? return
  │       ├── Check in-flight dedup map → already fetching? await
  │       └── Round-robin 3 providers:
  │           ① goldprice-org (no auth, free baseline)
  │           ② goldapi (requires GOLDAPI_KEY)
  │           ③ metals-api (requires METALS_API_KEY)
  │           On failure → rotate to next provider
  │
  └── Response { metals: [{ metal, price, timestamp, source }] }
```

### Bulk Lot Evaluation -- `POST /api/bulk-evaluate`

```
POST { text | items | file(.xlsx) }
  │
  ├── 1. Parse Input ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   ├─ Text: one coin per line, pipe-delimited fields (query | qty=N | grade=X)
  │   ├─ JSON: { items: [{query, qty, grade, year, mintMark, weight, series}] }
  │   └─ Excel: mapExcelToBackup() via excelMapper.js
  │
  ├── 2. Create Job ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   ├─ Validate: 1-500 coins, max 3 concurrent jobs server-wide
  │   ├─ Check result cache (SHA-256 of input array, 1hr TTL)
  │   └─ Return { jobId, coinCount } with 202 status
  │
  ├── 3. SSE Stream (GET /api/bulk-evaluate/:jobId/stream) ━━━━━━━━━
  │   Client connects → receives events as coins complete
  │   Late-connecting clients get replay of already-completed results
  │
  ├── 4. Per-Coin Evaluation (10 parallel) ━━━━━━━━━━━━━━━━━━━━━━━━━
  │   For each coin:
  │   ├─ pcgsService.parseDescription → resolve identity
  │   ├─ getCoinMetalProfile → detect metal/weight/bullion
  │   ├─ getMetalsSpotPrice → live spot for melt calculation
  │   ├─ ebayService.fetchSoldComps (1 page, 90 days)
  │   ├─ greysheetService (PCGS number or type fallback)
  │   ├─ computeValuation → FMV, range, confidence, method
  │   └─ Emit SSE "coin" event with result
  │
  ├── 5. Lot Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   computeLotSummary(results):
  │   ├─ Totals: coinCount, pricedCount, failedCount, totalFmv, totalMelt
  │   ├─ Avg confidence, bullion count/pct
  │   ├─ Discounts: sizeDiscount(0-20%) + confidencePenalty(5%) + concentrationPenalty(3%)
  │   ├─ Concentration flags: coins > 25% of lot value
  │   └─ Buy tiers: cherryPick(55-65%), fairLot(70-80%), fullRetail(85-90% minus fees)
  │
  └── 6. Complete ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      Emit SSE "summary" + "done" events
      Results cached for 1 hour; poll via GET /api/bulk-evaluate/:jobId
```

---

## Request / Response Schemas

### `POST /api/price`

**Request:**

```json
{
  "query": "1881-CC Morgan dollar MS 64",  // required — cert#, description, or barcode
  "askingPrice": 650,                       // optional — dealer's asking price
  "weight": "1 oz",                         // optional — override coin weight
  "coinData": {                             // optional — structured form input
    "pcgsNumber": 7126,
    "name": "Morgan Dollar",
    "year": 1881,
    "mintMark": "CC",
    "grade": "MS 64",
    "weight": "1 oz",
    "setType": null                         // "clad", "silver", "prestige", etc.
  },
  "options": {
    "timeWindowDays": 90,
    "requirePCGSOnly": false,
    "exactGradeOnly": false,
    "usMinComps": 8,
    "maxPages": 3
  }
}
```

**Response** (key fields):

```json
{
  "query": { "input": "...", "askingPrice": 650, "weight": null, "setType": null, "options": {} },
  "identification": { "inputQuery": "...", "resolvedVia": "pcgs-api", "parsed": {} },
  "pcgs": {
    "verified": true,
    "pcgsCoinNumber": 7126,
    "series": "Morgan Dollars 1878-1921",
    "year": 1881,
    "mint": "CC",
    "grade": "MS64",
    "designation": null,
    "priceGuide": { "valueUsd": 900 },
    "population": { "thisGrade": 9515, "higher": 8974 },
    "auction": { "medianUsd": 860, "count": 25 },
    "trueViewUrl": "https://...",
    "coinImages": ["https://..."],
    "mintage": 296000,
    "metalContent": "90% Silver",
    "country": "United States"
  },
  "ebay": {
    "keywords": "1881 CC Morgan dollar MS 64",
    "us": {
      "comps": [{ "title": "...", "totalUsd": 820, "soldDate": "...", "matchScore": 85, "gradeType": "graded", "itemId": "..." }],
      "stats": { "count": 15, "mean": 830.5, "median": 825, "stddev": 42 }
    },
    "global": { "comps": [], "stats": {} },
    "usedFallback": false
  },
  "valuation": {
    "fmvCore": 835.00,
    "rangeLow": 780.00,
    "rangeHigh": 890.00,
    "confidence": 82,
    "explanation": ["Certified coin blend (ebay+pcgs+auction)..."],
    "gradePool": { "wantsGraded": true, "wantsProof": false, "usedPool": "graded", "gradedCount": 12, "rawCount": 3, "proofCount": 0 },
    "lowData": false,
    "compCount": 15,
    "greysheetSpread": { "spreadPct": 12.5, "liquidity": "tight", "wholesale": 800, "retail": 900 },
    "adjacentYears": [
      { "year": 1880, "median": 420, "compCount": 8 },
      { "year": 1882, "median": 395, "compCount": 12 }
    ]
  },
  "decisions": {
    "buy": { "max70": 584.50, "max75": 626.25, "max80": 668.00, "askingPrice": 650, "recommendation": "BUY (thin margin)", "notes": [] },
    "sell": { "fast": 768.20, "normal": 835.00, "premium": 876.75, "offerFloor": 750, "notes": [] }
  },
  "keyDate": { "isKeyDate": true, "tier": "semi-key", "note": "Carson City issue" },
  "mintageData": { "mintage": 296000, "source": "pcgs" },
  "lunarComparison": null,
  "reproducibility": { "pcgs": {}, "ebay": { "timeWindowDays": 90, "usItemIds": [], "globalItemIds": [] } }
}
```

### `POST /api/bar-price`

**Request:**

```json
{
  "metal": "gold",
  "size": "1 oz",
  "brand": "PAMP",
  "series": "Fortuna",
  "year": null,
  "condition": "sealed",
  "askingPrice": 2400,
  "options": { "timeWindowDays": 90 }
}
```

**Response** (key fields):

```json
{
  "bar": { "metal": "gold", "size": "1 oz", "brand": "PAMP", "pureOzt": 1.0 },
  "ebay": {
    "keywords": "PAMP Fortuna 1 oz gold bar",
    "us": { "comps": [...], "stats": { "count": 20, "median": 2350 } }
  },
  "valuation": { "fmvCore": 2360, "confidence": 78, "series": "Fortuna" },
  "decisions": { "buy": { "max70": 1652, "max80": 1888 }, "sell": { "normal": 2360 } }
}
```

### `GET /api/bar-price/options`

**Response:**

```json
{
  "brands": [
    {
      "brand": "pamp",
      "series": [
        { "name": "Fortuna", "aliases": ["lady fortuna"] },
        { "name": "Coca-Cola", "aliases": ["coke", "coca cola"] }
      ]
    }
  ]
}
```

### `GET /api/metals`

**Response:**

```json
{
  "metals": [
    { "metal": "XAU", "price": 2345.67, "timestamp": "2024-01-15T12:00:00Z", "source": "goldprice-org" },
    { "metal": "XAG", "price": 27.43, "timestamp": "2024-01-15T12:00:00Z", "source": "goldprice-org" }
  ]
}
```

### `POST /api/clear-cache`

Clears both eBay and PCGS in-memory and persisted caches. Returns `{ cleared: true }`.

### `GET /api/health`

Returns `{ status: "ok", ... }` with configuration status flags.

---

## Caching Strategy

Three independent caches serve different data characteristics:

### eBay Comp Cache

| Property | Value |
|----------|-------|
| **Class** | `TTLCache` (src/utils/cache.js) |
| **Default TTL** | 1 hour (3,600,000 ms) — configurable via `EBAY_CACHE_TTL_MS` |
| **Persistence** | `cache/ebay_cache.json` (debounced 500 ms writes) |
| **Key pattern** | `ebay:{region}:{keywords}:p{page}` |
| **Why short TTL** | eBay sold prices are recent-sale snapshots that shift daily |
| **Eviction** | Lazy on `get()` (expired entries deleted on access) + `prune()` on `.size` |
| **Clear** | `ebayService.clearCache()` or `POST /api/clear-cache` |

### PCGS Data Cache

| Property | Value |
|----------|-------|
| **Class** | `TTLCache` |
| **Default TTL** | 24 hours (86,400,000 ms) |
| **Persistence** | `cache/pcgs_cache.json` |
| **Key patterns** | `pcgs:cert:{certNumber}`, `pcgs:num:{pcgsNo}:{gradeNo}`, `pcgs:desc:{queryHash}` |
| **Why long TTL** | PCGS reference data (population, price guide) changes infrequently |
| **Clear** | `pcgsService.clearCache()` or `POST /api/clear-cache` |

### Metals Spot Price Cache

| Property | Value |
|----------|-------|
| **Class** | `TTLCache` |
| **Default TTL** | 45 minutes (2,700,000 ms) — configurable via `METALS_CACHE_TTL_MS` |
| **Persistence** | None (in-memory only) |
| **Key pattern** | `{metal}:{currency}` (e.g. `XAU:USD`) |
| **Why 45 min** | Spot prices update throughout the trading day but sub-hourly precision is sufficient for melt calculations |
| **In-flight dedup** | Concurrent requests for the same metal share a single provider fetch |

### Greysheet Price Cache

| Property | Value |
|----------|-------|
| **Class** | `TTLCache` (src/utils/cache.js) |
| **Default TTL** | 24 hours (86,400,000 ms) |
| **Persistence** | `cache/greysheet_cache.json` (debounced writes) |
| **Key patterns** | `gs:pcgs:{pcgsNumber}:{grade}`, `gs:gsid:{gsid}:{grade}`, `gs:collectible:{gsid}` |
| **Why 24h TTL** | Greysheet wholesale prices update weekly; daily cache is conservative |
| **Negative caching** | `null` results are cached to avoid repeated API calls for coins not in the Greysheet catalog |
| **Clear** | `greysheetService._cache.clear()` |

### Bulk Evaluate Result Cache

| Property | Value |
|----------|-------|
| **Class** | In-memory `Map` (bulkEvaluateService.js) |
| **Default TTL** | 1 hour (3,600,000 ms) |
| **Persistence** | None (in-memory only) |
| **Key pattern** | SHA-256 hash of the JSON-serialized input coin array |
| **Why 1h TTL** | Lot evaluations are expensive (many API calls); caching avoids re-pricing identical submissions |
| **Eviction** | Lazy prune on new job submission |

### TTLCache Internals

The `TTLCache` class wraps a `Map` with per-entry expiration:

- **`get(key)`** — returns value if not expired, else deletes and returns `undefined`
- **`set(key, val, ttl?)`** — stores with expiration timestamp; triggers debounced file save
- **`has(key)`** / **`delete(key)`** / **`clear()`** — standard Map-like API
- **`prune()`** — bulk eviction of all expired entries
- **File persistence** — on `set()`/`delete()`/`clear()`, a 500 ms debounced `setTimeout` serializes the entire Map to JSON. On construction, previously persisted entries are loaded if they haven't expired.

---

## eBay Service -- Comp Acquisition Cascade

The cascade maximizes data quality while handling API limitations. Terapeak local data is checked first; live APIs are only called if local data is insufficient:

```
┌───────────────────────────────────────────────────────────┐
│  Tier 0: Terapeak Local Store                             │
│  Highest quality -- real sold prices from CSV exports     │
│  terapeakService.lookupComps() with fuzzy matching        │
│  No API call needed; no rate limits                       │
│  If enough comps → skip all live API tiers                │
├───────────────────────────────────────────────────────────┤
│  Tier 1: Marketplace Insights API                         │
│  Good quality -- actual sold prices + dates               │
│  Requires: eBay Partner oauth token                       │
│  If circuit-tripped or fails → fall through               │
├───────────────────────────────────────────────────────────┤
│  Tier 2: Finding API (findCompletedItems)                 │
│  DECOMMISSIONED by eBay (Feb 4, 2025)                    │
│  Code remains but always falls through                    │
├───────────────────────────────────────────────────────────┤
│  Tier 3: Browse API (search)                              │
│  Last resort -- ACTIVE listings (not sold)                │
│  Only triggers when zero sold comps exist                 │
│  Requires: OAuth client credentials flow                  │
│  Confidence penalty applied in valuation                  │
└───────────────────────────────────────────────────────────┘
```

**Circuit breaker:** When an API returns an error, it is marked as tripped for 5 minutes. Subsequent calls skip the tripped API and try the next tier.

**Throttling:** A global 1,100 ms minimum gap between any eBay API call prevents rate-limit issues.

**Grade-type pool split:** After comps are collected, `classifyGradeType()` classifies each comp into one of three pools: `graded` (PCGS/NGC slabbed or formal grade in title), `proof` (unslabbed proof coins -- title contains "proof" but not "proof-like"), or `raw` (everything else). The valuation engine selects the appropriate pool based on user intent: graded if a grade is specified, proof if grade is "Proof"/"PF"/"PR", raw otherwise. Falls back to all comps if the preferred pool has fewer than 3 entries. This prevents proof coin prices (typically 2-5x BU) from contaminating raw coin valuations.

**Scoring:** Each comp is scored via `scoreMatch(item, expected)`:
- **+10** per matching attribute (year, mint, series, grade, metal, zodiac)
- **-30** per mismatching attribute where the comp contains a different specific value
- Grade-number mismatch: -20 to -40 based on distance from expected grade
- Comps below score threshold are deprioritized; the deny-list (`isDenied`) removes lots, replicas, cleaned coins, etc.

**YearMismatch filter:** `applyFilters()` removes comps with wrong year in title. For bullion coins from generic datasets (dataset name doesn't contain the expected year), the yearMismatch filter is skipped entirely -- these datasets intentionally span all years. Year-specific datasets and non-bullion coins retain strict filtering.

**Outlier removal:** MAD-based outlier removal (via `stats.removeOutliersMAD`) filters extreme prices before statistics are computed.

---

## PCGS Resolution Cascade

When the user provides a free-text description (not a cert number), `resolveFromDescription()` attempts identification in this order:

```
1. /coindetail/Search endpoint (keyword search)
   └── Usually fails silently (endpoint not available on free tier)

2. Static table lookup (pcgsNumbers.js)
   ├── parseDescription(query) → { series, year, mint, grade }
   ├── lookupPCGSNumber(series, year, mint) → coinNumber
   └── lookupByCoinNumberAndGrade(coinNumber, gradeNo)
       → calls /coindetail/GetCoinFactsByGrade?PCGSNo=...&GradeNo=...

3. Parse fallback (parseDescription only)
   └── Returns { verified: false, parsed: {...} } with whatever was extracted
```

**`parseDescription(query)`** extracts:
- **Year**: 4-digit number (1700--2099)
- **Mint mark**: Adjacent to year (`1960-D`), standalone letter (`cent D`), or `CC` (Carson City)
- **Series**: Pattern-matched against known US series names
- **Grade**: `MS`/`PR`/`PF`/`AU`/`XF`/`VF`/`F`/`VG`/`G`/`AG`/`FR`/`PO` + numeric grade
- **Designation**: Red (RD), Red-Brown (RB), Brown (BN), Deep Cameo (DCAM), Cameo, Full Bands (FB), etc.
- **Metal**: gold, silver, platinum, palladium, copper
- **Weight**: `1 oz`, `1/2 oz`, `1/4 oz`, `1/10 oz`, `1/20 oz`, `1.5 oz`, `2 oz`, `5 oz`, `10 oz`
- **Set type**: proof set, silver proof set, prestige proof set, mint set
- **Exclusion operators**: tokens prefixed with `-` (e.g. `-proof`, `-gold`, `-W`) are stripped from parsed fields and passed through as negative keywords to eBay queries

**Mint filtering (#167):** Only an explicitly user-specified mint mark drives comp filtering in `applyFilters()`. When no mint mark is provided in the query, the `mintMismatch` filter is disabled entirely -- previously the system could infer a mint from the dataset name and over-filter comps. The `usMinComps` threshold is 8 (not 3) to ensure sufficient comps before falling back to global.

**Metal exclusion keywords (#171, #172):** `buildKeywords()` appends `-silver` for gold coin queries and `-gold` for silver coin queries, preventing cross-metal contamination in eBay results (e.g. silver bars appearing in Gold Libertad searches).

**Historical meltFloor (#171, #172):** The meltFloor filter in `applyFilters()` uses `getSpotOnDate(metal, soldDate)` from `metalsHistoryService` to compute melt value based on each comp's actual sale date, rather than today's spot price. This prevents older comps from being incorrectly rejected when spot has risen significantly since they were sold. Falls back to today's spot if no historical price is available within a 7-day tolerance.

**Type 1/2 variant filter (#180):** When `expected.label` contains "Type 1" or "Type 2", `applyFilters()` hard-removes comps whose titles reference the opposite type (e.g. "Type 2" titles when pricing a Type 1 coin). `pcgsService.parseDescription()` detects "Type 1" / "Type 2" in descriptions and sets `result.label`, which is passed through from the identification step to the expected object in `priceRoute.js` and `pricingBatchRoute.js`.

---

## Terapeak Sales Aggregation Architecture

The project uses two Python scripts (Playwright-based) and one Node.js script to build and maintain the Terapeak sold-comp dataset. All run inside a VNC session (Xtigervnc :1, port 5901, noVNC on 6080).

### Page 1 Aggregator -- `scripts/terapeak-export.py`

Automates Terapeak CSV downloads from eBay Seller Hub Research:

```
┌─ Phase 1: Login ──────────────────────────────────────────┐
│  --login flag → visible browser, manual eBay sign-in      │
│  Cookies saved to scripts/cache.cookies.json              │
├─ Phase 2: Batch Run ─────────────────────────────────────┤
│  --run flag → headless browser (or headed via VNC)        │
│  For each coin in schedule:                               │
│    1. Navigate to Terapeak Research (Sold Items)          │
│    2. Enter search keywords + date range (90 days)        │
│    3. Wait for results table to render                    │
│    4. Click "Download CSV" button                         │
│    5. Write .meta file (search_term, collected_at)          │
│    6. Upload CSV to Azure Blob Storage (upload_to_blob)   │
│       Falls back to POST /api/terapeak/import if no creds │
│  Browser recycled every 40 coins (fresh context)          │
│  Auto-recovery on crash (up to 5 retries)                 │
│  Bot-detection abort: stops batch on CAPTCHA/block        │
└───────────────────────────────────────────────────────────┘
```

Key flags: `--batch N` (coin count), `--priority` (thin-data-first), `--resume` (continue after crash), `--refresh` (re-collect stale CSVs by file age), `--max-age DAYS` (staleness threshold, default 14).

**Active Listings Guard (S0):** Two-layer protection against ingesting unsold asking prices when Terapeak falls back to the Active Listings tab: (1) DOM tab check detects active-tab selectors after results load, (2) date validation rejects pages where <20% of rows have parseable sold dates.

### Page 2+ Deep Pagination -- `scripts/sales-aggregator.py`

Extends CSVs from 50 rows (page 1 limit) to up to 250 rows by collecting pages 2-5:

```
┌─ Candidate Selection ─────────────────────────────────────┐
│  get_candidates(min_rows=50): queries /api/terapeak/      │
│  aggregation-status?needs=deep&minComps=50                │
│  Excludes gold coins (regex \bgold\b)                     │
│  Select datasets with >= 50 comps and no deepAt marker    │
├─ Collecting ──────────────────────────────────────────────┤
│  For each candidate:                                      │
│    1. Read search_term from server response               │
│    2. Navigate to Terapeak, enter search, load results    │
│    3. Navigate pages 2..max_pages (5 for bullion, 2 else) │
│    4. Collect rows from each page's results table          │
│    5. Upload CSV with composite-key dedup                 │
│       Key: itemId | soldDate | soldPrice                  │
│    6. Upload with aggregationMeta: deepAt + maxPageReached│
└───────────────────────────────────────────────────────────┘
```

**Three-tier persistence:** aggregationMeta is persisted through three independent mechanisms, loaded in priority order at startup:

1. **Git-tracked sidecar** (`data/terapeak-meta.json`) -- lightweight JSON file storing per-dataset metadata. Git-tracked so it survives codespace rebuilds and cache wipes without any infrastructure dependency. Loaded first via `loadMetaSidecar()`. Debounce-written (1s) whenever `importComps()` detects a metadata change.
2. **Cosmos DB write-through** -- aggregationMeta is written to the `terapeak-sold` Cosmos DB container on each import. On startup, `hydrateMetaFromCosmos()` merges Cosmos markers into the in-memory store (after sidecar load). Only active when Cosmos connection string is configured.
3. **CSV row-count inference** -- `importComps()` infers `deepAt` from comp count (>50 = was deep-paginated). Catches legacy datasets that predate explicit tracking.

**Per-dataset metadata fields:**

| Field | Type | Description |
|-------|------|-------------|
| `page1At` | ISO timestamp | When page 1 CSV export was first run |
| `deepAt` | ISO timestamp | When deep pagination was run |
| `maxPageReached` | number | Highest page collected (1-5) |
| `lastRefreshAt` | ISO timestamp | When last refresh export ran |
| `newestSaleDate` | YYYY-MM-DD | Most recent sale date in the dataset |
| `oldestSaleDate` | YYYY-MM-DD | Oldest sale date in the dataset |
| `compCount` | number | Total comps stored for this dataset |

The `newestSaleDate` field enables **reliable staleness detection** based on actual sale data, not file modification times. A dataset is genuinely stale when `today - newestSaleDate > 30 days`, regardless of when the file was last touched.

**deepAt inference:** When `importComps()` receives a dataset with >=100 comps but no explicit `deepAt` marker, it automatically infers `deepAt` from the current timestamp. This handles legacy deep-paginated datasets collected before aggregationMeta tracking was added.

Pagination selector: `button.pagination__next:not([disabled])`. Results per page control: `select[aria-label="Results per page"]` with 10/20/50 options.

**Dashboard mode:** When run without `--run` or `--dry-run`, the script queries `GET /api/terapeak/aggregation-status` and presents an interactive priority menu showing needs-deep, stale (>14 days), and thin (<20 comps) categories. User picks a category and the script auto-launches the aggregation run with the appropriate filter.

**Active Listings Guard (S0):** Same two-layer guard as `terapeak-export.py` -- tab check after page 1 loads, and date-ratio validation on each paginated page's rows. Stops pagination early if active listings detected.

**Aggregation depth tracking:** Each successful upload sends `deepAt` (ISO timestamp) and `maxPageReached` (highest page number collected) as form fields. The server merges these into the dataset's `aggregationMeta` and writes through to Cosmos DB, preventing redundant re-collection. On server startup, `hydrateMetaFromCosmos()` restores all meta from Cosmos. Query `GET /api/terapeak/aggregation-status?needs=deep&minComps=50` to see which datasets still need deep pagination.

### CSV Cleanup -- `scripts/clean-csvs.js`

One-time (or periodic) purge of junk rows from all CSV files:

- Loads deny patterns from `src/utils/filters.js` (`DENY_PATTERNS`) plus `EXTRA_DENY` patterns for sports cards, stamps, toys, greeting cards, media items
- Scans every CSV in `data/terapeak/`, testing each row's title against the combined deny list
- `--dry-run`: reports counts per file without modifying anything
- `--run`: rewrites files in place, removing matched rows
- Handles CSVs with or without headers, preserving the original format

### Terapeak Fuzzy Matching -- `terapeakService.js`

When the pricing engine calls `lookupComps(keywords, expected)`:

1. Tokenize search keywords
2. For each imported dataset, compute bidirectional token overlap
3. Apply hard guards: year must match, weight must match (if specified), metal must match, mint must not conflict
4. Return comps from the best-matching dataset, scored and sorted
5. Each comp passes through `isDenied()` and denomination/series filters before use

**Per-dataset metadata:** Each dataset stores `aggregationMeta: { page1At, deepAt, maxPageReached, lastRefreshAt, newestSaleDate, oldestSaleDate, compCount }` to track aggregation provenance and data freshness. `importComps()` merges aggregationMeta intelligently (never overwrites earlier timestamps, maxPageReached only increases, sale date bounds expand monotonically).

**Admin endpoints:**
- `GET /api/terapeak/aggregation-status` -- summary + filtered dataset lists (`needs=deep`, `needs=page1`, `needs=refresh&maxAge=N`, `minComps=N`)
- `POST /api/terapeak/backfill-aggregation-meta` -- one-time backfill from page2 log files

### VNC Environment

The collectors require a graphical environment for Playwright's Chromium:

| Component | Config |
|-----------|--------|
| Display server | Xtigervnc :7, geometry 1280x800 |
| VNC port | 5907 |
| noVNC / websockify | Port 6080 |
| VNC password | `coin2026` |
| Login helper | `scripts/vnc-login.py` |

VNC and noVNC are auto-started by `_start_vnc()` in both `--run` and dashboard modes. The function always checks that noVNC/websockify is alive on port 6080, even when Xtigervnc is already running -- this handles the case where the VNC server survives but the websockify proxy dies independently. VNC sessions may die between codespace restarts -- always verify with `ps aux | grep Xtigervnc` before running collectors.

### Chain Aggregation -- `scripts/chain-aggregate.sh`

Chains multiple Terapeak collect batches sequentially with anti-bot monitoring:

```
┌─ Configuration ───────────────────────────────────────────┐
│  source chain-aggregate.sh → exports run_batch() function    │
│  Each batch: name + FILTER_REGEX + optional PID to wait   │
├─ Per Batch ───────────────────────────────────────────────┤
│  1. Wait for previous batch PID (if provided)             │
│  2. run_batch "name" "Filter.*Regex"                      │
│     └─ terapeak-export.py --run --resume --filter REGEX   │
│     └─ Logs to cache/terapeak_<name>.log                  │
│  3. check_antibot (tail log for 3+ consecutive bot blocks)│
│     └─ If detected → abort chain, log warning             │
│  4. Continue to next batch                                │
└───────────────────────────────────────────────────────────┘
```

### Stale Data Refresh -- `scripts/refresh-stale.sh`

One-command biweekly refresh of stale Terapeak datasets:

```
┌─ Query ───────────────────────────────────────────────────┐
│  GET /api/admin/stale-datasets?days=N                     │
│  → list of datasets older than threshold (default 14 days)│
├─ Build Filter ────────────────────────────────────────────┤
│  Extract search terms → build regex: "term1|term2|..."    │
│  Write to /tmp/terapeak_refresh_regex.txt (avoids eval)   │
├─ Execute ─────────────────────────────────────────────────┤
│  terapeak-export.py --run --refresh --max-age N --filter  │
│  Uses --refresh (age-aware) not --resume (existence-only) │
└───────────────────────────────────────────────────────────┘

Options: --full, --days N, --dry-run, --include-empty, --limit N
```

---

## Test Architecture

### Golden Set + Seeded Runs

Test coin selection uses a two-layer strategy to balance deterministic coverage with randomized breadth:

```
┌─ Layer 1: Golden Set (fixed) ─────────────────────────────┐
│  __tests__/fixtures/golden_coins.json                     │
│  14 curated coins: Morgan (raw + graded + edge),          │
│  ASE (BU + Type variants + Generic), Peace, world bullion │
│  ALWAYS run regardless of sample size                     │
├─ Layer 2: Random Sample (rotating) ───────────────────────┤
│  pickRandom(remaining_pool, N, seeded_rng)                │
│  Fills slots up to target size from 29-coin catalog       │
│  Different coins selected each run (seed = Date.now())    │
├─ Composition ─────────────────────────────────────────────┤
│  selectCoins(label, opts)                                 │
│  → golden_set ∪ random_sample                             │
│  → dedup by query string                                  │
│  → stable sort for reproducible test order                │
│  → log seed + selected IDs for reproducibility            │
└───────────────────────────────────────────────────────────┘
```

**Suite presets** (`SUITE_TYPE` env var):

| Suite | Total | Golden | Random | Use Case |
|-------|-------|--------|--------|----------|
| `pr` | 24 | 14 | 10 | Fast PR checks |
| `nightly` | 29 | 14 | 15 (full catalog) | Broad nightly coverage |
| `soak` | 100 | 14 | 15 (catalog exhausted) | Extended soak testing |

**Env vars:** `COIN_TEST_SEED` (fixed seed), `COIN_SAMPLE_SIZE` (override total), `SUITE_TYPE` (preset).

**Golden fixture format:** Groups (morgan, ase, supplemental), each coin has `q`, `series`, `year`, `metal`, `grade`, `tags` (raw/graded/high-volume/edge/key-date/low-comps), and `_comps` (real Terapeak comp count at curation time).

**Safeguards:** Missing golden coins produce `console.warn` (test still runs). Zero golden coverage throws an error (corrupt fixture guard). `year: null` coins (e.g. "American Silver Eagle Generic") skip year assertion.

---

## Valuation Engine

### FMV Blend

Sources are weighted and blended. If any source is unavailable, the remaining weights are renormalized proportionally.

**`blendSources(available, weights)`** logic:
1. Sum weights of available sources
2. Divide each weight by that sum to normalize to 1.0
3. Compute weighted sum: `Σ (normalizedWeight × sourceValue)`

### Weighted Median

The eBay component uses `computeWeightedMedian(comps)` instead of a simple median:

- **Recency weight**: `1 / (1 + daysSince / 90)` — recent sales count more
- **Match weight**: `matchScore / 100` — higher-relevance comps count more
- **Combined**: `recencyWeight × matchWeight`
- Falls back to `stats.weightedMedian(prices, weights)`

### Confidence Scoring

`computeConfidence(params)` produces a 0–100 score:

| Input | Contribution |
|-------|-------------|
| `usCompCount` | Up to 30–40 pts (logarithmic scale) |
| `dispersion` (CV = stddev/mean) | Up to 20–25 pts (lower = better) |
| `avgMatchScore` | Up to 15–25 pts |
| `verified` (PCGS certified) | +10 |
| `hasPcgsGuide` | +10 |
| `hasAuction` | +5 |
| `hasGreysheet` | +5 |
| Greysheet spread <=15% | +5 (tight = liquid market) |
| Greysheet spread >=40% | -5 (wide = illiquid) |
| 20+ US comps | +10-15 bonus |
| `usedFallback` | −5 to −15 penalty |
| < 5 US comps | −10 penalty |
| `isBar` mode | Adjusted base (no PCGS expectation) |

### Graded vs Raw vs Proof Pool Selection

The valuation engine separates eBay comps by `gradeType` (three-way split):

1. If user grade is "Proof"/"PF"/"PR" → prefer `proof` comps pool
2. If user specified any other grade → prefer `graded` comps pool
3. If no grade specified → prefer `raw` comps pool (excludes both graded AND proof)
4. If preferred pool has < 3 comps → fall back to all comps
5. Explanation notes which pool was used and how many were excluded

`classifyGradeType()` priority chain:
- conditionId 2000 ("Certified") → `graded`
- TPG regex (PCGS/NGC/ANACS/ICG/CGC) or formal grade (MS-64, PF-69) → `graded`
- `/\bproof\b(?![\s-]*like)/i` in title → `proof`
- Everything else → `raw`

This ensures unslabbed proof coins (e.g. Proof Libertads in OGP) don't inflate raw BU valuations.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PCGS_API_KEY` | Yes | — | PCGS CoinFacts API bearer token |
| `EBAY_APP_ID` | Yes | — | eBay application ID |
| `EBAY_CLIENT_SECRET` | Yes | — | eBay client secret (for OAuth flows) |
| `GOLDAPI_KEY` | No | — | goldapi.io access token |
| `METALS_API_KEY` | No | — | metals-api.com access token |
| `GREYSHEET_API_TOKEN` | No | — | Greysheet CDN Public API V2 token |
| `GREYSHEET_API_KEY` | No | — | Greysheet CDN Public API V2 key |
| `GREYSHEET_BASE_URL` | No | `https://cpgpublicapiv2.greysheet.com/api` | Greysheet API base URL override |
| `PORT` | No | `3000` | HTTP server port |
| `PCGS_BASE_URL` | No | `https://api.pcgs.com/publicapi` | PCGS API base URL |
| `EBAY_FINDING_ENDPOINT` | No | `https://svcs.ebay.com/...` | eBay Finding API endpoint |
| `EBAY_GLOBAL_ID` | No | `EBAY-US` | eBay site ID |
| `EBAY_CACHE_TTL_MS` | No | `3600000` | eBay cache TTL (ms) |
| `EBAY_US_MIN_COMPS` | No | `8` | Min US comps before global fallback |
| `EBAY_ENTRIES_PER_PAGE` | No | `50` | Results per eBay API page |
| `EBAY_TIMEOUT_MS` | No | `10000` | eBay API request timeout |
| `EBAY_THROTTLE_MS` | No | `1100` | Min ms between eBay API calls |
| `METALS_CACHE_TTL_MS` | No | `2700000` | Metals cache TTL (ms) |
| `JWT_SECRET` | **Prod** | *(random on startup)* | Secret for signing auth JWTs. **FATAL throw if unset in production.** Random = sessions expire on server restart |
| `ADMIN_API_KEY` | No | -- | API key for admin/destructive endpoints |
| `CACHE_DIR` | No | `../../cache` | Path to file-cache directory (Azure Files: `/mnt/cache`) |
| `COSMOS_ENDPOINT` | No | -- | Azure Cosmos DB endpoint (enables dual-mode writes) |
| `COSMOS_KEY` | No | -- | Azure Cosmos DB key (optional; managed identity preferred) |
| `TERAPEAK_BLOB_ACCOUNT` | No | -- | Azure Blob Storage account name |
| `TERAPEAK_BLOB_CONTAINER` | No | -- | Azure Blob Storage container name |
| `TERAPEAK_DATA_DIR` | No | `data/terapeak` | Local directory for Terapeak CSV files |
| `METALS_POLL_MS` | No | `300000` | Metals spot-price polling interval (ms) |
| `EBAY_DEFAULT_LOOKBACK_DAYS` | No | `180` | Default sold-comp lookback window (auto-extends to 365 if thin) |
| `BLOB_REIMPORT_MS` | No | `1800000` | Periodic blob re-import interval (ms; 30 min default) |
| `GS_REFRESH_DAY` | No | `0` (Sunday) | Day of week for Greysheet bulk refresh (0=Sun, 1=Mon, ..., 6=Sat) |
| `GS_REFRESH_INTERVAL_DAYS` | No | `3` | Days between automatic Greysheet background refreshes |
| `NUMISTA_API_KEY` | No | -- | Numista API key for rarity/mintage lookups |

---

## Background Timers (server.js)

The server starts several background tasks on boot:

| Timer | Interval | Purpose |
|-------|----------|---------|
| Metals spot price | 30 min (`METALS_POLL_MS`) | Round-robin fetch from goldapi.io / metals-api.com; persists to `metals_spot.json` |
| Greysheet history refresh | `GS_REFRESH_INTERVAL_DAYS` days (default 3) | Runs `scripts/greysheet-refresh.js` to snapshot wholesale prices for all tracked coins. Checks `greysheetHistoryService.getLastRefreshDate()` on startup and every 12 hours; skips if interval not elapsed. |
| Blob re-import | 30 min (`BLOB_REIMPORT_MS`) | Polls Azure Blob Storage for new Terapeak CSV uploads; clears eBay cache on new data |
| Greysheet history eviction | Startup only | Evicts history entries older than 400 days |
| Terapeak meta sidecar | Startup only | Loads `data/terapeak-meta.json` (aggregation markers + sale date bounds); auto-seeds file on first run |
| Terapeak auto-import | Startup only | Imports CSVs from `data/terapeak/` (files < 7 days old) |
| Test account seed | Startup only | Seeds `testcollector` account with sample coins if empty |

---

## Statistics Module

`src/utils/stats.js` provides pure functions used across the valuation pipeline:

| Function | Purpose |
|----------|---------|
| `mean(arr)` | Arithmetic mean |
| `median(arr)` | Middle value of sorted array |
| `percentile(arr, p)` | p-th percentile (linear interpolation) |
| `stddev(arr)` | Population standard deviation |
| `mad(arr)` | Median Absolute Deviation |
| `removeOutliersMAD(arr, threshold?)` | Remove values > threshold × MAD from median |
| `removeOutliersIQR(arr, factor?)` | Remove values outside Q1 − f×IQR  to Q3 + f×IQR |
| `weightedMedian(vals, weights)` | Weighted median computation |
| `summarize(arr)` | Returns `{ count, mean, median, stddev, min, max }` |
| `sorted(arr)` | Returns a new sorted (ascending) copy |

---

## Client-Side Architecture

The frontend is a single-page app in `public/index.html` (~7,000 lines) with three external JavaScript modules. Authentication and coin storage are handled server-side via bcrypt + JWT; the client modules are thin API wrappers.

### Module Dependency Graph

```
auth.js     (no deps -- calls /api/auth/*)
    |
storage.js  -> CoinAuth (reads token from currentUser())
    |
my-coins.js -> CoinAuth + CoinStorage + _esc()
```

**Load order in HTML:** `auth.js` -> `storage.js` -> `my-coins.js`

### CoinAuth (`public/js/auth.js`)

Server-backed account management. Calls `/api/auth/*` endpoints.

**In-memory state:** `_session = { username, userId, token } | null` -- lost on page reload. No localStorage used.

| Function | Flow |
|----------|------|
| `signup(username, password)` | POST `/api/auth/signup` -> set `_session` with returned JWT |
| `login(username, password)` | POST `/api/auth/login` -> set `_session` with returned JWT |
| `logout()` | Clear `_session` (no server call) |
| `currentUser()` | Returns `{username, userId, token}` or `null` |
| `pendingReauth()` | Always returns `null` (no localStorage session to detect) |
| `changePassword(cur, new)` | POST `/api/auth/change-password` with Bearer token |
| `loginWithRecovery()` | Throws -- recovery phrases not supported in server mode |
| `resetPasswordWithRecovery()` | Throws -- not supported in server mode |
| `deleteAccount()` | No-op stub |
| `listAccounts()` | Returns `[]` |

### CoinStorage (`public/js/storage.js`)

Server-backed coin CRUD via `/api/coins/*`. All methods accept `(userId, key, ...)` for interface compatibility with the old IndexedDB version, but both params are ignored -- the server derives the user from the JWT.

| Function | Server Call |
|----------|-------------|
| `addCoin(_userId, _key, coin)` | POST `/api/coins` -> returns `coinHash` |
| `hasCoin(_userId, coin)` | POST `/api/coins/get` -> returns boolean |
| `getCoin(_userId, _key, coin)` | POST `/api/coins/get` -> returns coin or null |
| `updateCount(_userId, _key, hash, count)` | PUT `/api/coins/:hash` with `{count}` |
| `updateCostPer(_userId, _key, hash, cost)` | PUT `/api/coins/:hash` with `{costPer}` |
| `removeCoin(_userId, hash)` | DELETE `/api/coins/:hash` |
| `getAllDecrypted(_userId, _key)` | GET `/api/coins` -> returns `coins[]` |
| `count(_userId)` | GET `/api/coins/count` |
| `exportJSON(_userId, _key)` | GET `/api/coins/export` -> returns JSON string |
| `importJSON(_userId, _key, jsonStr)` | POST `/api/coins/import` -> returns `{imported, skipped}` |
| `coinHash(coin)` | Client-side SHA-256 (matches server `coinStorageService.coinHash()`) |
| `reEncryptAll()` | No-op (server-side storage, no client-side encryption) |
| `clearAll(_userId)` | Iterates and deletes all coins |

**BackupReminder** (also in `storage.js`) is a no-op in server mode -- `check()` always returns `{needed: false}`.

### Server-Side Auth & Storage Services

#### authService.js (`src/services/authService.js`)

| Property | Value |
|----------|-------|
| Store file | `cache/users.json` + Azure Cosmos `users` container (dual-mode) |
| Password hashing | bcrypt, 12 rounds |
| JWT signing | HS256, 7-day expiry |
| JWT secret | `JWT_SECRET` env var or random on startup |
| Username rules | Lowercased, `[a-z0-9_.-]`, max 50 chars |
| Password rules | Min 6 chars |

| Function | Purpose |
|----------|---------|
| `signup(username, password)` | Validate -> bcrypt hash -> UUID -> save -> sign JWT |
| `login(username, password)` | bcrypt.compare -> sign JWT |
| `changePassword(username, cur, new)` | Verify current -> hash new -> save |
| `verifyToken(token)` | jwt.verify -> return `{userId, username}` |
| `userExists(username)` | Check store |
| `deleteUser(username)` | Remove from store |

#### coinStorageService.js (`src/services/coinStorageService.js`)

| Property | Value |
|----------|-------|
| Store file | `cache/user_coins.json` + Azure Cosmos `user-coins` container (dual-mode) |
| Key structure | `{ [userId]: coin[] }` |
| Coin hash | SHA-256 of `series\|year\|mint\|grade\|notes\|label` (full 64-char hex) |
| Save strategy | Debounced 300ms async write (sync for `_resetStore`) |

| Function | Purpose |
|----------|---------|
| `addCoin(userId, coin)` | Sanitize fields -> compute hash -> upsert -> return hash |
| `removeCoin(userId, hash)` | Filter out by hash |
| `getAllCoins(userId)` | Return coin array |
| `updateCount(userId, hash, n)` | Update count field |
| `updateCostPer(userId, hash, cost)` | Validate + update costPer |
| `bulkDelete(userId, hashes)` | Remove all matching hashes |
| `importCoins(userId, coins)` | Add with duplicate detection (auto "lot N" differentiation) |
| `exportCoins(userId)` | Return `{format, exportedAt, count, coins}` backup object |
| `coinHash(coin)` | Deterministic SHA-256 hash |

### MyCoins (`public/js/my-coins.js`)

Portfolio renderer with batch pricing. Depends on `CoinAuth`, `CoinStorage`, and `_esc()` (XSS escaper from index.html).

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_BATCH` | 25 | Coins per pricing batch request |
| `PAGE_SIZE` | 50 | Table pagination size |

| Function | Purpose |
|----------|---------|
| `render()` | Main entry: check auth -> fetch coins from server -> `_fetchPricing` -> `_renderTable`. 2-minute render cache (`RENDER_CACHE_TTL`); tab-switch uses cached render, mutations pass `force=true`. |
| `_fetchPricing(coins)` | POST `/api/pricing-batch` in chunks of 25. Extracts `fmv`, `rangeLow`, `rangeHigh`, `avgEbay`, `confidence`. |
| `_fetchSpotPrices()` | Fetches spot prices from `/api/metals` for melt-value column. Sets `_spotFetchFailed` flag on error, showing a `role="alert"` warning banner. |
| `_renderTable(items)` | Portfolio summary card + sortable/filterable/paginated HTML table with inline qty +/-, cost editing, bulk delete with 5s undo toast, melt values, color-coded grade tags. Focus/selection state saved and restored across innerHTML re-renders. Empty filter state shows helpful message. Notes column has `title` attribute for hover disclosure. |
| `_setupDelegation()` | Single set of delegated event handlers wired on `init()` (click, change, input, blur, keydown). Includes Enter/Space handler for keyboard-operable sortable column headers. |
| `_ariaSortAttr(col)` | Emits `tabindex="0" role="columnheader button"` and `aria-sort` attribute for sortable headers. |
| `invalidate()` | Exposed for external callers (e.g. "I have this coin" button) to force re-render on next tab switch. |

### Index.html Inline JavaScript

The SPA contains several IIFEs and objects in inline `<script>` blocks:

| Component | Purpose |
|-----------|---------|
| `_esc(str)` / `_escUrl(url)` | XSS-safe HTML and URL escaping |
| `initTabs()` | Tab controller with auth gate for locked tabs |
| `AUTH_GATED_TABS` | `['tab-mycoins', 'tab-history']` |
| `CoinForm` / `BarForm` | Structured entry forms. BarForm fetches brand/series from `GET /api/bar-price/options` on init and dynamically populates the series dropdown on brand change. |
| `runQuery()` | Coin form submission -> POST `/api/price` -> `renderResults()` |
| `renderResults(d)` | ~500 lines: FMV hero card, gallery, comps, "I Have This Coin" button, cross-tab links |
| `BarForm._renderBarResults(d)` | Bar-specific results with cross-tab pull-through to Tracker/History/Melt |
| `MeltCalc` | Offline melt calculator with spot auto-fetch |
| `EbayTracker` | Market matrix UI (year x mint, year x grade, brand table). `setSeries()` for coins, `setBar()` for bars. |
| `TerapeakImporter` | CSV upload UI + dataset management |
| `CoinHistoryLink` | Cross-tab state for auto-loading price history chart |
| `initAuthUI()` | Auth dialog: login/signup toggle, badge, recovery link hidden |

### Cross-Tab Linkage

Both coin and bar pricing results pull through to all other tabs:

```
Coin Price Discovery --setSeries()-->           Live eBay Tracker (coin mode)
                                                (pre-fills series, auto-loads on tab switch)

Bar Price Discovery  --setBar(metal,size,brand)--> Live eBay Tracker (bar mode)
                                                   (switches to bar mode, pre-fills fields)

Both              --CoinHistoryLink.setCoin()--> Price History
                                                 (pre-fills query, auto-charts on tab switch)

Both              --MeltCalc.setCoin()-->        Melt Calculator
                                                 (pre-fills metal + troy oz)
```

Cross-tab quick-link buttons ("View on: Melt Calculator | eBay Tracker | Price History")
appear at the bottom of both coin and bar results.

### Storage Summary

| Location | Module | Contents |
|----------|--------|---------|
| `cache/users.json` + Cosmos `users` | authService | `{ [username]: { userId, hash, createdAt } }` |
| `cache/user_coins.json` + Cosmos `user-coins` | coinStorageService | `{ [userId]: coin[] }` |
| In-memory `_session` | CoinAuth (client) | `{ username, userId, token }` -- lost on reload |

---

## CSS Design System

The SPA uses CSS custom properties for theming. The dark theme defines 36+ tokens on `:root`:

### Core Palette

| Variable | Value | Purpose |
|----------|-------|---------|
| `--bg` | `#181a20` | Page background |
| `--surface` | `#23262f` | Card/panel background |
| `--surface-alt` | `#2a2d37` | Alternate surface (table stripes, hover) |
| `--border` | `#333` | Default border |
| `--text` | `#e0e0e0` | Primary text |
| `--muted` | `#aaa` | Secondary/muted text |
| `--accent` | `#4fc3f7` | Primary accent (links, active tab) |
| `--accent-dim` | `#2a7a9b` | Dimmed accent (hover state) |
| `--green` | `#43a047` | Positive values (gains) |
| `--red` | `#e53935` | Negative values (losses), remove buttons |
| `--gold` | `#ffd54f` | Gold accent, premium highlights |

### Grade Tag Tokens (added S3)

| Variable | Purpose |
|----------|---------|
| `--tag-graded-bg` / `--tag-graded-fg` | Graded coin tag (blue) |
| `--tag-proof-bg` / `--tag-proof-fg` | Proof coin tag (purple) |
| `--tag-bu-bg` / `--tag-bu-fg` | BU/Uncirculated tag (green) |
| `--tag-coa-bg` / `--tag-coa-fg` | COA (Certificate of Authenticity) tag |
| `--tag-sealed-bg` / `--tag-sealed-fg` | Sealed/original packaging tag |
| `--tag-raw-bg` / `--tag-raw-fg` | Raw (ungraded) coin tag |

### Feedback Tokens (added S3)

| Variable | Purpose |
|----------|---------|
| `--warning` | Warning state (spot-price failure banner) |
| `--caution` | Caution state (low confidence) |
| `--chip-hint` | Informational chip background |
| `--chip-purple` | Purple chip accent |
| `--chip-bronze` | Bronze chip accent |

### Responsive Breakpoints

| Width | Behavior |
|-------|----------|
| 1200px | My Coins hides Range, eBay Avg columns |
| 900px | Hides Troy Oz, Melt columns |
| 700px | Tab labels shrink to 0.85rem |
| 600px | Hides Notes, Date Added columns; full compact mode |
| 500px | Tab labels shrink to 0.78rem |
| 400px | Tab labels shrink to 0.72rem |

### Accessibility

- `prefers-reduced-motion: reduce` -- disables spinner animation
- Skip-navigation link: `.skip-nav` (visually hidden, positioned on `:focus`)
- All interactive targets >= 24x24px (WCAG 2.5.8)
- `aria-modal="true"` + `aria-labelledby` on all `<dialog>` elements
- Sortable headers: `tabindex="0"`, `role="columnheader button"`, `aria-sort`
- `<canvas>` has `aria-label` for screen readers
- Tab bar uses `mask-image` gradient to indicate scroll overflow on mobile

---

## Security Hardening

Server-side security controls implemented across the stack:

| Layer | Control | Location |
|-------|---------|----------|
| **Auth** | JWT_SECRET required in production (FATAL throw) | `authService.js` |
| **Auth** | bcrypt 12 rounds, 7-day JWT expiry | `authService.js` |
| **Input** | JSON body limit 5 MB | `server.js` |
| **Input** | Terapeak searchTerm: string, max 500 chars | `terapeakRoute.js` |
| **Input** | Excel upload: magic-byte check (ZIP/PK header) | `excelImportRoute.js` |
| **Input** | Label allowlist on coin pricing | `priceRoute.js` |
| **Proxy** | Image proxy: Content-Length check, 413 if > 2 MB | `imageProxyRoute.js` |
| **Proxy** | Image proxy: allowlisted hosts only (SSRF prevention) | `imageProxyRoute.js` |
| **Admin** | `x-api-key` header only (no query-param API keys) | `adminRoute.js` |
| **Admin** | Audit logging: method, path, IP, timestamp on all admin ops | `server.js` |
| **Headers** | Helmet CSP, rate limiting (express-rate-limit) | `server.js` |
| **Storage** | File store always written (source of truth), Cosmos as supplement | `coinStorageService.js` |
| **API key** | Timing-safe comparison (`timingSafeEqual`) | `adminRoute.js` |
