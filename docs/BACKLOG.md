# Backlog

Open work items, ordered by priority within each category.
Items marked DONE are kept for historical reference.

---

## Scraping & Data Pipeline

### ~~S0. Active Listings Guard in Aggregator [DONE]~~

Both `terapeak-export.py` and `sales-aggregator.py` now guard against active listings:
- Tab check: detects "Active listings" tab via DOM after results load
- Date validation: if <20% of collected rows have parseable sold dates, aborts with warning

---

### S2. Page 2+ Deep Pagination [HIGH -- IN PROGRESS]

**Problem:** High-volume coins have only 50 rows (page 1 limit). Deep pagination (pages 2-6) expands bullion to 300 rows.

**Status:** 243 datasets deep-aggregated. 165 high-volume datasets remaining (50+ comps, no `deepAt` in aggregationMeta). Batch 3 interrupted at 58%.

**Check remaining:** `GET /api/terapeak/aggregation-status?needs=deep&minComps=50`

**Command:** `python3 scripts/sales-aggregator.py --run --limit N`

**Files:** `scripts/sales-aggregator.py`

---

### S3. Eliminate Disk-CSV Dual-Write from Export Script [MEDIUM]

**Problem:** `terapeak-export.py` writes CSVs to both `data/terapeak/` (disk) and blob storage. This dual-write caused the data-loss bug fixed in `fix/csv-merge-on-refresh` -- naive file moves overwrote deep-paginated data with page-1 results.

**Proposed change:**
1. Export script uploads CSVs directly to blob storage only (already does this).
2. Remove the `_merge_csv` / file-move step that writes to `data/terapeak/`.
3. Server imports exclusively from blob on startup (`autoImportFromBlob`).
4. `data/terapeak/` becomes a read-only cache populated by the server, not the script.

**Benefits:** Single source of truth (blob); eliminates file-overwrite bug class; no git churn.
**Trade-offs:** Requires blob availability for imports; slower restart (network vs disk); lose git-tracked comp history (mitigated by blob versioning).

---

### S4. Refresh Stale 14-30 Days [MEDIUM -- defer after S2]

---

### S5. Gold Year-Specific CSVs [HIGH -- partial]

**Problem:** Gold Libertad, Gold Panda, and Gold Eagle all lack year-specific datasets. Gold queries hit mixed-metal generic datasets causing 95-99% attrition.

**Status (May 2026):** Stubs created and partially populated. 89 empty stubs remain (84 Gold Eagle fractional, 4 Gold Libertad, 1 Gold Panda). Populated: 50 Gold Libertad, 59 Gold Panda, 43+ Gold Eagle 1oz, 79-80 each fractional.

**Next:** Run `python3 scripts/terapeak-export.py --run --filter "Gold Eagle"` (requires VNC + cookies).

---

### ~~S6. Dashboard Gold Bullion & Gold Bars Staleness Categories [DONE]~~

Implemented in both `dashboard()` and `headless_dashboard()`. Stale split into: main (excl. gold/bars/low-vol/barber), gold bullion, gold bars, low volume, barber non-half. Each has its own menu entry [4]/[5] with count and independent launch.

**Files:** `scripts/sales-aggregator.py`

---

### ~~S7. Low-Volume Coin Dashboard Filter [DONE]~~

All pieces implemented:
1. `build-evidence-index.js` run (May 2026): 3879 keys stamped, 464 low-volume candidates flagged
2. `terapeakService.js` preserves identifiers across imports (non-destructive merge)
3. Dashboard menu item [6] "Low volume stale" excludes flagged datasets from main stale list
4. `GET /api/terapeak/aggregation-status` returns identifiers in response

**Files:** `scripts/build-evidence-index.js`, `scripts/sales-aggregator.py`, `src/services/terapeakService.js`, `src/routes/terapeakRoute.js`

---

### ~~S8. Barber Quarter/Dime/Dollar Dashboard Filter [DONE]~~

Added `is_barber_nonhalf_term()` filter (regex: `\bbarber\b(?!.*\bhalf\b)`). Barber non-halves (297 datasets) get their own dashboard category [7], excluded from main stale list. Both interactive and headless dashboards updated.

**Files:** `scripts/sales-aggregator.py`

---

### 24. Proof Libertad Search Term Quality [DATA QUALITY]

**Problem:** Proof Libertad searches return results dominated by NGC/PCGS slabbed coins. Need to split "raw proof" vs "graded proof" or add negative keywords.

**Options:**
- (a) Add `-NGC -PCGS -graded -slab` negative keywords in search terms
- (b) Create separate graded vs raw CSV files
- (c) Post-process filter in the valuation pipeline (already partially done via grade-pool split)

**Affects:** 40 proof Libertad placeholders (1986-2025) and likely other proof series.

---

## Pricing Accuracy

### ~~P0-A. MintMismatch Over-Filtering on Over-Mintmark Varieties [DONE]~~

Fixed in `a1e02ca` (May 1). Uses `matchAll` + over-mintmark detection (`O/S`, `O over S`). 1882-S Morgan: $74.85 -> $133.21.

---

### ~~P0-B. Batch Route Missing Year in Keywords [DONE]~~

Fixed in `a1e02ca` (May 1). `pricingBatchRoute.js` now passes year/mint into `buildKeywords`. Gold Libertad: $18.74 -> $104.14.

---

### ~~P1-A. Gold Libertad Pipeline Leak -- 99% Attrition [DONE]~~

Fixed May 6. Two changes:
- `buildKeywords` adds `-silver` exclusion for gold queries (and `-gold` for silver) to reduce wrong-metal eBay results
- `meltFloor` filter now uses historical spot price at comp's sale date (via `metalsHistoryService.getSpotOnDate()`) instead of today's spot, preventing false-positive removal of older comps when metals have rallied
- Files: `ebayService.js`, `metalsHistoryService.js`

---

### ~~P1-B. 2024 Krugerrand 1oz -- 93% Weight Attrition [DONE]~~

Fixed May 6 (same metal-exclusion + historical meltFloor changes as #171). Remaining thinness is data quality in the CSV (mixed weights from Terapeak scrape).

---

### ~~#180. AGE Type 1 vs Type 2 Variant Disambiguation [DONE]~~

Fixed May 6:
- `parseDescription()` detects "Type 1" / "Type 2" in query text, sets `result.label`
- Parsed label flows into `validLabel` in both routes (user-explicit label takes priority)
- `buildKeywords` appends Type token to eBay search
- New `typeMismatch` hard filter in `applyFilters` removes comps with the wrong type
- Files: `pcgsService.js`, `ebayService.js`, `priceRoute.js`, `pricingBatchRoute.js`

---

### ~~P1. LowRelevance Over-Filtering on Empty-Title Terapeak Comps [WONTFIX]~~

Empty titles are already filtered at CSV import (`rowToComp` returns null). The `lowRelevance` gate (score < 20) only fires for truly irrelevant comps (multiple mismatches: wrong year + wrong series + wrong weight). High attrition on ASE/Krugerrand is caused by eBay's broad search returning off-topic results in the Terapeak dataset, not by the gate threshold. Survival rates (30/100 for ASE, 8/45 for Krugerrand) are adequate for FMV calculation.

---

### ~~#167. Graded Morgan Cross-Route FMV Divergence [DONE]~~

Added cross-route consistency tests for graded Morgan MS65 (no mint), Walking Liberty MS64 (no mint), and 30g Silver Panda. Tests verify Discovery and Batch routes produce consistent FMV within 25% tolerance.

**Merged:** PR #3 (May 12)

---

### ~~#166. lowRelevance Over-Filtering on 30g Pandas [DONE]~~

Added gram-based weight parsing to `parseDescription()` in `pcgsService.js`. "30g", "30 gram", "31.1g" now correctly convert to troy oz (÷ 31.1035). Matches existing gram handling in `detectWeightFromTitle`.

**Merged:** PR #3 (May 12)

---

### ~~#178. Gold Coins 95-99% Attrition in Mixed-Metal Datasets [DONE]~~

Fixed by #171: `buildKeywords()` adds `-silver` for gold queries / `-gold` for silver queries. `meltFloor` uses `getSpotOnDate()` for historical spot pricing. Long-term: gold-specific datasets (S5).

---

### ~~#181. 2025 ASE Cross-Route FMV Delta [DONE]~~

Resolved: recency half-life is centralized in `valuationService.js` (`halfLifeDays = isBullion ? 30 : 90`), not per-route. Both routes pass `isBullion` identically -- no configuration divergence possible.

---

### ~~#182. Proof Coin FMV Accuracy -- Slabbed Proof Classification Fix [DONE]~~

Fixed: `classifyGradeType()` now checks `PROOF_RE` when `conditionId=2000` (or `_certificationAspect` set). Slabbed proofs (e.g., PCGS PR69 DCAM) classified as `'proof'` instead of `'graded'`. Same logic applied in `terapeakService.classifyGradeType()`. 20 tests in `classifyGradeType.test.js`.

**Files:** `ebayService.js`, `terapeakService.js`, `__tests__/classifyGradeType.test.js`

---

### ~~#183. Designation-Aware Comp Scoring (DCAM/CAM) [DONE]~~

`scoreMatch()` now applies `+10` for designation match and `-15` for mismatch, gated on `expected.designation && userWantsProof`. Soft scoring preserves thin pools.

**Files:** `ebayService.js` (`scoreMatch`)

---

### ~~#184. Block Proof-to-BU Fallback in Pool Selection [DONE]~~

Fixed: Proof pool used regardless of comp count. 0 comps = null FMV with explanation. 1-2 comps = lowData flag. BU comps never mixed in. Proof intent detected from `opts.isProof` or userGrade prefix (PR/PF/Proof). 7 tests in `computeValuation.test.js`.

**Files:** `valuationService.js`, `__tests__/computeValuation.test.js`

---

### #186. Bulk Lot Evaluator FMV Divergence from Price Discovery [MEDIUM]

**Problem:** The bulk lot evaluator produces different FMV than the individual price discovery route for the same coin (e.g. "mexican silver libertad 2004 1oz"). No grade, no COA/box -- purely bullion raw coin -- yet numbers differ.

**Root cause:** `evaluateOneCoin()` in `bulkEvaluateService.js` calls `fetchSoldComps` with a lighter config than the price route:

| Parameter | Price Discovery | Bulk Evaluator |
|---|---|---|
| `timeWindowDays` | 180 | 90 |
| `maxPages` | 3 | 1 |
| `usMinComps` | 8 | 3 |
| `expected.metal` | Set explicitly | Missing (auto-detect only) |

The narrower time window produces a different comp pool (fewer comps, different median). The lower `usMinComps` means Terapeak satisfies sooner with fewer data points instead of extending lookback. Missing `expected.metal` can affect Terapeak dataset matching and metal-mismatch scoring.

**Fix:**
1. Align `timeWindowDays` to 180, `maxPages` to 2 (compromise), `usMinComps` to 6
2. Set `expected.metal` from `parsed.metal || detectedMetal`
3. Trade-off: ~1.5-2x slower bulk evaluations (more Terapeak/API work per coin)

**Files:** `bulkEvaluateService.js` (`evaluateOneCoin`, lines 209-212)

---

### #202. Investigate Lot Evaluator Batch: Silver Libertad 1 oz (1985-2024) [MEDIUM -- PROPOSED]

**Problem:** A specific Silver Libertad batch submitted to Lot Evaluator needs investigation for pricing consistency, comp utilization, and potential attrition/filtering anomalies.

**Batch under investigation (13 coins):**
- Silver Libertad 1 oz	1985
- Silver Libertad 1 oz	1993
- Silver Libertad 1 oz	1993
- Silver Libertad 1 oz	2004
- Silver Libertad 1 oz	2004
- Silver Libertad 1 oz	2009
- Silver Libertad 1 oz	2009
- Silver Libertad 1 oz	2011
- Silver Libertad 1 oz	2014
- Silver Libertad 1 oz	2014
- Silver Libertad 1 oz	2016
- Silver Libertad 1 oz	2020
- Silver Libertad 1 oz	2024

**Investigation scope:**
1. Re-run this exact batch through `/api/bulk-evaluate` and capture per-row FMV, confidence, and comp counts.
2. Compare each year against single-coin `/api/price` output using equivalent inputs.
3. Review filter attrition breakdown (`metalMismatch`, `lowRelevance`, `meltFloor`, etc.) for years with thin comps or large FMV deltas.
4. Confirm duplicate years (1993, 2004, 2009, 2014) return stable per-coin outputs and only differ by lot-level discounting logic.

**Expected outcome:**
- Document whether divergence is route config drift, data freshness/thinness, or a regression in batch path normalization/filtering.

**Files:** `src/services/bulkEvaluateService.js`, `src/routes/bulkEvaluateRoute.js`, `src/services/ebayService.js`, `src/services/valuationService.js`

**Status notes:** Added May 26, 2026 per user-reported Lot Evaluator batch.

---

### #185. World Proof Greysheet Pricing Fallback [MEDIUM -- PARTIAL]

**Problem:** Missing proof-specific pricing for major world bullion proofs (Krugerrand, Kookaburra, Philharmonic, Gold Maple Leaf). Proof queries fall back to MS wholesale price in the Greysheet blend.

**Root cause (May 18 investigation):** Greysheet catalog does NOT have "Type" (yearless aggregate) entries for proof versions of most world series. The PCGS +90,000 offset convention does NOT work with Greysheet API (Type entries have no PcgsNumber; offset queries return no data). DNS is resolved -- API is reachable.

**Partial fix applied (May 18):** Found GSID 373710 = "South Africa Rand 1oz Silver PR DCAM [Type]" (IsType: true, CPG pricing populated at $115/PR65-PR66). Added `krugerrand|1|silver|proof` to `greysheetTypeMap.js`. Silver KR Proof queries now resolve correctly.

**Remaining gap -- no proof Type entries exist for:**
- Gold Krugerrand (all weights) -- no proof Type, no year-specific proofs found
- Kookaburra -- no proof entries at all in Greysheet catalog
- Philharmonic (silver & gold) -- no proof entries at all
- Gold Maple Leaf -- no proof Type (Silver Maple Leaf Proof exists at 396685)

**Remaining fix (year-specific fallback):** When `fetchTypePrice()` detects a proof finish but no proof GSID is mapped, and the query includes a year:
1. Look up the year-specific proof GSID via `GetPricingRequest`
2. If found, use year-specific proof pricing instead of falling through to MS Type
3. If no year provided, use the MS Type entry (current behavior) with a warning flag

**Trade-offs:** Requires year in query for proof pricing; yearless proof queries remain imprecise. Some series (Kookaburra, Philharmonic) may never have proof data in Greysheet.

**Files:** `greysheetService.js` (`fetchTypePrice`), `greysheetTypeMap.js`

---

## Scraper Performance

### ~~#200. Sort-Skip Optimization in Terapeak Scrapers [DONE]~~

Both `terapeak-export.py` and `sales-aggregator.py` now skip re-sorting when the "Date sold" column is already confirmed descending. A module-level `_sort_confirmed` flag persists across pages; validated by date-order check after CSV write. Resets on browser recycle, bot-block, or crash recovery.

**Merged:** `d08f63a` (May 18)

---

## Infrastructure & Automation

### #201. Admin User Role System [MEDIUM]

**Problem:** Admin access is purely API-key based (shared secret via `ADMIN_API_KEY` env var). No per-user admin distinction, no audit trail by userId, no granular permissions. The API key is all-or-nothing and cannot identify which user performed an admin action.

**Fix:**
1. Add `role` field to user accounts in `authService.js` (default `'user'`, option `'admin'`)
2. Add `requireAdminRole` middleware that accepts either `x-api-key` OR a valid JWT with `role=admin` (hybrid -- backwards compatible)
3. Seed a master admin account on first startup (or via CLI/env var: `ADMIN_USERNAME` + `ADMIN_PASSWORD`)
4. Admin tab supports both unlock methods: API key entry OR login with an admin-role account
5. Audit log admin actions with `userId` when JWT-based auth is used

**Trade-offs:** Hybrid approach keeps existing API-key flow working (CLI scripts, CI) while adding per-user admin auth for the browser UI. Migration: existing accounts default to `role='user'`; promote via CLI or env seed.

**Files:** `authService.js`, `server.js` (middleware), `authRoute.js` (optional promote endpoint), `public/index.html` (admin tab login option)

---

### 114. Cookie Blob Persistence [MEDIUM]

**Problem:** eBay cookies expire when codespace restarts. Manual CAPTCHA solve required every session.

**Fix:**
- Save `cache/ebay_cookies.json` to Azure Blob on successful login
- Restore on codespace start
- Sessions last 24-48h, skip re-login if fresh
- Reduces CAPTCHA frequency from every session to every 24-48h

**Files:** `scripts/terapeak-export.py`, `scripts/vnc-login.py`, new blob upload/download helper

---

### 115. GitHub Actions Scheduled Aggregation [LOW -- long-term]

**Problem:** Scraping requires manual codespace start + CAPTCHA. Automating the non-CAPTCHA parts reduces friction.

**Design:**
- Weekly cron starts codespace, restores cookies from blob, checks validity
- Valid cookies: auto-runs stale refresh, commits, pushes, stops codespace
- Expired cookies: sends push notification (GitHub Mobile / Slack) for CAPTCHA
- Only manual part is 30-second CAPTCHA solve when cookies expire

**Depends on:** #114 (Cookie Blob Persistence)

---

### ~~116. Add Test + Lint Gate to CI Pipeline [DONE]~~

Split CI workflow into `test` + `deploy` jobs. Test job runs full `npm ci` + `npm test`; deploy depends on test passing. Lint step deferred to #118.

**Commit:** `9738bda` (May 12)

---

### ~~117. Enable Branch Protection on main [DONE]~~

Classic branch protection rule added: require `test` status check, require PR before merging (0 approvals), require up-to-date branches, block force-push and deletions.

**Configured:** May 12 (GitHub Settings)

---

### ~~118. Add ESLint Configuration [DONE]~~

Installed ESLint with flat config (`@eslint/js` recommended rules, CommonJS sourceType, Node/Jest globals). Added `npm run lint` script. Fixed all blocking errors: `const` reassignment bug in `numistaService.js`, 5 duplicate keys in `mintages.js`. 83 `no-unused-vars` warnings remain (non-blocking).

**Merged:** PR #2 (May 12)

---

### ~~119. Add Dependency Security Scanning to CI [DONE]~~

Added `npm audit --audit-level=high` step to CI (xlsx excluded -- unmaintained, no fix). Added `dependabot.yml` for weekly npm + GitHub Actions scanning. Upgraded axios 1.15→1.16, express-rate-limit updated. Added `pull_request` trigger to CI workflow so checks run on PRs.

**Merged:** PR #1 (May 12)

---

### 120. Structured Logging [LOW -- long-term]

**Problem:** All logging is raw `console.log`/`console.warn` across 10 services and 9 routes. No structured format, no log levels, no correlation IDs. Production debugging requires Azure log stream with manual grep.

**Fix:**
- Adopt `pino` (fast, JSON-structured, low overhead)
- Add request correlation ID middleware (X-Request-ID header)
- Replace `console.*` calls incrementally (service-by-service)
- Configure Azure App Service to ingest JSON logs

**Files:** All service + route files, new `src/utils/logger.js`

---

### 121. Wire Copilot Agents to CI [LOW -- long-term]

**Problem:** 12 Copilot agents exist (security review, code review, pre-commit) but only run on manual invocation. No automated trigger on PR creation.

**Fix:**
- Add GitHub Actions workflow triggered on `pull_request` that invokes Copilot code review
- Leverage `security-review.sub.agent.md` + `code-reviewer.approval-gated.agent.md` via Copilot PR review
- Evaluate GitHub Copilot for PRs (auto-review) as alternative to custom workflow

**Files:** `.github/workflows/` (new workflow), agent configs

---

## Completed (reference)

| # | Item | Commit |
|---|------|--------|
| S0 | Active Listings Guard | Tab check + date validation in both aggregation scripts |
| S1 | Finish Page 1 remaining | Mostly done; 157 remaining are Royal Mint Lunar (no Terapeak data) |
| S3 | Refresh Stale >30d | `0d6c814` -- 1/42 succeeded (all Royal Mint Lunar = no data on eBay) |
| S6 | Dashboard Gold Bullion & Bars categories | May 2026 -- stale split into gold/bars/low-vol/barber |
| S7 | Low-Volume Coin Dashboard Filter | May 2026 -- evidence index (464 flagged), dashboard menu [6] |
| S8 | Barber Non-Half Dashboard Filter | May 2026 -- `is_barber_nonhalf_term()`, dashboard menu [7] |
| P0-A | MintMismatch over-filtering (over-mintmark) | `a1e02ca` -- matchAll + over-mintmark detection |
| P0-B | Batch route missing year in keywords | `a1e02ca` -- pass year/mint into buildKeywords |
| 171 | Gold Libertad pipeline leak (99% attrition) | May 6 -- metal exclusion keywords + historical meltFloor |
| 172 | Krugerrand 93% weight attrition | May 6 -- same as #171 |
| 180 | AGE Type 1/Type 2 disambiguation | May 6 -- parseDescription + typeMismatch filter |
| 91 | Morgan grade-specific datasets (288 CSVs) | Stubs created + scraped |
| 111 | Admin Portal | `public/admin.html` + `/api/admin/*` endpoints |
| 112 | Staleness Tracker Endpoint | `GET /api/admin/stale-datasets` |
| 113 | One-Click Refresh Script | `scripts/refresh-stale.sh` |
| 178 | Gold coins attrition (metal exclusion + historical meltFloor) | May 2026 -- `buildKeywords` + `getSpotOnDate()` |
| 181 | Cross-route FMV delta (centralized half-life) | May 2026 -- `valuationService.js` |
| 182 | Slabbed proof classification fix | May 2026 -- `classifyGradeType()` proof check |
| 183 | DCAM/CAM designation scoring | May 2026 -- `scoreMatch()` +10/-15 |
| 184 | Block proof-to-BU fallback | May 2026 -- proof pool unconditional |
| 200 | Sort-skip optimization in Terapeak scrapers | `d08f63a` -- `_sort_confirmed` flag skips re-sort |
| 21 | Batch pricing in My Coins | `my-coins.js` `_fetchPricing` (chunks of 25) |
| 22 | Event delegation | `my-coins.js` `_setupDelegation()` |
| 23 | Client-side spot cache | `my-coins.js` 5-min `SPOT_CACHE_TTL` |
| 11-20 | Code review findings (April 2026) | All resolved -- see README "Recent Changes" |
| 1-10 | Account features, labels, agents | All done |
