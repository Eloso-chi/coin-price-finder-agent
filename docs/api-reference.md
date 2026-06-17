# API Reference

Comprehensive reference of all HTTP endpoints exposed by the coin-price-finder-agent service.

**Auth:** 🔒 = requires `ADMIN_API_KEY` via `x-api-key` header. Protected endpoints without 🔒 = require `Authorization: Bearer <jwt>` header.

## Core Pricing

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/price` | None | Price a single coin — main entry point for pricing |
| `POST` | `/api/bar-price` | None | Price a bullion bar by metal, size, brand |
| `GET` | `/api/bar-price/options` | None | List available brands and series for bar pricing |
| `POST` | `/api/pricing-batch` | None | Batch-price up to 25 coins in one request |
| `GET` | `/api/coin-variant` | None | Design-series metadata (e.g., ASE variants, Proof vs BU) |
| `GET` | `/api/coin-history` | None | Sold-price time-series with optional spot-price overlay |

## Bulk Lot Evaluator

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/bulk-evaluate` | None | Submit a lot for batch evaluation; returns `jobId` |
| `GET` | `/api/bulk-evaluate/:jobId` | None | Poll job status and completed results |
| `GET` | `/api/bulk-evaluate/:jobId/stream` | None | SSE stream of per-coin + lot summary results |

**Input formats:** text (one coin per line, pipe-delimited), JSON array, or Excel .xlsx upload.

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
| `GET` | `/api/image-proxy` | None | Proxy coin images from allowlisted hosts (SSRF-protected) |

## Data Imports

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/import/excel` | None | Import coin collection from Excel (.xlsx) spreadsheet |
| `POST` | `/api/terapeak/import` | 🔒 | Upload a Terapeak CSV (multipart form) |
| `POST` | `/api/terapeak/import-text` | 🔒 | Paste Terapeak CSV as plain text |
| `GET` | `/api/terapeak/datasets` | 🔒 | List all imported Terapeak datasets with metadata |
| `GET` | `/api/terapeak/lookup` | None | Look up sold comps by keyword search |
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
| `GET` | `/api/admin/dashboard` | 🔒 | System overview: user count, dataset count, quota, uptime |
| `GET` | `/api/admin/stale-datasets` | 🔒 | Datasets older than N days (filters dormant/thin via freshness classifier) |
| `GET` | `/api/admin/data-health` | 🔒 | Total files, empty files, date ranges |
| `GET` | `/api/admin/prefetch-status` | 🔒 | PCGS nightly prefetch scheduler status |
| `POST` | `/api/admin/prefetch-trigger` | 🔒 | Trigger manual PCGS prefetch run |
| `GET` | `/api/admin/pcgs-quota` | 🔒 | Current PCGS API quota usage |
| `GET` | `/api/admin/auction-history` | 🔒 | Retrieve cached auction history |
| `POST` | `/api/admin/auction-fetch` | 🔒 | Force live auction refresh |
| `POST` | `/api/clear-cache` | 🔒 | Flush all service caches |

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

Error responses include a `message` field with details.
