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

### S4. Refresh Stale 14-30 Days [MEDIUM -- defer after S2]

**Problem:** ~1,031 CSVs older than 14 days. Many are high-volume coins worth refreshing (Morgans, ASEs, etc.) unlike the >30d batch which was all low-volume Lunar coins.

**Command:** `python3 scripts/terapeak-export.py --run --refresh --max-age 14 --limit 100`

---

### S5. Gold Year-Specific CSVs [HIGH -- data gap]

**Problem:** Gold Libertad, Gold Panda, and Gold Eagle all lack year-specific datasets. Gold queries hit mixed-metal generic datasets causing 95-99% attrition.

| Series | Gap | Files Needed |
|--------|-----|-------------|
| Gold Libertad (1981-2025) | Only 2 generics + some year-specific exist but need refresh | ~45 |
| Gold Panda (1982-2025) | Only 1 generic; no year-specific | ~44 |
| Gold Eagle (gaps in 1oz; missing 1/2, 1/4, 1/10) | ~30 years 1oz, ~38 each fractional | ~130 |

**Command:** `node scripts/create-grade-datasets.js` for stubs, then `python3 scripts/terapeak-export.py`

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

### #167. Graded Morgan Cross-Route FMV Divergence [HIGH]

**Problem:** Graded Morgan queries show 30-90% FMV delta between Discovery and Batch routes. Root cause: when user queries "1881 Morgan MS65" (no mint), PCGS lookup resolves to a specific mint mark, activating `mintMismatch` filter which removes most comps.

**Status:** Primary fix verified in place (both routes use `parsed.mint` from user input only). Remaining divergence may stem from grade pool thin-data cascade -- when graded pool is thin, pool fallback uses raw pool (median ~$40 for a $300+ MS65).

**Remaining work:** Add "no mint in query" test cases to `crossRouteConsistency.test.js`. Long-term fix: grade-specific datasets (#91 DONE) provide grade-matched pools.

---

### #166. lowRelevance Over-Filtering on 30g Pandas [MEDIUM]

**Problem:** 2020/2024 30g Pandas lose 71-83 comps to `lowRelevance`. The "30g" weight descriptor not recognized as ~0.9645 troy oz.

**Fix:** Ensure `detectWeightFromTitle` recognizes "30g" / "30 gram" as valid weight. A "30g Silver Panda" listing should score high relevance.

**Files:** `ebayService.js` (detectWeightFromTitle, relevance scoring)

---

### #178. Gold Coins 95-99% Attrition in Mixed-Metal Datasets [MEDIUM]

**Problem:** Gold coins stored in silver-dominated datasets (e.g., generic "Libertad") lose almost all comps to metal filters.

**Fix:** Addressed by #171 (metal exclusion keywords + historical meltFloor). Long-term: gold-specific datasets (S5 above).

---

### #181. 2025 ASE Cross-Route FMV Delta (14.7%) [MEDIUM]

**Problem:** "2025 American Silver Eagle" shows $36.40 (Discovery) vs $41.76 (Batch). Likely from lookback window and recency weighting differences.

**Fix:** Verify both routes use identical recency half-life settings. Consider date-weighted sampling.

---

## Infrastructure & Automation

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

### 118. Add ESLint Configuration [MEDIUM]

**Problem:** No linter configured anywhere. No style enforcement, no detection of unused variables, shadowed names, or common JS pitfalls.

**Fix:**
- Install `eslint` + `@eslint/js` (flat config)
- Start with `recommended` rules only (avoid style-only noise)
- Add `npm run lint` script to package.json
- Wire into CI (#116) once stable
- Run initial pass, fix blocking errors, suppress warnings for existing code

**Files:** `eslint.config.js`, `package.json`

---

### 119. Add Dependency Security Scanning to CI [MEDIUM]

**Problem:** 7 known vulnerabilities (3 high: axios, xlsx, fast-xml-builder). No automated detection -- vulns only found via manual `npm audit`.

**Fix:**
- Add `npm audit --audit-level=high` step to CI (fail on high/critical)
- Add `dependabot.yml` for automated PR creation on vulnerable deps
- Triage current vulns: upgrade axios, evaluate xlsx alternatives (SheetJS is unmaintained)

**Files:** `.github/workflows/main_coinpricefinder-h3a3b5g0dmdydna4.yml`, `.github/dependabot.yml`

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
| P0-A | MintMismatch over-filtering (over-mintmark) | `a1e02ca` -- matchAll + over-mintmark detection |
| P0-B | Batch route missing year in keywords | `a1e02ca` -- pass year/mint into buildKeywords |
| 171 | Gold Libertad pipeline leak (99% attrition) | May 6 -- metal exclusion keywords + historical meltFloor |
| 172 | Krugerrand 93% weight attrition | May 6 -- same as #171 |
| 180 | AGE Type 1/Type 2 disambiguation | May 6 -- parseDescription + typeMismatch filter |
| 91 | Morgan grade-specific datasets (288 CSVs) | Stubs created + scraped |
| 111 | Admin Portal | `public/admin.html` + `/api/admin/*` endpoints |
| 112 | Staleness Tracker Endpoint | `GET /api/admin/stale-datasets` |
| 113 | One-Click Refresh Script | `scripts/refresh-stale.sh` |
| 21 | Batch pricing in My Coins | `my-coins.js` `_fetchPricing` (chunks of 25) |
| 22 | Event delegation | `my-coins.js` `_setupDelegation()` |
| 23 | Client-side spot cache | `my-coins.js` 5-min `SPOT_CACHE_TTL` |
| 11-20 | Code review findings (April 2026) | All resolved -- see README "Recent Changes" |
| 1-10 | Account features, labels, agents | All done |
