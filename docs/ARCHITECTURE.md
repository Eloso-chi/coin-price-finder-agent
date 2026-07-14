# Architecture

Technical reference for the Coin Price Discovery Agent. Covers module layout, data flow, caching strategy, and API schemas.

For a quick endpoint reference, see [docs/api-reference.md](api-reference.md). For critical data store schemas, see [docs/data-dictionary.md](data-dictionary.md).

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
│   ├─ valuationService.js             FMV blend + buy/sell decision engine; routes Reverse Proof / Enhanced Reverse Proof queries to a separate `reverse-proof` comp pool (#260W) via `isReverseProofFinish()` from `coinIntent`
│   ├─ greysheetService.js             Greysheet CDN Public API V2 (wholesale pricing)
│   ├─ alertService.js                 Crash/ops alert notifications (SendGrid)
│   ├─ auctionPriceService.js          PCGS auction history fetch + local history cache
│   ├─ bulkEvaluateService.js           Bulk lot evaluator engine (per-coin FMV + lot summary)
│   ├─ metalsSpotPrice.js              Multi-provider spot price (round-robin)
│   ├─ MetalsSpotPriceError.js         Custom error class
│   ├─ metalsHistoryService.js         Daily spot price history snapshots + getSpotOnDate()
│   ├─ marketAggregator.js             Year x mint market matrix builder + caching
│   ├─ numistaService.js               Numista API -- search, mintages, rarity
│   ├─ pcgsQuotaService.js             PCGS API quota tracking service
│   ├─ prefetchScheduler.js            Nightly PCGS prefetch scheduler
│   ├─ terapeakService.js              Terapeak CSV import, fuzzy lookup, eviction, auto-import, aggregationMeta tracking (Cosmos write-through + hydration + git-tracked sidecar)
│   ├─ terapeakQuotaService.js         Daily Terapeak query quota tracker
│   ├─ adminService.js                 Admin dashboard aggregation (stats, stale detection [filters via freshnessClassifier], data health)
│   ├─ auditService.js                 Audit log writer (action + actor + resource triples)
│   ├─ freshnessClassifier.js          Shared refresh-skip logic (thresholds + shouldSkipRefresh) used by adminService and generate-freshness-report.js -- #229
│   ├─ greysheetHistoryService.js      Daily Greysheet price history snapshots
│   ├─ authService.js                  Server-side auth (bcrypt + JWT, dual-mode Cosmos + local JSON)
│   │                                  JWT_SECRET REQUIRED in production (FATAL throw if unset)
│   └─ coinStorageService.js           Server-side coin CRUD (dual-mode Cosmos + local JSON)
│
├─ src/data/
│   ├─ pcgsNumbers.js                  Static PCGS coin number lookup (10 US series + 7 world bullion: Kookaburra, Krugerrand, Kangaroo, Maple Leaf, Britannia, China Panda, China Lunar)
│   ├─ keyDates.js                     Key date / semi-key detection tables
│   ├─ mintages.js                     Mintage reference data by series/year/mint
│   ├─ halfDollarSeries.js             Half Dollar design eras + year-based resolver
│   ├─ constants.js                    Zodiac cycle + Perth Lunar series helpers
│   ├─ barSeries.js                    Bar brand/series data (7 brands, 40+ series) + detection helpers
│   ├─ dealerPremiums.js               Dealer premium benchmark ranges by bullion series (#196) -- lookupPremiumRange, classifyPremium, computePremium
│   └─ lunarReference.js               Perth / Royal / RAMint lunar comparison
│
├─ src/utils/
│   ├─ cache.js                        TTLCache class (in-memory + optional file persistence)
│   ├─ stats.js                        Statistical functions (median, MAD, weighted median, etc.)
│   ├─ filters.js                      Deny-list filtering, denomination & series checks, two-way composition mismatch (silver/clad)
│   ├─ coinMetalProfile.js             Metal detection + weight detection (detectWeightFromTitle, weightToKeyToken) for bullion
│   ├─ coinIntent.js                   Route-layer extractor: canonicalizes {grade, finish, isProof, designation} across coinData / options / pcgs / parsed (#254)
│   ├─ responseValidator.js            /api/price response schema & sanity validation
│   ├─ excelMapper.js                  Excel-to-backup converter (header aliases, series normalization)
│   ├─ cachePath.js                    Centralized CACHE_DIR from env var
│   ├─ cosmosClient.js                 Azure Cosmos DB client singleton (env-var gated)
│   └─ blobClient.js                   Azure Blob Storage client (managed identity)
│
├─ src/data/
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
│   ├─ terapeak_sold.json              Imported Terapeak comp data (~3,306 datasets)
│   ├─ terapeak-runs/                  Append-only JSONL ledger for operator-codespace runs (#200): `passes.jsonl` (one record per pass), `coins.jsonl` (one record per coin attempt)
│   ├─ users.json                      Server-side user accounts (bcrypt hashes + UUIDs)
│   └─ user_coins.json                 Server-side coin collections (plaintext JSON by userId)
│
├─ data/
│   ├─ terapeak/                       ~3,249 Terapeak CSV exports (real sold data)
│   └─ terapeak-meta.json              Git-tracked aggregation metadata sidecar (see below) + dormant tracking
│
├─ docs/
│   ├─ ARCHITECTURE.md                 This file -- technical architecture reference
│   ├─ BACKLOG.md                      Canonical backlog (single source of truth)
│   ├─ BACKLOG.rules.md                Backlog governance rules & PR hygiene expectations
│   ├─ runbooks/
│   │   ├─ secret-bootstrap.md         New-machine secret bootstrap via Azure Key Vault + load-secrets.sh (#138)
│   │   ├─ local-scraper-wsl2.md       WSL/Surface scraper fast-path runbook
│   │   ├─ first-launch-surface.md     First-launch checklist for the Surface scraper laptop
│   │   └─ scraper-travel-mode.md      Codespace travel-mode fallback for the scraper path
│   └─ testing/
│       └─ test-monitor.md             Test Monitor usage guide & command reference
│
├─ scripts/
│   ├─ cpf-go                          One-command WSL bootstrap + scraper launcher (#258; merge commit reads #252); page-1 batch size randomized 15-30 per loop pass for bot evasion (#268H)
│   ├─ terapeak-operator.sh             Canonical deterministic launcher (H-machine / WSL Surface): preflight(login) -> optional login -> preflight(loop) -> freshness pass (#168); randomized page-1 batching window (`--batch-min/--batch-max`) and run-scoped pass logs (`cache/terapeak-operator-passes/<RUN_ID>/pass-XXXX.log`) (#191)
│   ├─ terapeak-operator-codespace.sh   Codespace (W-machine) operator sibling (#200): no `~/.env.surface` dependency, system `python3`, unlimited loop by default (`--max-passes 0`), single-instance `flock` lock, jittered pause 600s +/- 90s. Per-run logs under `cache/terapeak-operator-codespace-passes/<RUN_ID>/`
│   ├─ _parse-terapeak-pass.py          Best-effort parser invoked by the codespace operator after each pass; appends to `cache/terapeak-runs/passes.jsonl` + `coins.jsonl`. Parse failures log to stderr but never fail the operator loop (#200)
│   ├─ show-terapeak-runs.sh            jq-backed viewer for the JSONL ledger (#200). Subcommands: `recent`, `runs`, `run <RUN_ID>`, `coin <pattern>`, `totals`, `stop-conditions`. Flags: `--since`, `--until`, `--json`
│   ├─ test_parse_terapeak_pass.py      Unit tests for `_parse-terapeak-pass.py` (synthetic fixture; `python3 scripts/test_parse_terapeak_pass.py` exits 0 on pass) (#200)
│   ├─ terapeak-startup-preflight.sh    Startup preflight gate (runtime/env/tooling/cookie health) for operator flow (#168)
│   ├─ run-surface-freshness-loop.sh   Orchestrator: meta sync (#259; merge commit reads #253) -> freshness report -> page-1 batch -> deep-paginate
│   ├─ load-secrets.sh                 Pull 8 dev secrets from Azure Key Vault `coinpricefinder-kv` into `.env` (mode 600); modes dryrun/--print/--write (#137)
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
│   ├─ reclassify-comps.js             Batch comp reclassification (weight mismatch detection + reroute)
│   ├─ build-evidence-index.js         Historical evidence index builder
│   ├─ generate-freshness-report.js    Freshness triage report (5-state decision tree: Fresh/Stale/LowSignal/Missing/Dormant + recently-confirmed-stale split)
│   ├─ freshness-composition-analyzer.js  Cross-tabulates the freshness report by composition to surface structural coverage gaps (#270H)
│   ├─ scan-parallel-key-drift.js      Silent-drift detector for the #267H class -- flags datasets whose normalized key collides with an empty sibling (#272H). `npm run scan:parallel-key-drift`
│   ├─ fmv-drift-monitor.js            FMV drift monitor (#196) -- runs bullion catalog through /api/price, flags rows outside dealer-premium band
│   ├─ investigate-libertad-batch.js   Libertad lot-evaluator diagnostic (#202) -- re-runs 13-coin batch, flags thin comps + duplicate FMV instability
│   ├─ lot-estimator-health.js         Lot Evaluator health check -- runs the 13-coin diagnostic batch through the batch route + reports FMV stability. `npm run health:lot-estimator`
│   ├─ sync-terapeak-meta.js           Remote-scraper meta sync helper (#253) -- called by `run-surface-freshness-loop.sh` before each pass; pulls current `data/terapeak-meta.json` from `/api/admin/terapeak-meta` and atomically replaces the local sidecar so the freshness classifier reads Azure-current state, not a git-frozen snapshot. `npm run sync:meta`
│   └─ test-metrics/                   Jest metrics capture + summary reporter
│
├─ .github/
│   ├─ agents/
│   │   ├─ freshness-triage.agent.md              Dataset freshness triage + refresh prioritization
│   │   ├─ pre-commit-reviewer.agent.md           Quick pre-commit safety check
│   │   ├─ code-reviewer.approval-gated.agent.md  Conductor for multi-agent code review
│   │   ├─ implementer.approval-only.agent.md     Applies approved review findings
│   │   ├─ performance-review.sub.agent.md        Performance-focused sub-reviewer
│   │   ├─ security-review.sub.agent.md           OWASP-focused security sub-reviewer
│   │   ├─ ux-reviewer.agent.md                   Accessibility and UX review
│   │   ├─ pricing-health.agent.md                Pricing accuracy diagnostics
│   │   ├─ numismatic-audit.agent.md              Audit classification against numismatic terminology
│   │   ├─ sales-aggregator.agent.md              Sales data aggregation assistant
│   │   ├─ test-coverage.agent.md                 Test coverage gap analysis + generation
│   │   ├─ test-monitor.agent.md                  Test health monitoring and diagnostics
│   │   └─ onboard.agent.md                       Project onboarding assistant
│   ├─ prompts/
│   │   ├─ pre-commit.prompt.md                   /pre-commit slash command
│   │   ├─ review-deep.prompt.md                  /review-deep slash command
│   │   ├─ apply-approved.prompt.md               /apply-approved slash command
│   │   ├─ pricing-health.prompt.md               /pricing-health slash command
│   │   ├─ test-coverage.prompt.md                /test-coverage slash command
│   │   └─ onboard.prompt.md                      /onboard slash command
│   └─ copilot-instructions.md                    Workspace-wide Copilot rules
│
└─ __tests__/                          73 Jest test suites
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

**Grade-type pool split:** After comps are collected, `classifyGradeType()` classifies each comp into one of three pools: `graded` (PCGS/NGC slabbed or formal grade in title), `proof` (slabbed or unslabbed proof coins -- title contains "proof" but not "proof-like"; slabbed proofs with `conditionId=2000` are detected via proof regex in title -- #182), or `raw` (everything else). The valuation engine selects the appropriate pool based on user intent: graded if a grade is specified, proof if grade is "Proof"/"PF"/"PR", raw otherwise. For proof queries, the proof pool is used unconditionally regardless of count (1-2 comps flags `lowData`; 0 comps returns null FMV -- #184). **All three pools are strictly isolated** -- raw queries use only raw comps (#270W Option #4 / PR #186) and graded queries use only graded comps (#272W); no silent fallback to all-comps when the preferred pool is thin (see `docs/memory/numismatic-terminology.md` -- Pool-Isolation Contract; INC-013 in `docs/WASTE-LEDGER.md`). When a graded query has zero graded comps AND no PCGS price guide AND no Greysheet anchor, the engine may return a last-resort raw blend only if at least 10 raw sold comps exist (the tightened #176 V2 fallback); otherwise FMV is null with `dataSource.label = 'guide-only'` (guide present but no comps) or `'metal-only'` (bullion fallback). Designation-aware scoring (#183): `scoreMatch()` applies +10 for DCAM/CAM match, -15 for mismatch on proof coins. This prevents proof coin prices (typically 2-5x BU) from contaminating raw coin valuations.

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
- **Weight**: `1 oz`, `1/2 oz`, `1/4 oz`, `1/10 oz`, `1/20 oz`, `1.5 oz`, `2 oz`, `5 oz`, `10 oz`. Also accepts Spanish `onza` / `onzas` as an `oz` synonym for Casa de Moneda Libertad titles (#283W).
- **Set type**: proof set, silver proof set, prestige proof set, mint set
- **Exclusion operators**: tokens prefixed with `-` (e.g. `-proof`, `-gold`, `-W`) are stripped from parsed fields and passed through as negative keywords to eBay queries

**Mint filtering (#167):** Only an explicitly user-specified mint mark drives comp filtering in `applyFilters()`. When no mint mark is provided in the query, the `mintMismatch` filter is disabled entirely -- previously the system could infer a mint from the dataset name and over-filter comps. The `usMinComps` threshold is 8 (not 3) to ensure sufficient comps before falling back to global.

**Metal exclusion keywords (#171, #172):** `buildKeywords()` appends `-silver` for gold coin queries and `-gold` for silver coin queries, preventing cross-metal contamination in eBay results (e.g. silver bars appearing in Gold Libertad searches).

**Historical meltFloor (#171, #172):** The meltFloor filter in `applyFilters()` uses `getSpotOnDate(metal, soldDate)` from `metalsHistoryService` to compute melt value based on each comp's actual sale date, rather than today's spot price. This prevents older comps from being incorrectly rejected when spot has risen significantly since they were sold. Falls back to today's spot if no historical price is available within a 7-day tolerance.

**Type 1/2 variant filter (#180):** When `expected.label` contains "Type 1" or "Type 2", `applyFilters()` hard-removes comps whose titles reference the opposite type (e.g. "Type 2" titles when pricing a Type 1 coin). `pcgsService.parseDescription()` detects "Type 1" / "Type 2" in descriptions and sets `result.label`, which is passed through from the identification step to the expected object in `priceRoute.js` and `pricingBatchRoute.js`.

**Specialty-edition family filter (#283W):** `VARIANT_FAMILY_TOKENS.specialtyEdition` (in `ebayService.js`) covers mint-issued commemorative runs that share the standard `proof` title token but command different premiums (e.g. Casa de Moneda `elite libertad`, `libertad traders`, `traders convention`). `applyFilters()` rejects these titles regardless of the caller's `wantsProof` intent, so they never blend into the standard-Proof pool. Add new tokens here as additional specialty runs are identified.

---

## Terapeak Sales Aggregation Architecture

The project uses two Python scripts (Playwright-based) and one Node.js script to build and maintain the Terapeak sold-comp dataset. All run inside a VNC session (Xtigervnc :1, port 5901, noVNC on 6080).

### Page 1 Aggregator -- `scripts/terapeak-export.py`

Automates Terapeak CSV downloads from eBay Seller Hub Research:

```
┌─ Phase 1: Login ──────────────────────────────────────────┐
│  --login flag → visible browser, manual eBay sign-in      │
│  Cookies saved to $COOKIE_FILE (default:                  │
│    cache/ebay_cookies.json; override per machine to       │
│    keep residential + Codespace jars separate -- #250)    │
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

**Dual-path execution model (#250):** the scraper runs from two environments
that must each maintain their own cookie jar. Akamai bot-management binds
session trust to the IP + browser fingerprint that first authenticated;
reusing one persistent identity across an Azure data-center IP and a
residential IP is a high-confidence fraud signal. Preferred path is a
personal laptop (e.g. Surface + WSL2 Ubuntu) on a residential IP; the
Codespace is a travel fallback. The `COOKIE_FILE` env var (with `~`
expansion) selects which jar to load; defaults preserve single-machine
behavior. Pre-flight gate: `scripts/cookie-health-check.py` exits
`0/1/2/3/4` for HEALTHY/EXPIRED/CHALLENGED/MISSING/PROBE_FAILED. Runbooks:
[docs/runbooks/local-scraper-wsl2.md](runbooks/local-scraper-wsl2.md) and
[docs/runbooks/scraper-travel-mode.md](runbooks/scraper-travel-mode.md).

Key flags: `--batch N` (coin count), `--priority` (thin-data-first), `--resume` (continue after crash), `--refresh` (re-collect stale CSVs by file age), `--max-age DAYS` (staleness threshold, default 14).

**Remote-scraper meta sync (#259):** the on-disk `data/terapeak-meta.json`
sidecar is only written by `saveMetaSidecar()` inside the Node server
process. Remote scrapers running under `UPLOAD_MODE=api` (WSL/Surface and
Codespaces) POST CSVs to Azure for ingest, so their local sidecar is
git-frozen and `generate-freshness-report.js` keeps re-targeting the same
coins forever. `scripts/run-surface-freshness-loop.sh` calls
`sync_meta_from_app()` before each freshness pass, which `curl`s
`GET /api/admin/terapeak-meta` (auth via `ADMIN_API_KEY`), validates the
JSON, and atomically replaces the local sidecar. Any failure (missing key,
non-200, non-JSON, transport error) logs `[warn]` and the loop proceeds
with the existing on-disk copy -- never crashes.

**Sort-skip optimization (#200):** Both scripts use a module-level `_sort_confirmed` flag to skip redundant "Date sold" column sort clicks. On first page load the script clicks the sort column and waits for re-render; after CSV write, it validates date order (first >= last = descending). If confirmed, subsequent pages skip the sort step entirely. The flag resets on browser recycle (every 40/80 coins), bot-block detection, or crash recovery via `reset_sort_state()`.

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

**Persistence tiers:** aggregationMeta is persisted through four independent mechanisms, loaded in priority order at startup:

1. **Git-tracked sidecar** (`data/terapeak-meta.json`) -- lightweight JSON file storing per-dataset metadata. Git-tracked so it survives codespace rebuilds and cache wipes without any infrastructure dependency. Loaded first via `loadMetaSidecar()`. Debounce-written (1s) whenever `importComps()` detects a metadata change. **Server-side only:** the writer runs inside the Node process, so any clone that does not host the Node server (remote scrapers under `UPLOAD_MODE=api`) sees a git-frozen copy unless it pulls from the server -- see tier 4.
2. **Cosmos DB write-through** -- aggregationMeta is written to the `terapeak-sold` Cosmos DB container on each import. On startup, `hydrateMetaFromCosmos()` merges Cosmos markers into the in-memory store (after sidecar load). Only active when Cosmos connection string is configured.
3. **CSV row-count inference** -- `importComps()` infers `deepAt` from comp count (>50 = was deep-paginated). Catches legacy datasets that predate explicit tracking.
4. **Remote-scraper HTTP pull (#259)** -- machines running `scripts/run-surface-freshness-loop.sh` (WSL/Surface, Codespaces) call `sync_meta_from_app()` before every freshness pass, which `curl`s `GET /api/admin/terapeak-meta` and atomically replaces their local `data/terapeak-meta.json`. Without this step the local sidecar is git-frozen and the classifier re-targets already-scraped coins forever, making the scraper loop appear to make zero progress. Failures degrade to `[warn]` and the loop continues with whatever is on disk.

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
| `noDataCount` | number | Consecutive empty Terapeak results (dormant tracking) |
| `noDataAt` | ISO timestamp | When the last no-data result was recorded |

The `newestSaleDate` field enables **reliable staleness detection** based on actual sale data, not file modification times. A dataset is genuinely stale when `today - newestSaleDate > 30 days`, regardless of when the file was last touched.

**deepAt inference:** When `importComps()` receives a dataset with >=100 comps but no explicit `deepAt` marker, it automatically infers `deepAt` from the current timestamp. This handles legacy deep-paginated datasets collected before aggregationMeta tracking was added.

**Dormant dataset tracking:** Datasets that consistently return zero Terapeak results are marked dormant to avoid wasting scrape cycles. When `terapeak-export.py` encounters "NO EXPORT", it calls `POST /api/terapeak/report-no-data` to increment `noDataCount` and stamp `noDataAt`. After 2+ consecutive empty attempts, `generate-freshness-report.js` assigns the `dormant` action and the export script skips those datasets. Self-healing: successful import resets `noDataCount` to 0; dormant status auto-expires after 60 days. Parse/upload failures that return HTTP 422 from `/api/terapeak/import` do **not** increment no-data markers.

**CSV merge protection (PR #21):** The export script's file-move step uses `_merge_csv()` instead of destructive overwrite. New rows are deduplicated against existing data (by `itemId` exact match and `title+price+date` composite key). A shrink guard refuses to write if the merged result has fewer rows than the existing file -- preventing deep-paginated CSVs (100-580 rows) from being truncated by single-page refreshes (<=50 rows).

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

**Per-dataset metadata:** Each dataset stores `aggregationMeta: { page1At, deepAt, maxPageReached, lastRefreshAt, newestSaleDate, oldestSaleDate, compCount, noDataCount, noDataAt }` to track aggregation provenance, data freshness, and dormant status. `importComps()` merges aggregationMeta intelligently (never overwrites earlier timestamps, maxPageReached only increases, sale date bounds expand monotonically, noDataCount resets on successful import).

**Import-time reclassification:** `importComps()` detects weight mismatches at import time. For each comp, `detectWeightFromTitle()` (from `coinMetalProfile.js`) extracts the actual weight from the listing title and compares it to the dataset's expected weight (from `detectWeightFromQuery()`). Mismatched comps are automatically rerouted to the correct dataset key using `weightToKeyToken()` mapping (e.g. a 1/4 oz comp imported into a 1oz dataset is rerouted to the "quarter oz" dataset). Metal mismatches are left in place for the meltFloor filter. The `reclassified` count is included in the import result.

**Admin endpoints:**
- `GET /api/terapeak/aggregation-status` -- summary + filtered dataset lists (`needs=deep`, `needs=page1`, `needs=refresh&maxAge=N`, `minComps=N`)
- `POST /api/terapeak/report-no-data` -- increment `noDataCount` for a dataset (called by export script on empty results)
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
│  → excludes dormant / confirmed-thin / thin-wait /        │
│    recently-confirmed-stale / dry-refresh-backoff via     │
│    src/services/freshnessClassifier.js::shouldSkipRefresh │
│  → ?includeSkipped=true returns all rows + skipReason     │
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

1. If user grade is "Proof"/"PF"/"PR" → use `proof` comps pool unconditionally (never falls back to BU/raw; 0 comps returns null FMV -- #184)
2. If user specified any other grade → use `graded` comps pool strictly (#272W); if `gradedSold === 0` AND no PCGS price guide AND no Greysheet anchor AND `rawSold >= 10`, the engine returns a last-resort raw blend (tightened #176 V2 fallback) with `poolFallback: true` and a -10 confidence penalty; otherwise FMV is null with `dataSource.label = 'guide-only'` or `'metal-only'`
3. If no grade specified → use `raw` comps pool strictly (#270W Option #4 / PR #186); excludes both graded AND proof; no fallback to all-comps when raw pool is thin
4. Explanation notes which pool was used, how many were excluded, and (when the #176 V2 fallback fires) why graded→raw was permitted

`classifyGradeType()` priority chain:
- conditionId 2000 ("Certified") → `graded`
- TPG regex (PCGS/NGC/ANACS/ICG/CGC) or formal grade (MS-64, PF-69) → `graded`
- `/\bproof\b(?![\s-]*like)/i` in title → `proof`
- Everything else → `raw`

This ensures unslabbed proof coins (e.g. Proof Libertads in OGP) don't inflate raw BU valuations.

**#282H -- proof / RP skip the bullion spot+premium branch.** Once the proof comp pool is selected, the engine also sets `skipSpotMath = wantsProof || wantsReverseProof`. This routes proof traffic through the standard comp-blend path (`raw-blend` / `certified-blend`) rather than the `bullion-spot-premium` math, whose silver / gold premium clamps (spot * 2 / spot * 1.4) would silently collapse dozens of distinct proof dates to one FMV. For BU bullion queries with no eBay comps, the fallback ladder is `bullion-greysheet-anchor` (Greysheet >= 80% of spot) -> `bullion-spot-only`. See [docs/memory/decision-engine-spec.md](docs/memory/decision-engine-spec.md) for the full mode list and triggers.

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
| `COOKIE_FILE` | No | `cache/ebay_cookies.json` | Per-machine cookie jar for `terapeak-export.py` and `cookie-health-check.py`. Set to a path outside the worktree on each host (e.g. `~/cpf/state/cookies-surface.json`) to keep Akamai trust intact when running from multiple machines. (#250) |
| `METALS_POLL_MS` | No | `1800000` | Metals spot-price polling interval (ms) |
| `EBAY_DEFAULT_LOOKBACK_DAYS` | No | `180` | Default sold-comp lookback window. Tier ladder extends through 365 -> 730 -> `all` when the Terapeak-only pool is thin (#270W Option #1, PR #188). Supplemented path still caps at 365 (tracked: #275W). |
| `BLOB_REIMPORT_MS` | No | `1800000` | Periodic blob re-import interval (ms; 30 min default) |
| `GS_REFRESH_INTERVAL_DAYS` | No | `3` | Days between automatic Greysheet background refreshes |
| `NUMISTA_API_KEY` | No | -- | Numista API key for rarity/mintage lookups |
| `PCGS_PREFETCH_ENABLED` | No | `true` | Enable/disable nightly PCGS prefetch scheduler |
| `PREFETCH_HOUR_PT` | No | `23` | Prefetch run hour in Pacific time |
| `PREFETCH_THROTTLE_MS` | No | `1000` | Delay between prefetch PCGS calls (ms) |
| `PREFETCH_RESERVE` | No | `10` | Quota calls reserved from prefetching |
| `APR_DATE_WINDOW_YEARS` | No | `3` | Auction history lookback window in years |
| `APR_FRESHNESS_DAYS` | No | `30` | Auction history recrawl freshness threshold in days |
| `SENDGRID_API_KEY` | No | -- | SendGrid key for crash/ops alerts |
| `ALERT_EMAIL_TO` | No | -- | Destination email for alerts |
| `ALERT_FROM_EMAIL` | No | `alerts@coinpricefinder.app` | Sender email for alerts |
| `STRICT_TOKEN_CACHE_TTL_MS` | No | `5000` | TTL (ms) for `verifyTokenStrict` username cache. `0` disables. Invalidated on every `_saveUser` / `deleteUser`. (#218) |
| `BROWSER_RECYCLE_EVERY` | No | `80` / `120` | Playwright browser-recycle interval override. Defaults: `terapeak-export.py` 80, `sales-aggregator.py` 120. (#199) |

---

## Background Timers (server.js)

The server starts several background tasks on boot:

| Timer | Interval | Purpose |
|-------|----------|---------|
| Metals spot price | 30 min (`METALS_POLL_MS`) | Round-robin fetch from goldapi.io / metals-api.com; persists to `metals_spot.json` |
| Greysheet history refresh | `GS_REFRESH_INTERVAL_DAYS` days (default 3) | Runs `scripts/greysheet-refresh.js` to snapshot wholesale prices for all tracked coins. Checks `greysheetHistoryService.getLastRefreshDate()` on startup and every hour; skips if interval not elapsed. |
| Blob re-import | 30 min (`BLOB_REIMPORT_MS`) | Polls Azure Blob Storage for new Terapeak CSV uploads; clears eBay cache on new data |
| Greysheet history eviction | Startup only | Evicts history entries older than 400 days |
| Terapeak meta sidecar | Startup only | Loads `data/terapeak-meta.json` (aggregation markers + sale date bounds); auto-seeds file on first run |
| Terapeak auto-import | Startup only | Imports CSVs from `data/terapeak/` (files < 7 days old) |
| Test account seed | Startup only | Seeds `testcollector` account with sample coins if empty |

### PCGS Prefetch Scheduler -- queue construction (PR-2b)

`src/services/prefetchScheduler.js` builds the nightly queue from the data
tables in `src/data/pcgsNumbers.js`. The queue is a flat list of
`{pcgsNo, grade, priority, lastFetched}` records consumed by
`executePrefetchRun()` until the daily PCGS quota (default 990 calls) is
spent or the breaker trips.

**Phase 1 -- Key dates (always at the front of the queue)**

`getKeyDatePcgsNumbers()` walks `KEY_DATES` from `src/data/keyDates.js` and
resolves each `(series, year, mint)` triple via `lookupPCGSNumber`. Each
resolved number is expanded against `targetGradesFor(year)` (see below).
Priority `1` = never-fetched key date, `2` = stale key date.

**Phase 2 -- Regular coins, round-robin by category**

`getCategorizedEntries()` walks `TABLES_BY_CATEGORY` (a new export from
`src/data/pcgsNumbers.js`) and produces three buckets:

| Category | Source tables | Approx pre-dedup combos |
|---|---|---|
| `us_classic` | 22 tables: Lincoln, Morgan, Peace, Washington, Roosevelt, Kennedy, Franklin, Jefferson, Mercury, Walking Liberty, Eisenhower, Barber (D/Q/H), SLQ, Seated Dollar, Liberty/Indian Half Eagles, Indian Eagle, Liberty/Saint-Gaudens Double Eagles | ~1,332 |
| `us_bullion` | 8 tables: ASE, AGE 1oz/half/quarter/tenth, Gold Buffalo, Platinum Eagle, Palladium Eagle | ~287 |
| `world_bullion` | 18 tables: Libertad x2, Kookaburra, Krugerrand, Kangaroo, Maple Leaf, Britannia, Panda, Lunar x4 (Perth + China), WTE x3, Koala x3 | ~462 |

Each bucket is sorted by `(priority asc, lastFetched asc)` and then the three
buckets are **interleaved 1:1:1** in `PHASE2_ROUND_ROBIN_ORDER =
['us_classic', 'us_bullion', 'world_bullion']`. This fixes the previous
starvation pattern where Phase 2 iterated source-file order, leaving world
bullion (positions 30-47 in `pcgsNumbers.js`) effectively unreachable
within a 14-23 day quota window. The spike on 2026-06-29 confirmed 0 of
749 bullion PCGS#s cached after ~30 nightly runs (separate from the
Phase 1 destructure bug fixed earlier the same day).

Priority `3` = never-fetched regular, `4` = stale regular. Dedup is per
`pcgsNo:grade` via a single `Set` shared across both phases.

**`targetGradesFor(year)` -- era-aware grade pruning (PR-2b)**

Querying PCGS APR for grades with zero population is wasted quota.
`targetGradesFor` returns a pruned grade ladder based on the coin's mint
year:

| Year range | Grade ladder | Reason |
|---|---|---|
| `year < 1900` | `[60, 61, 62, 63, 64, 65]` (6) | Pre-1900 issues, especially classic gold, almost never grade above MS65 |
| `1900 <= year < 1934` | `[60..67]` (8) | Classic-era issues rarely grade above MS67 |
| `year >= 1934` or null | `[60..70]` (11) | Modern + bullion: keep full ladder; null falls back to full to avoid silent coverage loss |

Each PCGS number's year is resolved from `pcgsYearMap` (first-seen wins for
the ~80 collision cases between `AMERICAN_SILVER_EAGLE` and
`AMERICAN_GOLD_EAGLE_*OZ` tables -- pre-existing data bug, follow-up
required; functionally harmless because both colliding tables are modern
bullion using the same 11-grade ladder anyway).

**Queue size impact**

| State | Total combos | Drain time at 990/day |
|---|---|---|
| Pre-PR-2a baseline | ~13,700 | ~14 days |
| Post-PR-2a (no pruning, source-order) | ~22,099 | ~23 days |
| **Post-PR-2b (era pruning + round-robin)** | **~14-18k** | **~14-18 days + world bullion reached daily** |

The headline win is not raw queue size -- it's that world bullion is no
longer behind the entire US block. Round-robin guarantees one world-bullion
call for every two US calls every night.

**Status observability (#277W, 2026-07-03)**

Each `saveStatus` write from `executePrefetchRun` includes a `perCategory`
object -- `{ us_classic, us_bullion, world_bullion, unknown }` each with
`{ attempted, newRecords }` counters -- so `/api/admin/prefetch-status` can
verify the round-robin actually delivered its 1:1:1 share on any given
night. Queue entries are tagged with `category` at build time (Phase 1 via
`pcgsCategoryMap` from `getCategorizedEntries`, Phase 2 from the bucket key)
so the accumulator does not need a second table lookup per call.

The safety-net "no quota available" skip write no longer overwrites
`status` / `lastRun`. It records into a separate `lastAttempt` /
`lastAttemptStatus` / `lastAttemptReason` namespace, so a completed
in-process run at 23:00 PT keeps `lastStatus: 'completed'` even after the
GH Actions safety-net races into the same day.

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
