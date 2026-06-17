# Background Processes & Automation Status (2026-05-26)

## Working Processes ✓

### 1. PCGS APR Prefetch Scheduler
- **Status:** ✓ ACTIVE & RECENTLY FIXED (PR #50)
- **Schedule:** Nightly 11 PM PT (in-process) + 6:05 AM UTC (GH Actions safety net)
- **Last run:** 2026-05-26 07:58:14 UTC (28.7 min, 990 calls, 79 new records, 0 errors)
- **Fixes (PR #50):** Fire-and-forget (202 response), idempotency guard, 30-min workflow polling, metrics reporting
- **Code:** src/services/prefetchScheduler.js, .github/workflows/nightly-prefetch.yml

### 2. Metals Spot Price Polling
- **Status:** ✓ ACTIVE
- **Interval:** 30 min (configurable: METALS_POLL_MS)
- **Providers:** Round-robin goldapi.io / metals-api.com
- **Persistence:** cache/metals_spot.json
- **Failure alert:** After 2+ consecutive failures (if SendGrid configured)
- **Code:** server.js, src/services/metalsSpotPrice.js

### 3. Greysheet Price History Refresh
- **Status:** ✓ ACTIVE
- **Interval:** 3 days default (configurable: GS_REFRESH_INTERVAL_DAYS)
- **Behavior:** Checks on startup (T+10s), re-checks hourly, runs if interval elapsed
- **Data retention:** Auto-evicts entries older than 400 days
- **Failure alert:** On error (if SendGrid configured)
- **Code:** server.js, src/services/greysheetHistoryService.js

### 4. Terapeak Blob Re-Import
- **Status:** ✓ ACTIVE (if Blob enabled)
- **Interval:** 30 min (configurable: BLOB_REIMPORT_MS)
- **Purpose:** Polls Azure Blob Storage for new CSV uploads from scrapers
- **Auto-import:** CSVs < 7 days old
- **Cache clear:** Clears eBay cache on new import
- **Failure alert:** After 3+ consecutive failures (if SendGrid configured)
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
- **Type:** On-demand SendGrid v3 API notifications
- **Should alert on:**
  - Metals refresh failure (2+ consecutive)
  - Greysheet refresh failure
  - Blob re-import failure (3+ consecutive)
  - PCGS prefetch failure (2+ consecutive)
  - PCGS breaker tripped during daytime
  - Server crash (unhandledRejection, uncaughtException)

**Missing Config:**
- ❌ SENDGRID_API_KEY: NOT in Azure Key Vault
- ❌ ALERT_EMAIL_TO: NOT in Azure App Service
- ✓ ALERT_FROM_EMAIL: Defaults OK (alerts@coinpricefinder.app)

**Current fallback:** Failures log to cache/alert_log.json (rate-limited 1/hour per topic)

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
| Prefetch enabled | PCGS_PREFETCH_ENABLED | true | ✓ Yes |
| SendGrid key | SENDGRID_API_KEY | (none) | ✓ Needs setup |
| Alert email | ALERT_EMAIL_TO | (none) | ✓ Needs setup |

---

## To Enable Email Alerts (Priority 3)

1. Get SendGrid API key (or create account at sendgrid.com)
2. `az keyvault secret set --vault-name coinpricefinder-kv --name SENDGRID-API-KEY --value "KEY"`
3. `az webapp config appsettings set --name coinpricefinder-h3a3b5g0dmdydna4 --resource-group CoinPriceFinder_group-82d5 --settings ALERT_EMAIL_TO="admin@..." SENDGRID_API_KEY="@Microsoft.KeyVault(...)"`
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
