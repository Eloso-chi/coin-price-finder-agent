# Data Dictionary

Reference for critical data stores, schemas, and privacy classifications used by the coin-price-finder-agent service.

## AI Response and Privacy Contracts

The internal `/api/ai/*` routes use these classifications. External OpenAPI/MCP
exposure is disabled.

| Response area | Classification | Public behavior | Notes |
|---|---|---|---|
| `/api/ai/price` valuation and explanation | Public-safe derived data | Deterministic numerical results plus an LLM explanation when the provider is enabled; provider-disabled responses identify deterministic fallback | FMV, confidence, comp counts, and guide values originate from deterministic services |
| `/api/ai/price` comp provenance | Restricted licensed provenance | Public comp source labels and identifiers are redacted before model/UI exposure | Uses the same public redaction boundary as `/api/price` |
| `/api/ai/price` handoff | Caller input, allowlisted | Contains only query, coin fields, pricing options, asking price, sale context, weight, and appeal multiplier | Trusted audience/admin context is server-derived and never accepted from the body |
| `/api/ai/collection` summary | Private user data | JWT-authenticated response is restricted to the verified `req.user.userId` collection | Caller/model-supplied user IDs are ignored; notes and cost basis remain private |
| `/api/ai/market` analytics | Derived market intelligence | Bounded observed/derived/missing classifications | Collection, administrative, history, bulk, and mutation tools are not exposed to the Phase 1 LLM registry |
| `conversationContext` | Bounded transient context | Last eight sanitized turns only | No trusted identity, audience, admin state, secrets, or provider configuration |

## Pricing Response Contracts

| Response area | Fields | Public behavior | Notes |
|---|---|---|---|
| `/api/price` valuation | `confidence`, `lowData`, `compCount`, `method`, `explanation`, `dataSource`, `gradePool` | Public-safe derived valuation context | `confidence: 0` is meaningful; composite estimates use `dataSource.label: cross-year-composite` and `gradePool.compositeBasis` |
| `/api/pricing-batch` result | `confidence`, `lowData`, `compCount`, `method`, `explanation`, `dataSource`, `gradePool` | Preserves the shared valuation contract for each item | A one-sold-comp result includes a `SINGLE-COMP ESTIMATE` explanation |
| `/api/bulk-evaluate` per-coin result | `confidence`, `lowData`, `compCount`, `method`, `explanation`, `dataSource`, `gradePool` | Public jobs preserve the shared contract; anonymous poll, replay, and live access to admin-origin jobs redacts `explanation` to `[]` | Bulk caches are audience-isolated because explanations differ for public and admin callers |
| `/api/ai/price` provenance valuation | `confidence`, `lowData`, `compCount`, `method`, `dataSource`, `compositeBasis`, `warning` | Deterministic and LLM-backed responses expose structured low-data and composite disclosure | `warning` is non-null for one-sold-comp and cross-year-composite estimates |
| `/api/price` reproducibility identity | `series`, `year`, `mint`, `metal`, `nominalWeightOz`, `finish`, `designation`, `pool`, `weightEvidence`, `parserVersion` | Public-safe canonical target used for deterministic pricing | `weightEvidence.status` is `none`, `single`, or `ambiguous`; successful valuations never contain ambiguous identity |

`gradePool.compositeBasis` contains `usedCohort`, `cohortYears`, `cohortCompCount`, `exactYearCompCount`, and `populationGateApplied`. It is present only when cohort comps contribute to FMV.

### Phase 1 LLM tool result shapes

The initial LLM registry exposes only `identify_coin`, `price_coin`, and
`evaluate_purchase`. Each result includes deterministic provenance. Tool
arguments are validated against the exact contracts in [docs/api-reference.md](api-reference.md)
and unknown root/nested fields are rejected. Numerical explanations without
financial evidence from valuation or buy/sell decision fields are rejected.

## Local Filesystem Stores

### cache/pcgs_quota.json

Persisted local PCGS request counter and upstream cooldown state. The local
entitlement remains capped at 1,000 calls; observed 429 values are diagnostic
fields and do not replace that entitlement.

| Field | Type | Privacy | Notes |
|-------|------|---------|-------|
| `date` | `YYYY-MM-DD` | Public | Pacific-date counter window |
| `used` | non-negative integer | Public | Calls consumed in the local window |
| `remaining` | non-negative integer | Public | Local calls remaining; never exceeds `limit` |
| `limit` | positive integer | Public | Local entitlement, bounded to 1,000 |
| `headerSynced` | boolean | Public | Whether valid successful-response headers synchronized the counter |
| `upstreamCooldown` | object or null | Public | Persisted 429 cooldown and recovery-probe state |
| `upstreamCooldown.reportedRemaining` | non-negative integer or null | Public | Sanitized `X-RateLimit-Remaining` observed on a 429 |
| `upstreamCooldown.reportedLimit` | non-negative integer or null | Public | Sanitized `X-RateLimit-Limit` observed on a 429 |
| `upstreamCooldown.resetAt` | ISO 8601 | Public | Next eligible recovery-probe time |
| `upstreamCooldown.reason` | string | Public | Sanitized rate-limit reason |

Invalid or inconsistent persisted counters are normalized fail-closed during
load so they cannot expand the nightly prefetch budget.

---

### cache/users.json

Keyed by username (lowercased, alphanumeric + `-_.`, max 50 chars). Structure:

| Field | Type | Privacy | Notes |
|-------|------|---------|-------|
| `[username]` | object | Private | Account metadata for this user |
| `.userId` | string (UUID) | Private | Unique account identifier |
| `.hash` | string | Private | bcryptjs password hash (12 rounds); never return in API responses |
| `.createdAt` | ISO 8601 | Public | Account creation timestamp |
| `.tokenVersion` | number | Private | Incremented on password change/logout; used for strict token verification (#218) |

Example:
```json
{
  "testcollector": {
    "userId": "a45c1c8e-da52-47f1-9b38-4cfc22f2e603",
    "hash": "$2b$12$...",
    "createdAt": "2026-06-03T16:30:33.436Z",
    "tokenVersion": 0
  }
}
```

**Use:** Server-side user account persistence. Persists across server restarts. Dual-mode: writes to local file + Cosmos DB (if available).

---

### cache/user_coins.json

Keyed by userId (UUID). Each userId value is an **array of coin objects**:

| Field | Type | Privacy | Notes |
|-------|------|---------|-------|
| `[userId]` | array | Private | Array of coins for this user |
| `.coinHash` | string (SHA-256) | Private | Hash of `series\|year\|mint\|grade\|notes\|label`; used as dedup key |
| `.series` | string | Public | Canonical series name (e.g., "American Silver Eagle") |
| `.year` | string | Public | 4-digit year as string (1600–2099) |
| `.mint` | string | Public | Mint mark, uppercase (empty = no mint mark) |
| `.grade` | string | Public | Grade range (e.g., "MS-65", "VF", "Raw") |
| `.weight` | number or null | Public | Troy ounces (bullion) or null |
| `.query` | string | Public | Original search term used to find the coin |
| `.count` | number | Public | Quantity of this coin held (minimum 1) |
| `.costPer` | number or null | Private | Cost basis per coin (USD); user-supplied, may be sensitive |
| `.notes` | string or null | Private | User notes (max 500 chars); may contain personal details |
| `.label` | string or null | Public | User-defined variant label (e.g., "PCGS Cert #12345") |
| `.baseMetal` | string or null | Public | Metal type for bullion (e.g., "Gold", "Silver", "Platinum") |
| `.fineness` | number or null | Public | Metal fineness (e.g., 0.999 for fine silver) |
| `.dateAdded` | ISO 8601 | Public | When the coin was added to collection |

Example:
```json
{
  "a45c1c8e-da52-47f1-9b38-4cfc22f2e603": [
    {
      "coinHash": "0b7ed9fdb2cb9af1...",
      "series": "Peace Dollar",
      "year": "1923",
      "mint": "",
      "grade": "VF",
      "weight": null,
      "query": "Peace Dollar 1923",
      "count": 2,
      "costPer": 45.50,
      "notes": "Estate purchase",
      "label": null,
      "baseMetal": null,
      "fineness": null,
      "dateAdded": "2026-06-17T01:00:12.681Z"
    }
  ]
}
```

**Use:** Server-side coin collection storage. Dual-mode: writes to local file + Cosmos DB (if available). File store is source of truth for sync reads.

---

### cache/terapeak-runs/passes.jsonl, cache/terapeak-runs/coins.jsonl

Append-only JSONL ledger written by `scripts/_parse-terapeak-pass.py` after each pass of `scripts/terapeak-operator-codespace.sh` (#200). Gitignored; survives codespace restart but not codespace deletion. Used by `scripts/show-terapeak-runs.sh` for run history queries.

**`passes.jsonl`** -- one JSON object per pass (fields as emitted by `_parse-terapeak-pass.py main()`):

| Field | Type | Privacy | Notes |
|-------|------|---------|-------|
| `ts` | ISO 8601 | Public | Record-write timestamp (same as `end_ts`) |
| `run_id` | string | Public | `YYYYMMDDTHHMMSSZ-<pid>` from operator launch |
| `operator` | string | Public | Name of the invoking operator (e.g. `terapeak-operator-codespace`) |
| `machine` | string | Public | `W` (codespace) or `H` (Surface/WSL) -- the calling machine letter |
| `pass` | number | Public | 1-indexed pass number within the run |
| `batch_size` | number | Public | Randomized batch for this pass (30-35 default in Normal state) |
| `pass_id` | number | Public | Canonical #284H pass identifier (same value as `pass`) |
| `started_at`, `ended_at` | ISO 8601 | Public | Canonical #284H aliases for pass boundaries |
| `batch_size_requested`, `batch_size_executed` | number | Public | Requested queue size and actual attempts |
| `new_count`, `dup_count` | number | Public | Canonical aliases for new and duplicate rows |
| `no_data_count`, `no_export_count` | number | Public | Explicit empty/no-export outcomes parsed from the pass log |
| `cookie_health_status`, `probe_status` | string or null | Public | Startup cookie and active-probe results |
| `include_thin` | boolean | Public | Whether thin-data datasets were included this pass |
| `start_ts` | ISO 8601 | Public | Pass start timestamp (UTC) |
| `end_ts` | ISO 8601 | Public | Pass end timestamp (UTC) |
| `duration_sec` | number or null | Public | Wall-clock seconds; null if timestamps unparseable |
| `pacing_profile_requested` | string | Public | Operator-selected profile: `baseline` or `normal-tuned` |
| `pacing_profile_effective` | string | Public | Profile actually applied; forced to `baseline` outside Normal risk state |
| `pacing_pilot_id` | string or null | Public | Safe identifier used to isolate one #280H A/B pilot from routine baseline history |
| `pacing_batch_min`, `pacing_batch_max`, `pacing_p01_fixed` | number or null | Public | Operator batch policy used to reject incomparable pilot arms |
| `pacing_upload_mode` | string or null | Public | Upload mode used to reject incomparable pilot arms |
| `challenge_signal_count`, `soft_risk_signal_count` | number | Public | #284H hard/soft anti-bot signals observed during the pass |
| `state_before`, `state_after` | string | Public | Persisted risk state before and after classification |
| `transition_reason` | string or null | Public | Why the #284H risk state changed or remained stable |
| `pass_exit_code` | number or null | Public | Operator pass process exit code |
| `attempted` | number | Public | Coins attempted in this pass |
| `succeeded` | number | Public | Coins that returned `ok` (non-empty result) |
| `empty` | number | Public | Coins that returned zero comps |
| `failed` | number | Public | Coins that errored out (network, parse, captcha, etc.) |
| `unknown` | number | Public | Coins whose status the parser could not determine |
| `dormant` | number | Public | Coins flagged dormant by the freshness classifier |
| `new_rows` | number | Public | Sum of new comp rows added across all coins this pass |
| `dup_rows` | number | Public | Sum of duplicate rows skipped across all coins this pass |
| `succeeded_reported` | number or null | Public | "succeeded" total scraped from the pass log's own summary line (cross-check) |
| `failed_reported` | number or null | Public | "failed" total scraped from the pass log's own summary line (cross-check) |
| `pass_log` | string | Public | Path to the per-pass log this record was parsed from |

**`coins.jsonl`** -- one JSON object per coin attempt within a pass:

| Field | Type | Privacy | Notes |
|-------|------|---------|-------|
| `ts` | ISO 8601 | Public | Record-write timestamp (matches parent pass `end_ts`) |
| `run_id` | string | Public | Matches the parent pass record |
| `machine` | string | Public | Matches the parent pass record |
| `pass` | number | Public | Pass number this attempt belongs to |
| `idx` | number | Public | 1-indexed position within the pass batch |
| `total` | number | Public | Total coins in the pass (for "idx of total" display) |
| `coin` | string | Public | Search term (Terapeak query) attempted |
| `status` | string | Public | `ok` / `empty` / `failed` / `unknown` |
| `new` | number | Public | New rows added from this coin |
| `dups` | number | Public | Duplicate rows skipped |
| `dormant` | boolean | Public | True if the coin was classified dormant before the attempt |
| `error` | string or null | Public | Error excerpt if the attempt failed; null otherwise |

**Use:** Operator forensics and longitudinal yield tracking. Parse failures in `_parse-terapeak-pass.py` log to stderr but never fail the operator loop. Schemas are append-only and best-effort; new fields may be added in later operator versions. Source of truth: `scripts/_parse-terapeak-pass.py` `main()` -- consult before relying on any field semantics.

---

### data/terapeak-meta.json

Keyed by Terapeak search term (lowercase, e.g., "morgan dollar"). Tracks refresh history and freshness metrics:

| Field | Type | Privacy | Notes |
|-------|------|---------|-------|
| `[searchTerm]` | object | Public | Metadata for this Terapeak dataset |
| `.compCount` | number | Public | Number of sold comps currently in memory for this series |
| `.newestSaleDate` | date (YYYY-MM-DD) | Public | Most recent sale date in current dataset |
| `.oldestSaleDate` | date (YYYY-MM-DD) | Public | Earliest sale date in current dataset |
| `.page1At` | ISO 8601 or null | Public | Last successful page-1 collection/import marker |
| `.deepAt` | ISO 8601 or null | Public | Last deep-pagination marker |
| `.maxPageReached` | number or null | Public | Highest collected page number |
| `.lastRefreshAt` | date (YYYY-MM-DD) | Public | Last date a refresh/reimport was attempted |
| `.refreshCount` | number | Public | Cumulative count of refresh attempts |
| `.consecutiveDryRefreshes` | number | Public | Counter for consecutive refresh-with-no-new-comps (triggers dormant classification via freshnessClassifier) |
| `.lastRefreshNewComps` | number | Public | Number of new comps added in most recent refresh |
| `.noDataAt` | ISO 8601 or null | Public | Most recent direct page-1 no-data observation |
| `.noDataCount` | number | Public | Consecutive no-data observations, capped by the service |
| `.identifiers` | object, optional | Public | Evidence-derived composition/volume classification and confidence metadata |

Example:
```json
{
  "2018 american silver eagle": {
    "compCount": 80,
    "newestSaleDate": "2026-05-28",
    "lastRefreshAt": "2026-05-13",
    "refreshCount": 4,
    "consecutiveDryRefreshes": 2,
    "lastRefreshNewComps": 0
  }
}
```

**Use:** Canonical metadata for Terapeak CSV datasets. Git-tracked (not in .gitignore). Used by freshnessClassifier and adminService for staleness detection. Enables zero-infra operation as a fallback when Cosmos DB unavailable.

---

## Azure Cosmos DB (optional, write-through)

### Container: `users`

Schema mirrors `cache/users.json`. Documents are upserted as `{ id: username, username, ...acct }`.

- Item id: `username` (lowercased)
- Partition key: `username`

---

### Container: `user-coins`

Schema mirrors user coins in `cache/user_coins.json`.

- Item id: `coinHash`
- Partition key: `userId`

---

### Container: `terapeak-sold`

Terapeak comps and aggregation metadata keyed by normalized search term.

- Item id: normalized/search-derived identifier
- Partition key: `/searchTerm`
- Writer/reader: `src/services/terapeakService.js`

Accepted comp rows may include internal `_productIdentity` evidence with the same canonical fields and parser version. It is persisted in the local/Cosmos sold-data record for reclassification and diagnostics, but stripped from public API comp payloads. Ambiguous multi-product rows and non-weight identity conflicts are excluded during import and migration rather than assigned to the first detected weight or retained in the wrong dataset.

---

### Containers: `greysheet-history`, `metals-history`

Daily price snapshots written by `greysheetHistoryService` and
`metalsHistoryService`. Partition keys are `/coinKey` and `/metal`
respectively. Local JSON cache files remain the synchronous fallback.

---

### Container: `admin-audit`

Structured administrative action events written by `auditService`. Records
use action/actor/resource triples with partition key `/actorUsername`. Access is
operator-only; audit writes never expose credentials in public responses.

---

### Container: `valuation-audit`

Append-only valuation events emitted by `/api/price`, `/api/pricing-batch`, and `/api/bulk-evaluate`. Provisioned lazily with partition key `/computedAtDate`.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | Unique event identifier |
| `query` | string | Pricing query as received |
| `fmv` | number or null | Computed fair-market value |
| `method` | string or null | Valuation/data-source method |
| `confidence` | number or null | Confidence score |
| `algorithmVersion` | semver string | Valuation logic version |
| `configVersion` | string | `sha256:` fingerprint of versioned valuation/config sources |
| `computedAt` | ISO timestamp | Valuation computation time |
| `computedAtDate` | `YYYY-MM-DD` | Cosmos partition value |
| `requestId` | string or null | Correlation ID |
| `actorId`, `ip` | string, optional | Included only for authenticated admin context |

When Cosmos is unavailable, the same records append to `cache/valuation-audit-YYYY-MM-DD.jsonl`. Audit failures never block pricing responses. `NODE_ENV=test` disables persistence.

**Privacy and retention:** Treat `query`, `requestId`, `actorId`, and `ip` as Private operational data because free-form queries may contain user-supplied text. Access is limited to operators with Cosmos RBAC or host filesystem access. Queries are capped at 300 characters. The container is provisioned with a 90-day Cosmos TTL, and the serialized fallback writer prunes JSONL files older than 90 days before each day's first write.

---

## Data Privacy Classifications

| Classification | Examples | Handling |
|---|---|---|
| **Public** | Series names, grades, years, mint marks, spot prices, FMV | Safe to log, cache, expose in API responses |
| **Private** | Cost basis, user notes, payment details, valuation audit queries, request/actor IDs, admin IPs, JWT tokens | Never log to unsecured systems; restrict audit access to operators; don't expose in API unless authenticated |
| **Sensitive** | Passwords (hashes only), API keys, secrets in .env | Never commit; rotate on leak; use Azure Key Vault for team access |

---

## CSV File Format (Terapeak)

Terapeak export headers vary by export version and locale. The importer maps
known aliases to these canonical internal fields:

| Column | Type | Example | Notes |
|--------|------|---------|-------|
| `title` | text | "1881-CC Morgan Dollar MS 64" | Required listing/product title; parsed for grade/finish |
| `itemId` | string or null | `1234567890` | Preferred deduplication key |
| `soldDate` | date | 2026-05-15 | Sale transaction/end date |
| `price` / `total` | currency amount | 85.50 | Realized price; `total` is accepted when separate price/shipping are absent |
| `shipping` | currency amount | 5.00 | Added to price when separately present |
| `condition`, `quantity`, `seller`, `listingType` | mixed | -- | Optional listing attributes |
| `imageUrl`, `url`, `category`, `country`, `bids`, `currency` | mixed | -- | Optional enrichment fields |

After import, data is normalized and merged by search key. Duplicates use
`itemId` when available, otherwise a title + total USD + sold-date fingerprint.
The exact accepted aliases live in `COLUMN_MAP` in
`src/services/terapeakService.js`.

---

## Test Data

### Golden Set (fixtures/golden_coins.json)

14 deterministic coins used in randomized test suites to ensure reproducibility:

- 1921 Morgan Dollar
- 1935 Peace Dollar
- 1964 Kennedy Half Dollar
- 1891 Liberty V Nickel
- 2024 American Silver Eagle
- 2015 Canadian Maple Leaf
- Geiger 1 oz gold bar
- And 7 others

See `coinTestConstants.js` selectCoins() for full list and loading logic.

---

## PCGS Number Reference Tables (src/data/pcgsNumbers.js)

Hard-coded lookup tables mapping `(series, year, mint)` to canonical **PCGS
coin numbers** (a.k.a. PCGS#). These numbers are the input to PCGS's
Photograde / Price Guide / Population API endpoints and to the local prefetch
scheduler (`src/services/prefetchScheduler.js`).

**Schema (every table):**

```js
const SERIES_NAME = {
  <year>: { <mint>: <pcgsNumber>, ... },
  // Optional suffixed keys for varieties: P_HR_WIRE, S_NO_MOTTO, S_OVERDATE, etc.
  // Suffixed keys are picked up by extractAllPcgsNumbers() (Phase 3 prefetch)
  // but bypass the canonical lookupPCGSNumber(series, year, mint) accessor.
};
```

**Lookup contract:**

| Function | Inputs | Output |
|---|---|---|
| `lookupPCGSNumber(series, year, mint)` | series name (free text), 4-digit year, mint mark ('', 'D', 'S', 'CC', 'O', 'W') | Numeric PCGS# or `null` |

Series-name routing lives in `SERIES_MAP` (ordered regex list -- specific
patterns first, generic denomination fallbacks last).

**Coverage (PR-2a, 2026-06-30):** 170/210 KEY_DATES entries resolve (81%),
up from 107/209 (51%) pre-PR. Remaining unresolved entries are mostly modern
series (Chinese Panda, Jefferson Nickel, Kennedy/Roosevelt/Lincoln modern key
dates), niche world bullion (Polar Bear, Philharmonic, Kookaburra), and
2026 Semiquincentennial releases.

**Classic US tables added in PR-2a:**

| Table | Denom | Years | PCGS Source URL |
|---|---|---|---|
| `BARBER_DIME` | 10c | 1892-1916 | https://www.pcgs.com/pcgsnolookup/barber-dime/702 |
| `BARBER_QUARTER` | 25c | 1892-1916 | https://www.pcgs.com/pcgsnolookup/barber-quarter/716 |
| `BARBER_HALF` | 50c | 1892-1915 | https://www.pcgs.com/pcgsnolookup/barber-half-dollar/732 |
| `STANDING_LIBERTY_QUARTER` | 25c | 1916-1930 | https://www.pcgs.com/pcgsnolookup/standing-liberty-quarter/111 |
| `SEATED_LIBERTY_DOLLAR` | $1 | 1840-1873 | https://www.pcgs.com/pcgsnolookup/liberty-seated-dollar/29 |
| `LIBERTY_HEAD_HALF_EAGLE` | $5 | 1839-1908 | https://www.pcgs.com/pcgsnolookup/liberty-head-half-eagle/61 |
| `INDIAN_HEAD_HALF_EAGLE` | $5 | 1908-1929 | https://www.pcgs.com/pcgsnolookup/indian-head-half-eagle/771 |
| `INDIAN_HEAD_EAGLE` | $10 | 1907-1933 | https://www.pcgs.com/pcgsnolookup/indian-head-eagle/65 |
| `LIBERTY_DOUBLE_EAGLE` | $20 | 1849-1907 | https://www.pcgs.com/pcgsnolookup/liberty-head-double-eagle/66 |
| `SAINT_GAUDENS_DOUBLE_EAGLE` | $20 | 1907-1933 | https://www.pcgs.com/pcgsnolookup/saint-gaudens-double-eagle/67 |

**Suffixed variety keys** (extracted for Phase 3 prefetch only -- not surfaced
by `lookupPCGSNumber`): `P_HR_WIRE`, `P_HR_FLAT`, `P_MOTTO`, `D_MOTTO`,
`P_NO_MOTTO`, `D_NO_MOTTO`, `S_NO_MOTTO`, `S_PAQUET`, `S_OVERDATE`,
`P_T2`, `D_T2`, `S_T2`, `P_FS401`, `P_WIRE_RIM`, `P_WIRE_RIM_EDGE_STARS`,
`P_PROOF` (used for the 1849 Liberty DE pattern-only specimen, PCGS#71908).

**Ordering rules in `SERIES_MAP`** (critical for correctness):
1. Saint-Gaudens before Liberty Double Eagle (both share 1907 dates).
2. Indian Half Eagle before Indian Eagle ("indian half eagle" must not hit the $10 table).
3. Standing Liberty Quarter before generic `\bquarter\b` (-> Washington) fallback.
4. Seated Liberty Dollar before generic `\bdollar\b` fallback.
5. Barber Dime/Quarter/Half before generic `\bdime\b`/`\bquarter\b`/`\bhalf\s*dollar\b` fallbacks.

**Known limitation: out-of-range fallthrough.** `lookupPCGSNumber` iterates
`SERIES_MAP` and, when a regex matches but the matched table has no entry for
the requested year, falls through to the next matching regex rather than
returning `null`. Combined with the generic denomination fallbacks
(`\bquarter\b`, `\bdime\b`, `\bhalf\s*dollar\b`, `\bdollar\b`), this
means queries with an out-of-range year + specific series name silently
return a different series' PCGS#. Examples:

| Query | Returns | Should be |
|---|---|---|
| `standing liberty quarter 1932` | Washington 1932 PCGS# | null (no 1932 SLQ; series ended 1930) |
| `barber half dollar 1916` | Walking Liberty 1916 PCGS# | null (Barber Half ended 1915) |
| `barber dime 1917` | Mercury 1917 PCGS# | null (Barber Dime ended 1916) |

Real-world impact is small because KEY_DATES entries always pair a series
with a valid year for that series, and most callers route by canonical
series -> table directly. Callers that accept free-text year + series input
should validate the year against the series' production range before relying
on the returned PCGS#. Tracked as a follow-up to tighten lookup semantics.

---

## Azure Key Vault Secrets (if configured)

| Secret Name | Env Var | Type | Used By |
|---|---|---|---|
| `ebay-app-id` | `EBAY_APP_ID` | API key | ebayService |
| `ebay-client-secret` | `EBAY_CLIENT_SECRET` | Secret | ebayService |
| `pcgs-api-key` | `PCGS_API_KEY` | API key | pcgsService |
| `greysheet-api-key` | `GREYSHEET_API_KEY` | API key | greysheetService |
| `admin-api-key` | `ADMIN_API_KEY` | Secret | Admin endpoint auth |
| `jwt-secret` | `JWT_SECRET` | Secret | Auth (JWT signing) |

Never commit these values. Load via `load-secrets.sh` (Azure CLI) or manual .env copy. See docs/runbooks/secret-bootstrap.md.
