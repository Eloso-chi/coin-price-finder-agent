# Background Processes & Automation Status (refreshed 2026-09-04 for #314H)

## Working Processes ✓

### 1. PCGS APR Prefetch Scheduler
- **Status:** CONTAINED; automatic triggers disabled during #314H production remediation
- **Schedule:** In-process disabled with `PCGS_PREFETCH_ENABLED=false`; GitHub Actions remains manually disabled during containment. Its dual 6:05/7:05 UTC schedule is restored in code with a 23:00 `America/Los_Angeles` gate for post-validation re-enablement. Controlled manual diagnostics remain available.
- **Production truth:** Use `/api/admin/prefetch-status` or the nightly workflow logs; local `cache/` files are not production evidence.
- **Fixes (PR #50):** Fire-and-forget (202 response), idempotency guard, 30-min workflow polling, metrics reporting
- **Fixes (#277W, 2026-07-03):**
  - `lastStatus` no longer clobbered by safety-net "no quota" skip writes.  The skip attempt now records into `lastAttempt` / `lastAttemptStatus` / `lastAttemptReason` and leaves the completed-run `status` / `lastRun` / `callsMade` / `newRecords` fields intact.
  - Status file gains `perCategory: { us_classic, us_bullion, world_bullion, unknown -> { attempted, newRecords } }` so `/api/admin/prefetch-status` can prove world coins received their round-robin share on any given night without a manifest read.
- **Recovery (#285H, 2026-07-31):**
  - Persists upstream HTTP 429 cooldown separately from the local daily quota counter, including sanitized reset metadata and reason.
  - Scheduled and manual triggers make no PCGS calls during cooldown. After expiry, one bounded probe must succeed before the normal queue continues.
  - Unexpired cooldown survives process restart and Pacific day rollover. Missing or malformed reset headers use `PCGS_429_COOLDOWN_MS` (default one hour).
  - Production validation remains open for three consecutive nightly runs without the prior one-call-then-429 pattern.
- **Observed-limit safety follow-up (#285H, 2026-08-13):** Numeric `X-RateLimit-Limit` and `X-RateLimit-Remaining` values from 429 responses are persisted and exposed in status. Nightly prefetch is temporarily bounded by `PCGS_PREFETCH_OBSERVED_LIMIT=100` minus the 10-call reserve, for a fresh-run maximum of 90 calls; the shared published entitlement remains 1,000.
- **Alerting (#282W/#285H, 2026-08-13):** Partial and fatal runs share a two-run alert gate and neutral "degraded" wording. Completed runs reset the streak; ACS delivery and fallback logs share one-hour per-topic burst limiting.
- **Invalid-response protection (#310H, 2026-09-01):** HTTP-success APR payloads with `IsValidRequest !== true` are classified as failures with bounded rejection details. A rejected `pcgsNo:grade` target is quarantined from automatic queueing for 30 days, five invalid responses anywhere in one run stop it, and an invalid recovery probe stops after its one bounded call. `/api/admin/prefetch-status` exposes `lastInvalidResponses` and capped `lastRejectedTargets`; production validation remains pending.
- **Systemic rejection containment (#314H, 2026-09-04):** A one-call sanitized diagnostic against verified PCGS 7130 grade 65 returned HTTP 200 with `IsValidRequest=true`. Durable handling classifies bare/account/service rejection as systemic, persists a distinct 24-hour cooldown after five distinct targets, avoids per-target quarantine, and uses that verified target for exactly one recovery probe. Workflow completion now fails for scheduler `partial`, `failed`, or unverified timeout outcomes. Automatic triggers remain off until deployment and controlled production validation.
- Recovery-probe coordination uses an exclusive shared lock and fails closed if that lock already exists. A lock left after abnormal process termination must be inspected and removed by an operator only after confirming no instance is probing; it is never reclaimed automatically.
- **Selective #314H repair runbook:** Keep every application instance stopped so no process holds a stale in-memory manifest. Run `node scripts/repair-apr-generic-quarantines.js` first and review the exact key list and default `2026-09-01T00:00:00.000Z` cutoff. Apply only with `node scripts/repair-apr-generic-quarantines.js --apply --confirm-app-stopped`; use `--cutoff=<ISO timestamp>` only with incident evidence. Verify the reported exclusive backup exists, restart the app, confirm APR history counts remain intact, and confirm only exact generic incident quarantine fields disappeared. To roll back, stop every instance again and restore the reported `.pre-314H-repair-*.bak` file before restart. Never run this against a live writer or delete the full manifest/cache.
- **Code:** src/services/prefetchScheduler.js, .github/workflows/nightly-prefetch.yml

### 2. Metals Spot Price Polling
- **Status:** ✓ ACTIVE
- **Interval:** 30 min (configurable: METALS_POLL_MS)
- **Providers:** Four-provider round-robin: gold-api.com, goldprice.org, GoldAPI, and Metals-API
- **Persistence:** cache/metals_spot.json
- **Failure alert:** After 3+ consecutive failures (if ACS Email configured)
- **Code:** server.js, src/services/metalsSpotPrice.js

### 3. Greysheet Price History Refresh
- **Status:** ✓ ACTIVE
- **Interval:** 3 days default (configurable: GS_REFRESH_INTERVAL_DAYS)
- **Behavior:** Checks on startup (T+10s), re-checks hourly, runs if interval elapsed
- **Data retention:** Auto-evicts entries older than 400 days
- **Failure alert:** On error (if ACS Email configured)
- **Code:** server.js, src/services/greysheetHistoryService.js

### 4. Terapeak Blob Re-Import
- **Status:** ✓ ACTIVE (if Blob enabled)
- **Interval:** 30 min (configurable: BLOB_REIMPORT_MS)
- **Purpose:** Polls Azure Blob Storage for new CSV uploads from scrapers
- **Auto-import:** CSVs < 7 days old
- **Cache clear:** Clears eBay cache on new import
- **Failure alert:** After 3+ consecutive failures (if ACS Email configured)
- **Code:** server.js, src/services/terapeakService.js

### 5. Bulk Evaluate Job Cleanup
- **Status:** ✓ ACTIVE (on-request garbage collection)
- **TTL:** 1 hour per job
- **Cleanup:** Prunes expired jobs on each new request
- **Code:** src/routes/bulkEvaluateRoute.js

---

## NOT Working / Disabled ⚠️

### Email Alert System
- **Status:** ⚠️ **NOT CONFIGURED** in production
- **Type:** On-demand Azure Communication Services Email notifications
- **Should alert on:**
  - Metals refresh failure (2+ consecutive)
  - Greysheet refresh failure
  - Blob re-import failure (3+ consecutive)
  - PCGS prefetch failure or partial run (2+ consecutive)
  - PCGS breaker tripped during daytime
  - Server crash (unhandledRejection, uncaughtException)

**Missing Config:**
- ❌ COMMUNICATION_CONNECTION_STRING: NOT in Azure Key Vault / App Service
- ❌ ALERT_EMAIL_TO: NOT in Azure App Service
- ❌ ALERT_FROM_EMAIL: NOT in Azure App Service

**Current fallback:** Failures log to cache/alert_log.json. Both fallback logs and configured email are burst-limited to one alert per hour per topic; a degradation that persists across nights can still produce one alert each night.

---

## Health Endpoints

All background processes have status endpoints:
- GET /api/health — overall server status & uptime
- GET /api/admin/prefetch-status — PCGS APR scheduler state (needs ADMIN_API_KEY)
- GET /api/admin/pcgs-quota — PCGS API quota status
- GET /api/admin/dashboard — overall system stats

---

## Configuration Summary

| Process | Env Var | Default | Configurable? |
|---------|---------|---------|---------------|
| Metals polling | METALS_POLL_MS | 1800000 (30m) | ✓ Yes |
| Greysheet interval | GS_REFRESH_INTERVAL_DAYS | 3 | ✓ Yes |
| Blob re-import | BLOB_REIMPORT_MS | 1800000 (30m) | ✓ Yes |
| Prefetch hour | PREFETCH_HOUR_PT | 23 (11 PM) | ✓ Yes |
| Prefetch throttle | PREFETCH_THROTTLE_MS | 1000 | ✓ Yes |
| Prefetch reserve | PREFETCH_RESERVE | 10 | ✓ Yes |
| Prefetch observed upstream limit | PCGS_PREFETCH_OBSERVED_LIMIT | 100 (90-call effective fresh budget) | ✓ Yes |
| Prefetch enabled | PCGS_PREFETCH_ENABLED | true | ✓ Yes |
| PCGS 429 fallback cooldown | PCGS_429_COOLDOWN_MS | 3600000 (1h) | ✓ Yes |
| PCGS systemic rejection cooldown | PCGS_SYSTEMIC_COOLDOWN_MS | 86400000 (24h) | Yes |
| ACS Email connection | COMMUNICATION_CONNECTION_STRING | (none) | ✓ Needs setup |
| Alert email | ALERT_EMAIL_TO | (none) | ✓ Needs setup |
| Alert sender | ALERT_FROM_EMAIL | (none) | ✓ Needs setup |

---

## To Enable Email Alerts (Priority 3)

1. Provision or select an Azure Communication Services Email resource and verified sender domain.
2. Store its connection string in Key Vault without printing it to logs or chat.
3. Configure App Service Key Vault references for `COMMUNICATION_CONNECTION_STRING`, `ALERT_EMAIL_TO`, and `ALERT_FROM_EMAIL`.
4. Restart app: `az webapp restart --name coinpricefinder-h3a3b5g0dmdydna4 --resource-group CoinPriceFinder_group-82d5`

---

## Test Commands

```bash
# Check prefetch status
curl -H "x-api-key: ADMIN_KEY" https://coinpricefinder.azurewebsites.net/api/admin/prefetch-status

# Check metals data freshness
curl https://coinpricefinder.azurewebsites.net/api/metals/spot

# Check PCGS quota
curl -H "x-api-key: ADMIN_KEY" https://coinpricefinder.azurewebsites.net/api/admin/pcgs-quota

# Manually trigger prefetch (returns 202)
curl -X POST -H "x-api-key: ADMIN_KEY" https://coinpricefinder.azurewebsites.net/api/admin/prefetch-trigger

# Check alert log fallback
ssh-to-app && cat /mnt/cache/alert_log.json
```
