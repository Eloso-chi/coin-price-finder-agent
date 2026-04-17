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
│   ├─ pricingBatchRoute.js            POST /api/pricing-batch -- batch pricing (up to 25)
│   ├─ metalsRoute.js                  GET /api/metals[/:metal] -- spot prices
│   ├─ marketRoute.js                  GET /api/market/ebay -- year x mint market matrix
│   ├─ coinHistoryRoute.js             GET /api/coin-history -- sold-price time-series
│   ├─ coinVariantRoute.js             GET /api/coin-variant -- design series resolver
│   ├─ excelImportRoute.js             POST /api/import/excel -- Excel spreadsheet import
│   ├─ imageProxyRoute.js              GET /api/image-proxy -- proxied coin images
│   ├─ terapeakRoute.js                /api/terapeak/* -- Terapeak data & quota management
│   ├─ authRoute.js                    /api/auth/* -- signup, login, me, change-password
│   └─ coinRoute.js                    /api/coins/* -- collection CRUD (JWT-protected)
│
├─ src/services/
│   ├─ pcgsService.js                  PCGS CoinFacts API (cert, coin#, description)
│   ├─ ebayService.js                  eBay sold comps (3-tier API cascade + grade-type pool split)
│   ├─ valuationService.js             FMV blend + buy/sell decision engine
│   ├─ greysheetService.js             Greysheet CDN Public API V2 (wholesale pricing)
│   ├─ metalsSpotPrice.js              Multi-provider spot price (round-robin)
│   ├─ MetalsSpotPriceError.js         Custom error class
│   ├─ metalsHistoryService.js         Daily spot price history snapshots
│   ├─ marketAggregator.js             Year x mint market matrix builder + caching
│   ├─ numistaService.js               Numista API -- search, mintages, rarity
│   ├─ terapeakService.js              Terapeak CSV import, fuzzy lookup, eviction, auto-import (local + blob)
│   ├─ terapeakQuotaService.js         Daily Terapeak query quota tracker
│   ├─ greysheetHistoryService.js      Daily Greysheet price history snapshots
│   ├─ authService.js                  Server-side auth (bcrypt + JWT, dual-mode Cosmos + local JSON)
│   └─ coinStorageService.js           Server-side coin CRUD (dual-mode Cosmos + local JSON)
│
├─ src/data/
│   ├─ pcgsNumbers.js                  Static PCGS coin number lookup (10 US series)
│   ├─ keyDates.js                     Key date / semi-key detection tables
│   ├─ mintages.js                     Mintage reference data by series/year/mint
│   ├─ halfDollarSeries.js             Half Dollar design eras + year-based resolver
│   ├─ constants.js                    Zodiac cycle + Perth Lunar series helpers
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
│   └─ greysheetTypeMap.js             Series-to-GSID mapping for Greysheet API lookups
│
├─ public/
│   ├─ index.html                      SPA frontend (dark theme, 7 tabs)
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
│   ├─ terapeak_sold.json              Imported Terapeak comp data
│   ├─ users.json                      Server-side user accounts (bcrypt hashes + UUIDs)
│   └─ user_coins.json                 Server-side coin collections (plaintext JSON by userId)
│
├─ data/
│   └─ terapeak/                       ~1,200 Terapeak CSV exports (real sold data)
│
├─ scripts/
│   ├─ terapeak-export.py              Semi-automated Terapeak CSV exporter (Playwright)
│   ├─ terapeak-page2.py               Page 2 enrichment scraper (extends CSVs beyond 50 rows)
│   ├─ clean-csvs.js                   CSV junk cleaner (deny-pattern purge)
│   ├─ migrate-to-cosmos.js            One-time migration of history data to Cosmos DB
│   ├─ upload-csvs-to-blob.js          Upload Terapeak CSVs to Azure Blob Storage
│   ├─ vnc-login.py                    VNC + eBay login helper for Playwright sessions
│   └─ test-metrics/                   Jest metrics capture + summary reporter
│
└─ __tests__/                          38 Jest test suites
    └─ helpers/
        └─ coinTestConstants.js        Shared token lists & test utilities
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
  │   └─ Cached 24h with file persistence (cache/greysheet_cache.json)
  │
  ├── 6. Valuation + Decisions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  │   computeValuation(pcgs, ebay, askingPrice, userGrade, { greysheet })
  │   ├─ Split comps into graded vs raw pools (user intent decides pool)
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
  ├── 1. Build eBay keywords (year + brand + size + metal + "bar" + lunar labels)
  ├── 2. fetchSoldComps (same 3-tier cascade as coins)
  ├── 3. computeValuation with pcgs = { _isBar: true }
  └── Response { keywords, comps stats, valuation, decisions }
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
    "gradePool": { "wantsGraded": true, "usedPool": "graded", "gradedCount": 12, "rawCount": 3 },
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
  "series": null,
  "year": null,
  "condition": "sealed",
  "askingPrice": 2400,
  "options": { "timeWindowDays": 90 }
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

**Grade-type pool split:** After comps are collected, `classifyGradeType()` separates them into graded vs raw pools based on whether the title contains slab/grade indicators. The valuation engine selects the appropriate pool based on user intent (graded if grade specified, raw otherwise) and falls back to all comps if the preferred pool has fewer than 3 entries.

**Scoring:** Each comp is scored via `scoreMatch(item, expected)`:
- **+10** per matching attribute (year, mint, series, grade, metal, zodiac)
- **-30** per mismatching attribute where the comp contains a different specific value
- Grade-number mismatch: -20 to -40 based on distance from expected grade
- Comps below score threshold are deprioritized; the deny-list (`isDenied`) removes lots, replicas, cleaned coins, etc.

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
- **Year**: 4-digit number (1700–2099)
- **Mint mark**: Adjacent to year (`1960-D`), standalone letter (`cent D`), or `CC` (Carson City)
- **Series**: Pattern-matched against known US series names
- **Grade**: `MS`/`PR`/`PF`/`AU`/`XF`/`VF`/`F`/`VG`/`G`/`AG`/`FR`/`PO` + numeric grade
- **Designation**: Red (RD), Red-Brown (RB), Brown (BN), Deep Cameo (DCAM), Cameo, Full Bands (FB), etc.
- **Metal**: gold, silver, platinum, palladium, copper
- **Weight**: `1 oz`, `1/2 oz`, `1/4 oz`, `1/10 oz`, `1/20 oz`, `1.5 oz`, `2 oz`, `5 oz`, `10 oz`
- **Set type**: proof set, silver proof set, prestige proof set, mint set

---

## Terapeak Scraper Architecture

The project uses two Python scripts (Playwright-based) and one Node.js script to build and maintain the Terapeak sold-comp dataset. All run inside a VNC session (Xtigervnc :1, port 5901, noVNC on 6080).

### Page 1 Scraper -- `scripts/terapeak-export.py`

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
│    5. Write .meta file (search_term, scraped_at)          │
│    6. POST CSV to server /api/terapeak/import             │
│  Browser recycled every 40 coins (fresh context)          │
│  Auto-recovery on crash (up to 5 retries)                 │
│  Bot-detection abort: stops batch on CAPTCHA/block        │
└───────────────────────────────────────────────────────────┘
```

Key flags: `--batch N` (coin count), `--priority` (thin-data-first), `--resume` (continue after crash).

### Page 2 Enrichment Scraper -- `scripts/terapeak-page2.py`

Extends CSVs from 50 rows (page 1 limit) to ~100 rows by scraping page 2:

```
┌─ Candidate Selection ─────────────────────────────────────┐
│  get_candidates(min_rows=50): scan data/terapeak/*.csv    │
│  Select files with exactly 50 rows (likely truncated)     │
├─ Scraping ────────────────────────────────────────────────┤
│  For each candidate:                                      │
│    1. Read .meta file for original search_term            │
│    2. Navigate to Terapeak, enter search, load results    │
│    3. Click pagination "Next" button                      │
│    4. Scrape page 2 rows from the results table           │
│    5. append_to_csv() with composite-key dedup            │
│       Key: itemId | soldDate | soldPrice                  │
│    6. Update .meta with enrichment timestamp              │
└───────────────────────────────────────────────────────────┘
```

Pagination selector: `button.pagination__next:not([disabled])`. Results per page control: `select[aria-label="Results per page"]` with 10/20/50 options.

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

### VNC Environment

The scrapers require a graphical environment for Playwright's Chromium:

| Component | Config |
|-----------|--------|
| Display server | Xtigervnc :1, geometry 1280x800 |
| VNC port | 5901 |
| noVNC / websockify | Port 6080 |
| VNC password | `coin2026` |
| Login helper | `scripts/vnc-login.py` |

VNC sessions may die between codespace restarts -- always verify with `ps aux | grep Xtigervnc` before running scrapers.

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

### Graded vs Raw Pool Selection

The valuation engine separates eBay comps by `gradeType`:

1. If user specified a grade → prefer `graded` comps pool
2. If no grade specified → prefer `raw` comps pool
3. If preferred pool has < 3 comps → fall back to all comps
4. Explanation notes which pool was used

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
| `JWT_SECRET` | No | *(random on startup)* | Secret for signing auth JWTs. Random = sessions expire on server restart |
| `ADMIN_API_KEY` | No | -- | API key for admin/destructive endpoints |
| `CACHE_DIR` | No | `../../cache` | Path to file-cache directory (Azure Files: `/mnt/cache`) |
| `COSMOS_ENDPOINT` | No | -- | Azure Cosmos DB endpoint (enables dual-mode writes) |
| `COSMOS_KEY` | No | -- | Azure Cosmos DB key (optional; managed identity preferred) |
| `TERAPEAK_BLOB_ACCOUNT` | No | -- | Azure Blob Storage account name |
| `TERAPEAK_BLOB_CONTAINER` | No | -- | Azure Blob Storage container name |
| `TERAPEAK_DATA_DIR` | No | `data/terapeak` | Local directory for Terapeak CSV files |
| `METALS_POLL_MS` | No | `300000` | Metals spot-price polling interval (ms) |
| `EBAY_DEFAULT_LOOKBACK_DAYS` | No | `180` | Default sold-comp lookback window (auto-extends to 365 if thin) |

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

The frontend is a single-page app in `public/index.html` (~5,250 lines) with three external JavaScript modules. Authentication and coin storage are handled server-side via bcrypt + JWT; the client modules are thin API wrappers.

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
| `reEncryptAll()` | No-op (no client-side encryption) |
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
| `render()` | Main entry: check auth -> fetch coins from server -> `_fetchPricing` -> `_renderTable` |
| `_fetchPricing(coins)` | POST `/api/pricing-batch` in chunks of 25. Extracts `fmv`, `rangeLow`, `rangeHigh`, `avgEbay`, `confidence`. |
| `_renderTable(items)` | Portfolio summary card + sortable/filterable/paginated HTML table with inline qty +/-, cost editing, bulk delete, melt values. |
| `_setupDelegation()` | Single set of delegated event handlers wired on `init()` (click, change, input, blur, keydown). |

### Index.html Inline JavaScript

The SPA contains several IIFEs and objects in inline `<script>` blocks:

| Component | Purpose |
|-----------|---------|
| `_esc(str)` / `_escUrl(url)` | XSS-safe HTML and URL escaping |
| `initTabs()` | Tab controller with auth gate for locked tabs |
| `AUTH_GATED_TABS` | `['tab-mycoins', 'tab-history']` |
| `CoinForm` / `BarForm` | Structured entry forms |
| `runQuery()` | Coin form submission -> POST `/api/price` -> `renderResults()` |
| `renderResults(d)` | ~500 lines: FMV hero card, gallery, comps, "I Have This Coin" button |
| `MeltCalc` | Offline melt calculator with spot auto-fetch |
| `EbayTracker` | Market matrix UI (year x mint, year x grade, brand table) |
| `TerapeakImporter` | CSV upload UI + dataset management |
| `CoinHistoryLink` | Cross-tab state for auto-loading price history chart |
| `initAuthUI()` | Auth dialog: login/signup toggle, badge, recovery link hidden |

### Cross-Tab Linkage

```
Price Discovery --setSeries()-->  Live eBay Tracker
                                  (pre-fills series, auto-loads on tab switch)

Price Discovery --CoinHistoryLink.setCoin()--> Price History
                                               (pre-fills query, auto-charts on tab switch)
```

### Storage Summary

| Location | Module | Contents |
|----------|--------|---------|
| `cache/users.json` + Cosmos `users` | authService | `{ [username]: { userId, hash, createdAt } }` |
| `cache/user_coins.json` + Cosmos `user-coins` | coinStorageService | `{ [userId]: coin[] }` |
| In-memory `_session` | CoinAuth (client) | `{ username, userId, token }` -- lost on reload |
