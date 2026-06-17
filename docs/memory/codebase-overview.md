# Coin Price Agent — Codebase Overview

## IMPORTANT: Server Startup
- ALWAYS use `isBackground: true` when running `node server.js` -- the server never exits and will block the terminal forever otherwise.
- After starting, use `get_terminal_output` to confirm it's up, then run all subsequent commands in a separate foreground terminal.

## Stack
- **Runtime:** Node.js 22, Express 5.2, CommonJS
- **Frontend:** Single-page app in `public/index.html` (~6,982 lines), dark theme, 9 tabs
- **Auth:** Server-side bcrypt + JWT (authService.js); client modules are thin API wrappers
- **Hosting:** Azure App Service (Linux, B2, Canada Central) -- `coinpricefinder-h3a3b5g0dmdydna4`
- **Azure Services:** Key Vault (`coinpricefinder-kv`), Cosmos DB (`coinpricefinder-cosmos`, serverless), Blob Storage (`coinpricecache01/terapeak-csvs`), Azure Files (`appcache` at `/mnt/cache`)
- **CI/CD:** GitHub Actions with OIDC -> Azure (`main_coinpricefinder-h3a3b5g0dmdydna4.yml`)
- **Tests:** Jest 30, 48 suites, ~2,100+ tests, `npm test`

## Project Structure
```
server.js                   Express entry, port 3000, helmet, rate limiting, background timers
public/
  index.html               SPA (all HTML/CSS/JS inline except 3 JS modules)
  js/auth.js               CoinAuth: server-backed login/signup (JWT in memory)
  js/storage.js            CoinStorage: server-backed coin CRUD via /api/coins/*
  js/my-coins.js           MyCoins: portfolio render with batch pricing
src/
  routes/                  14 Express route modules
  services/                16 service modules
  data/                    Static reference data (PCGS numbers, key dates, mintages, greysheetTypeMap, etc.)
  utils/                   Cache, stats, filters, coinMetalProfile, responseValidator, excelMapper, cachePath, cosmosClient, blobClient
data/terapeak/             CSV import folder (~2,834 CSVs, auto-loaded at startup)
cache/                     Persisted caches (ebay, pcgs, greysheet, metals, terapeak, users, user_coins, history files)
scripts/                   Terapeak scrapers, greysheet-refresh, migrate-to-cosmos, upload-csvs-to-blob, test-metrics
docs/ARCHITECTURE.md       Full technical docs
docs/BACKLOG.md            Canonical backlog (single source of truth for planned/in-progress/done work)
docs/BACKLOG.rules.md      Backlog governance rules, approval gates, PR hygiene expectations
docs/testing/test-monitor.md  Test Monitor usage guide & command reference
.github/agents/            13 Copilot agents (code-reviewer, implementer, onboard, pricing-health, sales-aggregator, freshness-triage, etc.)
.github/prompts/           6 slash-command prompts (/review-deep, /apply-approved, /pre-commit, /test-coverage, /onboard, /pricing-health)
.github/skills/            Shared code-review skill (SKILL.md)
__tests__/                 56 Jest test suites (~2,658 tests)
```

## 9 Tabs
1. **Price Discovery** -- Coin + Bar sub-modes, POST /api/price or /api/bar-price
2. **Melt Calculator** -- 80+ coin types + 20 bar types, live spot from /api/metals
3. **Live eBay Tracker** -- Market matrix (year x mint, year x grade, or brand), GET /api/market/ebay
4. **Lot Evaluator** -- Bulk collection pricing (50-500 coins), SSE streaming, POST /api/bulk-evaluate
5. **Sold Data (Terapeak)** -- CSV import + quota tracking, admin-gated writes
6. **My Coins** -- Auth-gated, server-backed collection with live FMV pricing + Cosmos DB write-through
7. **Price History** -- Auth-gated, canvas chart with metal overlay, GET /api/coin-history
8. **About** -- Docs, confidence key, privacy, disclaimer, feature previews for logged-out users
9. **Admin** -- Hidden, admin-key-gated dashboard (users, data health, stale datasets, cache controls)

## API Routes
| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| /api/price | POST | -- | Full coin pricing (PCGS + eBay + valuation) |
| /api/bar-price | POST | -- | Bullion bar pricing |
| /api/pricing-batch | POST | -- | Batch pricing (<=25 coins, lightweight) |
| /api/bulk-evaluate | POST+GET+SSE | -- | Lot evaluator (50-500 coins, SSE streaming) |
| /api/metals[/:metal] | GET | -- | Spot prices (XAU, XAG, XPT, XPD) |
| /api/coin-variant | GET | -- | Half-dollar design series lookup |
| /api/market/ebay | GET | -- | Market matrix (series across years/mints) |
| /api/terapeak/* | Mixed | Some admin | CSV import, lookup, datasets, quota |
| /api/image-proxy | GET | -- | Numista image proxy (allowlisted hosts) |
| /api/coin-history | GET | -- | Price time-series from Terapeak data |
| /api/import/excel | POST | -- | Import .xlsx spreadsheet as coin collection |
| /api/auth/* | POST | -- | Signup, login, me, change-password |
| /api/coins/* | Mixed | JWT | Collection CRUD (add, list, update, delete, export, import) |
| /api/admin/* | Mixed | Admin | Dashboard, users, data health, stale datasets |
| /api/clear-cache | POST | Admin | Clear all caches |
| /api/health | GET | -- | Health check |

## Services
- **ebayService** -- 4-tier comp cascade (Terapeak CSV -> Marketplace Insights -> Finding (dead) -> Browse API), circuit breaker (5min), throttle (1.1s), match scoring, outlier removal
- **pcgsService** -- PCGS CoinFacts API, parseDescription text parser, static PCGS number table
- **valuationService** -- FMV blending (3 modes: bullion-spot-premium, certified-blend, raw-blend), confidence scoring, buy/sell decisions, grade-tiered weights, sale context adjustment
- **greysheetService** -- Greysheet CDN Public API V2 (wholesale/retail pricing, 5 price sources), finish-aware type fallback
- **bulkEvaluateService** -- Lot evaluator (50-500 coins), 10-coin concurrency, 3-job cap, SSE streaming, lot-level discounts
- **metalsSpotPrice** -- 4-provider round-robin (gold-api-com, goldprice-org, goldapi, metals-api), multi-tier fallback (live -> stale -> disk -> hardcoded)
- **metalsHistoryService** -- Daily spot snapshots (cache/metals_history.json + Cosmos)
- **greysheetHistoryService** -- Daily Greysheet price snapshots (cache/greysheet_history.json + Cosmos)
- **numistaService** -- Numista API v3, rarity classification, batch enrichment
- **terapeakService** -- CSV parsing, fuzzy lookup, auto-import (local folder + Azure Blob), stale eviction
- **terapeakQuotaService** -- Daily query quota (250/day default)
- **marketAggregator** -- Year x mint/grade/brand matrix builder
- **authService** -- Server-side auth (bcrypt + JWT, dual-mode Cosmos + local JSON)
- **coinStorageService** -- Server-side coin CRUD (dual-mode Cosmos + local JSON)

## Auth System (Server-Side)
- **authService.js:** bcrypt 12 rounds, JWT HS256 (7d expiry), users.json + Cosmos `users` container
- **coinStorageService.js:** user_coins.json + Cosmos `user-coins` container, SHA-256 coin hashes
- **Client modules:** `auth.js` (thin /api/auth/* wrapper), `storage.js` (thin /api/coins/* wrapper), `my-coins.js` (portfolio UI)

## Key User Features
- **Export Backup** -- Downloads plaintext JSON of all coins (decrypted). Account-independent.
- **Import Backup (JSON)** -- Reads JSON backup, re-encrypts under current account, skips duplicates.
- **Import Backup (Excel)** -- Reads .xlsx spreadsheet via POST /api/import/excel. Maps headers, normalizes series names, extracts year/mint/weight. Returns standard backup JSON for client-side encryption.
- **Auto-Seed Test Account** -- On page load, if `testcollector` doesn't exist, silently creates account with 10 sample coins. Credentials: testcollector / Coins2026!. Logs out immediately so user sees normal login prompt.
- **"I Have This Coin"** -- In search results; adds coin to encrypted storage. Shows lock icon if logged out.
- **Change Password** -- Re-derives key, re-encrypts all coins via `CoinStorage.reEncryptAll()`.
- **Auth-gated tabs** -- My Coins + Price History locked for logged-out users.
- **Cross-tab linkage** -- Price Discovery auto-loads tracker series and history chart.
- **My Coins Table Columns** -- Checkbox (multi-select), Coin, Grade, Qty (+/-), Troy Oz, FMV (ea), Total, Cost (ea -- inline editable), P/L, Melt Value (from live spot), Avg eBay, Range, Notes, Added, Remove.
- **Bulk Delete** -- Select All checkbox + "Delete Selected" button with count and confirmation.
- **Coin Dedup** -- coinHash = SHA-256(series|year|mint|grade|notes), so same coin with different notes = different entry.

## Env Vars
EBAY_APP_ID, EBAY_CLIENT_SECRET, PCGS_API_KEY, GOLDAPI_KEY, METALS_API_KEY, NUMISTA_API_KEY, GREYSHEET_API_TOKEN, GREYSHEET_API_KEY, ADMIN_API_KEY, JWT_SECRET, PORT, CACHE_DIR, COSMOS_ENDPOINT, COSMOS_KEY, TERAPEAK_BLOB_ACCOUNT, TERAPEAK_BLOB_CONTAINER, TERAPEAK_DATA_DIR, METALS_POLL_MS

## Admin Features
- Terapeak CSV import (POST /api/terapeak/import, requires x-api-key)
- Cache clearing (POST /api/clear-cache)
- Quota management endpoints
- Auto-import from data/terapeak/ folder + Azure Blob Storage at startup

## Test Utilities
- **Auto-seed (server.js)** -- `seedTestAccount()` creates `testcollector` / `Coins2026!` with 10 coins on startup if missing. Server-side, persists across browser clears.
- **`__tests__/`** -- 56 Jest test suites (~2,658 tests). Run with `npm test`.
- **`__tests__/helpers/coinTestConstants.js`** -- Shared test helpers: `makeComp()`, `makeComps()`, token lists
- **`samples/`** -- Test fixtures: `test-collection.xlsx`, `no-collectors-sheet.xlsx`.
- **`.test-metrics/`** -- Jest timing metrics: `npm run test:metrics`, `npm run test:summary`

## Dependencies
- **Runtime:** express, helmet, express-rate-limit, axios, csv-parse, dotenv, multer, xlsx, bcrypt, jsonwebtoken, @azure/cosmos, @azure/storage-blob, @azure/identity
- **Dev:** jest, axios-mock-adapter, supertest


## Quick Start for New Conversations
- Run `/onboard` to read all docs and source files systematically.
- Or at minimum, read this file + `/memories/repo/future-edits.md` for the full backlog.
- The canonical backlog is `docs/BACKLOG.md` (git-tracked, single source of truth). `/memories/repo/future-edits.md` is a detailed supplemental reference.
- For decision engine details, read `/memories/repo/decision-engine-spec.md`.
- Key commits this session: df0a3e6 (Azure KV/Cosmos/cachePath), 17952c7 (Blob/tests/UI features), b41b12c (terapeakService tests).

## Copilot Agents (12)
| Agent | Type | Purpose |
|-------|------|---------|
| `@code-reviewer` | Primary | Full approval-gated code review (conductor) |
| `@implementer` | Primary | Applies only user-approved review items |
| `@pre-commit-reviewer` | Primary | Quick pre-commit safety check |
| `@test-coverage` | Primary | Test gap analysis + test generation |
| `@test-monitor` | Primary | Test health monitoring and diagnostics |
| `@ux-reviewer` | Primary | UX/IA/a11y review (WCAG 2.2, Nielsen heuristics) |
| `@onboard` | Primary | Project onboarding assistant |
| `@pricing-health` | Primary | End-to-end pricing flow validator, comp attrition auditor |
| `@freshness-triage` | Primary | Terapeak data freshness triage and staleness detection |
| `@sales-aggregator` | Primary | Terapeak scraping session orchestrator |
| `@security-review` | Sub-agent | OWASP-focused security sub-reviewer |
| `@performance-review` | Sub-agent | Performance bottleneck sub-reviewer |

## Background Timers (server.js startup)
- **Metals polling**: every 30 min (METALS_POLL_MS), records daily history snapshots
- **Greysheet refresh**: weekly check on startup + 24h re-check interval (GS_REFRESH_DAYS)
- **Blob re-import**: every 30 min (BLOB_REIMPORT_MS), picks up new Terapeak CSVs from Azure Blob
- **Stale eviction**: 180-day Terapeak comp eviction + CSV purge on startup
