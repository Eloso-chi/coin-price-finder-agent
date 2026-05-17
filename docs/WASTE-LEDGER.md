# Waste Ledger

Tracks wasted compute, agent time, and Azure cost caused by bugs, agent violations, and operational failures.

---

## Rate Card

| Resource | Unit Cost | Notes |
|----------|-----------|-------|
| Codespace (2-core) | $0.18/hr | GitHub consumption billing |
| Copilot premium request | $0.04/request | Consumed against plan or overage -- always counted |
| Azure App Service B2 | $0.075/hr | Always-on, rarely incident-affected |
| Azure Cosmos DB | $0.25/1M RU | Serverless, negligible for most incidents |
| Azure Blob Storage | ~$0.01/10K ops | Negligible |

---

## Categories

| Code | Description |
|------|-------------|
| `data-corruption` | Data destroyed or silently degraded by a bug |
| `agent-violation` | Agent broke an operating rule (e.g., blocking server, unsafe action) |
| `duplicate-pull` | Data re-fetched that already existed |
| `bot-detection` | Session killed by anti-bot measures |
| `code-bug` | Bug in production code caused rework |
| `config-error` | Misconfiguration caused failure |
| `recovery-ops` | Time spent recovering from another incident |

---

## Incidents

### INC-001: CSV Overwrite -- Deep-Paginated Data Destroyed

| Field | Value |
|-------|-------|
| Date | 2026-05-08 through 2026-05-16 |
| Category | `data-corruption` |
| Root Cause | `csv_path.rename(dest)` in `terapeak-export.py` replaced deep-paginated CSVs (100-580 rows) with page-1 exports (50 rows) on every refresh |
| Impact | 16,188 rows lost across 165 files over 8 commits. 103 datasets dropped below deep-pagination threshold. Store cache (`terapeak_sold.json`) rebuilt from truncated data. |
| Codespace | 14h (original deep-pagination compute destroyed) = **$2.52** |
| Copilot | ~30 requests (diagnosis session) = **$1.20** |
| Azure | < $0.01 |
| **Total** | **$3.72** |
| Resolution | PR #21 -- `_merge_csv()` + shrink guard. Restored 165 CSVs from git `416829a`. |
| Rule Added | Export script must merge, never overwrite. Shrink guard rejects if new < existing. |

---

### INC-002: Sidecar Overwrite -- Jest Debounce Race

| Field | Value |
|-------|-------|
| Date | 2026-05-16 to 2026-05-17 |
| Category | `data-corruption` / `code-bug` |
| Root Cause | `saveMetaSidecar()` uses a 2s debounce timer. Jest `afterAll()` restores the original file, but the pending timer fires afterward, writing test-state (2 entries) over production sidecar (3,654 entries). |
| Impact | `data/terapeak-meta.json` clobbered from 3,654 entries to 2. Freshness report, stale refresh targeting, and comp counts all degraded until recovery. |
| Codespace | 74 min (discovery through verified fix) = **$0.22** |
| Copilot | ~50 requests (diagnosis + fix + test rewrites) = **$2.00** |
| Azure | $0.00 |
| **Total** | **$2.22** |
| Resolution | Commit `44444ad` -- `NODE_ENV=test` guard skips `saveStore()`/`saveMetaSidecar()`. Exported `_cancelPendingSaves()` for test teardown. Sidecar recovered via `backfillMetaFromDisk()`. |
| Rule Added | All disk-write functions must no-op under `NODE_ENV=test`. |

---

### INC-003: Agent Started Server Blocking Terminal

| Field | Value |
|-------|-------|
| Date | 2026-05-17 |
| Category | `agent-violation` |
| Rule Violated | "ALWAYS start `node server.js` with `isBackground: true`" |
| Root Cause | Agent ran `node server.js` with `isBackground: false`, blocking the terminal session. No subsequent commands could execute until manually killed. |
| Impact | Terminal blocked; required kill + restart. |
| Codespace | ~5 min = **$0.02** |
| Copilot | ~3 requests (detect + fix) = **$0.12** |
| Azure | $0.00 |
| **Total** | **$0.14** |
| Resolution | Killed process, restarted with correct flag. Added rule to `/memories/server-management.md`. |
| Rework Cost | $0.14 |

---

### INC-004: Bot Detection -- Export Session Killed at 22%

| Field | Value |
|-------|-------|
| Date | 2026-05-16 |
| Category | `bot-detection` |
| Root Cause | Terapeak anti-bot triggered during stale refresh. Session terminated at 22% completion (~700 of 3,200 datasets processed). |
| Impact | ~2h of Codespace time for setup + partial run wasted. Cookies invalidated. Required manual re-login + fresh cookie export. |
| Codespace | 2h (session time lost) = **$0.36** |
| Copilot | ~5 requests (setup + diagnosis) = **$0.20** |
| Azure | $0.00 |
| **Total** | **$0.56** |
| Resolution | Fresh VNC login, new cookies exported. Keepalive process added (5-min interval). |
| Rule Added | Always run keepalive alongside exports. Monitor for early termination signals. |

---

### INC-005: Agent Ran Tests That Triggered Sidecar Corruption

| Field | Value |
|-------|-------|
| Date | 2026-05-16 |
| Category | `agent-violation` |
| Rule Violated | Understand side effects before running destructive operations |
| Root Cause | Agent ran the full test suite as a diagnostic step without understanding that the debounce race would clobber the sidecar. The test run itself was the destructive event. |
| Impact | Directly caused INC-002. Cost already counted there. |
| Codespace | (counted in INC-002) |
| Copilot | ~2 requests = **$0.08** |
| Azure | $0.00 |
| **Total** | **$0.08** (incremental; bulk cost in INC-002) |
| Resolution | Same as INC-002. |
| Rework Cost | $0.08 |

---

### INC-006: Duplicate CSV Rows Re-Fetched

| Field | Value |
|-------|-------|
| Date | 2026-05-16 |
| Category | `duplicate-pull` |
| Root Cause | Stale refresh exported page-1 data that overlapped with existing rows. Pre-merge dedup removed 754 duplicate rows. |
| Impact | Minimal -- bandwidth and minor Codespace time. Data integrity preserved by dedup logic. |
| Codespace | ~3 min = **$0.01** |
| Copilot | $0.00 |
| Azure | $0.00 |
| **Total** | **$0.01** |
| Resolution | Acceptable. Dedup logic in `_merge_csv()` handles this correctly. No action needed. |

---

## Summary

| # | Date | Category | Description | Total Cost |
|---|------|----------|-------------|------------|
| INC-001 | May 8-16 | data-corruption | CSV overwrite destroyed 16K rows | $3.72 |
| INC-002 | May 16-17 | data-corruption | Sidecar clobbered by Jest race | $2.22 |
| INC-003 | May 17 | agent-violation | Server started blocking | $0.14 |
| INC-004 | May 16 | bot-detection | Export killed at 22% | $0.56 |
| INC-005 | May 16 | agent-violation | Tests triggered corruption | $0.08 |
| INC-006 | May 16 | duplicate-pull | 754 rows re-fetched | $0.01 |
| | | | **Running Total** | **$6.73** |

---

## Metrics

- **Total waste (all time):** $6.73
- **Worst category:** data-corruption ($5.94 / 88%)
- **Agent violations:** 2 incidents, $0.22
- **Preventable (with rules now in place):** $6.17 (INC-001 through INC-005)
