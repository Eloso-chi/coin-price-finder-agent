# API Reference

Comprehensive reference of all HTTP endpoints exposed by the coin-price-finder-agent service.

**Auth:** 🔒 = requires `ADMIN_API_KEY` via `x-api-key` header. Protected endpoints without 🔒 = require `Authorization: Bearer <jwt>` header.

## Core Pricing

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/price` | None | Price a single coin through the shared deterministic pricing service |
| `POST` | `/api/ai/price` | None | Conversational pricing projection with public-safe provenance and structured handoff |
| `POST` | `/api/ai/collection` | JWT | Authenticated deterministic collection summary or metadata-gap analysis |
| `POST` | `/api/ai/market` | None | Bounded market coverage, comparison, and year-series analytics |
| `POST` | `/api/bar-price` | None | Price a bullion bar by metal, size, brand |
| `GET` | `/api/bar-price/options` | None | List available brands and series for bar pricing |
| `POST` | `/api/pricing-batch` | None | Batch-price up to 25 coins in one request |
| `GET` | `/api/coin-variant` | None | Design-series metadata (e.g., ASE variants, Proof vs BU) |
| `GET` | `/api/special-marks` | None | Registry-backed official marks filtered by `program`, `year`, `metal`, `weight`, `finish`, and `mint`; returns inferred `resolvedMetal` and `requiresSelection` |
| `GET` | `/api/coin-history` | None | Sold-price time-series with optional spot-price overlay |

Every valuation includes `algorithmVersion` (semantic version), `configVersion` (`sha256:` fingerprint), and `computedAt` (UTC ISO timestamp). Successful and null-FMV outcomes are audited asynchronously. Anonymous audits omit actor and IP; authenticated admin audits may include both. Audit persistence never delays the pricing response.

`POST /api/price` validates HTTP input and derives trusted admin context before calling `pricingService.priceCoin(input, trustedContext)`. The route then adapts the deterministic result to the legacy response contract, writes the audit record, and redacts licensed comp provenance for public callers. Caller-supplied coin data cannot set audience, identity, authorization, or redaction state.

Structured `coinData` may include `composition`, `specialMarkMode` (`unspecified`, `standard`, `exact`, or `unknown`), and at most one `specialMarks` item containing a lowercase dotted `markId`. Exact mode requires one registered mark; its issue constraints must match the resolved series, year, metal, weight, finish, and mint or the request returns `AMBIGUOUS_PRODUCT_IDENTITY`. Standard mode rejects comps that positively declare a privy, including registered applicable marks. Unknown mode accepts the backward-compatible bounded `variantDetail` description but never maps it to a registered premium. An unspecified complete context matching multiple registered marks returns `422` with `code: "SPECIAL_MARK_CLARIFICATION_REQUIRED"`; callers must choose exact, standard, or unknown. `variantDetail` remains limited to 50 letters, numbers, spaces, and `._+=-`; provider operator prefixes are rejected. The same input validation runs before deterministic or LLM-backed AI routing. Successful responses expose the resolved mode and client-safe canonical marks, including `issueId`, in `query` and `reproducibility.productIdentity`.

Equivalent single, batch, bulk, and deterministic AI requests resolve through canonical product identity parser version `2.0.0`. Multiple distinct explicit weights or conflicts between structured fields and parsed series, year, mint, metal, weight, grade, finish, designation, or registered special-mark applicability return `400` with `code: "AMBIGUOUS_PRODUCT_IDENTITY"` for single-price and AI routes; batch and bulk results carry the same per-item error. Weight evidence within 5% is treated as the same nominal product. Internal `_productIdentity` fields attached to sold comps are removed from public responses.

For equivalent deterministic inputs, `/api/price`, `/api/pricing-batch`, and `/api/bulk-evaluate` preserve the same `confidence`, `lowData`, `compCount`, `method`, `explanation`, `dataSource`, and `gradePool` semantics. A valuation based on exactly one sold comp includes a `SINGLE-COMP ESTIMATE` warning. A thin exact-year Terapeak pool may use a bounded cross-year cohort and returns `dataSource.label: "cross-year-composite"`, `gradePool.compositeBasis`, a `(composite)` method suffix, explicit warnings, and confidence capped at 30 without population data or 35 with it. Exact special-mark requests are excluded from cross-year composites. Bullion comps whose titles omit weight are rejected when price exceeds `max(meltPerOz * weight * 5, $50)`, for fractional and multi-ounce coins alike. `/api/ai/price` preserves these fields and a structured `warning` in `provenance.valuation` for deterministic and LLM-backed responses.

## Bulk Lot Evaluator

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/bulk-evaluate` | None | Submit a lot for batch evaluation; returns `jobId` |
| `GET` | `/api/bulk-evaluate/:jobId` | None | Poll job status and completed results |
| `GET` | `/api/bulk-evaluate/:jobId/stream` | None | SSE stream of per-coin + lot summary results |

**Input formats:** text (one coin per line, pipe-delimited), JSON array, or Excel .xlsx upload.

Per-coin bulk results include `lowData`, `explanation`, `dataSource`, and `gradePool` in addition to FMV, confidence, method, and comp count. A genuine confidence score of `0` is returned as `0`, not `null`.

## Authentication & My Coins

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/signup` | None | Create new account with username + password |
| `POST` | `/api/auth/login` | None | Log in; returns JWT (7-day expiry) |
| `GET` | `/api/auth/me` | Bearer | Get current user info |
| `POST` | `/api/auth/change-password` | Bearer | Update account password |
| `GET` | `/api/coins` | Bearer | List user's coin collection |
| `POST` | `/api/coins` | Bearer | Add a coin to collection |
| `PUT` | `/api/coins/:hash` | Bearer | Update coin count or cost basis |
| `DELETE` | `/api/coins/:hash` | Bearer | Remove a coin |
| `GET` | `/api/coins/export` | Bearer | Export collection as JSON backup |
| `POST` | `/api/coins/import` | Bearer | Import coins from JSON backup |
| `POST` | `/api/coins/bulk-delete` | Bearer | Delete multiple coins by hash |
| `POST` | `/api/coins/get` | Bearer | Get specific coin by metadata fields |
| `GET` | `/api/coins/count` | Bearer | Get total coin count |

## Market & Metals

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/market/ebay` | None | Year × mint market matrix (eBay median prices, key dates, Numista rarity) |
| `GET` | `/api/metals` | None | Get current spot prices for multiple metals |
| `GET` | `/api/metals/:metal` | None | Get spot price for single metal (gold, silver, platinum, palladium) |

### AI pricing handoff

`POST /api/ai/price` accepts `query` plus optional allowlisted `structuredContext` fields: `query`, `coinData`, `weight`, `options`, `saleContext`, `askingPrice`, and `appealMultiplier`. Trusted audience and admin fields are always derived from server authentication and are never accepted from the request body. The deterministic-fallback path normalizes several natural-language phrasings before pricing, including "what is the value/price of my X", "what is a fair/good/reasonable price for X", "how much is my X worth", and "price/value X" -- input normalization only, no change to the request/response contract.

Successful responses include `provenance` with valuation method, algorithm/config versions, confidence, comp counts, source labels, history summaries, and audit request metadata. Public responses redact licensed comp provenance through the same helper used by `/api/price`. The `handoff` object contains only structured pricing context suitable for returning to the traditional form.

`POST /api/ai/market` supports `coverage` and `year-series` for one `series`, plus `compare` for at most three series. Responses distinguish `observed-completed-sales` from `derived-from-matrix` metrics and report missing observations explicitly. Year-series results are year-by-year completed-sale medians, not daily temporal trends.

When `LLM_PROVIDER=azure-openai` and the complete server-side configuration is present, `POST /api/ai/price` uses the Phase 1 orchestrator. Its only available model tools are `identify_coin`, `price_coin`, and `evaluate_purchase`; deterministic services calculate all numerical results before the provider explains them. The provider is disabled by default, and provider failure falls back to the deterministic response path so the existing pricing experience remains functional.

#### Phase 1 LLM tool contracts

These are internal server-side tools. The model cannot call the HTTP routes, persistence layer, collection tools, market tools, history tools, administrative tools, or mutation functions.

| Tool | Input schema | Deterministic service | Output and provenance | Timeout / errors |
|---|---|---|---|---|
| `identify_coin` | `{ query: string }`, trimmed and 1-300 non-whitespace characters; follow-up context is server-managed by the orchestrator and is not model-supplied tool input | `pcgsService.parseDescription(query)` | `{ query, parsed, provenance: { source: "deterministic-coin-intent", observed: true } }` | 5s; invalid object, missing query, malformed provider arguments |
| `price_coin` | `{ query: string, coinData?: CoinData, weight?: number [0.001..100], options?: PriceOptions, askingPrice?: number [0..1000000], appealMultiplier?: number [1..2] }`. `CoinData` allows only `name`, `year`, `mint`, `grade`, `finish`, `designation`, `composition`, `isProof`, `coa`, `originalBox`; string fields are bounded, `year` is a bounded string/integer, and boolean flags are boolean. `PriceOptions` allows only `timeWindowDays [1..365]`, `usMinComps [1..100]`, `maxPages [1..10]`, `requirePCGSOnly` boolean, `exactGradeOnly` boolean, and `weight [0.001..100]`. | `pricingService.priceCoin(input, trustedContext)` | `{ result: { valuation, decisions, coin, ebay, pcgs, greysheet, reproducibility, ... }, provenance: { source: "deterministic-pricing-service", observed: true } }`; public comp provenance is redacted before model/UI exposure | 45s; validation failure, deterministic service failure, no-data result |
| `evaluate_purchase` | Same exact `CoinData`, `PriceOptions`, `weight`, and `appealMultiplier` bounds as `price_coin`, with required `query` and `askingPrice [0..1000000]` | `pricingService.priceCoin(input, trustedContext)` and its buy/sell decision output | `{ result: { valuation, decisions: { buy, sell }, coin, ebay, pcgs, reproducibility, ... }, provenance: { source: "deterministic-purchase-evaluation", observed: true } }`; all numerical values remain deterministic | 45s; missing asking price, validation failure, deterministic service failure, no-data result |

Allowed caller context is server-derived `{ audience, isAdmin }`; request bodies and model arguments cannot set identity, admin state, audience, secrets, provider configuration, or arbitrary function names. The orchestrator allows one tool call per turn and at most three tool turns. Tool results are validated and returned to the LLM for explanation; numerical explanations without deterministic evidence are rejected. Registry timeouts are enforced before a tool result is accepted. Focused coverage is in `__tests__/aiToolRegistry.test.js`, `__tests__/aiOrchestratorService.test.js`, `__tests__/aiPriceRoute.integration.test.js`, `__tests__/aiPriceRoute.llm.test.js`, `__tests__/aiPriceRoute.test.js`, `__tests__/aiCollectionRoute.test.js`, `__tests__/aiMarketRoute.test.js`, and `__tests__/llmProviderAdapter.test.js`.

External OpenAPI/MCP exposure is not enabled. See [docs/AI-EXTERNAL-EXPOSURE-EVALUATION.md](AI-EXTERNAL-EXPOSURE-EVALUATION.md) for the governance decision and prerequisites for any future external gateway.
| `GET` | `/api/image-proxy` | None | Proxy coin images from allowlisted hosts (SSRF-protected) |

## Data Imports

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/import/excel` | None | Import coin collection from Excel (.xlsx) spreadsheet |
| `POST` | `/api/terapeak/import` | 🔒 | Upload a Terapeak CSV (multipart form) |
| `POST` | `/api/terapeak/import-text` | 🔒 | Paste Terapeak CSV as plain text |
| `GET` | `/api/terapeak/datasets` | 🔒 | List all imported Terapeak datasets with metadata |
| `GET` | `/api/terapeak/lookup` | None | Look up sold comps by keyword search; public rows redact internal identity and cohort metadata |
| `DELETE` | `/api/terapeak/datasets/:key` | 🔒 | Delete specific Terapeak dataset |
| `DELETE` | `/api/terapeak/datasets` | 🔒 | Clear all Terapeak data |

## Terapeak Metadata & Quota

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/terapeak/quota` | 🔒 | Get current daily quota status (used/limit) |
| `POST` | `/api/terapeak/quota/record` | 🔒 | Log Terapeak API calls to quota counter |
| `POST` | `/api/terapeak/quota/set-used` | 🔒 | Set used quota count directly |
| `POST` | `/api/terapeak/quota/reset` | 🔒 | Reset today's quota counter to 0 |
| `POST` | `/api/terapeak/quota/set-limit` | 🔒 | Change daily quota limit (default 250) |
| `GET` | `/api/admin/terapeak-meta` | 🔒 | Stream canonical `data/terapeak-meta.json` sidecar with mtime/size headers |
| `POST` | `/api/terapeak/reimport` | 🔒 | Re-import Terapeak CSVs from Azure Blob Storage |
| `POST` | `/api/terapeak/purge-stale-csvs` | 🔒 | Delete CSV files older than N days |
| `GET` | `/api/terapeak/aggregation-status` | 🔒 | Aggregation depth summary + filtered dataset lists |
| `GET` | `/api/terapeak/scrape-status` | 🔒 | Backward-compatible alias to aggregation status |
| `POST` | `/api/terapeak/report-no-data` | 🔒 | Increment dormant/no-data tracking for a dataset |
| `POST` | `/api/terapeak/backfill-aggregation-meta` | 🔒 | One-time backfill of aggregation metadata from historical logs |

## Admin Dashboard

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/health` | None | Health check + uptime |
| `GET` | `/api/health?deep=1` | 🔒 | Downstream status for Cosmos, metals, PCGS, and Terapeak; Key Vault is reported as `not_probed` |
| `GET` | `/api/admin/dashboard` | 🔒 | System overview: user count, dataset count, quota, uptime |
| `GET` | `/api/admin/stale-datasets` | 🔒 | Datasets older than N days (filters dormant/thin via freshness classifier) |
| `GET` | `/api/admin/data-health` | 🔒 | Total files, empty files, date ranges |
| `GET` | `/api/admin/prefetch-status` | 🔒 | PCGS prefetch status, including `perCategory`, `lastAttempt*`, invalid-response scope summaries, and separate local-quota/upstream-availability fields |
| `POST` | `/api/admin/prefetch-trigger` | 🔒 | Trigger manual PCGS prefetch run; rejected while an upstream cooldown is active |
| `GET` | `/api/admin/pcgs-quota` | 🔒 | PCGS local quota and upstream cooldown status |
| `GET` | `/api/admin/auction-history` | 🔒 | Retrieve cached auction history |
| `POST` | `/api/admin/auction-fetch` | 🔒 | Force live auction refresh |
| `POST` | `/api/clear-cache` | 🔒 | Flush all service caches |

PCGS status distinguishes the local daily counter from upstream availability. The
prefetch response includes `quota.localQuotaRemaining`,
`quota.upstreamAvailability`, `quota.nextEligibleProbeAt`,
`quota.upstreamBlockType`,
`quota.rateLimitedAt`, `quota.rateLimitReason`, `quota.upstreamReportedLimit`,
`quota.upstreamReportedRemaining`, `quota.prefetchObservedLimit`, and
`quota.prefetchBudgetRemaining`, plus the top-level `upstreamAvailability`,
with `lastProbeAt` and `lastProbeOutcome` under `quota`. `lastInvalidResponses`
counts rejected payloads in the last real run, and `lastRejectedTargets` is a
capped list of `{ pcgsNo, grade, reason, scope, quarantinePersisted }` objects.
`scope` is `target-specific` or `systemic`; the objects contain sanitized PCGS
rejection details and quarantine-write state. Upstream availability
is `available`, `cooldown`, `probe-required`,
or `probe-in-flight`. After cooldown expiry, the scheduler permits one recovery
probe before continuing the queue. When a 429 response has no usable reset
metadata, `PCGS_429_COOLDOWN_MS` controls the fallback cooldown (default: one
hour).

### Health Checks

`GET /api/health` is the public load-balancer check. It performs no downstream
probes and returns `{"status":"ok","uptime":<seconds>}`.

`GET /api/health?deep=1` requires an admin JWT or `x-api-key`. It reports
`status`, `overall`, `uptime`, and a `dependencies` object containing Cosmos,
Key Vault, metals, PCGS, and Terapeak state. Each dependency includes
`status`, `latencyMs`, and `lastSuccess`; source-specific safe fields may also
be present. Key Vault is `not_probed` because App Service resolves its secret
references outside this process. Results are cached for 10 seconds and the
endpoint is separately rate-limited.

Optional dependency failures return HTTP `200` with `overall: "degraded"`.
Configured Cosmos failure returns HTTP `503` with `overall: "down"`. Responses
never include credentials, endpoints, configuration values, or raw errors.

## Error Codes

All endpoints return standard HTTP status codes:

- `200` — Success
- `400` — Bad request (invalid input, validation failure)
- `401` — Unauthorized (invalid/missing JWT or API key)
- `403` — Forbidden (JWT/key valid but operation not allowed)
- `404` — Not found
- `429` — Rate limited (eBay API throttle; retry with backoff)
- `500` — Server error
- `503` — Service unavailable (dependency down, Azure, Terapeak, etc.)

Error responses use an `error` field and include `requestId` for correlation. Some endpoint-specific responses may add safe structured details; raw upstream errors and credentials are never returned.
