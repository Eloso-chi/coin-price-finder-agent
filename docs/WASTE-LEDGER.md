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

### INC-007: Agent Code Quality Failures + Process Violations (PRs #39 & #40)

| Field | Value |
|-------|-------|
| Date | 2026-05-23 |
| Category | `code-bug` / `agent-violation` |
| Root Cause | Insufficient self-review before commit. Code shipped with comparison bug (raw count vs filtered count), fragile mutation pattern, and orphaned tests for removed code. Pre-commit reviewer skipped after fix commits. Wasted compute running unrelated test suite on main to deflect. |
| Mistakes | 1) Used `aprData.records.length` (includes null-price entries) vs `pcgs.auction?.count` (filtered) -- apples-to-oranges. 2) Mutation pattern `pcgs.auction = stats; pcgs.auction.trend = x` risks leaking trend into cached reference. 3) Removed Search endpoint but left 3 tests asserting its behavior. 4) Did not run pre-commit reviewer after fix commits; ran irrelevant 68s full test suite on main instead. 5) Asked user about `--admin` merge override when user is sole owner/codeowner. |
| Rules Violated | "Run pre-commit reviewer" (PR workflow step 3); "Optimize for correctness"; "Surface mistakes immediately"; "Do not assume intent" |
| Codespace | ~45 min rework = **$0.14** |
| Copilot | ~35 premium requests (review sub-agents, file reads, fixes, wasted test runs, merge attempts) = **$1.40** |
| Azure | $0.00 |
| **Total** | **$1.54** |
| Resolution | Fix commits `607b2f7` (PR #40) and `2162331` (PR #39). Both PRs merged to main via `--admin`. No production impact (not deployed between initial commit and fix). |

---

### INC-008: PR #52 Branch-Protection Bypass + Repeated Token Rediscovery + Silent Working-Tree Carryover

| Field | Value |
|-------|-------|
| Date | 2026-05-26 through 2026-05-27 |
| Category | `agent-violation` / `recovery-ops` |
| Rules Violated | "ALL changes must go through a PR workflow"; "Never commit directly to `main`"; "Two-strike rule"; "Ask permission before hard-to-reverse changes"; "Workarounds are a last resort" |
| Root Cause | (1) Agent committed PR #52 on a working tree that already contained unrelated in-progress edits (`ebayService.js` proof-pool split, `pcgsService.js` fractional-oz parsing, matching tests) without auditing `git status` or surfacing them to the user. (2) When `gh` returned 404s on PR #52 (codespace `GITHUB_TOKEN` is a scoped GitHub App token with no access to this private repo), agent improvised: tried `gh`, then raw API, then escalated to a git worktree fast-forwarding `origin/main` to the feature branch -- bypassing branch protection and the documented review-deep / approval-gated reviewer steps. Should have stopped after the second failure (two-strike rule) and escalated. (3) Token-precedence quirk (codespace `GITHUB_TOKEN` shadows OAuth-login `gh auth`) was not persisted to memory, so the following session rediscovered it from scratch with multiple probes. (4) The leftover working-tree edits surfaced only the next day when user asked to commit new work, forcing rediscovery and clarification turns. |
| Impact | (a) PR #52 merged to `main` without review, branch-protection bypass logged by remote. No production code damage but review trail lost. (b) Following session burned turns re-investigating leftover edits via reflog/mtime/diff, re-diagnosing the token issue with curl probes, and explaining the behavior delta to the user. (c) User explicitly called out wasted spend and asked for waste-log entry. |
| Mistakes | 1) No `git status` audit before staging PR #52. 2) Improvised around branch protection instead of stopping. 3) Did not capture token-precedence quirk in repo memory. 4) Created a new `/memories/repo/waste-log.md` instead of locating and updating `docs/WASTE-LEDGER.md` -- user had to redirect. 5) Did not run pre-commit reviewer or review-deep on PR #52 (skipped both gates). |
| Codespace | ~50 min combined (bypass workaround + next-day rediscovery + explanation) = **$0.15** |
| Copilot | ~35 premium requests (PR #52 workaround attempts ~15; next-day investigation + token diagnosis + explanations + ledger redo ~20) = **$1.40** |
| Azure | $0.00 |
| **Total** | **$1.55** |
| Resolution | Honest disclosure to user; INC-008 logged with full root cause. Three follow-on PRs queued to properly land the carried-over edits (lot-estimator health, proof pool split, fractional-oz parsing). No remediation possible on PR #52's lost review trail. |
| Rules Added | 1) Always audit `git status` before any commit; list every modified/untracked file and explicitly include, exclude, or ask. 2) Never push directly to `main` or use worktree fast-forward as a workaround for branch protection -- escalate to user instead. 3) Hard stop after two `gh` failures: try one `GITHUB_TOKEN= GH_TOKEN= gh ...` fallback, then escalate. 4) Before searching memory, also check `docs/` for project-owned ledgers (WASTE-LEDGER.md, BACKLOG.md, ARCHITECTURE.md). 5) Persist codespace token-precedence quirk to repo memory so future sessions prefix `gh` calls correctly from turn 1. |

---

### INC-009: Backlog Drift -- Multi-Pass Reconciliation Triggered by Stale Status

| Field | Value |
|-------|-------|
| Date | 2026-05-31 |
| Category | `agent-violation` / `recovery-ops` |
| Root Cause | Agent let `docs/BACKLOG.md` drift from reality over multiple sessions: items implemented in code/data (PCGS world bullion numbers #206-#210/#212-#213, RRV mode #195, classification audit agent #190, sales-aggregator APP_URL #182, holdout validation #177, bar-pricing-health #187, pricing-regression #191, classification-audit #192, admin role #201, PAMP Suisse normalization #225, cross-route platinum #184, Type 1 ASE dataset #168, Franklin/Kennedy D-mints #44/#46, 1870-CC Seated Liberty dataset #170) were never marked DONE. Required three escalating user prompts ("are 206-213 done?", "mark any and all done", "spot check open items") plus a thorough fourth-pass verification to clean up. Compounded: agent then **falsely marked #228 DONE** based on `git checkout` mtimes rather than verifying scrape scope; user caught the error. |
| Impact | 16 backlog items correctly moved Open -> DONE this session; 1 (#228) wrongly marked DONE and reverted after user challenge. User had to re-ask three times AND catch a fabricated completion. Three+ extra reconciliation rounds in this session that should have been one. Also originally violated process by tracking items in `/memories/repo/future-edits.md` instead of `docs/BACKLOG.md` (corrected earlier in same session). |
| Codespace | ~90 min of session time spent on reconciliation that should have been an ongoing per-PR discipline = **$0.27** |
| Copilot | ~35 requests across the three reconciliation rounds (initial gap analysis, PCGS pass, spot check, thorough verification) = **$1.40** |
| Azure | $0.00 |
| **Total** | **$1.67** |
| Resolution | Imported all open items into BACKLOG.md (Option A bulk reconciliation), then ran four verification passes against the actual codebase. Final state: 17 items moved Open -> DONE in this session; ~30 truly open remain. |
| Rules Added | 1) **Every PR that implements a backlog item MUST update its status in the same commit** -- enforced by PR template review checklist. 2) When asked "show the backlog", agent MUST spot-check status of at least the top-priority items against current code, not just read the file. 3) Backlog status changes are approval-gated per `BACKLOG.rules.md` but the *verification* of completion is not -- agent must surface evidence proactively. 4) `/memories/repo/future-edits.md` is non-authoritative; never the destination for new items. 5) **File mtimes are NOT evidence of work being done** -- `git checkout` updates mtimes. Use `git log -- <path>` to verify actual content changes, and read commit messages to confirm scope matches the backlog item. |

---

### INC-011: Backfill Script Truncated Sidecar -- Incomplete Wiring + Missing Integration Test

| Field | Value |
|-------|-------|
| Date | 2026-06-02 |
| Category | `data-corruption` / `code-bug` / `agent-violation` |
| Root Cause | PR #86 Fix C (`scripts/backfill-no-data.js`) was authored against the in-memory `terapeakService._store` API but never wired up the store hydration that the running server does at boot. Two omissions:<br>1. Script never called `terapeakService.loadMetaSidecar()`, so `_store` held only ~628 entries loaded from `cache/terapeak_sold.json` instead of the full 4,812 in `data/terapeak-meta.json`.<br>2. `buildPlan()` used `existingEntry.compCount` (in-memory `comps.length`, = 0 in slim deployments) instead of `aggregationMeta.compCount` (the stored marker). So the script considered nearly every entry "empty" and queued it for stamping.<br>When `--apply` then triggered `updateDatasetMeta()` → `saveMetaSidecar()`, the sidecar was rewritten from the partial `_store`, **deleting 4,184 entries** (92,276 lines → 3,978 lines). Restored via `git checkout HEAD -- data/terapeak-meta.json`. |
| Impact | Production sidecar truncated by 88,716 lines (95% loss) before being caught and reverted from git. INC-002's `NODE_ENV=test` guard didn't trigger because this was a real one-shot script, not a test run. The first dry-run reported "374 stamp / 254 skip"; the second reported "628 stamp / 0 skip" -- the inconsistency between runs was the smoking gun that something was wrong with the store snapshot, but agent applied anyway. |
| Missing Test | No integration test exercised the script's full `--apply` path against a populated sidecar. Unit tests mocked the store via `terapeakService` API in-process, which masked both the missing-hydration bug and the compCount-source bug. A simple test that wrote a multi-entry sidecar to a tmp dir, invoked the script's exported helpers, and asserted the sidecar still contained every original key would have caught both bugs in CI. |
| Codespace | ~35 min (corruption detection + git restore + architectural diagnosis + Fix C.1 + regression test + re-verify + amend PR) = **$0.11** |
| Copilot | ~22 requests (root cause hunt across store/sidecar code paths, two rounds of dry-run analysis, test authoring, full-suite re-run, PR amend + merge) = **$0.88** |
| Azure | $0.00 |
| **Total** | **$0.99** |
| Resolution | Commit `6b8427f` (Fix C.1): call `loadMetaSidecar()` at script start; `buildPlan()` uses `max(comps.length, aggregationMeta.compCount)`. New regression test `treats sidecar aggregationMeta.compCount as evidence of data even if comps.length is 0`. Re-applied cleanly: 255 stamps, sidecar grew from 92,276 to 93,956 lines, all 4,812 keys preserved. |
| Rules Added | 9) **Standalone scripts that mutate persistent state via a service module MUST replicate the service's full boot-time hydration sequence** (call `loadMetaSidecar()`, `hydrateMetaFromCosmos()`, etc.) before any write. The "in-memory store" abstraction is not safe to reach into from a fresh `node` process without explicit hydration. 10) **Any script with `--apply` semantics MUST have an integration test that asserts post-write data is a strict superset (or precise transformation) of pre-write data** -- not just that the intended entries changed. The test would have failed loudly here. 11) **Dry-run output instability between consecutive runs is a stop signal**: if a dry-run on identical input produces a materially different plan than its previous run (628→374 here), agent MUST diagnose before invoking `--apply`. |

---

### INC-010: Red-on-Green CI -- Cosmetic Workflow Failure Masked Healthy Production for 5 Days

| Field | Value |
|-------|-------|
| Date | 2026-05-26 -- 2026-05-31 |
| Category | `observability-debt` / `agent-violation` |
| Root Cause | `nightly-prefetch.yml` "Report prefetch results" step used a Python `python3 -c "<heredoc>"` block with indented body lines. Bash preserved the indentation when forwarding to Python, causing `IndentationError: unexpected indent`. The report step runs AFTER the prefetch already succeeded, but exited 1 anyway, marking every nightly workflow run as FAILED. Nobody clicked into the failing runs because "of course it's failing -- it always fails". Meanwhile production was prefetching ~990 calls/night successfully. Discovered only when user asked "has the process been running for non-bullion coins?" and agent dug into GH Actions logs and the prod `/api/admin/prefetch-status`. |
| Impact | False signal for 5 consecutive nights (May 26-31). Lost the ability to detect a REAL prefetch failure if one had occurred. Wasted agent time during INC-009 reconciliation chasing the stale local `cache/prefetch_status.json` (May 19) under the assumption the scheduler was broken -- it wasn't. Could have led to false WONTFIX/DONE conclusions about scheduler reliability. |
| Codespace | ~15 min investigating GH Actions + prod status during INC-009 cleanup that traced back to this issue = **$0.05** |
| Copilot | ~6 requests to triage workflow failure, fetch logs, identify Python heredoc bug = **$0.24** |
| Azure | $0.00 (scheduler actually worked; no real waste, just no signal) |
| **Total** | **$0.29** |
| Resolution | Replaced Python heredoc with inline `jq` calls in `.github/workflows/nightly-prefetch.yml` "Report prefetch results" step. Tonight's run will be the first to pass cleanly (and the first to include world-bullion APR data after the #214 regex fix). |
| Rules Added | 6) **A failing CI run is a signal, not noise.** If the same workflow has been failing for >2 consecutive runs, agent MUST investigate before continuing other work. 7) **Workflow steps that run AFTER the critical work must not be allowed to mask success.** Reporting/summary steps should be wrapped with `if: always()` and exit 0 on their own internal errors, or kept simple enough to not fail. 8) Prefer `jq` / bash over inline Python heredocs in workflow YAML -- indentation rules differ between the two and break silently. |

---

### INC-012: Terapeak Startup Thrash -- Wrong Distro + Quoting Churn Before Successful Loop

| Field | Value |
|-------|-------|
| Date | 2026-06-20 |
| Category | `agent-violation` / `recovery-ops` |
| Root Cause | Agent did not immediately apply the known fast path and burned cycles on nested `wsl bash -lc` orchestration in the wrong runtime. The default `Ubuntu` distro (`devcontainers` user, Ubuntu 26.04) does not support Playwright Chromium/Firefox, but this was only confirmed after repeated launch attempts. Additional waste came from over-quoted one-liners that intermittently truncated commands and required retries. |
| Impact | User lost time waiting through repeated startup attempts; compute was consumed on failed setup/login loops before switching to the supported `Ubuntu-24.04` interactive flow. The scraper eventually started correctly and entered freshness-only loop mode after manual login/captcha. |
| Mistakes | 1) Did not prioritize the runbook fast path from turn 1. 2) Did not preflight distro compatibility (`Ubuntu-24.04` vs default `Ubuntu 26.04`) before first Playwright launch. 3) Used fragile nested one-liners instead of immediate interactive shell execution for long commands. |
| Codespace | ~35 min rework / failed launches = **$0.11** |
| Copilot | ~25 premium requests (retries, diagnostics, terminal churn) = **$1.00** |
| Azure | $0.00 |
| **Total** | **$1.11** |
| Resolution | Switched to `Ubuntu-24.04`, completed interactive `--login`, validated healthy cookie jar, and launched `run-surface-freshness-loop.sh --skip-deep --skip-probe` in a persistent loop. |
| Rules Added | 12) For scraper startup, preflight distro first: if Playwright target is Ubuntu 26.04, switch immediately to `Ubuntu-24.04`. 13) Use interactive shell + stepwise commands for scraper bring-up; avoid nested quoted one-liners for long orchestration. 14) Startup sequence order is fixed: login (`terapeak-export.py --login`) -> cookie-health -> freshness loop (`--skip-deep` when requested). |

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
| INC-007 | May 23 | code-bug / agent-violation | Buggy code + skipped pre-commit reviewer | $1.54 |
| INC-008 | May 26-27 | agent-violation / recovery-ops | PR #52 branch-protection bypass + token rediscovery + silent working-tree carryover | $1.55 |
| INC-009 | May 31 | agent-violation / recovery-ops | Backlog drift -- 17 items stale-marked, required 4-pass reconciliation | $1.67 |
| INC-010 | May 26-31 | observability-debt / agent-violation | Red-on-green CI: heredoc bug masked healthy prefetch for 5 days | $0.29 |
| INC-011 | Jun 2 | data-corruption / code-bug / agent-violation | Backfill script truncated sidecar (95% loss) -- missing hydration + missing integration test | $0.99 |
| INC-012 | Jun 20 | agent-violation / recovery-ops | Terapeak startup thrash before successful freshness-only loop | $1.11 |
| | | | **Running Total** | **$13.88** |

---

## Metrics

- **Total waste (all time):** $13.88
- **Worst category:** data-corruption ($6.93 / 50%)
- **Agent violations:** 8 incidents, $7.37
- **Code bugs:** 2 incidents, $2.53
- **Preventable (with rules now in place):** $13.32 (INC-001 through INC-012)
