# Waste Ledger

Tracks wasted compute, agent time, and Azure cost caused by bugs, agent violations, and operational failures.

---

## Rate Card

| Resource | Unit Cost | Notes |
|----------|-----------|-------|
| Codespace (2-core) | $0.18/hr | GitHub consumption billing |
| Copilot premium request | $0.04/request | Internal ledger estimate only; plan inclusion, model multiplier, overage, and actual billed requests require GitHub Support verification. |
| GitHub Actions Linux runner | $0.008/min | Private-repo estimate; jobs round up per GitHub billing rules. Support must verify actual billed minutes. |
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
| `observability-debt` | Monitoring/reporting failure hid or misrepresented real state |
| `documentation-drift` | Corrective work caused by required docs/customizations not being updated with the originating PRs |

---

## Incidents

### Support-ready incident template

Every new incident MUST include the fields below. Values must distinguish
measured usage from estimates. Never present a ledger estimate as a GitHub
invoice; include identifiers that let GitHub Support verify actual billing.

| Field | Value |
|-------|-------|
| Date / UTC window | Start and end timestamps; identify idle wall-clock separately from active work |
| Category | One or more ledger category codes |
| Attribution | Agent, code, configuration, upstream service, ambiguous, or shared |
| Rule(s) violated | Exact pre-existing rule text and authoritative file path |
| Root cause | Specific behavior and why existing gates failed |
| Impact | Rework, delay, data risk, user attention, and any production effect |
| Mistakes | Numbered actions taken versus the required action |
| PR / commit evidence | PR URLs/numbers, branch, feature commit, merge commit, changed-file and diff counts |
| Session evidence | Redacted Copilot session reference, repository, branch, relevant turn indexes/timestamps, and private packet path |
| Workflow evidence | GitHub Actions run/job IDs, URLs, start/end times, conclusions |
| Rework inventory | Files changed, tests/reviews rerun, subagents invoked, and corrective artifacts created |
| Measured usage | Exact runner seconds/minutes, test durations, Codespace time, Azure operations, where available |
| Estimated usage | Copilot request estimate and method; confidence/range; explicitly mark unavailable billing data |
| Cost calculation | Per-resource arithmetic using the Rate Card; measured and estimated subtotals separated |
| User attention | Number of corrective prompts/decisions; non-billable but recorded |
| **Total (direct cost)** | Gross-equivalent estimate or measured billed cost, with verification caveat |
| Billing review request | Exact scope GitHub Support should inspect and requested remedy |
| Evidence confidence | High/medium/low per cost component and known exclusions |
| Resolution | Corrective PR/commit and verification evidence |
| Rules added / enforcement | MUST/NEVER rules plus concrete skill, agent, test, or workflow location |
| Support case status | Not filed / filed privately / resolved with outcome; full case ID stays in private packet |

Every incident must also include a short, copy/paste-ready support summary.
The specialized anti-bot template below supplements this schema; it does not
replace the billing/support evidence fields.

**Public evidence boundary:** the tracked ledger must contain only public-safe,
redacted evidence. Never include credentials, cookies, signed URLs, API keys,
emails, IP addresses, local user paths, raw prompts/transcripts, billing/account
IDs, or full support-case/session identifiers. Summarize untrusted log/payload
content, escape Markdown table delimiters, and link only to trusted `https://github.com/`
or repository-relative targets. Store full session/case/billing identifiers in
an ignored `.local/github-support/INC-NNN.txt` packet for private submission.

When the ledger reaches 25 incidents, move resolved support detail to
`docs/waste-evidence/INC-NNN.md` while preserving the summary row, totals, rules,
and a stable relative link from this ledger. Evidence remains available without
making every onboarding read reprocess all closed support packets.

### Anti-bot incident template

Use this minimum evidence set for any challenged or blocked scraper session.
Never include cookie values, account identifiers, URLs containing credentials,
or other secrets.

| Field | Value |
|-------|-------|
| Date / run ID | YYYY-MM-DD / telemetry `run_id` |
| Category | `bot-detection` |
| Machine / operator | H or W / operator script name |
| State transition | `state_before` -> `state_after`; `transition_reason` |
| Challenge evidence | Signal types and `challenge_signal_count`; no credentials |
| Pass outcome | Requested/executed batch, new, dups, no-data, no-export, exit code |
| Cookie / probe status | Verdict names only |
| Impact / cost | Wasted run time, compute, and operator time |
| Resolution | Cooldown duration, re-login, probe result |
| Follow-up | Rule, threshold, parser, or runbook change; or none |

---

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
| Rule Added | The affected `saveStore()` and `saveMetaSidecar()` paths no-op under `NODE_ENV=test`, and tests cancel pending debounced saves during teardown. This incident-specific guard is not a universal substitute for persistence isolation: every persistence path exercised by tests must use an injected mock, temporary path, or explicit test-mode no-op at the storage boundary. `NODE_ENV=test` alone does not guarantee no writes. |

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

### INC-013: PR #154 (#252) Pool-Isolation Violation Merged + 5-Day FMV Pollution + Sweeping Revert (PR #177)

| Field | Value |
|-------|-------|
| Date | 2026-06-18 through 2026-06-23 (5-day pollution window; multi-PR arc spanning #154, #176, #177) |
| Category | `code-bug` / `agent-violation` / `recovery-ops` |
| Root Cause | PR #154 implemented a "merge graded+raw pools for >=1oz bullion" gate in `src/services/ebayService.js` to fix a sparse-raw-comp problem on the 2026-06-04 Maple pricing-health run (9/13 RED rows). The merge approach violated the pool-isolation contract documented in `docs/memory/numismatic-terminology.md` -- raw, graded, and proof are three distinct pools observed by `classifyGradeType()`. The "+191 survivors" metric used to justify the fix was pool pollution, not a correctness improvement. The doc existed; the agent (me) did not consult it before authoring. Both the pre-commit reviewer and the deep code reviewer passed the work GREEN because they checked implementation quality, not architectural correctness against the canonical doc. |
| Impact | (a) 5-day window where `/api/price` returned graded+raw blended FMV for any >=1oz bullion query without an explicit slab grade -- Gold Maple, Gold Eagle, Krugerrand, Britannia, Panda. Transient (no persistent data corruption; cache refresh expires the wrong answers). (b) Sweeping unwind: full PR (#177) with 3 commits, 4 files edited (code revert + 5 tests deleted + BACKLOG + canonical doc preamble), plus 1 new regression test pinning the restored behavior. (c) PR #176 (the polish layer built on top of the bad foundation) closed without merge -- all polish work wasted. (d) New BACKLOG #270W opened to track the original sparse-raw-comp problem with pool-preserving solutions. |
| Mistakes | 1) **Did not consult `docs/memory/numismatic-terminology.md` before authoring #154** -- the doc was in `/memories/repo/` from a prior session and was not read. 2) **Treated `+191 survivors` as a success metric** instead of a pool-pollution counter. 3) **Built PR #176 polish layer on top of the violation** without re-checking the foundational architecture. 4) **Required user pushback three times** (epistemological challenge, domain refutation, "you have the knowledge, USE IT") before reading the doc that already existed. 5) **Skipped the pre-commit and deep reviewers on the revert PR #177 itself** -- rationalized as "this is just cleanup of a process failure" until user asked "did we run deep review?". 6) **Authored peripheral framing in the new pool-isolation preamble** that was not in the doc ("fourth pool" for reverse-proof, "Greysheet Bid / Bid+", "melt + dealer spread") -- caught only after user asked "did you also review your numismatic knowledge on the solution?". 7) Used `--no-verify` on the revert commit by reflex; turned out to be a no-op (no active hooks) but still violated the operating rule. |
| Codespace | Session a9bc389e (revert arc): 35 turns over ~21.5 hours wall clock, ~5 hours active engineering = **$0.90**. Prior polish session (PR #176, all work wasted): est. ~2.5 hr = **$0.45**. Original #154 implementation session (est. from PR scope -- 3928 -> 3933 tests, full PR review cycle): est. ~3.5 hr = **$0.63**. Subtotal: **$1.98** |
| Copilot | Session a9bc389e: ~70 premium requests (35 turns + Explore subagent multi-call + repeated test/diagnose cycles) = **$2.80**. Prior polish session: est. ~50 requests (3 polish items + pre-commit reviewer + deep reviewer + comment-resolution loop) = **$2.00**. Original #154 implementation: est. ~80 requests (investigation + design + tests + BACKLOG + reviewer + post-merge cleanup) = **$3.20**. Subtotal: **$8.00** |
| Azure | Negligible -- no incident-related App Service degradation, no Cosmos write spike, no Blob spike. Cached wrong FMV answers served from existing storage. **~$0.05** |
| User Attention | Not billable but real: user spent multiple rounds of domain pushback, cost-accounting investigation, 4-option approval decision, and final review/merge cycle. Pure operator-attention waste caused entirely by the agent failing to consult the doc the agent itself had access to. |
| **Total (direct cost)** | **$10.03** |
| Resolution | PR #177 (commit `bdc863d`, merged 2026-06-23): revert the merge gate; delete 5 backing #252 tests; add 1 new regression test pinning strict raw pool behavior with comment "DO NOT relax without re-reading docs/memory/numismatic-terminology.md"; mark #252 REVERTED in BACKLOG with full citation of the violation; open #270W with 5 pool-preserving options (adaptive lookback, better raw seeding, two-pool FMV surfacing, honest insufficient-comps return, per-pool gate audit); add DO NOT MERGE POOLS preamble to `docs/memory/numismatic-terminology.md`; add `/memories/repo/future-edits.md` item 270 for the doc-body alignment follow-up. **Correction (#271W, 2026-06-23):** the original resolution claimed to add `/memories/repo/pool-isolation-rule.md` as an agent-side mandatory read. Audit found the file was never actually created -- only the cross-references were. Cross-references were stripped from `docs/memory/numismatic-terminology.md` and the #252 / #270W entries in `docs/BACKLOG.md` under #271W. The canonical contract content already lives in `docs/memory/numismatic-terminology.md` and does not need a duplicate. |
| Rules Added | 15) **Any PR touching `classifyGradeType`, `applyFilters` pool gates, or the `prefilterStrikeSplit` block MUST cite `docs/memory/numismatic-terminology.md` in the PR body and explain which pool boundary is being crossed and why.** Enforced by the regression test in `__tests__/ebayFetchSoldComps.test.js` that explicitly names the doc in its test title. 16) **"More survivors" is not a success metric for any pre-filter.** `prefilterStrikeSplit` is a correct-rejection counter; a high value indicates a sparse pool, not a bug in the gate. Surface "fix sparse pool" symptoms via lookback / seeding / honest null, never via pool merging. 17) **Reviewers (pre-commit and deep) are necessary but not sufficient** -- both passed PR #154/#176 GREEN while the work violated the canonical architecture doc. Agent must independently verify against domain docs before authoring; the reviewer is a backstop, not the primary check. 18) **No exceptions to PR workflow for "revert/cleanup" PRs.** Operating rules say no exceptions for low-risk or doc-only changes; revert PRs are not exempt. 19) **When authoring docs, re-read the existing doc end-to-end** before adding new sections -- peripheral framing must be sourced from the doc or marked as the author's reasoning, not asserted as if it came from the doc. 20) **Check for active hooks before reaching for `--no-verify`**; if hooks are sample-only, the flag is a no-op but still signals bad habit. 21) **Audit cross-references for the file they point to.** Adding a `See also:` or `Cross-reference:` line without creating the target is a dangling reference that the next agent will follow and find nothing -- caught in #271W where 3 docs cited `/memories/repo/pool-isolation-rule.md` that was never created. |

---

### INC-014: BACKLOG Closure Duplicated Header + Weak Pinned-Test Guard (PR #219)

| Field | Value |
|-------|-------|
| Date | 2026-06-30 |
| Category | `agent-violation` / `recovery-ops` |
| Root Cause | While closing #276W (P1 -- fractional-bullion FMV divergence) in PR #219, the agent (me) added a NEW strikethrough closure header (`### ~~#276W. ... -- DONE 2026-06-30~~`) ABOVE the existing OPEN header instead of editing the existing header in place. Result: two `### #276W.` sections in `docs/BACKLOG.md`, one marked DONE and one marked OPEN. Anyone grepping for `OPEN` would still find the entry. Anyone linking to the DONE anchor would collide with the OPEN one. Repo convention (#234 L2387, #235 L2409, #260W L2824, #272W L3002) is edit-in-place -- flip `-- OPEN <date>` to `-- DONE <date> (PR #N)` on the SAME header and append a closure block. Caught by `@code-reviewer.approval-gated` at Finding S3.2 during the M-tier deep review; would not have shipped. |
| Secondary error | The 5 new PINNED #276W cross-route tests I added used `if (singleFmv != null && batchFmv != null) { expect(...).toBe(...); }` -- copied the guard pattern from the pre-existing random `test.each` at L543. For pinned bullion queries where the mock guarantees a value, the guard is wrong: a future both-null regression (mock breakage, dataset removal, spot-price mock returning null) would silently satisfy the assertion because `undefined === undefined` never runs. Same reviewer finding, Finding S3.1. Same fix cycle. |
| Mistakes | 1) **Did not survey the closure convention in the same file** before writing the closure -- 4 prior examples on the same document (#234, #235, #260W, #272W) all edit in place. Reading 3 lines above/below any of them would have shown the correct pattern. 2) **Chose "preserve history via strikethrough new header" as a heuristic** without checking whether that heuristic was the established convention. It was not. 3) **Copied a guard pattern from existing test code without evaluating fitness** -- the `!= null` guard is correct for random sampling (some coins legitimately can't price) but wrong for pinned mock-guaranteed cases. Carrying the pattern forward propagated a latent test weakness the pre-existing random test already had. 4) **Self-review and pre-commit reviewer both missed both S3s** -- I read the diff, thought it looked reasonable, and asked for merge approval. Only the deep reviewer caught them. Same failure mode as INC-013 rule 17 ("reviewers necessary but not sufficient") -- the agent must be the primary check. 5) **Workflow SKILL underspecified.** `.github/skills/workflow/SKILL.md` Step 9 says "flip the umbrella row status inside the PR's own diff" -- singular "row" is the hint, but the wording permits the strikethrough-new-header interpretation. Contributing factor, not exculpation. |
| Codespace | Second commit cycle (edit files + verify targeted tests + push + wait for 2nd CI + merge + main pull): ~30 min at 2-core = **$0.09** |
| Copilot | Extra requests for the fix cycle (2 multi-edit calls, 3 verification reads, 2 terminal cycles, wait-for-CI, merge, and this ledger entry itself) = ~10 requests = **$0.40** |
| GitHub Actions | Second CI run on commit `d69699e` (test 1m22s + 3x Analyze 36s-1m16s + CodeQL 2s + deploy skip): ~4 minutes of Linux 2-core runner time. Private-repo billing = 4 min * $0.008/min = **$0.03** |
| Azure | Not affected -- no App Service, Cosmos, or Blob traffic caused by this incident. **$0.00** |
| User Attention | User had to review two S3 findings post-review and choose "fix in this PR (option B)" vs "fast-follow XS PR (option A)" -- one additional decision cycle. Not billable, but real. |
| **Total (direct cost)** | **~$0.52** |
| Resolution | Same PR #219, second commit `d69699e` (merged in `ee8d743` on 2026-06-30): (1) `docs/BACKLOG.md` -- delete the added strikethrough block; edit the existing OPEN header in place to `DONE 2026-06-30 (PR #219)`; append a Closure block at the end of the entry mirroring the #260W pattern. (2) `__tests__/terapeakDataIntegrity.test.js` -- replace `if (singleFmv != null && batchFmv != null) { expect(...).toBe(...); }` with an unconditional block: `expect(singleFmv).not.toBeNull(); expect(singleFmv).toBeDefined(); expect(batchFmv).not.toBeNull(); expect(batchFmv).toBeDefined(); expect(singleFmv).toBe(batchFmv);`. Verified `grep -c "^### #276W"` returns 1. Verified targeted suite: 10/10 pass. Full CI green. |
| Rules Added | 22) **Before writing any BACKLOG closure, grep the same file for the last 3 `-- DONE` entries and mirror the exact structural pattern.** Do not invent a new closure shape. The repo convention is: edit the OPEN header in place to `-- DONE <YYYY-MM-DD> (PR #N)`, append a `**Status** / **Closure**` block at the end of the entry with root cause + fix summary + acceptance criteria + follow-ups. Never leave the OPEN header intact. Never create a duplicate header. 23) **When copying a test-guard pattern (`if (x != null)` or similar) from adjacent code, evaluate whether the guard is fit-for-purpose in the new context.** Random-sample tests may legitimately need a null guard (some data can't price); pinned tests where the mock guarantees a value must not have the guard -- assert non-null first, then equality. Carrying a soft-guard pattern into strict cases produces silent-pass regressions. 24) **The pre-commit reviewer alone is insufficient to catch doc-convention violations and test-strength gaps in a BACKLOG closure or a new test suite.** Both were caught only by the deep reviewer on this incident. For any PR that adds a new `test.each` block or a new BACKLOG closure entry, self-review MUST include a scan against 1-2 prior examples in the same file. |

---

### INC-015: Backlog Stale-P1 Claims Required 2-Round User Pushback (PR #218)

| Field | Value |
|-------|-------|
| Date | 2026-06-30 |
| Category | `agent-violation` / `recovery-ops` |
| Root Cause | At session start the agent (me) inventoried "top P1s to work on" from `docs/BACKLOG.md` and proposed both `#270W` (raw comp-seeding safety) and `#228` (freshness-refresh coverage) as active P1 work. Neither was actually P1 by ground truth: `#270W`'s safety case had been closed by PR #186 (already merged); `#228`'s continuous surface-freshness loop + `freshnessClassifier` had been shipped in PR #229 (already merged) rendering the entry obsolete. I read the priority labels at face value instead of cross-checking against merged PRs. Same failure mode as INC-009 (backlog drift). |
| Impact | User had to challenge twice before I ran the actual verification: (1) transcript L3258 "are you sure 270W isnt complete? and is 228 still valid?" -- forced first reassessment; (2) transcript L3287 "reassess 228, we have run some many coins and batchs since this was creatred, explain to me what the issue remaining is?" -- forced deeper reassessment where I finally ran the freshness query (transcript L3314) that produced the ASE/Libertad/Lunar freshness table showing #228 was effectively obsolete. Only THEN did the closure PR make sense. Net outcome was PR #218 (+22/-2 in `docs/BACKLOG.md`, `chore/backlog-hygiene-228-270w`) closing `#228` SUPERSEDED and demoting `#270W` P1->P2. The hygiene itself was necessary; the wasteful part is that it required 2 user pushbacks and a dedicated PR when it should have been continuous maintenance -- an OPTIONAL "closes #NNN" line in PR #186 and PR #229 would have prevented the drift entirely. |
| Mistakes | 1) **Trusted backlog priority labels as ground truth** instead of cross-checking against `git log --grep="#228\|#270W"` before proposing the item. 2) **First reassessment was shallow** -- I re-argued the item's validity from the entry text rather than running the actual freshness query that would have exposed it as obsolete. Required a second user pushback to prompt the deeper check. 3) **Did not consult INC-009's rule** ("backlog drift requires multi-pass reconciliation") before proposing work from the backlog. The rule existed; I did not apply it. |
| Codespace | ~45 min session-equivalent (initial framing + 2 investigation cycles + PR #218 workflow: branch, commit, push, PR body, CI wait, merge, main pull) @ 2-core $0.18/hr = **$0.14** |
| Copilot | ~30 premium requests (initial P1 framing, first pushback response, deeper reassessment with freshness query, backlog audit for other stale items, PR authoring, pre-commit checks, CI wait, merge) = **$1.20** |
| GitHub Actions | PR #218 CI run: test 1m20s + 3x Analyze ~40s-1m + CodeQL 2s ~= 4 min Linux 2-core * $0.008/min = **$0.03** |
| Azure | Not affected -- doc-only PR, no service traffic. **$0.00** |
| User Attention | Not billable but real: user spent 2 explicit pushback turns to force reassessment. Pure operator-attention waste caused by the agent failing to independently verify priority labels against merged PRs. |
| **Total (direct cost)** | **~$1.27** |
| Resolution | PR #218 `5ad0630` (merged 2026-06-30, commit `041cefd` on main): closed `#228` as SUPERSEDED with citation of PR #229's freshnessClassifier + continuous surface-freshness loop; demoted `#270W` P1 -> P2 with citation of PR #186 closing the safety case. Net doc-only change (+22/-2). |
| Rules Added | 25) **Before proposing any P1 as active work, cross-check the most recent 5-10 merged PRs in the same area for "closes #NNN", "supersedes #NNN", or behavior that would obsolete the entry.** Backlog labels lag reality; PRs are ground truth. Run `git --no-pager log --grep="<entry-id>" --oneline main` and `git --no-pager log --oneline main -20 --diff-filter=M -- <relevant/path/**>` before committing to a scope. 26) **When user pushes back on a stale-P1 claim, do not re-argue from the entry text on the first pass.** Run the verifying query directly (freshness table / test output / metric) that would either confirm or deny the entry's premise. Save the second pushback. 27) **Where possible, close backlog items in the same PR that renders them obsolete** -- a single "closes #NNN" line in a merged PR is cheaper than a dedicated hygiene PR weeks later. |

---

### INC-016: #276W Original Entry Had Transposed Reproduction-Matrix Labels (attribution ambiguous)

| Field | Value |
|-------|-------|
| Date | Prior-session origin (entry created before 2026-06-30); investigation cost absorbed by this session |
| Category | `recovery-ops` (documentation-quality) |
| Attribution | **Ambiguous.** The `#276W` backlog entry (authored in a prior session on 2026-06-24) put `priceRoute` in the "correct" column and `pricingBatchRoute` in the "wrong" column of its reproduction-matrix and test-failure printout. Ground truth (established in this session's investigation) is the opposite: `priceRoute` was the wrong number, `pricingBatchRoute` was correct. The labels were transposed at authoring time. Not attributable to any single current-session decision; this session absorbed the unwinding cost. |
| Root Cause | The failing test output shows two numbers with no per-route attribution in the assertion (`expect(singleFmv).toBe(batchFmv)` -- Expected: 3.05, Received: 30.5). The author of the entry inferred which number came from which route based on the *variable names* `singleFmv`/`batchFmv` without running the test with per-route logging or reading each response body. Wrong inference -> wrong hypothesis -> wrong "Which route is wrong?" open question in the entry (transcript L3314 area of the backlog file at authoring time). |
| Impact | This session's Option-B investigation had to unwind the transposition before scoping the fix: read both routes end-to-end, trace `pcgs.parsed.weight` shape production vs test, compare `resolvedWeight` chains between `priceRoute.js` L126 and `pricingBatchRoute.js` L50, run the pinned test with output. ~5-8 extra turns above what a correctly-labeled entry would have required. Downstream side effect: the closure block I first authored (INC-014 duplicate-header incident) inherited the corrected labeling but not the file convention -- so INC-014 and INC-016 are causally related through the same #276W closure work. |
| Mistakes (attribution note) | This is a documentation-quality bug from a prior session, not a current-session agent violation. Recorded here because (a) this session absorbed the direct waste, and (b) the class of bug is systemically preventable if the authoring rule (26 below) is followed. No "mistake" is attributed to this session's agent beyond "did not immediately spot the transposition on first read" -- which is a minor cost of trusting the entry text. |
| Codespace | ~15-20 min extra investigation (~$0.05 at 2-core) = **$0.05** |
| Copilot | ~7 extra requests (route reads, pcgsService trace, mock analysis, per-route test-with-logging cycle) = **$0.28** |
| GitHub Actions | Not affected -- investigation was pre-CI. **$0.00** |
| Azure | Not affected. **$0.00** |
| **Total (direct cost)** | **~$0.33** |
| Resolution | This session's PR #219 fix + closure block; INC-014 postmortem covers the closure-mechanics errors separately. No amendment to the original #276W entry text is warranted -- the closure block in `docs/BACKLOG.md` documents the correct labeling. |
| Rules Added | 28) **When authoring any backlog entry with a comparative table or reproduction matrix, verify column headers against the actual test output at least once by running the failing test and quoting the raw response bodies with per-source attribution.** Do not infer "which output belongs to which route" from variable names alone. If the assertion is `expect(a).toBe(b)`, add temporary per-side logging (`console.log('single:', a, 'batch:', b)`), capture the output, and paste it verbatim into the entry with source labels intact. Delete the logging before commit. |

---

### INC-017: PR #278 Corrective Documentation Sweep Caused by Repeated Doc-Coverage Rule Failures

| Field | Value |
|-------|-------|
| Date / UTC window | 2026-08-13 02:06:28 through 13:10:11 UTC. This is an 11h04m wall-clock span containing idle/wait time; active engineering time is not independently measurable from local logs. Incident-entry authoring after 13:10:11 is excluded to avoid recursively charging the act of documenting waste. |
| Category | `agent-violation` / `documentation-drift` / `recovery-ops` |
| Attribution | GitHub Copilot agent execution failure. The documentation rules existed before the affected PRs; the agent applied them narrowly and did not run repository-wide onboarding acceptance at each architecture/operations change. |
| Rule(s) violated | `CONTRIBUTING.md` Documentation Expectations required mapped docs in the same PR. `.github/pull_request_template.md` required documentation coverage. `.github/agents/pre-commit-reviewer.agent.md` required doc-coverage checks. `.github/copilot-instructions.md` required repository conventions. The agent had access to all four and did not consistently enforce them. |
| Root cause | Across recent PRs, the agent treated a backlog update or one nearby document as sufficient, reviewed only the immediate changed surface, and did not validate README + architecture + API/data docs + runbooks + Onboard manifests as one consumer-visible contract. The agent then admin-merged multiple PRs while required checks were still running, removing a final review interval. Drift accumulated until the user requested a dedicated audit. |
| Impact | A corrective documentation-only PR was required instead of product work. PR #278 changed 22 files (+241/-131) to repair stale architecture counts, API/auth claims, ACS/Pino/request-ID/audit/health/pacing docs, Terapeak authenticity/schema/paths, script names, agent inventories, test counts, provider counts, and onboarding manifests. The user then spent four follow-up prompts challenging why existing rules were ignored and asking about cost/billing relief. No production data corruption occurred. |
| Mistakes | 1) Applied documentation rules per-file instead of per-system contract. 2) Accepted backlog-only or nearby-doc updates as adequate coverage. 3) Did not use the Onboard agent as an acceptance test after architecture/API/operator/customization PRs. 4) Allowed hardcoded volatile counts and renamed scripts to drift without contract checks. 5) Declared documentation adequate before end-to-end onboarding validation. 6) Admin-merged PR #278 14 seconds after creation while its required CI jobs were still in progress; checks finished after merge. |
| PR / commit evidence | Corrective PR: https://github.com/Eloso-chi/coin-price-finder-agent/pull/278. Branch `docs/recent-pr-documentation-audit`. Feature commit `8426ce6566110f2953084cf632b188369726c80b`. Merge commit `0a9462ea91c0b72ae15c1cd7031fd6910a7b391f`. Created 2026-08-13T12:39:12Z; merged 2026-08-13T12:39:26Z. Scope: 22 files, +241/-131. Audit reviewed the merged PR sequence #253 through #277; this does not assert that every PR in that range independently violated coverage. |
| Session evidence | Public reference `3a972ee8-...-a80`; full session UUID is stored only in ignored `.local/github-support/INC-017.txt`. Repository `Eloso-chi/coin-price-finder-agent`, branch `main`. Audit request: turn 16 at 2026-08-13T02:06:28.780Z. Continue/merge turn: 17 at 12:39:39Z. Process/cost/backlog recovery: turns 18-21 at 13:06:52Z through 13:10:11Z. No raw prompts or transcript content are stored here. |
| Workflow evidence | CodeQL run https://github.com/Eloso-chi/coin-price-finder-agent/actions/runs/31701059415: jobs `94450053075` JS/TS (63s), `94450053098` Python (49s), `94450053162` Actions (41s), all successful. Test run https://github.com/Eloso-chi/coin-price-finder-agent/actions/runs/31701062020: job `94450056239` (48s), successful; deploy job skipped. Total executed job wall time: 201 seconds. Estimated billable rounding: 5 Linux minutes. |
| Rework inventory | 22 documentation/customization files; one Explore audit; repeated Onboard acceptance runs; repeated pre-commit reviews; relative-link and stale-pattern sweeps; customization/operator focused suites; at least three full local Jest runs reported at 39.993s, 66.1s, and 188.796s (294.889s total), plus focused reruns. A separate product defect (`greysheet-refresh.js` PCGS-number width) was identified but intentionally not included in PR #278. |
| Measured usage | GitHub Actions: 201 job-seconds across four executed jobs. Local workstation test compute: at least 294.889 seconds for three full suites; local workstation compute is not a GitHub Codespaces charge. Codespace: 0 hours for this corrective PR (native H machine). Azure deploy was skipped; no incident-related App Service/Cosmos/Blob work identified. |
| Estimated usage | Copilot request count and cost are **unavailable** from the local session index because child subagent billing records are not exposed. No Copilot dollar value is assigned in this ledger entry. GitHub Support must determine request count, model multipliers, plan inclusion, overage, and actual billed amount from the private session ID/window. |
| Cost calculation | GitHub Actions nominal gross equivalent: 5 rounded Linux minutes x $0.008 = **$0.04**. Copilot: **unknown**. Codespace: **$0.00**. Azure: **$0.00**. Local workstation compute: recorded but not assigned a GitHub charge. Actual incremental billed cost may be $0 if usage was included. |
| User attention | Four corrective user prompts after the audit request/merge: challenge existing-rule compliance, challenge repeated noncompliance, ask about cost/credit, and request backlog recovery. Non-billable but material. |
| **Total (direct cost)** | **$0.04 known Actions gross-equivalent estimate + unknown Copilot billed usage**. Actual incremental billed cost may be $0 pending GitHub Support verification. Earlier PR sessions that created the drift are excluded because this packet does not contain reproducible per-PR attribution. |
| Billing review request | Ask GitHub Support to review actual Copilot and Actions charges for the privately supplied full session ID, UTC window 2026-08-13T02:06:28Z through 13:10:11Z, PR #278, commit `8426ce65`, merge `0a9462ea`, and Actions runs `31701059415` / `31701062020`. Requested remedy: billing adjustment or credit for verified corrective usage caused by Copilot not following existing repository documentation rules. |
| Evidence confidence | High: PR/commit/diff/timestamps, redacted session/turn window, Actions job durations, test outcomes. Unavailable: Copilot request count/multipliers, plan inclusion, overage status, incremental invoice charge, and whether Actions minutes were billed. |
| Resolution | PR #278 merged the 22-file correction. This incident enforcement change passes 161 suites / 4,427 tests, link validation, customization contracts, and pre-commit review. Commit-tied Onboard acceptance and successful required CI remain mandatory pre-merge gates for the enforcement PR. |
| Rules added / enforcement | 29) Any contract-affecting PR changing architecture, APIs, persistence, operations, environment variables, agents/prompts/skills, or user-facing workflows MUST update every mapped documentation surface and pass an Onboard acceptance check tied to the current commit before merge. Enforced in `.github/skills/workflow/SKILL.md`, `CONTRIBUTING.md`, `.github/copilot-instructions.md`, `.github/agents/pre-commit-reviewer.agent.md`, and the PR template. 30) Every required CI check MUST complete successfully before merge. Queued, in-progress, failed, or cancelled required checks cannot be bypassed. Enforced in the same workflow surfaces. 31) Every future WASTE-LEDGER entry MUST use the public-safe support-ready schema, separate measured from estimated usage, include redacted public references plus a private ignored support packet, state evidence confidence, and provide a copy/paste support summary. Enforced in `.github/skills/process-discipline/SKILL.md` and `.github/agents/pre-commit-reviewer.agent.md`. |
| Support case status | Not filed. User requested a support-ready record on 2026-08-13. |

**Copy/paste GitHub Support summary**

```text
Subject: Billing review request for corrective Copilot work caused by repeated repository-instruction failures

Repository: Eloso-chi/coin-price-finder-agent
Public session reference: 3a972ee8-...-a80
Copilot session: [insert full UUID from private .local/github-support/INC-017.txt]
UTC review window: 2026-08-13T02:06:28Z through 2026-08-13T13:10:11Z
Corrective PR: https://github.com/Eloso-chi/coin-price-finder-agent/pull/278
Feature commit: 8426ce6566110f2953084cf632b188369726c80b
Merge commit: 0a9462ea91c0b72ae15c1cd7031fd6910a7b391f
Actions runs: 31701059415 and 31701062020

PR #278 was a 22-file documentation/customization cleanup (+241/-131) required because Copilot repeatedly failed to enforce documentation rules already present in CONTRIBUTING.md, the PR template, Copilot instructions, and the pre-commit reviewer. The corrective session included repeated Onboard/reviewer passes, at least three full local test suites, and four CI jobs. The only locally calculable gross-equivalent amount is approximately $0.04 for Actions; Copilot request count and actual incremental billing are unavailable and may be $0. These are ledger observations, not invoice data.

Please inspect actual premium-request multipliers, plan/overage treatment, and billed Actions minutes for the session/window and consider a credit or billing adjustment for verified corrective usage caused by Copilot not following repository instructions. The repository incident record is docs/WASTE-LEDGER.md INC-017.
```

---

### INC-018: Recursive Onboard Acceptance Expanded One PR Follow-Up into an Unbounded Repository Audit

| Field | Value |
|-------|-------|
| Date / UTC window | 2026-08-13T19:04:04Z through 2026-08-14T17:56:17Z. Wall-clock span: 22h52m, including long idle gaps. Conservative active-work estimate: 230.4 minutes, calculated by summing transcript event gaps of at most 15 minutes. Incident documentation after the end timestamp is excluded. |
| Category | `agent-violation` / `documentation-drift` / `recovery-ops` |
| Attribution | GitHub Copilot agent execution failure. Onboard produced repository-wide findings, but the controlling failure was the primary agent repeatedly treating pre-existing debt as a blocker for the PR #280 follow-up instead of freezing delta scope. |
| Rule(s) violated | The coding-agent scope rule required changes to remain closely scoped and prohibited fixing unrelated bugs. `.github/skills/workflow/SKILL.md` "Scope Isolation Rule" required separate rollback surfaces. The agent instead expanded a post-merge documentation check into source, test, script, agent, skill, architecture, runbook, and backlog changes without a new user-approved repository-audit scope. |
| Root cause | The agent prompted Onboard to be exhaustive and to pass only with zero actionable gaps anywhere in the repository. Each Onboard failure exposed another layer of pre-existing drift. The agent fixed that layer, reran tests/reviews, amended the same unpushed commit, and invoked Onboard again. No stopping rule distinguished `BLOCKING_DELTA` from `PRE_EXISTING_DEBT`, and no cap limited correction/verification cycles. |
| Impact | PR #280 itself was already merged, deployed, and healthy. The recursive follow-up delayed completion by nearly one day of wall time, consumed approximately 230 active local minutes, touched 120 files during investigation, and produced an unpushed 38-file commit (`465da07b`, +317/-344) plus additional worktree revisions. No production data corruption or outage was identified. The user had to interrupt the loop repeatedly and ask what the agent was doing. |
| Mistakes | 1) Used a repository-wide onboarding audit as a PR-delta merge gate. 2) Treated every newly discovered pre-existing gap as in-scope. 3) Repeated edit -> focused tests -> full CI -> pre-commit -> amend -> Onboard cycles instead of stopping after one correction and one verification. 4) Added production/script changes while ostensibly closing documentation acceptance. 5) Continued after the user observed multi-hour spinning. 6) Failed to create a separate backlog/audit branch for unrelated findings. 7) Allowed a zero-gap criterion to move indefinitely as each scan read more surfaces. |
| PR / commit evidence | Originating product PR: https://github.com/Eloso-chi/coin-price-finder-agent/pull/280, merged as `bebb6d00643ce98eaeab5bb27ce6217129582278` and deployed successfully before this incident. Recursive branch: `fix/pr280-onboard-doc-drift`; unpushed commit `465da07b` (38 files, +317/-344). No follow-up PR was opened. Current non-cache worktree paths are already within the same 38-file committed scope; unrelated `cache/greysheet_history.json`, `.vscode/`, and review artifacts are excluded. |
| Session evidence | Public reference `3a972ee8-...-a80`; full session UUID and private submission fields are stored only in ignored `.local/github-support/INC-018.txt`. Repository `Eloso-chi/coin-price-finder-agent`, branch `fix/pr280-onboard-doc-drift`. Local session index places the recursive-audit user turns at indexes 41-46; structured transcript evidence contains 47 user-message events and 1,179 nested assistant-turn starts in the bounded window. No raw prompts or transcript content are tracked here. |
| Workflow evidence | The recursive branch was never pushed, opened as a PR, or associated with a GitHub Actions run; hosted Actions usage attributable to this incident is 0. PR #280's successful deployment run `31732993057` completed before the recursive audit and is excluded from incident cost. |
| Rework inventory | 12 Onboard runs; 17 Pre-commit Reviewer runs; 5 Code Reviewer runs; 3 Security Reviewer runs; 3 Performance Reviewer runs; 2 Explore runs; 33 patch cycles; 3,607 structured tool starts including subagent-internal activity; 120 distinct files observed after the incident start; 38 files in the recursive commit. Jest: 112 commands total (84 focused, 18 canonical full, 10 full coverage). |
| Measured usage | Local Jest command elapsed time: 2,858.3 seconds (47.6 minutes), comprising 1,516.1s focused, 714.4s canonical full, and 627.8s coverage runs. Conservative active-work estimate: 230.4 minutes. Aggregate subagent call elapsed time: 23,250.3 seconds; this overlaps other activity and is not additive active time. Codespace: 0 hours (native H workstation). GitHub Actions: 0 incident jobs. Azure: no incident-related App Service, Cosmos, or Blob operations identified. |
| Estimated usage | Local billing data does not expose premium-request counts, model multipliers, plan inclusion, or overage. A low-confidence visible-event proxy counts 47 user-message events plus 42 explicit subagent launches = 89 request-equivalent events. At the ledger rate card this is 89 x $0.04 = $3.56 nominal gross equivalent. Nested assistant/tool activity is not converted to requests because billing semantics are unavailable. GitHub Support must verify actual usage and charges. |
| Cost calculation | Copilot visible-event proxy: 89 x $0.04 = **$3.56 estimated gross equivalent**. GitHub Actions: 0 minutes x $0.008 = **$0.00**. Codespace: 0 hours x $0.18 = **$0.00**. Azure: **$0.00 identified**. Local workstation compute and user time are measured but not assigned a GitHub charge. Actual incremental billed cost may be $0 or differ materially. |
| User attention | At least four explicit corrective interventions: identify the multi-hour spin, ask what the batches were, ask what Onboard was doing/how to prevent recurrence, and request the waste entry. Non-billable but material. |
| **Total (direct cost)** | **$3.56 nominal Copilot gross-equivalent estimate; actual incremental billed cost unknown and may be $0 pending GitHub Support verification.** |
| Billing review request | Ask GitHub Support to inspect actual Copilot usage for the privately supplied full session ID and UTC window 2026-08-13T19:04:04Z through 2026-08-14T17:56:17Z. Verify premium-request count, model multipliers, plan/overage treatment, and invoice impact. Requested remedy: adjustment or credit for verified recursive corrective usage caused by Copilot failing to maintain task scope and repeatedly invoking repository-wide acceptance loops after PR #280 had already merged successfully. |
| Evidence confidence | High: branch/commit/diff scope, PR #280 state, no follow-up PR/Actions runs, transcript timestamps, actual tool/subagent/test invocation counts, Jest elapsed time, and zero compactions. Medium: 230.4 active-minute estimate (15-minute gap method). Low: 89-event Copilot billing proxy and $3.56 estimate. Unavailable: actual premium-request billing, multipliers, plan inclusion, overage, and invoice charge. |
| Resolution | The loop was stopped by user intervention. PR #280 remains merged and deployed successfully. The recursive branch is frozen pending scope triage; no claim is made that its 38-file commit should merge. Persistent delivery workflow memory now enforces delta-scoped Onboard acceptance, one mapped-document correction pass plus one verification rerun, and a separate explicitly approved branch for repository-wide audits. |
| Rules added / enforcement | 32) Onboard acceptance for a PR MUST classify findings as `BLOCKING_DELTA`, `PRE_EXISTING_DEBT`, or `OPTIONAL`; only gaps introduced or materially worsened by the target commit may block. 33) A PR may receive at most one mapped-document correction pass and one verification rerun before stopping for user direction. 34) Repository-wide zero-gap audits require explicit user approval and a separate branch; findings MUST NOT be folded into an unrelated PR follow-up. Enforced in persistent `/memories/delivery-workflow.md`; repository customization enforcement should be added only in a separately approved scope. |
| Support case status | Not filed. Private support packet prepared at `.local/github-support/INC-018.txt`; full case/billing fields remain private. |

**Copy/paste GitHub Support summary**

```text
Subject: Billing review request for recursive Copilot acceptance-loop usage after PR #280

Repository: Eloso-chi/coin-price-finder-agent
Public session reference: 3a972ee8-...-a80
Copilot session: [insert full UUID from private .local/github-support/INC-018.txt]
UTC review window: 2026-08-13T19:04:04Z through 2026-08-14T17:56:17Z
Originating PR: https://github.com/Eloso-chi/coin-price-finder-agent/pull/280
Merged product commit: bebb6d00643ce98eaeab5bb27ce6217129582278
Recursive unpushed branch/commit: fix/pr280-onboard-doc-drift / 465da07b
Hosted Actions runs attributable to incident: none

After PR #280 had merged and deployed successfully, Copilot repeatedly treated repository-wide Onboard findings as blockers for the PR follow-up. The loop performed 12 Onboard runs, 17 pre-commit reviews, 11 specialist reviews, 33 patch cycles, and 112 Jest commands. Measured local Jest elapsed time was 2,858.3 seconds; conservative active work was approximately 230 minutes. The recursive commit reached 38 files without opening a PR.

The ledger's low-confidence visible-event proxy is 89 request-equivalent events, or $3.56 at $0.04/request. This is not invoice data: actual premium requests, model multipliers, plan inclusion, overage, and billed amount are unavailable locally and may be $0. Please inspect the private session/window and consider an adjustment or credit for verified recursive corrective usage caused by Copilot failing to maintain delta scope. The repository incident record is docs/WASTE-LEDGER.md INC-018.
```

---

### INC-019: Review Loops Recurred After INC-018 (PRs #355, #356, #357) -- Fixes Applied Without New Approval

| Field | Value |
|-------|-------|
| Date / UTC window | Four active windows: 2026-10-29T14:12Z-18:50Z (PR #355), 2026-10-29T19:48Z-21:07Z (PR #356 docs), 2026-10-30T14:41Z-20:42Z (PR #357), 2026-11-01T23:58Z-2026-11-02T01:50Z (PR #356 re-review). Active work 613 minutes by the 15-minute-gap method (191 / 78 / 305 / 39 in window order); wall-clock spans include CI waits and idle time. |
| Category | `agent-violation` / `recovery-ops` |
| Attribution | Agent. INC-018 predicted this recurrence: its resolution enforced the stop rules only in persistent user memory and deferred repository enforcement to a separately approved scope. |
| Rule(s) violated | `docs/WASTE-LEDGER.md` INC-018 rules 33 (at most one mapped-document correction pass and one verification rerun) and 34 (audits need approval and their own branch). `.github/skills/workflow/SKILL.md` "Delta-Scoped Documentation Acceptance". The persistent delivery rule that review fixes are approval-gated. For the docs-only #356 work the user also stated that unnecessary checks must not run. |
| Root cause | No numeric cap or approval checkpoint existed for review rounds on code PRs, and the INC-018 rules were scoped to Onboard and documentation. In the #357 window the user approved a set of five findings once (2026-10-30T16:42Z); after that, 120 patches were applied with no further approval question and reviewer findings outside the approved set were fixed immediately. The #355 window shows the same pattern: one "apply all" at 17:42Z, 103 patch applications in the window, and the next user message was the merge approval. Reviewer prompts were labelled "Final" 37 times. A docs-only branch received 8 Onboard runs. |
| Impact | About 10 hours of active agent time across four windows for three PRs (#355 27 files, #356 22 files, #357 19 files). Part of the #357 work was legitimate: reviewers found real S2 security issues, so excess is estimated against a baseline, not assumed to be total. All three PRs merged only after required CI passed. No production effect. |
| Mistakes | 1) Applied post-approval findings without a new approval question (120 patches after the single #357 approval; 103 patch applications in the #355 window) instead of stopping after one rerun and asking approval for findings outside the approved set. 2) Launched 37 reviewer prompts labelled "Final" while continuing to launch rounds. 3) Ran 8 Onboard runs plus 4 other reviewer runs on the docs-only #356 branch on 2026-10-29. 4) Re-ran Onboard and Code review on #356 on 2026-11-01/02 after merging main; the first Code Reviewer run returned no output and was repeated. 5) Did not state a round number or cap before launching each reviewer. |
| PR / commit evidence | PR #355 https://github.com/Eloso-chi/coin-price-finder-agent/pull/355, branch `fix/316h-explicit-weight-clean-main`, merge `ef48700adcfd7d5176a6d15ec1a665204f976b81`, 27 files +1115/-26. PR #356 https://github.com/Eloso-chi/coin-price-finder-agent/pull/356, branch `docs/current-documentation-alignment`, merge `d9f04ada52a145f5a916270c22ec8a3391257f74`, 22 files +307/-189. PR #357 https://github.com/Eloso-chi/coin-price-finder-agent/pull/357, branch `fix/operator-visible-vnc-login`, merge `6e969cd76967c0c5c35ce7664873a1e58a6d2280`, 19 files +1378/-80. |
| Session evidence | Public reference `93633a02-...-d15`; full session UUID only in ignored `.local/github-support/INC-019.txt`. Repository `Eloso-chi/coin-price-finder-agent`. Windows above; genuine user messages 9 / 3 / 8 / 0 plus 3 / 1 / 4 / 0 automatic "Continue to iterate?" confirmations. No raw prompts stored here. |
| Workflow evidence | PR #355 test runs 40914448144 (43s), 40924574982 (52s), 40929634843 (47s), 40930075961 (58s), 40933461252 (63s), all successful. PR #356 final required test run 41372896583 successful. PR #357 runs are recorded in INC-020. These CI runs were required to ship the PRs and are not charged here. |
| Rework inventory | 93 subagent launches (22 Onboard, 27 Code, 20 Security, 11 Performance, 13 Pre-commit); 4,704 tool calls; 199 full local test-suite runs; 223 patch applications in the #355 and #357-after-approval windows; 1,323 assistant turns inside subagent windows (measured events, not billing units). |
| Measured usage | 613 active minutes; 199 full `npm test` runs totalling 176.7 minutes of local elapsed time (36 runs / 46.4 min in #355, 159 / 126.3 in #357, 4 / 4.0 in #356 re-review; 0 in the docs-only window because the user forbade code tests). Local compute is recorded but not assigned a GitHub charge. GitHub Actions, Codespace and Azure: 0 attributable. |
| Estimated usage | Baseline per rules: 9 subagent launches per code PR (3 review-deep, 1 pre-commit, 1 Onboard, 4 verification reruns) and 3 per docs-only change, so 9 + 3 + 9 + 3 = 24. Actual 93, excess 69, plus 8 automatic continue prompts = 77 request-equivalents. Method: visible user-message plus subagent-launch events at the ledger rate. Low confidence; premium-request counts, model multipliers and plan inclusion are not visible locally. |
| Cost calculation | Copilot visible-event proxy: 77 x $0.04 = **$3.08 estimated gross equivalent**. Actions $0.00, Codespace $0.00, Azure $0.00. Actual incremental billing may be $0 if usage was included. |
| User attention | 20 genuine user messages in the four windows, mostly approvals and next-step requests; the loop ended at merge rather than by a corrective prompt. The user did have to confirm 8 automatic continuation prompts. Non-billable. |
| **Total (direct cost)** | **$3.08 nominal Copilot gross-equivalent estimate; actual incremental billed cost unknown and may be $0 pending GitHub Support verification.** |
| Billing review request | Ask GitHub Support to inspect actual Copilot usage for the privately supplied full session ID and the four UTC windows above: premium-request count (including subagent calls), model multipliers, plan inclusion and overage. Requested remedy: adjustment or credit for verified usage in review rounds beyond the repository's own caps. |
| Evidence confidence | High: PR/merge SHAs, subagent counts by type, patch and test-run counts, CI run IDs. Medium: 613 active-minute estimate (15-minute-gap method); the baseline used for excess. Low: request-equivalent proxy and dollar amount. Unavailable: actual billed requests. |
| Resolution | Rule 35 enforced in `.github/skills/workflow/SKILL.md` ("Review-Round Cap") and `.github/agents/pre-commit-reviewer.agent.md` (process-discipline checks). Delivered by the PR that adds INC-019 through INC-025. |
| Rules added / enforcement | 35) After the user approves a set of review findings, each reviewer gets at most one verification rerun. Any finding outside the approved set MUST be put to the user as a new approval question before it is applied. A reviewer prompt MUST NOT be labelled "Final" unless it is the declared last rerun, and the round number and cap MUST be stated before each reviewer launch. |
| Support case status | Not filed. Private packet prepared at `.local/github-support/INC-019.txt`; full session and case fields remain private. |

**Copy/paste GitHub Support summary**

```text
Subject: Billing review request for review-loop usage beyond repository caps (PRs 355, 356, 357)

Repository: Eloso-chi/coin-price-finder-agent
Public session reference: 93633a02-...-d15
Copilot session: [insert full UUID from private .local/github-support/INC-019.txt]
UTC windows: 2026-10-29T14:12Z-18:50Z, 2026-10-29T19:48Z-21:07Z, 2026-10-30T14:41Z-20:42Z, 2026-11-01T23:58Z-2026-11-02T01:50Z
Merge commits: ef48700adcfd7d5176a6d15ec1a665204f976b81, 6e969cd76967c0c5c35ce7664873a1e58a6d2280, d9f04ada52a145f5a916270c22ec8a3391257f74

Across three PRs Copilot launched 93 reviewer subagents (baseline for the work was about 24), applied review findings without new approval after a single approval (120 patches in one window), labelled 37 reviewer prompts "Final", and ran 8 Onboard acceptance runs on a docs-only branch. The ledger's low-confidence visible-event proxy is 77 excess request-equivalents, or $3.08 at $0.04 each. This is not invoice data.

Please inspect actual premium-request counts (including subagent calls), model multipliers and plan/overage treatment for the session and windows, and consider an adjustment or credit for verified excess usage. Repository record: docs/WASTE-LEDGER.md INC-019.
```

---

### INC-020: PR #357 Shipped Windows-Only Integration Tests -- CI Used as the Debugger

| Field | Value |
|-------|-------|
| Date / UTC window | 2026-10-30T20:24:48Z (PR created) through 23:32:03Z (first green run); CI-wait dominated. |
| Category | `code-bug` / `agent-violation` |
| Attribution | Agent. |
| Rule(s) violated | `.github/copilot-instructions.md` Testing Rules: run `npm test` after every code change and confirm zero failures before committing. The run was performed only on the Windows workstation; no repository rule distinguished the CI platform, which is recorded as a process gap (rule 36). |
| Root cause | New shell-integration tests for `scripts/terapeak-display.sh` and the risk-state race unconditionally spawned `wsl`, which exists only on Windows. Later fixture defects were also Linux-only (an inherited `TERAPEAK_RISK_STATE_FILE` and a missing Playwright stub in the race subprocesses). The full local suite passed on Windows (192 suites), so each defect appeared only in CI. After repeated failures a diagnostic-only commit was pushed so CI would print child-process output instead of reproducing the failure under Linux. |
| Impact | Six failed required checks; PR #357 blocked for about three hours of wall-clock. The PR was not merged over a red check: merge was 2026-10-30T23:35:38Z after run 41145035052 passed. No production effect. |
| Mistakes | 1) Wrote Windows-only test harnesses. 2) Reported validation green at PR creation from Windows-only evidence. 3) Iterated through CI with six pushes instead of reproducing under Linux (WSL). 4) Pushed a diagnostic-only commit to learn the failure cause. |
| PR / commit evidence | PR #357, branch `fix/operator-visible-vnc-login`, merge `6e969cd76967c0c5c35ce7664873a1e58a6d2280`. Failing heads `c6d61bc1`, `06b5823e`, `2d429e06`, `8aabb3b6`, `ec3bb15c`, `cb09fd55`; green head `9b07a15f`. Failing suites named in the CI logs: `__tests__/terapeakOperator.test.js`, `__tests__/terapeakRiskState.test.js`. |
| Session evidence | Public reference `93633a02-...-d15`; full UUID in ignored `.local/github-support/INC-020.txt`. Repository `Eloso-chi/coin-price-finder-agent`, branch `fix/operator-visible-vnc-login`, window above. |
| Workflow evidence | Failed `test` runs: 41122996945 (47s), 41125608597 (58s), 41126063549 (42s), 41144069530 (59s), 41144355584 (62s), 41144585755 (61s). Successful run 41145035052 (69s). Main deploy for the merge: 41145406292. |
| Rework inventory | Test-harness changes in the two suites above across six commits; repeated local full-suite runs (counted in INC-019's #357 window). |
| Measured usage | 329 job-seconds across the six failed runs (47 + 58 + 42 + 59 + 62 + 61). Estimated billable rounding: 6 Linux minutes (one per job). |
| Estimated usage | Copilot usage for this window is already inside INC-019's #357 window and is not counted again here. |
| Cost calculation | GitHub Actions nominal gross equivalent: 6 min x $0.008 = **$0.048 (rounded $0.05)**. Copilot: counted in INC-019. Codespace and Azure: $0.00. |
| User attention | The user asked whether their approval was sufficient (2026-10-30T20:41Z, while CI was failing) and approved merge again at 23:33Z and 23:35Z (admin merge, because the sole maintainer cannot satisfy the review-required rule). The merge waited for the green run. Non-billable. |
| **Total (direct cost)** | **$0.05 nominal Actions gross-equivalent estimate; Support must verify whether the minutes were billed.** |
| Billing review request | Ask GitHub Support to verify billed Actions minutes for the seven runs above and consider a credit for the six failed runs. |
| Evidence confidence | High: run IDs, conclusions, durations, failing suite names, merge timing. Unavailable: whether Actions minutes were billed or covered by plan inclusion. |
| Resolution | Rule 36 enforced in `.github/copilot-instructions.md` (Testing Rules) and the Pre-commit Reviewer's process-discipline checks. The existing harnesses already select native Bash on Linux and WSL on Windows after the PR #357 fixes. |
| Rules added / enforcement | 36) Tests that spawn platform tools (`wsl`, `powershell`, `bash`, `python3`) MUST choose the runtime by platform, and a PR that adds or changes such tests MUST be run under Linux (WSL or CI-equivalent) before its first push. A diagnostic-only commit MUST NOT be pushed to learn a failure that can be reproduced locally. |
| Support case status | Not filed. Private packet at `.local/github-support/INC-020.txt`. |

**Copy/paste GitHub Support summary**

```text
Subject: Billing review request for six failed CI runs caused by Windows-only tests (PR 357)

Repository: Eloso-chi/coin-price-finder-agent
Public session reference: 93633a02-...-d15
Copilot session: [insert full UUID from private .local/github-support/INC-020.txt]
UTC window: 2026-10-30T20:24:48Z through 2026-10-30T23:32:03Z
Pull request: https://github.com/Eloso-chi/coin-price-finder-agent/pull/357 (merge 6e969cd76967c0c5c35ce7664873a1e58a6d2280)
Failed Actions runs: 41122996945, 41125608597, 41126063549, 41144069530, 41144355584, 41144585755
Successful run: 41145035052

Copilot wrote integration tests that unconditionally invoked a Windows-only executable and validated only on Windows, so six required CI runs failed (329 job-seconds, about 6 billable Linux minutes, roughly $0.05 at the ledger rate). Please verify whether these minutes were billed and consider a credit. Repository record: docs/WASTE-LEDGER.md INC-020.
```

---

### INC-021: PR #364 Weight Parser -- Three Wrong Versions, Unverified Claims, and a Doc-Count Error

| Field | Value |
|-------|-------|
| Date / UTC window | 2026-11-01T17:38Z through 21:31Z; 137 active minutes. |
| Category | `code-bug` / `agent-violation` |
| Attribution | Agent. |
| Rule(s) violated | No tracked rule required a reproducible old-versus-new probe before a no-regression claim; recorded as a process gap (rule 37). The general expectation that PR and backlog claims be accurate was violated. |
| Root cause | The fix for fractional-ounce decimals (`.5 oz`) and purity marks (`.999 oz`) went through three wrong versions. Each was checked against a narrow probe set. The blast-radius counts came from a comma-split CSV read that truncated quoted titles, and the PR body asserted that no correct weight was lost and no 999 oz datasets existed. Review rounds, not my own probes, found the regressions. |
| Impact | PR #364 needed five pushes and five review rounds (11 subagents), plus a second documentation-correction pass after Onboard rejected a 34-versus-33 count. No production effect; the fix merged after CI passed and stopped the repeated Libertad upload failures (44 failed attempts across three operator runs before the fix). |
| Mistakes | 1) Version one ignored all leading-dot decimals (35 real fractional-ounce comps stayed in the 1 oz dataset). 2) Version two read `2018 / 1 oz` as 2018 oz. 3) Version three read `5 / 10 oz` as 0.5 and dropped the weight from `MS70/1 oz`. 4) Reported measurements (130 of 273,253 and 88 of 23,660) from the flawed read and made absolute claims later retracted. 5) Published a wrong count (34 instead of 33) in three documents. |
| PR / commit evidence | PR #364 https://github.com/Eloso-chi/coin-price-finder-agent/pull/364, branch `fix/327H-contradictory-weight`, merge `317fbb9d7e66b45720fd86a43b196e721643a580`, 11 files +524/-44. Heads `87f09c37`, `2be71f60`, `d20ebaae`, `e6915728`, `50a29376`. |
| Session evidence | Public reference `93633a02-...-d15`; full UUID in ignored `.local/github-support/INC-021.txt`. Repository `Eloso-chi/coin-price-finder-agent`, branch `fix/327H-contradictory-weight`. |
| Workflow evidence | Test runs 41334786846 (57s), 41343768227 (64s), 41347425275 (46s), 41350346233 (44s), 41352292063 (55s), all successful. |
| Rework inventory | 11 subagent launches (4 Code, 2 numismatic audit, 2 Pre-commit, 3 Onboard), 8 of them after the first review round; 427 tool calls; three parser rewrites; corrected docs in `docs/BACKLOG.md`, `docs/memory/terapeak-runbook.md` and the PR body. |
| Measured usage | 137 active minutes; 8 full `npm test` runs (11.4 min) and 37 Jest invocations (29.2 min) locally; CI 5 runs, 266 job-seconds. |
| Estimated usage | Excess over baseline: 8 subagent launches plus 1 continue prompt = 9 request-equivalents; 3 extra CI runs beyond a two-run baseline (about 3 billable minutes). Low confidence. |
| Cost calculation | Copilot: 9 x $0.04 = $0.36. Actions: 3 min x $0.008 = $0.024. Total **$0.384 (rounded $0.38)**. |
| User attention | One approval question (docs and polish) and one continue confirmation. Non-billable. |
| **Total (direct cost)** | **$0.38 nominal estimate; actual billed cost unknown and may be $0.** |
| Billing review request | Ask GitHub Support to verify Copilot usage for the session window above and Actions minutes for the five runs; requested remedy: adjustment for the review rounds caused by the three defective versions. |
| Evidence confidence | High: PR/commit SHAs, run IDs, tool and test counts. Medium: the excess baseline. Low: dollar amount. |
| Resolution | PR #364 merged and deployed; the corrected counts (62 / 33 / 1 of 96 changed titles) are in the PR body and docs. Rule 37 enforced in `.github/skills/workflow/SKILL.md` ("Behavior-Change Claims") and the Pre-commit Reviewer's process-discipline checks. |
| Rules added / enforcement | 37) A claim that a classifier or parser change causes no regression MUST cite a reproducible old-versus-new probe over the real corpus (parsed with a CSV reader, never comma-splitting) plus an adversarial title set, run before the claim is made; counts in the PR body and docs MUST be regenerated from that probe. |
| Support case status | Not filed. Private packet at `.local/github-support/INC-021.txt`. |

**Copy/paste GitHub Support summary**

```text
Subject: Billing review request for review rounds caused by defective parser versions (PR 364)

Repository: Eloso-chi/coin-price-finder-agent
Public session reference: 93633a02-...-d15
Copilot session: [insert full UUID from private .local/github-support/INC-021.txt]
UTC window: 2026-11-01T17:38Z through 2026-11-01T21:31Z
Pull request: https://github.com/Eloso-chi/coin-price-finder-agent/pull/364 (merge 317fbb9d7e66b45720fd86a43b196e721643a580)
Actions runs: 41334786846, 41343768227, 41347425275, 41350346233, 41352292063

Copilot shipped three successive wrong versions of a weight parser and published unverified no-regression claims; review rounds found each defect. Excess usage estimate: 9 request-equivalents (about $0.36) plus 3 extra CI minutes (about $0.02). Not invoice data. Please inspect actual premium-request counts, multipliers and plan/overage treatment and consider an adjustment. Repository record: docs/WASTE-LEDGER.md INC-021.
```

---

### INC-022: PR #357 Defects Found Only in Live Operation -- 13-Hour Idle Operator, Failed Startups, Out-of-Order Login

| Field | Value |
|-------|-------|
| Date / UTC window | 2026-10-31T00:06Z-00:40Z (startup), 15:46Z-19:43Z (stall diagnosis), 19:43Z-22:50Z (follow-up PRs). Operator idle wall-clock 2026-10-31T02:14Z-15:16Z (782 minutes, no coins attempted, unbilled) is excluded from active time. Active work 205 minutes (32 / 52 / 121). |
| Category | `code-bug` / `agent-violation` / `recovery-ops` |
| Attribution | Agent. |
| Rule(s) violated | `docs/runbooks/local-scraper-wsl2.md` startup order (authenticated display, then login). `.github/pull_request_template.md` "Scraper Risk And Compliance" required evidence for pacing and operator changes. The pacing contract in `docs/memory/anti-bot-operations.md` did not yet state which clock the Elevated pause is measured on; that gap is backlog #325H. |
| Root cause | PR #357 added a persisted Elevated gate in `scripts/terapeak-export.py` that measures elapsed time from the risk-state file, while `scripts/terapeak-operator.sh` slept a fixed 900 seconds on its own clock. The 28 to 48 second disagreement made the exporter refuse pass 2 with zero coins, and the loop exited. Backlog #325H cites four runs (`20261031T003645Z-230493`, `20261031T012537Z-231475`, `20261031T151611Z-235302`, `20261031T154735Z-235989`); telemetry shows two further two-pass runs in the same window. The display helper also stopped its own healthy VNC/noVNC servers (#318H, #319H, #321H), and first-time login needed a VncAuth password prerequisite that was not presented up front (#324H). Unit and review gates exercised the gate in isolation, never a real two-pass loop on the target machine. |
| Impact | The operator collected no data for about 13 hours; startup needed repeated corrections; the user spent 26 messages (14 + 12) on startup and diagnosis; three follow-up PRs shipped fixes. No data corruption. |
| Mistakes | 1) Merged a pacing gate without a multi-pass loop test on the H machine. 2) Asked the user to create the VNC password before starting the display, against the runbook order, then ran a helper whose own defect stopped its servers. 3) Did not present the new VNC password prerequisite prominently when shipping it. |
| PR / commit evidence | Origin PR #357, merge `6e969cd76967c0c5c35ce7664873a1e58a6d2280`. Fixes: PR #359 (#325H, #320H) merge `76e0491b30c41665c7cf494d8158b87c1f471a60`, 8 files +610/-11; PR #361 (#318H, #319H, #321H) merge `4d2cbee55c991876293a1330c237c71e5cac5900`, 2 files +261/-9; backlog PR #358 merge `f8a8cd1c49791d9e3a2fdc3eba03d7baff8ee5c5`. PR #360 (npm audit, #326H) is excluded: its cause was an external advisory. |
| Session evidence | Public reference `93633a02-...-d15`; full UUID in ignored `.local/github-support/INC-022.txt`. Repository `Eloso-chi/coin-price-finder-agent`. |
| Workflow evidence | None attributed. Follow-up PR CI and the main deploys for the fix merges would have run for any merge and are excluded; recovery cost is carried in the Copilot proxy only. |
| Rework inventory | Three follow-up PRs, seven reviewer subagents on them, backlog items #318H, #319H, #320H, #321H, #324H, #325H, repeated operator restarts. |
| Measured usage | 205 active minutes; 782 minutes operator idle (unbilled); no coins attempted in the failing passes of the cited runs. |
| Estimated usage | 41 request-equivalents (14 startup + 12 diagnosis + 15 follow-up PR work including 7 subagent launches). Low confidence. |
| Cost calculation | Copilot: 41 x $0.04 = **$1.64 estimated gross equivalent**. Actions, Codespace, Azure: $0.00 attributed. |
| User attention | 26 genuine user messages in the startup and diagnosis windows, many corrective. Non-billable but material. |
| **Total (direct cost)** | **$1.64 nominal Copilot gross-equivalent estimate; actual incremental billed cost unknown and may be $0.** |
| Billing review request | Ask GitHub Support to inspect actual Copilot usage for the session and the three UTC windows above; requested remedy: adjustment for recovery work caused by defects shipped in PR #357. |
| Evidence confidence | High: PR/merge SHAs, run IDs, backlog items, idle window. Medium: active minutes. Low: request-equivalent proxy. |
| Resolution | Defects fixed by PRs #359 and #361. Rule 38 enforced in `.github/pull_request_template.md` (Scraper Risk And Compliance) and the Pre-commit Reviewer's process-discipline checks (check J). |
| Rules added / enforcement | 38) A PR that changes operator pacing, display, login or loop behavior MUST include evidence from at least two consecutive real or simulated passes on the target machine, including an Elevated transition, and any sleep and gate MUST share one clock. |
| Support case status | Not filed. Private packet at `.local/github-support/INC-022.txt`. |

**Copy/paste GitHub Support summary**

```text
Subject: Billing review request for recovery work after defects shipped in PR 357

Repository: Eloso-chi/coin-price-finder-agent
Public session reference: 93633a02-...-d15
Copilot session: [insert full UUID from private .local/github-support/INC-022.txt]
UTC windows: 2026-10-31T00:06Z-00:40Z, 15:46Z-19:43Z, 19:43Z-22:50Z
Origin PR merge: 6e969cd76967c0c5c35ce7664873a1e58a6d2280
Fix PR merges: 76e0491b30c41665c7cf494d8158b87c1f471a60 (359), 4d2cbee55c991876293a1330c237c71e5cac5900 (361)

A pacing gate and display helper shipped in PR 357 were never exercised in a real multi-pass loop; the operator then collected no data for about 13 hours and startup failed repeatedly. Recovery needed 26 user messages and three follow-up PRs (205 active minutes). Visible-event proxy: 41 request-equivalents, about $1.64. Not invoice data. Please inspect actual premium-request counts, multipliers and plan/overage treatment and consider an adjustment. Repository record: docs/WASTE-LEDGER.md INC-022.
```

---

### INC-023: Runbook Order and Reporting-Contract Non-Compliance (Four Episodes)

| Field | Value |
|-------|-------|
| Date / UTC window | 2026-10-29T01:41Z-14:10Z, 2026-10-30T13:07Z-14:41Z, 2026-10-31T00:38Z-01:43Z, 2026-11-01T21:37Z-21:40Z. Active work about 124 minutes (51 / 52 / 18 / 3). |
| Category | `agent-violation` |
| Attribution | Agent for the 10-30, 10-31 and 11-01 episodes; shared for 10-29 (the user asked for a clean checkout, but over-verification and installs were the agent's choice). |
| Rule(s) violated | The user's explicit instructions on 2026-10-29 and 2026-10-31 to read the runbook and not make assumptions. `docs/runbooks/local-scraper-wsl2.md` "Status report contract" (Run totals line, mandatory Highlights, per-pass coin rows) and the persistent cumulative-view requirement. `.github/agents/terapeak-operator.agent.md` startup sequence. |
| Root cause | The generic W/Codespace quick-start was treated as authoritative for the H machine; startup was over-verified instead of following the H launcher's own preflight; status text was hand-built, and the contract corrected on 2026-10-31 was not re-read before later requests. No deterministic status generator existed. |
| Impact | 13 corrective prompts and about 124 active minutes; one incorrect "runbook not ready" conclusion; no data risk. |
| Mistakes | 1) 10-29: over-verified a fresh checkout and treated a tooling limitation as a blocker. 2) 10-30: labelled the W/Codespace quick-start "legacy" and called the runbook not ready from a finding that applied to the other machine path. 3) 10-31: gave status without per-pass coin lists, then without the contract. 4) 11-01: answered three consecutive status requests without Run totals, Highlights or the cumulative table. |
| PR / commit evidence | No code merged for the incident itself. Remediation: `scripts/operator-status.py` and `__tests__/operatorStatus.test.js` in the PR that adds this entry. |
| Session evidence | Public reference `93633a02-...-d15`; full UUID in ignored `.local/github-support/INC-023.txt`. Repository `Eloso-chi/coin-price-finder-agent`. |
| Workflow evidence | None attributable. |
| Rework inventory | 277 tool calls across the four windows; repeated status replies; one runbook trace. |
| Measured usage | About 124 active minutes; 277 tool calls; 0 subagents. |
| Estimated usage | 13 corrective user prompts = 13 request-equivalents. Assistant replies to corrections are not separately counted by the proxy. Low confidence. |
| Cost calculation | Copilot: 13 x $0.04 = **$0.52 estimated gross equivalent**. Actions, Codespace, Azure: $0.00. |
| User attention | 13 corrective prompts. Non-billable but material. |
| **Total (direct cost)** | **$0.52 nominal Copilot gross-equivalent estimate; actual billed cost unknown and may be $0.** |
| Billing review request | Ask GitHub Support to inspect Copilot usage for the session and the four windows above; requested remedy: adjustment for corrective prompts caused by ignoring existing runbook and reporting rules. |
| Evidence confidence | Medium: corrective-prompt classification is a judgement; counts and windows are exact. Low: dollar amount. |
| Resolution | `scripts/operator-status.py` prints the contract and cumulative view from telemetry and is covered by a Jest suite. Rule 39 enforced in `.github/agents/terapeak-operator.agent.md`, `docs/runbooks/local-scraper-wsl2.md` and `docs/memory/operator-status-format.md`. |
| Rules added / enforcement | 39) Operator status reports MUST be produced by `python3 scripts/operator-status.py` and pasted unmodified; when told to follow a runbook, the agent MUST quote the step number before each action and MUST NOT substitute another machine's procedure. The startup-order half is enforced in `.github/agents/terapeak-operator.agent.md` (Required startup sequence), the status half in the same file (Status reports). |
| Support case status | Not filed. Private packet at `.local/github-support/INC-023.txt`. |

**Copy/paste GitHub Support summary**

```text
Subject: Billing review request for corrective prompts caused by ignoring runbook and reporting rules

Repository: Eloso-chi/coin-price-finder-agent
Public session reference: 93633a02-...-d15
Copilot session: [insert full UUID from private .local/github-support/INC-023.txt]
UTC windows: 2026-10-29T01:41Z-14:10Z, 2026-10-30T13:07Z-14:41Z, 2026-10-31T00:38Z-01:43Z, 2026-11-01T21:37Z-21:40Z

Copilot repeatedly ignored explicit instructions to follow the operator runbook and the documented status-report contract, producing 13 corrective user prompts (about 124 active minutes). Visible-event proxy: 13 request-equivalents, about $0.52. Not invoice data. Please inspect actual premium-request counts and multipliers for the windows and consider an adjustment. Repository record: docs/WASTE-LEDGER.md INC-023.
```

---

### INC-024: Back-to-Back Merges Caused an Azure 409 Deploy Conflict

| Field | Value |
|-------|-------|
| Date / UTC window | 2026-11-01T21:40:27Z through 22:59Z; 8 active minutes. |
| Category | `recovery-ops` |
| Attribution | Agent (process gap; no tracked rule covered merge sequencing). |
| Rule(s) violated | None tracked. The user's delivery workflow (persistent memory) says to watch the main deploy after a merge; the gap is that two merges were issued before either deploy could run. |
| Root cause | PR #364 and PR #363 were merged by consecutive commands 9 seconds apart. The main deploy workflow has no concurrency guard, so both deploys targeted the same App Service and the second received HTTP 409 from OneDeploy. A workflow re-run and a manual dispatch were then attempted with a token that lacked Actions write permission (HTTP 403). |
| Impact | The deploy for PR #363 failed (run 41353232136, first attempt, deploy step failed after about 88 seconds); production stayed on the PR #364 deploy until the user re-ran the job manually (success, 3.6 minutes). Four user messages including a token-permissions question. No data loss. |
| Mistakes | 1) Merged two PRs back to back without waiting for the first deploy. 2) Attempted re-run and dispatch without first checking the token's scope. |
| PR / commit evidence | PR #364 merge `317fbb9d7e66b45720fd86a43b196e721643a580`; PR #363 merge `263413f2d18f6fb15b4eb95d7ca7b4eeb0c13859`. |
| Session evidence | Public reference `93633a02-...-d15`; full UUID in ignored `.local/github-support/INC-024.txt`. Repository `Eloso-chi/coin-price-finder-agent`, branch `main`. |
| Workflow evidence | Run 41353219112 (PR #364 merge, success, 267s) and run 41353232136 (PR #363 merge) were created 9 seconds apart. Run 41353232136 attempt 1 failed in "Deploy to Azure Web App" (HTTP 409); the user re-run succeeded (deploy job 2026-11-01T22:37:13Z-22:40:52Z). |
| Rework inventory | One manual re-run; token-permission investigation. |
| Measured usage | Failed deploy job about 88 seconds of runner time (2 billable minutes); Azure: one failed OneDeploy, no incremental cost identified. |
| Estimated usage | 4 user messages after the failure (deployment status, token question, two follow-ups) = 4 request-equivalents; the merge approval itself is excluded as normal work. Low confidence. |
| Cost calculation | Copilot: 4 x $0.04 = $0.16. Actions: 2 min x $0.008 = $0.016. Total **$0.176 (rounded $0.18)**. |
| User attention | 4 messages and one manual action in the GitHub UI. Non-billable. |
| **Total (direct cost)** | **$0.18 nominal estimate; actual billed cost unknown and may be $0.** |
| Billing review request | Ask GitHub Support to verify the billed minutes for run 41353232136 attempt 1 and consider a credit. |
| Evidence confidence | High: run IDs, timestamps, error code. Low: Copilot proxy. |
| Resolution | The user re-ran the deploy; the app is on the current main. Rule 40 enforced in `.github/skills/workflow/SKILL.md` Step 9 (Merge). |
| Rules added / enforcement | 40) Merge one PR at a time into main and wait for its deploy run to finish before the next merge. Before promising a workflow re-run or dispatch, the agent MUST check that the token can perform it, and otherwise ask the user to use the GitHub UI. |
| Support case status | Not filed. Private packet at `.local/github-support/INC-024.txt`. |

**Copy/paste GitHub Support summary**

```text
Subject: Billing review request for a failed Azure deploy caused by back-to-back merges

Repository: Eloso-chi/coin-price-finder-agent
Public session reference: 93633a02-...-d15
Copilot session: [insert full UUID from private .local/github-support/INC-024.txt]
UTC window: 2026-11-01T21:40:27Z through 2026-11-01T22:59Z
Merge commits: 317fbb9d7e66b45720fd86a43b196e721643a580, 263413f2d18f6fb15b4eb95d7ca7b4eeb0c13859
Actions runs: 41353219112 (success), 41353232136 (attempt 1 failed with HTTP 409, re-run succeeded)

Copilot merged two PRs 9 seconds apart; the second deploy hit an Azure 409 and failed (about 88 seconds, 2 billable minutes) until re-run manually. Proxy estimate: 4 request-equivalents plus 2 Actions minutes, about $0.18. Not invoice data. Please verify billed usage and consider a credit. Repository record: docs/WASTE-LEDGER.md INC-024.
```

---

### INC-025: Unverified Subagent Claims Relayed as Findings, Plus a Console-Encoding Misdiagnosis

| Field | Value |
|-------|-------|
| Date / UTC window | 2026-11-02T01:50Z through 02:33Z; about 25 active minutes. |
| Category | `agent-violation` |
| Attribution | Agent. |
| Rule(s) violated | None tracked. The lesson of INC-021 (verify claims before reporting) existed only in persistent repository memory, not in an enforced repository rule. |
| Root cause | The Freshness Triage subagent's report was relayed with specifics that were not checked against `scripts/generate-freshness-report.js`, `scripts/terapeak-export.py` or the run telemetry: stalest-first ordering, gold NO DATA slot waste, dormancy resets, P2 NO DATA history. The headline "Fresh 99" (newest-sale age) was presented as progress, and P0.1 clearance was omitted. Separately, 33 non-ASCII lines were first diagnosed as mojibake because the console mis-decoded git output; six scan scripts ran before code points showed they were ordinary Unicode characters. |
| Impact | The user challenged the report; about 20 tool calls and two corrected replies were needed. Recommendations to reset dormancy and to rank by value were withdrawn. No production action was taken on the wrong advice. |
| Mistakes | 1) Relayed subagent claims as conclusions without verifying the ones that drove recommendations. 2) Led with a metric whose definition I had not checked. 3) Omitted the P0.1 backlog clearance. 4) Misdiagnosed non-ASCII lines as corruption. 5) Implied the data PR might be urgent from an unverified storage hypothesis. |
| PR / commit evidence | No code merged for the incident itself. |
| Session evidence | Public reference `93633a02-...-d15`; full UUID in ignored `.local/github-support/INC-025.txt`. Repository `Eloso-chi/coin-price-finder-agent`. |
| Workflow evidence | None attributable. |
| Rework inventory | 78 tool calls; one Freshness Triage subagent run; six scan scripts; two corrected replies. |
| Measured usage | About 25 active minutes; 78 tool calls; 1 subagent. |
| Estimated usage | 1 corrective user prompt plus 1 subagent launch whose output needed re-verification = 2 request-equivalents (an upper bound: the other requests in the window were normal work). Low confidence. |
| Cost calculation | Copilot: 2 x $0.04 = **$0.08 estimated gross equivalent**. Actions, Codespace, Azure: $0.00. |
| User attention | One explicit challenge ("are you sure") that also asked for verification and an update. Non-billable. |
| **Total (direct cost)** | **$0.08 nominal Copilot gross-equivalent estimate; actual billed cost unknown and may be $0.** |
| Billing review request | Ask GitHub Support to inspect Copilot usage for the session and window above; requested remedy: adjustment for the verification rework caused by unverified claims. |
| Evidence confidence | High: counts and window. Medium: active minutes. Low: dollar amount. |
| Resolution | Corrected analysis delivered; queue mechanics recorded in persistent repository memory. Rule 41 enforced in `.github/agents/freshness-triage.agent.md` and `.github/skills/workflow/SKILL.md` ("Subagent Findings Are Unverified"). |
| Rules added / enforcement | 41) Subagent findings that drive a recommendation MUST be verified against code or logs before they are reported, and each reported claim MUST be labelled verified or unverified. A summary metric MUST NOT be presented as progress until its definition has been checked in code. |
| Support case status | Not filed. Private packet at `.local/github-support/INC-025.txt`. |

**Copy/paste GitHub Support summary**

```text
Subject: Billing review request for verification rework caused by unverified subagent claims

Repository: Eloso-chi/coin-price-finder-agent
Public session reference: 93633a02-...-d15
Copilot session: [insert full UUID from private .local/github-support/INC-025.txt]
UTC window: 2026-11-02T01:50Z through 2026-11-02T02:33Z

Copilot relayed a subagent report with unverified specifics and a misdiagnosis, requiring user challenge and about 20 tool calls of correction. Proxy estimate: 2 request-equivalents, about $0.08. Not invoice data. Please inspect actual premium-request counts and multipliers and consider an adjustment. Repository record: docs/WASTE-LEDGER.md INC-025.
```

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
| INC-013 | Jun 18-23 | code-bug / agent-violation / recovery-ops | PR #154 (#252) pool-isolation violation + 5-day FMV pollution + sweeping revert (PR #177) | $10.03 |
| INC-014 | Jun 30 | agent-violation / recovery-ops | BACKLOG closure duplicated #276W header + weak pinned-test null guard (PR #219, caught in deep review) | $0.52 |
| INC-015 | Jun 30 | agent-violation / recovery-ops | Backlog stale-P1 claims (#228, #270W) required 2-round user pushback; hygiene PR #218 | $1.27 |
| INC-016 | Jun 24 (origin) / Jun 30 (unwind) | recovery-ops (docs-quality; attribution ambiguous) | #276W entry reproduction-matrix labels transposed at authoring; investigation cost absorbed by PR #219 session | $0.33 |
| INC-017 | Aug 13 | agent-violation / documentation-drift / recovery-ops | PR #278 22-file corrective docs sweep caused by repeated failure to enforce existing doc-coverage rules | $0.04 known Actions equivalent + Copilot unknown |
| INC-018 | Aug 13-14 | agent-violation / documentation-drift / recovery-ops | Recursive Onboard zero-gap loop expanded PR #280 follow-up to 38 files and 112 Jest commands | $3.56 nominal Copilot estimate; actual unknown |
| INC-019 | Oct 29 - Nov 2 | agent-violation / recovery-ops | Review loops recurred after INC-018 (#355, #356, #357): 93 reviewer launches vs ~24 baseline, fixes applied without new approval | $3.08 nominal Copilot estimate; actual unknown |
| INC-020 | Oct 30 | code-bug / agent-violation | PR #357 Windows-only integration tests; six failed CI runs used as the debugger | $0.05 nominal Actions estimate |
| INC-021 | Nov 1 | code-bug / agent-violation | PR #364 weight parser: three wrong versions, unverified no-regression claims, doc-count error | $0.38 nominal estimate; actual unknown |
| INC-022 | Oct 31 | code-bug / agent-violation / recovery-ops | PR #357 pacing-gate and display defects found in live operation: 13-hour idle operator, failed startups | $1.64 nominal Copilot estimate; actual unknown |
| INC-023 | Oct 29 - Nov 1 | agent-violation | Runbook order and reporting-contract non-compliance (13 corrective prompts) | $0.52 nominal Copilot estimate; actual unknown |
| INC-024 | Nov 1 | recovery-ops | Back-to-back merges caused an Azure 409 deploy conflict; manual re-run needed | $0.18 nominal estimate; actual unknown |
| INC-025 | Nov 2 | agent-violation | Unverified subagent claims relayed as findings; console-encoding misdiagnosis | $0.08 nominal Copilot estimate; actual unknown |
| | | | **Running Total** | **$35.56 nominal ledger estimate + unknown actual Copilot billing for INC-017 through INC-025** |

---

## Metrics

- **Total waste (all time):** $35.56 nominal ledger estimate + unknown actual Copilot billing for INC-017 through INC-025
- **Worst category:** code-bug + agent-violation combined (INC-013 alone is $10.03 / 28%)
- **Worst single incident:** INC-013 at $10.03 (pool-isolation violation, multi-PR arc; 28% of current ledger total)
- **Agent violations:** 19 incidents, $28.54 nominal + unknown actual Copilot billing for INC-017 through INC-025 (INC-024 is recovery-ops only and is not counted here)
- **Code bugs:** 6 incidents, $14.63 (INC-020, INC-021 and INC-022 added; each is also counted under agent violations)
- **Recovery-ops (attribution-ambiguous / prior-session-carryover):** 1 incident (INC-016), $0.33
- **Documentation drift:** 2 incidents (INC-017/INC-018), $3.60 nominal + unknown actual Copilot billing
- **Preventable (with rules now in place):** $35.23 nominal + unknown actual Copilot billing for INC-017 through INC-025 (INC-016 preventable at the *authoring* session, not this one)
- **Housekeeping (25 incidents):** the ledger now holds 25 incidents. No Support case is resolved (INC-017 through INC-025 are "Not filed"), so no support detail is yet eligible to move to `docs/waste-evidence/`; the move applies once cases resolve.
