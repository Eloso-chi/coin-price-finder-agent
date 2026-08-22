# Coin Price Agent — Codebase Overview

## IMPORTANT: Server Startup
- ALWAYS use `isBackground: true` when running `node server.js` -- the server never exits and will block the terminal forever otherwise.
- After starting, use `get_terminal_output` to confirm it's up, then run all subsequent commands in a separate foreground terminal.

## Stack
- **Runtime:** Node.js 22, Express 5.2, CommonJS
- **Frontend:** Single-page app in `public/index.html`, dark theme, 10 tabs including AI Pricing
- **Auth:** Server-side bcrypt + JWT (authService.js); client modules are thin API wrappers
- **Hosting:** Azure App Service (Linux, B2, Canada Central) -- `coinpricefinder-h3a3b5g0dmdydna4`
- **Azure Services:** Key Vault (`coinpricefinder-kv`), Cosmos DB (`coinpricefinder-cosmos`, serverless), Blob Storage (`coinpricecache01/terapeak-csvs`), Azure Files (`appcache` at `/mnt/cache`)
- **CI/CD:** GitHub Actions with OIDC -> Azure (`main_coinpricefinder-h3a3b5g0dmdydna4.yml`)
- **Observability:** X-Request-ID async context, redacted Pino JSON logs, shallow/deep health checks, versioned valuation audits
- **Tests:** Jest 30; merge commit `715dda32` passed 174 suites / 4,539 tests. Run `npm test` for the current count.

## Project Structure
```
server.js                   Express entry, port 3000, helmet, rate limiting, background timers
public/
  index.html               SPA (all HTML/CSS/JS inline except 3 app modules)
  js/auth.js               CoinAuth: server-backed login/signup (JWT in memory)
  js/storage.js            CoinStorage: server-backed coin CRUD via /api/coins/*
  js/my-coins.js           MyCoins: portfolio render with batch pricing
  js/test-my-coins.js      Browser-only My Coins regression helper
src/
  routes/                  18 Express route modules
  services/                28 service modules
  utils/                   14 shared utility modules
  middleware/              4 request/auth/logging middleware modules
  schemas/                 Price response and AI tool argument schemas
  data/                    Static reference data (PCGS numbers, key dates, mintages, greysheetTypeMap, etc.)
  utils/                   Cache, stats, filters, coinMetalProfile, responseValidator, excelMapper, cachePath, cosmosClient, blobClient
data/terapeak/             CSV import folder; count local CSV/meta files as needed (production truth is via admin endpoints)
cache/                     Persisted caches (ebay, pcgs, greysheet, metals, terapeak, users, user_coins, history files)
scripts/                   Terapeak scrapers, greysheet-refresh, migrate-to-cosmos, upload-csvs-to-blob, test-metrics
docs/ARCHITECTURE.md       Full technical docs
docs/BACKLOG.md            Canonical backlog (single source of truth for planned/in-progress/done work)
docs/BACKLOG.rules.md      Backlog governance rules, approval gates, PR hygiene expectations
docs/testing/test-monitor.md  Test Monitor usage guide & command reference
.github/agents/            14 Copilot agents (see root AGENTS.md)
.github/prompts/           6 slash-command prompts (/review-deep, /apply-approved, /pre-commit, /test-coverage, /onboard, /pricing-health)
.github/skills/            7 shared workflow/domain skill directories
__tests__/                 174 current *.test.js files recursively plus fixtures/helpers/setup
```

## 10 Tabs
1. **Price Discovery** -- Coin + Bar sub-modes, POST /api/price or /api/bar-price
2. **Melt Calculator** -- 80+ coin types + 20 bar types, live spot from /api/metals
3. **Live eBay Tracker** -- Market matrix (year x mint, year x grade, or brand), GET /api/market/ebay
4. **Lot Evaluator** -- Bulk collection pricing (50-500 coins), SSE streaming, POST /api/bulk-evaluate
5. **Sold Data (Terapeak)** -- CSV import + quota tracking, admin-gated writes
6. **My Coins** -- Auth-gated, server-backed collection with live FMV pricing + Cosmos DB write-through
7. **Price History** -- Auth-gated, canvas chart with metal overlay, GET /api/coin-history
8. **About** -- Docs, confidence key, privacy, disclaimer, feature previews for logged-out users
9. **Admin** -- Hidden, admin-key-gated dashboard (users, data health, stale datasets, cache controls)
10. **AI Pricing** -- Optional LLM-powered conversational pricing with deterministic tools, bounded context, provenance, and deterministic fallback when the provider is disabled

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
| /api/health | GET | -- | Shallow load-balancer health check |
| /api/health?deep=1 | GET | Admin | Bounded downstream dependency health |
| /api/ai/price | POST | -- | LLM-or-deterministic conversational pricing; provider disabled by default |
| /api/ai/collection | POST | JWT | Authenticated deterministic collection context |
| /api/ai/market | POST | -- | Bounded deterministic market analytics |

## Services
- **ebayService** -- Terapeak-first comp cascade; deprecated Finding is disabled by default and Browse provides active-listing fallback, with circuit breakers, throttling, match scoring, and pool isolation
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
- **auctionPriceService / prefetchScheduler / pcgsQuotaService** -- PCGS APR history, nightly prefetch, local quota and persisted upstream cooldown recovery
- **auditService** -- Admin and versioned valuation audit events, Cosmos-first with bounded JSONL fallback
- **aiOrchestratorService** -- Server-side Azure OpenAI loop restricted to `identify_coin`, `price_coin`, and `evaluate_purchase`; deterministic results are the numerical authority
- **aiToolRegistry / aiToolSchemas** -- Strict three-tool allowlist, root/nested field validation, timeouts, and trusted-context boundaries
- **llmProviderAdapter** -- Disabled-by-default Azure OpenAI adapter with request timeout and concurrency bounds
- **alertService** -- Rate-limited Azure Communication Services Email alerts with local fallback logging
- **adminService / freshnessClassifier** -- Admin health and shared freshness/dormancy decisions

## Auth System (Server-Side)
- **authService.js:** bcrypt 12 rounds, JWT HS256 (7d expiry), users.json + Cosmos `users` container
- **coinStorageService.js:** user_coins.json + Cosmos `user-coins` container, SHA-256 coin hashes
- **Client modules:** `auth.js` (thin /api/auth/* wrapper), `storage.js` (thin /api/coins/* wrapper), `my-coins.js` (portfolio UI)

## Key User Features
- **Export Backup** -- Downloads authenticated plaintext JSON from server-side coin storage.
- **Import Backup (JSON)** -- Sends a JSON backup to the server, which validates records and skips duplicate hashes.
- **Import Backup (Excel)** -- Reads `.xlsx` via `POST /api/import/excel`, maps headers, and returns normalized coin records for server-side import.
- **Auto-Seed Test Account** -- On page load, if `testcollector` doesn't exist, silently creates account with 10 sample coins. Credentials: testcollector / Coins2026!. Logs out immediately so user sees normal login prompt.
- **"I Have This Coin"** -- In search results; adds a coin to authenticated server-side storage. Shows a lock icon if logged out.
- **Change Password** -- Updates the bcrypt password hash and increments token version; plaintext server-side coin records require no re-encryption.
- **Auth-gated tabs** -- My Coins + Price History locked for logged-out users.
- **Cross-tab linkage** -- Price Discovery auto-loads tracker series and history chart.
- **My Coins Table Columns** -- Checkbox (multi-select), Coin, Grade, Qty (+/-), Troy Oz, FMV (ea), Total, Cost (ea -- inline editable), P/L, Melt Value (from live spot), Avg eBay, Range, Notes, Added, Remove.
- **Bulk Delete** -- Select All checkbox + "Delete Selected" button with count and confirmation.
- **Coin Dedup** -- Server/client hash parity uses SHA-256 of `series|year|mint|grade|notes|label`; different notes or labels produce distinct entries.

## Env Vars
See the authoritative tables in `README.md` and `docs/ARCHITECTURE.md`. Recent operational settings include `COMMUNICATION_CONNECTION_STRING`, `ALERT_EMAIL_TO`, `ALERT_FROM_EMAIL`, `LOG_LEVEL`, `PCGS_429_COOLDOWN_MS`, `TERAPEAK_PACING_PROFILE`, and `TERAPEAK_PACING_PILOT_ID`.

## Admin Features
- Terapeak CSV import (POST /api/terapeak/import, requires x-api-key)
- Cache clearing (POST /api/clear-cache)
- Quota management endpoints
- Auto-import from data/terapeak/ folder + Azure Blob Storage at startup

## Test Utilities
- **Auto-seed (server.js)** -- `seedTestAccount()` creates `testcollector` / `Coins2026!` with 10 coins on startup if missing. Server-side, persists across browser clears.
- **`__tests__/`** -- Current Jest tests plus fixtures/helpers/setup. Run `npm test`; use `npm run test:metrics`, `npm run test:summary`, and `npm run test:analyze` for timing history.
- **`__tests__/helpers/coinTestConstants.js`** -- Shared test helpers: `makeComp()`, `makeComps()`, token lists
- **`samples/`** -- Test fixtures: `test-collection.xlsx`, `no-collectors-sheet.xlsx`.
- **`.test-metrics/`** -- Jest timing metrics: `npm run test:metrics`, `npm run test:summary`

## Dependencies
- **Runtime:** Express, Pino, Helmet, rate limiting, Axios, csv-parse, dotenv, multer, ExcelJS, bcryptjs, JWT, AJV, Azure Cosmos/Blob/Identity/Communication Email
- **Dev:** Jest/jsdom, ESLint, Stryker, axios-mock-adapter, Supertest


## Quick Start for New Conversations
- Run `/onboard` to read all docs and source files systematically.
- Or at minimum, read this file, `docs/memory/numismatic-terminology.md`, and `docs/BACKLOG.md`.
- The canonical backlog is `docs/BACKLOG.md`; `docs/memory/future-edits.md` is historical only.
- For decision-engine details, read `docs/memory/decision-engine-spec.md`.

## Copilot Agents (14)
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
| `@numismatic-audit` | Primary | Classification/filter audit against numismatic contracts |
| `@terapeak-operator` | Primary | Canonical guarded Terapeak startup workflow |
| `@security-review` | Sub-agent | OWASP-focused security sub-reviewer |
| `@performance-review` | Sub-agent | Performance bottleneck sub-reviewer |

## Terapeak Operators
- **H-machine (WSL Surface)**: `scripts/terapeak-operator.sh` -- preflight(login) -> optional login -> preflight(loop) -> freshness pass. Run via `@terapeak-operator` agent.
- **W-machine (Codespace)**: `scripts/terapeak-operator-codespace.sh` (#200) -- system `python3`, no `~/.env.surface`, default `--max-passes 0` (unlimited loop), single-instance `flock`. Per-pass records appended to `cache/terapeak-runs/{passes,coins}.jsonl` by `scripts/_parse-terapeak-pass.py`; view with `scripts/show-terapeak-runs.sh recent|runs|totals|stop-conditions`.
- Both operators use #284H risk states, randomized Normal batches (30-35 by default), smaller Elevated batches, longer Elevated pauses, hard-challenge Cooldown stops, and shared pass telemetry. #280H adds an opt-in baseline/tuned pilot that remains baseline by default. Full details live in `docs/memory/terapeak-runbook.md` and `docs/memory/anti-bot-operations.md`.

## Background Timers (server.js startup)
- **Metals polling**: every 30 min (METALS_POLL_MS), records daily history snapshots
- **Greysheet refresh**: every 3 days by default (`GS_REFRESH_INTERVAL_DAYS`), checked on startup and hourly
- **Blob re-import**: every 30 min (BLOB_REIMPORT_MS), picks up new Terapeak CSVs from Azure Blob
- **Stale eviction**: 180-day Terapeak comp eviction + CSV purge on startup
- **PCGS APR prefetch**: nightly scheduler with local quota, persisted upstream cooldown, bounded recovery probe, and repeated-partial alerts
