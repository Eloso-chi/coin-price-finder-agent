# Production State Lookup -- codespace `cache/` is NOT production truth

**Origin:** 2026-07-03 investigation captured in PR #220 (`fix/277W-prefetch-status-observability`). This document was written after a real misdiagnosis where a Copilot session claimed "PCGS prefetch hasn't run in 3 nights" based on reading `cache/prefetch_status.json` in the codespace. In reality the prefetch had run every night in production; the codespace file is a local dev artifact and has no relationship to Azure state. This memory exists to prevent that specific mistake from recurring on any machine (Windows or Codespace).

---

## Rule

**Anything under `cache/` in this workspace is not authoritative.** Verify with:

```bash
git check-ignore -v cache/<file>   # will print the .gitignore line proving it is local-only
```

Concretely, `cache/` is:

- `.gitignore`d
- written only when THIS machine's `node server.js` runs, or by Jest test fixtures
- **never** synced from Azure Files. It never reflects production state.

Do **not** infer whether a production background process ran (or when, or with what result) from any file under `cache/`. Use the admin endpoints or the GH Actions workflow history instead.

---

## Sources of truth for production state

App Service URL: `https://coinpricefinder-h3a3b5g0dmdydna4.azurewebsites.net`

| Question | Source of truth | Notes |
|---|---|---|
| Did the PCGS prefetch run? | `GET /api/admin/prefetch-status` | Needs `x-api-key: $ADMIN_API_KEY` |
| PCGS quota state? | `GET /api/admin/pcgs-quota` | Needs admin key |
| Overall server health? | `GET /api/health` | Public, no auth |
| System stats? | `GET /api/admin/dashboard` | Needs admin key |
| Auction history for one coin? | `GET /api/admin/auction-history?pcgsNo=X&grade=Y` | Needs admin key |
| Did the safety-net cron fire? | `gh run list --workflow=nightly-prefetch.yml -L 15` then `gh run view <id> --log` | Codespace token is fine for read-only `gh run` calls; no `unset GITHUB_TOKEN` needed |
| Terapeak sidecar as prod sees it? | `GET /api/admin/terapeak-meta` | Needs admin key; used by remote scrapers (#253) |

The `ADMIN_API_KEY` value is **REDACTED** from all repo docs and memory files. Load it from `.env` locally or from Azure Key Vault (`ADMIN-API-KEY` secret). Never paste it into chat.

## Order of operations when asked "did X happen in prod?"

1. **Check the GitHub Actions workflow that triggers X** (`gh run list --workflow=<name> -L 15`). Cron history is the cheapest signal and works from any machine with `gh` installed. Recent runs green = the trigger fired.

2. **If the workflow polls the admin endpoint and prints the response** (as `nightly-prefetch.yml` does at ~07:20 UTC nightly), extract the response body from the log:

   ```bash
   gh run view <run_id> --log 2>&1 | grep -E "lastRun|lastStatus|lastCalls|newRecords|quota"
   ```

   This gives you the real production status file contents without needing an admin key.

3. **Only fall back to curling the admin endpoint** if steps 1-2 are insufficient. Use the user's local `ADMIN_API_KEY`; do not fetch it into the codespace environment.

4. **Never** infer prod state from `cache/*.json` in this workspace.

---

## Files that look authoritative but are NOT

| Codespace file | What it actually is |
|---|---|
| `cache/prefetch_status.json` | Only written when this codespace's `node server.js` runs. Bears no relation to Azure's copy at `$CACHE_DIR/prefetch_status.json`. |
| `cache/apr_manifest.json` | Same. Records per-`pcgsNo:grade` fetches from local runs and test fixtures only. |
| `cache/metals_spot.json` | Local polling only, when the local server runs. |
| `cache/alert_log.json` | Local alert fallback + Jest test noise. Entries around test runs (e.g. `"error": "not-configured"` / `"topic": "test-topic"`) are test artefacts, not real alerts. |
| `cache/pcgs_quota.json` | Local quota accounting; production quota lives in the App Service process memory + Azure Files sidecar. |

If any of these files exist in this workspace, treat them as unreliable snapshots of an old local run. Timestamp them (`stat -c '%y' cache/*.json`) and note the mtime is codespace-local before drawing any conclusion.

---

## Confounding detail: pre-PR #220 the production status file itself was misleading

Even production `prefetch_status.json` was itself confusing before PR #220. The GH Actions safety-net workflow triggers `/api/admin/prefetch-trigger` ~1 hour after the in-process 23:00 PT scheduler runs. When Pacific-date rollover causes the second call to re-invoke `executePrefetchRun`, it hits the `available <= 0` branch, and pre-#220 that branch wrote `status: 'skipped'` while preserving `lastRun` / `callsMade` / `newRecords` via spread. The file ended up looking like:

```json
{
  "lastRun": "2026-07-02T07:48:37.720Z",   // real completed run
  "status": "skipped",                       // confusing overwrite from a later skip attempt
  "callsMade": 990,                          // real
  "newRecords": 607                          // real
}
```

Post-#220, the skip branch writes to `lastAttempt` / `lastAttemptStatus` / `lastAttemptReason` and `status` reflects the last real run only. `lastPerCategory` also appears with per-bucket `{ attempted, newRecords }` counts.

---

## Cross-references

- `docs/memory/background-processes-status.md` -- inventory of background timers, updated 2026-07-03 for #277W
- `docs/memory/azure-infrastructure.md` -- Key Vault, Cosmos DB, Blob Storage, App Service topology
- `.github/workflows/nightly-prefetch.yml` -- the safety-net cron whose logs are the cheapest way to observe prod status
- `src/services/prefetchScheduler.js` -- the in-process scheduler and status file writer
