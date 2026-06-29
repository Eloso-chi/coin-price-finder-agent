# Data Dictionary

Reference for critical data stores, schemas, and privacy classifications used by the coin-price-finder-agent service.

## Local Filesystem Stores

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
| `batch_size` | number | Public | Randomized batch for this pass (15-30 default) |
| `include_thin` | boolean | Public | Whether thin-data datasets were included this pass |
| `start_ts` | ISO 8601 | Public | Pass start timestamp (UTC) |
| `end_ts` | ISO 8601 | Public | Pass end timestamp (UTC) |
| `duration_sec` | number or null | Public | Wall-clock seconds; null if timestamps unparseable |
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
| `.lastRefreshAt` | date (YYYY-MM-DD) | Public | Last date a refresh/reimport was attempted |
| `.refreshCount` | number | Public | Cumulative count of refresh attempts |
| `.consecutiveDryRefreshes` | number | Public | Counter for consecutive refresh-with-no-new-comps (triggers dormant classification via freshnessClassifier) |
| `.lastRefreshNewComps` | number | Public | Number of new comps added in most recent refresh |

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

## Data Privacy Classifications

| Classification | Examples | Handling |
|---|---|---|
| **Public** | Series names, grades, years, mint marks, spot prices, FMV | Safe to log, cache, expose in API responses |
| **Private** | Cost basis, user notes, payment details, JWT tokens | Never log to unsecured systems; don't expose in API unless authenticated |
| **Sensitive** | Passwords (hashes only), API keys, secrets in .env | Never commit; rotate on leak; use Azure Key Vault for team access |

---

## CSV File Format (Terapeak)

Terapeak CSV exports follow this structure:

| Column | Type | Example | Notes |
|--------|------|---------|-------|
| `Sell Date` | date | 2026-05-15 | Sale transaction date |
| `Sales Price` | USD | 85.50 | Realized sale price |
| `Title` | text | "1881-CC Morgan Dollar MS 64" | Listing title; parsed for grade/finish |
| `Item Condition` | enum | "Used" | Item condition code |
| `Quantity Sold` | number | 1 | Number of units in transaction |

After import, Terapeak data is de-duped and merged into a single in-memory result set keyed by series. Duplicates are detected by `{title, saleDate, price}` tuple to avoid double-counting.

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
