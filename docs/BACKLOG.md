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

### ~~S2a. Apply Low-Signal Exclusions to Deep-Needed Candidate List [DONE]~~

Added three opt-in query params to `GET /api/terapeak/aggregation-status`:
- `excludeLowVolume=1` -- drops datasets flagged `identifiers.is_low_volume_candidate` (S7)
- `excludeBarberNonHalf=1` -- drops Barber quarter/dime/dollar datasets (S8)
- `excludeNoData=1` -- drops datasets with `aggregationMeta.noDataAt` stamped (Terapeak empirically empty)

Response `summary.excluded` now reports per-filter drop counts. `scripts/sales-aggregator.py` defines `DEEP_NEEDED_EXCLUDE_PARAMS` and passes all three on every `needs=deep` query (candidate fetch + both dashboard variants). All 294 terapeak tests still pass.

**Files:** `src/routes/terapeakRoute.js`, `scripts/sales-aggregator.py`

---

### ~~S2b. Page 2+ Deep Pagination [DONE]~~

After S2a went in and the candidate list was re-measured (2026-05-31), only **1 dataset** remained: `2011 china tenth oz gold panda` (50 comps, bullion, not low-volume). 1308 datasets are deep-aggregated; the historical "165 remaining" figure was stale. Treating S2b as effectively complete -- the single straggler can be picked up in a normal stale-refresh pass.

**Verification:** `curl -H "x-api-key: $KEY" "http://localhost:3000/api/terapeak/aggregation-status?needs=deep&minComps=50&excludeLowVolume=1&excludeBarberNonHalf=1&excludeNoData=1"` -> 1 dataset.

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

**Status (May 2026):** Stubs created and partially populated. 89 empty stubs remain (84 Gold Eagle fractional, 4 Gold Libertad, 1 Gold Panda). Populated: 50 Gold Libertad, 59 Gold Panda, 43+ Gold Eagle 1oz, 79-80 each fractional. Re-verified May 31, 2026 -- some year-specific files exist (e.g., `2024_Mexican_Gold_Libertad_1oz.csv`) but full coverage incomplete.

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

### ~~#186. Bulk Lot Evaluator FMV Divergence from Price Discovery [DONE]~~

Fixed: `evaluateOneCoin()` in `bulkEvaluateService.js` now matches price discovery config -- `timeWindowDays: 180`, `maxPages: 3`, `usMinComps: 8` (3 for rolls). `expected.metal` is set explicitly from `parsed.metal || detectedMetal` before the `fetchSoldComps` call. All four divergences from the original table are resolved.

**Files:** `src/services/bulkEvaluateService.js` (`evaluateOneCoin`)

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

### #185. World Proof Greysheet Year-Specific Fallback [LOW]

**Problem:** When a proof query has no mapped Type GSID, the Greysheet blend falls through to the MS Type entry, producing MS wholesale instead of proof pricing.

**Background:** Catalog walks (verified 2025-01-27 and 2026-04-19, recorded in `greysheetTypeMap.js`) confirm Greysheet has **no proof Type entries** for: Gold Krugerrand (all weights), Kookaburra, Philharmonic (silver + gold), Gold Maple Leaf. These cannot be fixed by adding map entries -- the upstream data does not exist. Silver Krugerrand Proof (GSID 373710) is already mapped.

**Remaining work:** Year-specific proof fallback in `fetchTypePrice()`. When a proof finish is detected, no proof GSID is mapped, and the query includes a year:
1. Look up the year-specific proof GSID via `GetPricingRequest`
2. If found, use year-specific proof pricing instead of MS Type
3. If no year, keep MS Type behavior but flag as imprecise

**Trade-offs:** Helps only when (a) a year is present and (b) Greysheet has the specific year's proof. Kookaburra / Philharmonic may yield nothing even with a year. Low expected hit-rate -- consider closing as WONTFIX if proof-blend coverage becomes adequate from eBay/Terapeak comps alone.

**Files:** `src/services/greysheetService.js` (`fetchTypePrice`)

---

## Scraper Performance

### ~~#200. Sort-Skip Optimization in Terapeak Scrapers [DONE]~~

Both `terapeak-export.py` and `sales-aggregator.py` now skip re-sorting when the "Date sold" column is already confirmed descending. A module-level `_sort_confirmed` flag persists across pages; validated by date-order check after CSV write. Resets on browser recycle, bot-block, or crash recovery.

**Merged:** `d08f63a` (May 18)

---

## Infrastructure & Automation

### ~~#201. Admin User Role System [DONE]~~

Delivered in PR #60 (`774f136 feat(auth): admin role + audit log + login hardening`) plus PR #61 (`4f5341b feat(audit): auto-provision Cosmos admin-audit container`). `authService.js` exposes `grantAdmin`/`revokeAdmin`/`listAdmins`, `isAdmin` flag on accounts and tokens, `middleware/requireAdminOrKey.js` accepts JWT-with-admin or `x-api-key`, `server.js` L195-209 bootstraps from env, `scripts/grant-admin.js` CLI, audit log writes username/userId for JWT path. Tests in `__tests__/authServiceAdmin.test.js`.

**Deferred follow-ups tracked separately:** #216 (self-service UI), #218-224 (S3/S4 review findings).

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

## Numismatic Data Gaps

Items below were tracked only in repo memory until now. Imported May 31, 2026 during backlog reconciliation. Numbers preserved from memory unless noted.

### 43. Clad Kennedy Half Dollars (1971-2024) [P2]

**Problem:** Zero Terapeak coverage for clad Kennedys. Only 1964 (90% silver) and 1970-D (40% silver) have data.

**Fix:** Scrape generic clad Kennedy file plus key dates (1972 no FG, 1976 bicentennial, proof-only years).

---

### ~~44. 40% Silver Kennedy D-Mints (1968-D, 1969-D) [DONE]~~

Both `data/terapeak/1968-D_Kennedy_Half_Dollar_40_Silver.csv` and `data/terapeak/1969-D_Kennedy_Half_Dollar_40_Silver.csv` exist. Verified May 31, 2026.

---

### 45. Walking Liberty Common Dates [P3]

**Problem:** Key dates covered (1916, 1916-S, 1919-D, 1921 all mints, 1938-D). Many common dates (1917-1939) lack year-specific files. Generic file only 27 rows.

**Fix:** Scrape common-date year-specific files; refresh generic with broader terms.

---

### ~~46. Franklin Half Dollar D/S-Mint Gaps [DONE]~~

`data/terapeak/` now has 1948-D through 1952-D (and beyond), plus 1948-S, 1950-S, 1951-S, 1952-S files. Coverage gap closed. Verified May 31, 2026.

---

### 47. Barber Half/Quarter/Dime Generics [P3]

**Problem:** Generic files nearly empty (2-5 rows).

**Fix:** Fresh scrapes for Barber Half, Quarter, and Dime generics with refined search terms.

---

### 48. Mercury Dime Generics [P3]

**Problem:** Generic file only 34 rows. Common dates lack year-specific files.

**Fix:** Generic refresh + common date year-specifics (covered by #72 done for some years).

---

### 49. Washington Quarter Silver Generics [P3]

**Problem:** Generic file only 27 rows. Only key dates (1932-D, 1932-S) have dedicated files.

**Fix:** Generic refresh + common-date files (partially covered by #73).

---

### 83. Gold Page 2 Enrichment for Existing 50-Row CSVs [P2]

**Problem:** 8 gold coins qualify for page-2 deep pagination now: 1986 AGE 1oz, 2024 AGE 1/10oz, 2025 AGE 1oz/1/10oz, AGE Generic 1oz/1/10oz, Gold Libertad Generic 1oz/1/2oz.

**Fix:** `python3 scripts/terapeak-page2.py --run --filter "Gold"`.

---

### 84. Gold Page 2 for New CSVs from S5 [P3]

**Problem:** Any year-specific gold CSV from S5 (Gold Libertad/Panda/Eagle) that crosses 50 rows needs page-2 follow-up.

**Fix:** Run after S5 page-1 scrapes complete.

**Depends on:** S5

---

### 226. Gold Libertad Year-Specific Re-Scrape -- Thin Comp Data [P2]

> Originally memory #185 -- renumbered to avoid collision with backlog #185 (World Proof Greysheet Fallback).

**Problem:** Gold Libertad year-specific datasets have <10 gold comps surviving after metal/weight filtering. 2019 hits 100% attrition; most others 93-96%. Pipeline-leak + browseOnly for worst cases.

**Evidence:** pricing-health Libertad run May 9, 2026. RED: 2024 (95.5%), 2023, 2022, 2019, 2016 (95.7%), 1992 (93.8%).

**Fix:** Re-scrape with gold-specific search terms (e.g., "2024 Gold Libertad 1 oz" instead of "2024 Libertad 1 oz"). Target 20-50 gold-only comps per year.

**Scope:** ~45 year-specific CSVs.

**Related:** S5 (gold year-specific stubs), #178 (gold attrition -- DONE)

---

### 227. Silver Libertad Proof Year-Specific Re-Scrape -- Thin Comp Data [P2]

> Originally memory #186 -- renumbered to avoid collision with backlog #186 (Bulk Evaluator FMV Divergence -- DONE).

**Problem:** Silver Libertad Proof datasets mix BU and Proof comps; variant filter removes BU leaving 3-4 proof comps. Pipeline-leak + browseOnly for worst cases.

**Evidence:** pricing-health Libertad run May 9, 2026. RED: 2013 (90.3%), 2022, 2010, 2009, 2011 (91.7%). 13 more YELLOW.

**Fix:** Re-scrape with proof-specific terms (e.g., "2013 Silver Libertad 1 oz Proof"). Target 15-40 proof-only comps per year.

**Scope:** ~25 proof year CSVs.

**Related:** #109 (Greysheet proof support -- DONE), #24 (proof Libertad search term quality)

---

## Pricing Accuracy -- Additional Open Items

### ~~168. ASE Type 1 -- 97% yearMismatch Attrition [DONE]~~

`data/terapeak/2021_American_Silver_Eagle_Type_1.csv` exists -- Type 1 / Type 2 disambiguation dataset is in place. Combined with #165 (yearMismatch relaxation) and #180 (Type variant detection), root cause closed. Verified May 31, 2026.

---

### ~~170. 1870-CC Seated Liberty Half -- Suspect $29 FMV [DONE -- data gap closed]~~

Dedicated `data/terapeak/1870-CC_Seated_Liberty_Half_Dollar.csv` exists; `src/data/keyDates.js` L131 has `{ series: 'seated liberty half dollar', year: 1870, mint: 'CC', tier: 'key' }` ensuring key-date weighting. Verified May 31, 2026.

**Note:** If a $29 FMV symptom reappears post-data, file as a new pricing item (likely filter regression, not data).

---

### ~~#184. American Platinum Eagle 1oz Cross-Route FMV Divergence [DONE]~~

Platinum metal detection wired through the shared pipeline: `coinMetalProfile.js` recognizes Platinum Eagle (verified by `__tests__/coinMetalProfile.test.js`), `applyFilters.test.js` L579 confirms `detectMetalFromTitle('2024 American Platinum Eagle 1 oz') === 'platinum'`, and `buildKeywords` adds `-silver -gold` exclusions for platinum series (`__tests__/coinSearch.ebayKeywords.test.js` L199). Both routes now share the same metal detection path.

**Follow-up (optional):** Add an explicit Platinum Eagle row to `crossRouteConsistency.test.js`. Track as a separate item if regression risk warrants.

---

### ~~225. Normalize "Suisse" Out of PAMP Brand Before Tokenization [DONE]~~

`src/data/barSeries.js` L95: `const key = brand.toLowerCase().replace(/\s+suisse$/i, '');` -- trailing "Suisse" stripped before lookup/tokenization. Verified May 31, 2026.

---

## Scraper Performance -- Additional Open Items

### 198. Smart SPA Render Wait Instead of 3s Hard Pause [P3]

**Problem:** Both scraper flows use a fixed `time.sleep(3)` after `networkidle`.

**Fix:** Wait for the result-table selector with bounded timeout; keep the sleep as fallback.

**Files:** `scripts/terapeak-export.py`, `scripts/sales-aggregator.py`

**Acceptance:** Measurable per-page latency reduction, no increase in extraction failures.

---

### 199. Increase Browser Recycle Interval From 40/80 to 120 [P3]

**Problem:** Current recycle thresholds (40 in terapeak-export, 80 in sales-aggregator) trigger restart overhead more often than memory pressure requires.

**Fix:** Profile RSS during long runs; raise to 120 only if stability holds.

**Files:** `scripts/terapeak-export.py`, `scripts/sales-aggregator.py`

---

### 228. Page 1 Refresh Run -- Libertads, ASEs, Perth Lunars [P1]

> Originally memory #183 -- renumbered to avoid collision with backlog #183 (Designation-Aware Comp Scoring -- DONE).

**Problem:** Three highest-volume bullion series age quickly. New sold listings appear daily and aren't in current page-1 data.

**Fix:** Run aggregator in page-1 mode (no `--min-rows`, no deep pagination) for:
- Libertads (~131 datasets, ~12.4K comps)
- American Silver Eagles (~51 datasets, ~7.5K comps)
- Perth Lunars (~173 datasets, ~8.5K comps)

**Execution:** `python3 scripts/sales-aggregator.py --filter "Libertad"` then repeat for ASE / Lunar.

**Scope:** ~355 datasets, ~4-5 hours total.

**Status notes:** Commit `567dc17` (May 30) refreshed 122 datasets as part of a general loop run, NOT the targeted 355-dataset sweep this item requires. Still open.

---

## Tooling & Observability

### ~~177. Holdout Validation Test -- FMV vs Actual Sales [DONE]~~

Implemented as `__tests__/holdoutValidation.test.js` with `holdoutSplit` + IQR comparison. Verified May 31, 2026.

---

### ~~187. Bar Pricing Health Check Script [DONE]~~

`scripts/bar-pricing-health.js` exists with 50+ test cases and melt-floor assertions. Verified May 31, 2026.

---

### ~~190. Classification Audit Agent [DONE]~~

`.github/agents/numismatic-audit.agent.md` exists. Verified May 31, 2026.

---

### ~~191. Pricing Regression Audit Tool [DONE]~~

`scripts/pricing-regression.js` exists with golden coin set, drift checking, and baseline comparison. Verified May 31, 2026.

---

### ~~192. Filter Correctness Audit Tool [DONE]~~

`scripts/classification-audit.js` exists. Verified May 31, 2026.

---

### 193. Historical FMV Drift Monitor [P3]

**Problem:** No automated detection of unexpected FMV drift on stable coins.

**Fix:** Maintain `cache/fmv-snapshots.json` with weekly FMV for 20 benchmark coins. Weekly cron re-prices all 20; flags bullion drift >5% beyond spot movement, numismatic drift >15% with no data change. Distinguish "expected drift" (spot moved) from "suspicious drift" (code/data change).

**File:** `scripts/fmv-drift-monitor.js`

**Related:** #177, #191

---

### ~~195. RRV (Retail Replacement Value) Calculation Mode [DONE]~~

`src/services/valuationService.js` L354-368 computes `rrv` from Greysheet CPG retail when available, falls back to spread-derived markup or default 20%. Returned in valuation payload at L421. Verified May 31, 2026.

---

### 196. Dealer Premium Benchmark Table for Bullion Anomaly Detection [P3]

**Problem:** No reference table of normal dealer premiums by metal/weight to flag abnormal FMV outputs.

**Fix:** Add benchmark table; pricing-health / regression diagnostics use it to explain premium outliers.

**Files:** new data constants/reference table, pricing health scripts.

---

## PCGS World Coin Number Extraction

Tracked from May 2026 audit. All depend on Pop Report extraction; some pages use JS-rendered links requiring Playwright or backward-search workarounds.

### ~~206. Kookaburra 2006-2025 PCGS Numbers [DONE]~~

Full 1992-2026 series populated in `src/data/pcgsNumbers.js` (`AUSTRALIA_KOOKABURRA_SILVER`, lines 477-494). Verified May 31, 2026.

---

### ~~207. Krugerrand 1oz Gold PCGS Numbers [DONE]~~

1967-2026 populated in `SOUTH_AFRICA_KRUGERRAND_GOLD` (lines 497-522). Some years (1986, 1992, 1996, 1997, 2001, 2003, 2006) intentionally missing -- not in PCGS pop report.

---

### ~~208. Kangaroo 1oz Silver PCGS Numbers [DONE]~~

1993-2026 populated in `AUSTRALIA_KANGAROO_SILVER` (lines 524-542). 2012 and 2014 intentionally absent -- not in pop report for base silver coin.

---

### ~~209. Maple Leaf Silver PCGS Numbers [DONE]~~

1988-2026 populated in `CANADA_SILVER_MAPLE_LEAF` (lines 544-563).

---

### ~~210. Britannia Silver PCGS Numbers [DONE]~~

1998-2026 populated in `GREAT_BRITAIN_BRITANNIA_SILVER` (lines 565-582).

---

### ~~211. Philharmonic Silver PCGS Numbers [WONTFIX]~~

**Resolution (May 31, 2026):** PCGS does not appear to maintain a pop-report category for Vienna Philharmonic Silver -- no portal entry, no reverse-lookup path from cert numbers yielded a series. Closed as WONTFIX; revisit if PCGS adds tracking. Other world bullion proceeds without this entry.

---

### ~~212. Panda Silver PCGS Numbers [DONE]~~

1989-2026 populated in `CHINA_PANDA_SILVER` (lines 585-606). Weight changed from 1 oz to 30g in 2016 -- noted in source comment.

---

### ~~213. Lunar Silver (Perth) PCGS Numbers [DONE]~~

All three Perth Lunar series populated:
- `AUSTRALIA_LUNAR_HALF_OZ` 1999-2026 (lines 631-647)
- `AUSTRALIA_LUNAR_SILVER` 1oz 1999-2026 (lines 650-666)
- 2oz series also present in same file

Also includes `CHINA_LUNAR_SILVER` (1997-2011) for completeness.

---

### ~~214. Enable APR Prefetch for World Coins [DONE]~~

**Root cause:** `extractAllPcgsNumbers()` in `src/services/prefetchScheduler.js` matched `:\s*(\d{3,5})\b` -- a regex that silently skipped every 6-7 digit PCGS number. All world bullion series (Kookaburra 114425, Krugerrand 564601, Maple Leaf 1004509, Britannia 1001434, Panda 1000705, Perth Lunar 170456, etc.) were excluded from the nightly queue even though they were present in `pcgsNumbers.js`.

**Fix (May 31, 2026):** Changed regex to `\d{3,7}` in `src/services/prefetchScheduler.js` lines 113-127. Queue size jumps from 745 → 1243 distinct PCGS numbers (+498 world bullion entries from #206-#210, #212, #213). #211 (Philharmonic) closed WONTFIX; no longer a blocker.

**Test:** `__tests__/prefetchScheduler.test.js` -- new `world bullion extraction (#214)` suite asserts seven sample 6-7 digit PCGS numbers reach the extractor. All 14 tests pass.

**Capacity note:** ~498 new numbers × 11 grades ≈ 5,478 new combos; at ~990 calls/night the full first-pass world bullion sweep completes over ~5-6 nights, then settles into normal refresh cadence.

---

### ~~215. Review/Merge/Close Stale Open PRs [DONE]~~

All four PRs already merged on 2026-05-25, six days before this backlog item was imported. Verified via `gh pr list`:
- #18 MERGED 2026-05-25 23:20 UTC (`185-world-proof-type-map-wontfix`)
- #19 MERGED 2026-05-25 23:20 UTC (`184-proof-pool-isolation-tests`)
- #32 MERGED 2026-05-25 23:48 UTC (`feature/perth-mint-expansion`)
- #38 MERGED 2026-05-25 23:46 UTC (`feat/dry-refresh-backoff`)

Current repo state: 63 total PRs, **0 open**. Item was stale-imported; root cause tracked in INC-009.

---

## Infrastructure -- Additional Open Items

### 100. Shared Rate Limiting With Azure Cache for Redis [P2]

**Problem:** `express-rate-limit` uses in-memory store -- per-process, lost on restart. Multi-instance App Service would multiply the allowed rate.

**Fix:** Swap to `rate-limit-redis` backed by Azure Cache for Redis (Basic C0, ~$15/mo). Also useful for shared TTLCache (eBay, PCGS) if scaling beyond one instance.

---

### 101. Run Playwright Scraping in Azure Container Instances [P2]

**Problem:** Three scrapers (`terapeak-export.py`, `terapeak-page2.py`, `vnc-login.py`) need headful Chromium + manual CAPTCHA.

**Fix:** Dockerfile with Chromium + Xvfb + websockify + noVNC + Python + Playwright. ACI starts on-demand, browser-accessible for CAPTCHA, auto-stop. ~$0.04/hr running.

---

### 102. Schedule Scraping With Azure Logic Apps [P3]

**Problem:** ACI lifecycle (#101) still needs a scheduler.

**Fix:** Logic App or Azure Functions Timer trigger starts ACI at configured intervals. Manual CAPTCHA still required when cookies expire.

**Depends on:** #101

---

### 103. Alternative -- Azure VM (B1s) for Scraping [P3]

**Problem:** Alternative to #101/#102 for high-frequency scraping.

**Fix:** $7/mo always-on Linux VM with VNC; cron jobs for scheduled scraping. Simpler than ACI lifecycle.

---

### 104. Azure CDN / Front Door for Static Assets [P3]

**Problem:** `public/` served via Express static middleware on every request.

**Fix:** Azure CDN or Front Door for edge caching of static assets; reduces App Service load.

**Why low priority:** Current traffic doesn't warrant it.

---

### ~~182. Sales Aggregator -- Target Azure Directly Instead of Local Server [DONE]~~

`scripts/terapeak-export.py` defines `APP_URL = os.environ.get("APP_URL", "http://localhost:3000")` and `sales-aggregator.py` imports the same via `_mod.APP_URL`. Setting `APP_URL=https://<app-service>` directs all admin API traffic at production Cosmos + Azure Files. Verified May 31, 2026.

---

### 216. Self-Service Admin Management UI [P2]

**Problem:** PR #60 (feat/admin-role) ships with env-var bootstrap + `scripts/grant-admin.js` CLI. CLI is fine for emergency recovery, inconvenient for day-to-day onboarding/offboarding.

**Fix:**
- Backend: `GET /api/admin/users`, `POST /api/admin/users/:username/grant-admin`, `.../revoke-admin`, `.../reset-password` (one-time temp password). Routes reuse CLI primitives.
- Self-revoke guard: cannot revoke own admin if last admin.
- Frontend: "Admin Users" section in Admin tab with list table + actions.
- Audit log entries (already covered by PR #60 audit infra).

**Out of scope:** invite-by-email, MFA enrolment UI.

**Depends on:** #201 (admin role system)

**Files:** new `src/routes/adminUsersRoute.js`, `authService.js`, `public/index.html`, tests.

---

### 218. verifyTokenStrict TTL Cache [P3]

**Problem:** Strict admin verification hits Cosmos on every admin request.

**Fix:** Small in-memory LRU keyed by username with ~5s TTL. Must invalidate on grant/revoke/changePassword/resetPassword/deleteUser. Gate behind perf observation first.

**Source:** PR #60 deferred S3#5

---

### 219. Audit Debounce / Sample on Chatty Endpoints [P3]

**Problem:** Per-request audit writes could become noisy in prod.

**Fix:** Once we have volume data, sample `admin-key-use` and `admin-denied` (e.g. 1-in-N). NEVER sample `bootstrap-admin`, `grantAdmin`, `revokeAdmin`, `token-invalid`.

**Source:** PR #60 deferred S3#6

---

### 220. listAdmins Cosmos Query [P3]

**Problem:** Today reads file mirror only. If Cosmos is enabled and the file mirror is rebuilt from scratch, listAdmins would miss admins until each is re-saved.

**Fix:** Switch to `SELECT * FROM c WHERE c.isAdmin = true` when `cosmos.isEnabled()`, fall back to file otherwise. Mirror-always (PR #60 S2#1) softens the risk.

**Source:** PR #60 deferred S3#7

---

### 221. Case-Insensitive Bearer Scheme [P4]

**Problem:** RFC 6750 says auth scheme is case-insensitive; we currently match `/^Bearer /`.

**Fix:** Switch to `/^Bearer /i`.

**Source:** PR #60 deferred S4#9

---

### 222. HMAC-Then-timingSafeEqual for ADMIN_API_KEY [P3]

**Problem:** `_timingSafeKeyMatch` bails on length mismatch -- still constant-time within equal-length compare but leaks length.

**Fix:** HMAC-SHA256 over both inputs before compare; cheap defense-in-depth.

**Source:** PR #60 deferred S4#10

---

### 223. Per-Username Login Throttle [P2]

**Problem:** express-rate-limit on `/login` is per-IP only; doesn't defeat low-and-slow password spray across rotating IPs.

**Fix:** Small in-memory LRU per-username bucket + Cosmos write on lockout. Tie into audit log.

**Source:** PR #60 deferred S4#13

---

### 224. Admin Chip Styles to CSS Class [P4]

**Problem:** Frontend Admin chip uses inline styles.

**Fix:** Move to `.admin-chip` class in shared stylesheet.

**Source:** PR #60 deferred S4#15

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
| 186 | Bulk evaluator FMV divergence (config alignment + expected.metal) | May 2026 -- `bulkEvaluateService.js` matches price discovery config |
| S2a | Low-signal exclusions on deep-needed candidate list | May 2026 -- `excludeLowVolume`/`excludeBarberNonHalf`/`excludeNoData` params |
| S2b | Page 2+ deep pagination | May 2026 -- 1308 datasets deep, 1 candidate remaining (2011 1/10 oz Gold Panda) |
| 200 | Sort-skip optimization in Terapeak scrapers | `d08f63a` -- `_sort_confirmed` flag skips re-sort |
| 21 | Batch pricing in My Coins | `my-coins.js` `_fetchPricing` (chunks of 25) |
| 22 | Event delegation | `my-coins.js` `_setupDelegation()` |
| 23 | Client-side spot cache | `my-coins.js` 5-min `SPOT_CACHE_TTL` |
| 11-20 | Code review findings (April 2026) | All resolved -- see README "Recent Changes" |
| 1-10 | Account features, labels, agents | All done |
