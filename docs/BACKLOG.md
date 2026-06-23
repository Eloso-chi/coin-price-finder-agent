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

### ~~#202. Investigate Lot Evaluator Batch: Silver Libertad 1 oz (1985-2024) [DIAGNOSTIC SCRIPT SHIPPED]~~

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

**Status notes:** Added May 26, 2026 per user-reported Lot Evaluator batch. Diagnostic script shipped at `scripts/investigate-libertad-batch.js` — re-runs the 13-coin batch via `/api/price`, cross-checks each row against the dealer-premium band from #196, surfaces low-data/thin-comp/high-attrition rows, and flags duplicate-query FMV instability (>5% spread). Run with the server up: `node scripts/investigate-libertad-batch.js [--out cache/libertad-202.json]`. Findings will be appended when the script is executed against a live server.

---

### #233. Tier B Audience Gating -- Competitive Weighting Math [P3 -- DEFERRED]

**Problem:** #232 (Tier A) sanitized licensed dollar amounts (Greysheet/CPG) and source-brand attribution in public-facing valuation `explanation` text. Tier B covers *internal competitive weighting math* that still leaks today: dynamic grade-weight curves (#51), sliding buy spread tiers (#52), low-pop confidence penalty thresholds (#50), Greysheet blend weight schedule (5%/10%/15%/20% by comp count), and recency half-life constants. These reveal our proprietary scoring approach to scrapers/competitors.

**Why deferred:** Stripping them entirely would gut the explainability the UI relies on; need a design pass on a "summary-only" mode that preserves *narrative* (e.g. "high-comp count → minimal wholesale anchor") without exposing exact thresholds. Likely a follow-on to #232 once we observe what admins vs anonymous users actually need.

**Files (when picked up):** `src/services/valuationService.js`, plus any UI tooltip that currently surfaces these numbers.

---

### ~~#243. Terapeak Source-Label Redaction for Non-Admin Responses [SECURITY -- P1 -- DONE]~~

**Status (DONE):** Shipped on branch `fix/redact-terapeak-public`. Option A scope: rewrite `_source: "terapeak"` -> `"ebay-sold"` (and `source: "terapeak"` -> `"ebay-sold"` in `/api/coin-history`) for non-admin callers. Admins (JWT `isAdmin === true` or `x-api-key: ADMIN_API_KEY`) still see the real label for dealer/debug tooling.

**Problem (resolved):** Audit of an anonymous `POST /api/price` for `1882-S Morgan Silver Dollar` showed every entry in `ebay.us.comps[]` shipping `_source: "terapeak"` -- a provenance label that advertises our use of licensed eBay Seller Hub Research data. Across ~4,800 cached datasets this label was leaking on every public price request, every batch (`/api/pricing-batch`), every bulk-evaluate SSE/poll, every history chart, and every bar-price call.

**Fix:** New utility `src/utils/redactForPublic.js` (`redactCompsForPublic(response, isAdmin)`) wired into the response path of: `priceRoute`, `barPriceRoute`, `pricingBatchRoute`, `bulkEvaluateRoute` (SSE replay + GET poll + `_runJob` per-coin emit), and `coinHistoryRoute` (top-level `source` field). The utility shallow-clones `ebay.us`/`ebay.global` and each rewritten comp so the upstream `ebayService` TTL cache and `terapeakService` in-memory dataset cache are never mutated -- regression-tested explicitly (anon call followed by admin call still returns the real `"terapeak"` label to admin).

**Trade-offs accepted:**
- Public UI's `c._source === 'terapeak'` branch in `public/index.html` (lines 3389, 3597) becomes a no-op for anon viewers -- they see uniform "SOLD" badges instead of the distinct "TERAPEAK" badge. Admins still see the badge. Intentional.
- This is a label-only redaction. `itemId`, `url`, `title`, `totalUsd`, `soldDate` etc. are still shipped. If compliance ever escalates, two escalation paths are pre-scoped: **Option B** -- strip `itemId` + `url` from non-admin comps (lose deep-links but keep tabular comp data); **Option C** -- strip `comps[]` entirely for non-admin, return only aggregated `stats` (most defensible, biggest UX hit).

**Files:** `src/utils/redactForPublic.js` (new), `src/routes/priceRoute.js`, `src/routes/barPriceRoute.js`, `src/routes/pricingBatchRoute.js`, `src/routes/bulkEvaluateRoute.js`, `src/routes/coinHistoryRoute.js`, `__tests__/redactForPublic.test.js` (new, 11 cases incl. cache-poisoning regression), `__tests__/coinHistoryRoute.test.js` (assertion updated).

---

### #244. Reverse-Proof Morgan Dollar Pipeline-Leak [P2 -- TRIAGE] -- DONE 2026-06-04

**Status:** Telemetry gap fixed on `fix/244-prefilter-telemetry`. Root cause was the Terapeak pre-filter path in `ebayService.js` (lines ~1373-1407) -- the grade-pool split and time-window narrowing dropped comps without incrementing any `removed.*` bucket. Added `preFilterRemoved = { prefilterPoolSize, prefilterStrikeSplit, prefilterTimeWindow }` (provenance-neutral key names, see review item 3), hoisted to function scope so partial-seed paths (Finding/Browse supplement) preserve it through downstream `usResult` rebuilds. Added a runtime `console.warn('[telemetry-leak]')` guard that fires when `reportedTotal + tolerance < droppedTotal` (catches both fully-silent AND partial-attribution gaps). `pricing-health-full.js` now prints the top non-zero `removed.*` bucket per RED issue with a stable tie-break. Test coverage: 5 new cases in `__tests__/ebayFetchSoldComps.test.js` (strike-split, zero-drop sanity, time-window, partial-seed path, guard no-fire). Schema-safe: `priceResponse.schema.js` has `additionalProperties: true`.

**Follow-up:** The underlying data-quality issue (2023 Reverse Proof Morgan dataset is contaminated with regular Proof/BU comps that get correctly rejected) is tracked separately -- the 200 drops are now visible as `prefilterStrikeSplit=N` and represent CORRECT REJECTIONS, not a bug in the filter. Open as a fresh backlog entry if intake-side cleanup is wanted (no ID reserved -- see #252 / #253 for the related findings that emerged from the post-merge Maple pricing-health run).

**Original problem:** Pricing health full-run on 100 Morgans (`cache/health-morgan-100.json`) flagged `2023 Reverse Proof Morgan Silver Dollar` RED: 205 Terapeak rows enter the discovery pipeline but only 3 US comps survive (98.5% attrition) with `discovery.removed.*` ALL reporting 0. The filter that's killing the comps was silently dropping them without reporting to the `removed` telemetry buckets.

**Repro:** `ADMIN_API_KEY="$(grep '^ADMIN_API_KEY' .env | cut -d= -f2-)" node scripts/pricing-health-full.js --full --filter "Morgan" --limit 100 --min 10 --out cache/health-morgan-100.json` then inspect the RED row.

**Files:** `src/services/ebayService.js`, `scripts/pricing-health-full.js`, `__tests__/ebayFetchSoldComps.test.js`.

---

### #245. Freshness Triage Safeguards Not Firing [P1 -- DATA-QUALITY] -- DONE 2026-06-02

**Status:** Resolved via 5 commits on `fix/freshness-safeguards-245`. All 4 fixes (A/B/C/D) landed + a Fix C.1 patch for a corruption bug in the backfill script. Verified end-to-end: initial-fetch 171→40, dormant 0→473, evidence-low-vol 196→54 (numbers settle after Fix C applied 255 historical noDataCount stamps). 89/89 suites pass, 3164 tests.

**Problem (original):** Freshness triage keeps recommending scrapes for coins that should be excluded by existing safeguards (dormancy, low-volume evidence, recently-empty refresh). Diagnostic on `data/terapeak-meta.json` (4,812 entries) on 2026-06-02 confirms multiple chain breaks:

| Bug | Hard-number evidence |
|-----|---------------------|
| **B1. Dormancy never fires** | `0 / 4,812` entries have `noDataCount > 0`. Logs show **485 "NO EXPORT (no results)" hits in last 30 days** -- ALL went unrecorded. `shouldSkipRefresh()` gates on `noDataCount >= 2`, so dormancy is dead code. |
| **B2. Classifier ignores `identifiers` block** | `196` entries have `identifiers.is_low_volume_candidate=true` + `identifier_confidence='High'` (built by `build-evidence-index.js`); `freshnessClassifier.js` never reads them. `84` of the `171` P0 initial-fetch queue and `4` of the `1,313` P1 refresh queue are known-low-vol-High but still queued. |
| **B3. 421 evidence-only orphans** | 421 entries have ONLY the `identifiers` block (no `page1At`, `compCount`, `refreshCount`). Classifier sees `marketDepth='untested'` → permanently queued for initial-fetch. |
| **B4. `refreshCount` only counts successes** | Entries scraped and returned empty get `page1At` stamped but `refreshCount` stays 0, `compCount` stays `null`. The `recently-confirmed-stale` guard requires `marketDepth='viable'`, so empty scrapes get no protection and cycle back into the queue every report. |

**Root cause of B1:** Python `_report_no_data()` only fires on the "NO EXPORT (no results or button not found)" branch and is wrapped in `try/except: pass`. When the export button DOES appear but returns 0 rows, the script uploads an empty CSV which stamps `page1At` and skips the no-data signal entirely. POST failures are silent.

**Why it matters:** Wasted aggregation runs on known-dud datasets. ~485 untracked no-data events in last 30 days; ~196 high-confidence low-vol candidates re-queued every refresh; 421 entries permanently stuck in `initial-fetch`. After fixes, the actionable queue is projected to drop from `2,477` to roughly `800-1,200` (~50-65% reduction).

**Fix order (separate small commits, each testable):**
1. **Fix A** -- `freshnessClassifier.js` reads `identifiers`. When `is_low_volume_candidate=true && confidence='High'`, treat as `confirmed-thin` (skip initial-fetch + refresh). ~30 LOC + classifier tests. Projected drainage: 88 queue items immediately.
2. **Fix B** -- `terapeakService.importComps()` auto-stamps `noDataCount++` + `noDataAt` when `comps.length === 0`. Stops relying on Python's optional POST. ~10 LOC + unit test.
3. **Fix C** -- `scripts/backfill-no-data.js` (new): parse `cache/terapeak_*.log` for "NO EXPORT" hits since 2026-04-01, stamp historical `noDataCount` + `noDataAt`. One-shot; activates B1's safeguard retroactively for ~485 documented events.
4. **Fix D** -- Split `refreshCount` (successes) from `attemptCount` (all tries). Extend `recently-confirmed-stale` guard to gate on either when `compCount === 0` after an attempt. Small schema migration + meta sidecar update.

**Verification:** After all four fixes + re-run `generate-freshness-report.js`, the `1990 Great Britain 1oz Gold Britannia` / `1968 South Africa 1oz Gold Krugerrand` family should move from `initial-fetch` to `dormant` / `confirmed-thin`. Re-running the diagnostic in `/tmp/diag-phase1.js` should show `noDataCount > 0` for ~200+ entries.

**Files:**
- MOD `src/services/freshnessClassifier.js` (A, D)
- MOD `src/services/terapeakService.js` (B, D)
- NEW `scripts/backfill-no-data.js` (C)
- NEW `__tests__/freshnessClassifierIdentifiers.test.js` (A)
- NEW `__tests__/terapeakServiceNoDataStamp.test.js` (B)
- MOD `__tests__/freshnessClassifier.test.js` (D regression)

**Out of scope (separate item #246):** dataset-key deduplication across naming variants (`"south africa 1oz gold krugerrand"` vs `"gold krugerrand 1oz"`). That mutates `terapeak-meta.json` and needs its own approval gate.

---

### #246. Dataset-Key Duplication Across Naming Variants [P2 -- DATA-QUALITY] -- DONE 2026-06-03

**Status (2026-06-03):** Complete. Meta sidecar deduped (PR #95) and Cosmos cleaned up (operator run via PR #97). 0 / 146 loser docs remaining in `terapeak-sold` after the migration. App Service stopped during the window and restarted clean.

| PR | Merged | Scope |
|---|---|---|
| #90 | yes | Phase 1 audit (`scripts/audit-duplicate-keys.js`, read-only) |
| #91 | yes | PR A -- canonicalize 133 `.meta` files + Python placeholder script (preventive; no runtime data touched) |
| #92 | yes | PR B' -- `_mergeAggregationMeta` hydration helper (fixes latent first-wins bug in `loadMetaSidecar` / `hydrateMetaFromCosmos`) |
| #93 | yes | PR C -- `scripts/merge-duplicate-keys.js` (dry-run + `--apply` + `--migrate-cosmos`) |
| #95 | yes (2026-06-02) | Operator run, meta-only: `--apply` against `data/terapeak-meta.json`. 4,812 -> 4,666 keys. 146 losers archived to `data/archive/terapeak-meta-orphans-2026-06-02T20-37-59-494Z.json`. Cosmos NOT touched. |
| #96 | yes (2026-06-02) | `scripts/export-cosmos-terapeak-sold.js` -- pre-migration safety dump (107MB rollback artifact). |
| #97 | yes (2026-06-02) | `--from-archive` flag for Cosmos-only follow-up + S1 fix for `applyCosmosMigration` partition-key bug (was passing sanitized id as both id and pk; `terapeak-sold` pk is `/searchTerm`, the raw key). |

**Cosmos migration results (2026-06-03T00:05:48Z, run from this codespace via `az`-resolved creds):**

| Metric | Predicted | Actual |
|---|---|---|
| Loser deletes | 101 | **101** |
| Losers missing (already absent) | 45 | **45** |
| Winner upserts | up to 144 | **99** (45 skipped where `didChange=false`) |
| Comps merged into winners | up to 2,317 | **643** (rest dedup'd against existing winner comps) |
| Errors | 0 | **0** |

Post-migration verification probe: 0 / 146 losers present in Cosmos; 101 / 43 winners present-vs-absent (the 43 absent are local-meta-only entries with no losers in Cosmos and no comps to migrate -- meta sidecar already has them from PR #95). App Service stopped before apply, restarted after, HTTP 200 confirmed.

**Runbook for future similar operations:**

```bash
# 1. Stop App Service to prevent write-through races
az webapp stop --name coinpricefinder --resource-group CoinPriceFinder_group-82d5

# 2. Resolve Cosmos creds from Azure
export COSMOS_ENDPOINT="$(az cosmosdb show --name coinpricefinder-cosmos --resource-group CoinPriceFinder_group-82d5 --query documentEndpoint -o tsv)"
export COSMOS_KEY="$(az cosmosdb keys list --name coinpricefinder-cosmos --resource-group CoinPriceFinder_group-82d5 --query primaryMasterKey -o tsv)"
export COSMOS_DB="coinprice"

# 3. Take fresh dump (rollback artifact) + persistent off-tree backup
node scripts/export-cosmos-terapeak-sold.js
ROLLBACK_DUMP=$(ls -t data/archive/cosmos-terapeak-sold-*.json | head -1)
cp "$ROLLBACK_DUMP" ~/cpf-rollback-$(date -u +%Y%m%dT%H%M%SZ).json   # survives codespace rebuild (~/ is persisted; /tmp/ is not)

# 4. Bind the orphans archive once (latest from PR #95-era run, or rerun the planner first)
ORPHANS_ARCHIVE=$(ls -t data/archive/terapeak-meta-orphans-*.json | head -1)

# 5. Dry-run (--verbose for full group list) -- probe will show real Cosmos scope
node scripts/merge-duplicate-keys.js --from-archive="$ORPHANS_ARCHIVE" --verbose

# 6. Apply (after operator eyeball-review of #5)
node scripts/merge-duplicate-keys.js --from-archive="$ORPHANS_ARCHIVE" --apply --migrate-cosmos

# 7. Re-probe to verify 0/N losers present
node scripts/merge-duplicate-keys.js --from-archive="$ORPHANS_ARCHIVE"

# 8. Restart App Service
az webapp start --name coinpricefinder --resource-group CoinPriceFinder_group-82d5
```

Rollback if `--migrate-cosmos` goes wrong: re-upsert every doc from `$ROLLBACK_DUMP` (or the `~/cpf-rollback-*.json` copy) back into the `terapeak-sold` container (one-off script, not pre-built; the export is full-fidelity including `_etag`).

**Phase 1 complete.** `scripts/audit-duplicate-keys.js` shipped (read-only) with regression coverage in `__tests__/auditDuplicateKeys.test.js`. Audit output committed at `docs/reports/duplicate-keys-report.json` for review.

**Phase 1 findings (against `data/terapeak-meta.json` post-#245, 4,812 keys):**
- 144 duplicate groups (290 keys total)
- **30 mixed-class groups** (one form populated, another empty) -- HIGH PRIORITY
- 85 all-populated groups (merge candidates)
- 29 all-empty groups (low priority)
- Largest delta: 223 comps fragmented between `"2025 perth lunar snake 1oz silver"` (223 comps) and `"perth lunar 2025 snake silver 1oz"` (0 comps)

Numbers are more conservative than the spec's "620/1,242" estimate because phase-1 deepCanonical applies only a high-precision alias map (country aliases + ounce normalization + token sort). Phase 2 normalizeSearchKey extension can widen the net.

**Phase A complete (PR A, 2026-06-02): source cleanup.** Investigation during phase 2 design revealed the root cause is NOT a missing normalizer feature -- it's that two placeholder scripts (`scripts/create_placeholders.py` and `scripts/generateAllCoinData.js`) emit different search-term conventions for the same coin:
- `create_placeholders.py` wrote `"1990 Great Britain 1 oz Gold Britannia"` (long-form, spaced ounce) into `.meta` files.
- CSV filenames used `"1990_British_Gold_Britannia_1oz.csv"` (short-form, collapsed ounce).
- Result: every Britannia and Krugerrand year had two cache keys -- one from each convention -- and historical scrape runs over time populated both intermittently, producing the fragmentation visible in the audit report.

PR A is a *preventive* fix: it rewrites 133 `.meta` files to match the CSV filename convention (`British` / `Gold Krugerrand 1oz`) and updates `create_placeholders.py` so future placeholder runs are canonical. It does NOT touch `data/terapeak-meta.json` (the historical cache) or Cosmos -- the existing duplicates persist until a separate cleanup PR (PR C). PR A guarantees that re-importing the affected CSVs going forward will write to the canonical key form instead of re-creating the long-form duplicate.

**Investigation summary (in support of PR A):**
- Britannia: 78 cache keys with `great britain` form, 78 with `british` form -- same data, two keys.
- Krugerrand: 103 with `south africa` prefix, 73 without -- same data, two keys.
- Panda / Maple Leaf / Philharmonic also have country-vs-demonym splits (~700 keys), but the audit showed 0 / 0 / 3 mixed-class years respectively -- the forms exist in parallel but are not fragmenting data. Out of scope for PR A.
- PCGS service does NOT touch search-term strings (it works with cert numbers / grade codes) -- this is purely a Terapeak-scrape-pipeline issue.

**PR B (deferred -- needs decision):** Extend `normalizeSearchKey()` with alias rules (`great britain` -> `british`, `south africa` strip for Krugerrand, `one ounce` -> `1oz`) to defensively collapse any *historical* search terms that still come in long-form (e.g. from old log replays in `build-evidence-index.js`). Also fix `loadCosmosHydration()` to merge comps arrays when two docs collapse to the same key (currently last-write-wins drops the first doc's comps in memory).

**PR C (deferred -- needs decision):** Extend `scripts/prune-ghost-keys.js` with (1) archive write to `data/archive/terapeak-meta-orphans-YYYYMMDD.json` before delete, (2) `--migrate-cosmos` flag to dedup Cosmos docs whose `id` derives from a stale key form. Run after PR B is live in prod.

**Phases 2-4 still open.** See the original plan below.

**Problem:** `data/terapeak-meta.json` has **620 duplicate groups (1,242 keys)** that represent the same coin under two or more naming forms. **106 of those groups have a mix of populated + empty entries** -- so the same coin was scraped twice into different keys, and one form returned data while the other silently dropped its 0-row "result."

**Examples (from 2026-06-02 freshness-report inspection):**

| Long form (0 comps) | Short form (has data) |
|---|---|
| `1996 South Africa 1oz Gold Krugerrand` | `1996 Gold Krugerrand 1oz` (1 comp) |
| `2006 South Africa 1oz Gold Krugerrand` | `2006 Gold Krugerrand 1oz` (5 comps) |
| `1990 Great Britain 1oz Gold Britannia` | `1990 British Gold Britannia 1oz` (1 comp) |
| `2018 Great Britain 1oz Gold Britannia` | `2018 British Silver Britannia 1oz` (62 comps) |

**Root cause:** `terapeakService.normalizeSearchKey()` doesn't collapse:
- country aliases (`south africa` ↔ ∅, `great britain` ↔ `british`, `royal mint` ↔ `royalmint`)
- ounce notation (`1oz` ↔ `1 oz` ↔ `one ounce`)
- word order (`gold krugerrand 1oz` ↔ `1oz gold krugerrand`)

**Why it matters:** Comp data is fragmented across keys -- valuation lookups miss data that exists under the alternative key. Refresh queues waste pulls re-scraping orphan keys. Adds noise to every dashboard.

**Plan (gated -- audit first, merge second):**
1. **Audit (read-only)** -- `scripts/audit-duplicate-keys.js` produces `docs/reports/duplicate-keys-report.json`: groups, suggested canonical form per group, comp-count delta, identifier confidence. Output reviewed before any write. **[DONE 2026-06-02]**
2. **Extend `normalizeSearchKey()`** -- add alias map (countries + series + ounce notation) + sorted-token canonicalization. Add unit tests for each alias rule before applying merges.
3. **Backfill merger (one-shot)** -- `scripts/merge-duplicate-keys.js` reads the audit report, merges comps into the canonical key, archives the orphan to `data/archive/terapeak-meta-orphans-YYYYMMDD.json`. Includes `--dry-run` flag.
4. **Cosmos write-through** -- migration must propagate to Cosmos `terapeak-sold` container or the orphans resurrect on next hydration.

**Risk:** Direct mutation of canonical data store. Mitigations: dry-run default, archived orphans, audit report committed before merger run, Cosmos backup taken first.

**Files:**
- NEW `scripts/audit-duplicate-keys.js` **[DONE]**
- NEW `__tests__/auditDuplicateKeys.test.js` **[DONE]**
- NEW `docs/reports/duplicate-keys-report.json` **[DONE]**
- NEW `scripts/merge-duplicate-keys.js`
- MOD `src/services/terapeakService.js` (`normalizeSearchKey` alias map)
- NEW `__tests__/normalizeSearchKey.test.js`

**Dependency:** Should be done AFTER #245 so the audit isn't polluted by entries that should be marked dormant first.

---

### #266H. Ship Phase 2 + Phase 3 of #246 -- normalizeSearchKey alias map + duplicate-key merger [P2 -- DATA-QUALITY] -- Phase 2 DONE 2026-06-18 (PR #155); Phase 3 script DONE 2026-06-18 (PR #157); live migration OPEN

**Status (2026-06-18):** Phase 2 shipped in PR #155. Phase 3 (one-shot merger script) remains OPEN -- see the Phase 3 block below.

**Phase 2 resolution (PR #155, merge commit `e7ca5bf`):**
- `normalizeSearchKey()` extended with country aliases (`mexican` <-> `mexico`, `chinese` <-> `china`, `american` <-> `usa` / `us` / `u.s.` / `united states`, `british` <-> `great britain` / `united kingdom`, `royalmint` <-> `royal mint`), decimal-fraction oz forms (`0.05`/`0.1`/`0.25`/`0.5 oz`), `one oz` / `troy oz` aliases, Krugerrand south-africa stripping, and deterministic sorted+deduped token canonicalization (alphabetical, `new Set(...)` dedupe).
- Formal grade hyphens are also canonicalized away (`MS-65` -> `ms65`) so the `lookupComps` grade-augmented key path actually matches.
- Lazy in-place migration on `loadStore()` via `_rekeyStoreInPlace` + `_mergeStoreEntries` -- legacy keys are rewritten to canonical form on first load, and collisions MERGE comps + aggregationMeta instead of last-write-wins. `loadMetaSidecar` now canonicalizes raw keys on read so a pre-Phase-2 sidecar cannot re-inject legacy stubs.
- New tests: `__tests__/normalizeSearchKey.test.js` (per-alias + golden duplicate-pair regression from `docs/reports/duplicate-keys-report.json`), `__tests__/rekeyStore.test.js` (migration fast-path identity, collision merge, fingerprint dedupe, defensive non-array `comps` guard), `__tests__/loadMetaSidecarCanonicalize.test.js` (legacy raw keys canonicalize on read).
- Full suite: 3981/3981 stable across 3 consecutive runs at fixup-commit verification; CI green at merge (test, CodeQL JS/TS, Python, Actions).
- Deep-review (`.github/skills/code-review/SKILL.md` framework) ran on PR #155 -- 4 S2-High findings + 3 S3-Medium + 2 S4-Low; all applied in fixup commit `694cb4f` before merge.

**Original problem statement (Phase 2 + Phase 3, retained for Phase 3 history):**

**Problem:** #246 shipped only Phase 1 (read-only audit). The PR B (`normalizeSearchKey` extension) and PR C (`scripts/merge-duplicate-keys.js --apply --migrate-cosmos`) phases were deferred. In the 12 days since the committed audit (2026-06-02), duplicate-key drift has continued and `data/terapeak-meta.json` is actively double-scraping a growing set of variant pairs.

**Evidence (re-running `node scripts/audit-duplicate-keys.js --top 1` against today's meta, 2026-06-15):**

| Metric | 2026-06-02 (committed) | 2026-06-15 (fresh) | Delta |
|---|---:|---:|---:|
| metaKeyCount | 4,812 | 5,115 | +303 |
| canonicalGroupCount | 4,666 | 4,948 | +282 |
| duplicateGroupCount | 144 | 165 | **+21** |
| duplicateKeyCount | 290 | 332 | +42 |
| mixed-populated-and-empty | 30 | 1 | -29 |
| **all-populated (both halves scraping)** | **85** | **164** | **+79** |
| all-empty | 29 | 0 | -29 |

The "all-populated" tier nearly doubled -- those are pairs where BOTH variants are actively returning comps to two separate keys, e.g.:

- `2025 perth lunar snake 1oz silver` (190c) vs `perth lunar 2025 snake silver 1oz` (0c)
- `2021 perth lunar ox 1oz silver` (256c) vs `perth lunar 2021 ox silver 1oz` (13c)
- `2024 perth lunar dragon 1oz silver` (174c) vs `perth lunar 2024 dragon silver 1oz` (4c)
- `perth lunar 2022 tiger silver half oz` (231c) vs `2022 perth lunar tiger half oz silver` (88c)
- `perth lunar 2023 rabbit silver 1oz` (305c) vs `2023 perth lunar rabbit 1oz silver` (168c)

Pattern is always token-order ambiguity (`<year> perth lunar <animal> <oz> <metal>` vs `perth lunar <year> <animal> <metal> <oz>`). Phase-1 audit catches these because it does token-sort + alias collapse internally, but the live ingest path through `normalizeSearchKey()` does not, so each variant remains its own key.

A second class of duplicates does NOT surface in the v1 audit because the alias map is too narrow. Example surfaced during the 2026-06-15 freshness triage:

- `2025 mexico half oz silver libertad` (102c, 126d stale) vs `2025 mexican silver libertad half oz` (107c, 126d stale)

Same coin, ~100 comps in each bucket, both very-stale, scheduled to be scraped again in the same P0 pass. The `mexican` <-> `mexico` country alias is not in v1.

**Goal:** Land the two deferred phases of #246 so new duplicates stop accumulating and the existing 165 groups merge into their canonical keys.

**Phase 2 -- `normalizeSearchKey()` extension (PR B):**
- Extend `src/services/terapeakService.js#normalizeSearchKey()` (and any other call sites) with an alias map covering at minimum:
  - Country aliases: `mexican` <-> `mexico`, `chinese` <-> `china`, `american` <-> `usa` / `us`, `british` <-> `great britain`, `royalmint` <-> `royal mint`, drop bare `south africa` for Krugerrand entries.
  - Ounce notation: `half oz` <-> `0.5 oz` <-> `1/2 oz`, `quarter oz` <-> `0.25 oz` <-> `1/4 oz`, `tenth oz` <-> `0.1 oz` <-> `1/10 oz`, `twentieth oz` <-> `0.05 oz` <-> `1/20 oz`, `one ounce` <-> `1oz`.
  - Sorted-token canonicalization: after alias substitution, sort the remaining tokens deterministically so `<year> perth lunar <animal> <metal> <oz>` and `perth lunar <year> <animal> <oz> <metal>` collapse to the same key.
- Fix `loadCosmosHydration()` last-write-wins drop: when two source docs canonicalize to the same key, MERGE comps arrays (dedupe by item id) instead of overwriting.
- Add `__tests__/normalizeSearchKey.test.js` with one test per alias rule plus golden-input regression cases drawn from the top 20 duplicate groups in `docs/reports/duplicate-keys-report.json`.

**Phase 3 -- one-shot merger (PR C):**
- Build `scripts/merge-duplicate-keys.js` that reads `docs/reports/duplicate-keys-report.json` and for each group:
  1. Picks the canonical key (the report's `suggestedCanonicalKey`).
  2. Merges all member comps into the canonical entry (`compCount` recomputed from the deduped union, `refreshCount` summed, `lastRefreshAt` = max, `noDataCount` summed, identifiers from the highest-confidence member).
  3. Renames orphan CSVs under `data/terapeak/` to point at the canonical filename (or archives them if the canonical already has a CSV with newer mtime).
  4. Archives the pre-merge state to `data/archive/terapeak-meta-orphans-YYYYMMDD.json` for rollback.
- Flags: `--dry-run` (default), `--apply`, `--migrate-cosmos` (also writes the merge through to the Cosmos `terapeak-sold` container), `--from-archive=PATH` (rerun against a previously-archived orphan set), `--verbose`.
- Take a Cosmos backup before any `--apply --migrate-cosmos` run (documented in the PR description; not automated in the script).

**Acceptance criteria:**
- After Phase 2 ships, a fresh run of `node scripts/audit-duplicate-keys.js` against an unchanged meta file produces a strictly-shrinking or equal duplicate count over time -- new ingests stop creating fresh variants.
- After Phase 2 + Phase 3 ship (in that order), the audit report shows `duplicateGroupCount: 0` for the alias categories covered by the new map. Residual duplicates are limited to genuinely-different coins that happen to share a canonical-form collision (flagged for manual review).
- The 5 example pairs above (4 Perth Lunar token-order pairs + the Mexican Libertad half-oz pair) all merge cleanly in `--dry-run`, with the report showing the expected canonical key and merged `compCount`.
- Cosmos query for any merged key returns the unioned comps (no comp lost to last-write-wins).
- Cross-route consistency check (`@pricing-health`) on any merged coin returns the same FMV from `/api/price`, `/api/pricing-batch`, `/api/bulk-evaluate`, and `/api/market/ebay`.
- The two existing #246-Phase-1 tests in `__tests__/auditDuplicateKeys.test.js` continue to pass.
- Server smoke: `npm test` zero failures; freshness report still generates without errors.

**Files:**
- MOD `src/services/terapeakService.js` (`normalizeSearchKey` alias map + sorted-token canonicalization)
- MOD `src/services/<wherever loadCosmosHydration lives>` (merge instead of overwrite on key collision)
- NEW `__tests__/normalizeSearchKey.test.js`
- NEW `scripts/merge-duplicate-keys.js`
- NEW `__tests__/mergeDuplicateKeysSmoke.test.js` (dry-run shape + no-mutation safety)
- MOD `docs/BACKLOG.md` (close out #246 fully once both phases ship)

**Risk:**
- Direct mutation of `data/terapeak-meta.json` and Cosmos. Mitigation: `--dry-run` default, archived orphans, audit-report-pinned source of truth, manual Cosmos backup before `--apply --migrate-cosmos`, separate PRs for Phase 2 vs Phase 3.
- `normalizeSearchKey()` change may shift live cache hit/miss patterns. Mitigation: ship Phase 2 first, observe one freshness pass, then run Phase 3.

**Dependency:** Picks up exactly where #246 left off. No new prerequisites. Recommended to land BEFORE the next bulk Terapeak refresh pass so the merger sees a quiescent meta file.

**Status notes:** Filed from the H machine during the 2026-06-15 freshness-triage session. Highest-leverage data-quality item currently open -- estimated 332 keys collapse to ~165 (saving ~165 redundant scrape slots per refresh cycle) plus prevention of further drift. See also: `docs/reports/duplicate-keys-report.json` for the full list of candidate groups.

---

### #267H. `lookupComps` returns empty parallel-key dataset over populated one [P1 -- BUG] -- DONE 2026-06-15

**Problem:** Production Azure valuation for `2010 Perth Mint Lunar Tiger Series II in 1/2 oz` returned `compCount: 0`, `method: bullion-spot-premium`, `confidence: 0`, `lowData: true` despite 21 verified sold comps existing on disk under a parallel storage key.

**Root cause:** Azure's Terapeak store contains two entries for the same coin keyed differently by `normalizeSearchKey()`:
- `2010 lunar tiger half oz silver` -- 21 real sold comps (populated)
- `perth lunar 2010 tiger silver half oz` -- 0 comps (empty stub, created by an earlier aggregator run with a different search phrasing)

`lookupComps()` scored both candidates on token overlap alone. The empty stub shared more tokens with the user's verbose query (`perth`, `lunar`, `2010`, `tiger`, `half`, `oz`, `silver`) and won the fuzzy match, returning 0 comps. The pipeline then fell back to bullion-spot-premium with live active-listing prices, yielding a useless valuation.

**Verified on Azure (2026-06-15):**
```
GET /api/terapeak/lookup?q=2010+Perth+Mint+Lunar+Tiger+Series+II+in+1/2+oz
  -> searchTerm=perth lunar 2010 tiger silver half oz, compCount=0
GET /api/terapeak/lookup?q=2010+Lunar+Tiger+Half+oz+Silver
  -> searchTerm=2010 lunar tiger half oz silver, compCount=21
```

**Fix (shipped):** In `src/services/terapeakService.js`, `lookupComps()` now skips datasets with zero comps:
- Exact-match branch: falls through to fuzzy when the matched dataset is empty.
- Fuzzy loop: `continue` at top of iteration if `(data.comps || []).length === 0`.

An empty dataset can never produce a useful match, so skipping outright is purely a behavioral win.

**Regression test:** `__tests__/terapeakEmptyDatasetSkip.test.js` (4 tests covering: populated wins over empty stub; empty-only store still returns null; exact-match path falls through on empty; populated exact match unchanged).

**Test results:** All 4 new tests pass. Full suite: 3,336 passing; 5 pre-existing failures unrelated to this change (`freshnessReportDeepPaginate`, `freshnessReportEvidenceGates`, `imageProxyRoute` SSRF allowlist) -- confirmed by re-running the same 3 suites without the fix applied.

**Relationship to #266H:** This is a tactical hotfix that mitigates the user-visible symptom of the underlying duplicate-key drift. #266H remains the structural fix -- merging the duplicate keys at the data layer so empty stubs never exist in the first place. After #266H ships, this empty-dataset skip becomes belt-and-suspenders defense rather than the only line of protection.

**Files:**
- MOD `src/services/terapeakService.js` (+16 lines: empty-dataset guard in exact-match + fuzzy loop)
- NEW `__tests__/terapeakEmptyDatasetSkip.test.js`

**Follow-up (open):** Audit Azure's actual store to scope how many other coins are affected. The `GET /api/terapeak/datasets` endpoint is admin-gated; needs a one-off audit run with admin auth to enumerate all `compCount=0` keys and check whether a populated parallel exists. If non-zero, log a one-shot cleanup that deletes the empty stubs (deferred until #266H is in flight, since #266H's merger handles them anyway).

---

### #268H. Randomize cpf-go loop-pass batch size to evade bot-detection patterning [P2 -- TOOLING / BOT-EVASION] -- DONE 2026-06-15

**Problem:** `scripts/cpf-go --loop` was running a perfectly constant batch size every pass -- default `--page1-batch=15` forwarded verbatim to `terapeak-export.py` -- producing a "fetch exactly 15 page-1 queries, sleep exactly N minutes, repeat" footprint. Bot-detection systems trivially fingerprint that periodicity even with otherwise-randomized cookies, viewport, mouse trajectories, and inter-action delays. The first thing a defender's volume model keys on is "predictable count per window." Surfaced during the 2026-06-15 local-scraper session ("didnt we add a randomizer, so that it didnt always grab 15, but somethign between 15 and 30?").

**Fix:** Per-pass batch-size jitter in `scripts/cpf-go`.
- New flags `--batch-min=N` (default 15) and `--batch-max=N` (default 30).
- Before each `./surface` invocation in the loop, pick `BATCH=$(shuf -i $MIN-$MAX -n 1)` and forward `--page1-batch "$BATCH"`.
- If the caller explicitly passed `--page1-batch`, the jitter is suppressed (caller intent wins). Detection: tracked via `USER_PASSED_PAGE1_BATCH` flag during the arg parse loop.
- Falls back to `$((MIN + RANDOM % span))` if `shuf` is missing (slight bias acceptable -- bot evasion only needs visible variability, not uniform distribution).
- Validates `MIN >= 1 && MAX >= MIN` and both are positive integers; fails loudly otherwise.
- Single-pass mode (no `--loop`) is unchanged -- the jitter only applies when looping.

**Behavior change:**
- Before: every pass scraped exactly 15 coins.
- After: each pass scrapes a different count in `[15..30]`, drawn fresh per pass.
- Logged per pass: `Pass N -- randomized --page1-batch=23 (range 15..30)`.

**Smoke tests (manual):**
- `bash -n scripts/cpf-go` -- syntax clean.
- 10x `shuf -i 15-30 -n 1` -- saw spread `27 27 30 25 20 22 26 19 28 22` (good distribution, no clustering).
- `cpf-go --batch-min=foo --batch-max=30` -- exits 1 with clear error message.
- `cpf-go --batch-min=30 --batch-max=10` -- exits 1 with clear error message.

**Files:**
- MOD `scripts/cpf-go` (+34 lines: new flag parsing, validation block, `pick_batch_size()` helper, loop body uses jittered size unless caller forced one).

**Why no unit test:** `cpf-go` is a thin orchestrator script; the random selection just shells out to `shuf` and the validation is checked by the smoke tests above. Adding a Bats harness for one script isn't worth the dependency.

**Related:** #265H (unified launcher / status -- this is a small incremental hardening of the existing launcher, doesn't depend on or block #265H).

---

### #269H. Meta-sync swallows local state on Azure POST failure -- HTTP 422 coins keep re-scraping forever [P1 -- DATA-QUALITY / SCRAPER] -- DONE 2026-06-16

**Problem:** When `terapeak-export.py` finishes a coin, it tries to POST the CSV to Azure (`/api/admin/terapeak/import`) AND sync the resulting canonical meta back into `data/terapeak-meta.json`. When the POST fails (HTTP 422 "No valid comps found in CSV", or HTML/auth-redirect from Azure), the local meta-sync logs:

```
[warn] meta sync returned non-JSON payload; keeping existing data/terapeak-meta.json
```

...and bails -- **without persisting the local in-memory state delta** (`lastFetchedAt`, `lastEmptyAt`, `noDataCount++`, `dormant=true`-on-2nd-strike). The next freshness pass therefore re-classifies the coin as stale and the scraper re-fetches it. Loop forever.

**Evidence (2026-06-15 local-scraper session):**

| Coin | Hit count this session | Outcome |
|---|---|---|
| `1997 American Gold Eagle Tenth oz` | 2 passes (412, 948) | HTTP 422, 3 rows, all skipped |
| `1989 China Twentieth Oz Gold Panda` | pre-restart session | HTTP 422, 2 rows, all skipped |
| `1982 Gold Krugerrand Quarter Oz` | post-restart pass 1 | HTTP 422, similar |

Meta inspection of `1997 American Gold Eagle Tenth oz` after 2 failures:

```
key:            1997 american gold eagle tenth oz
compCount:      20
lastFetchedAt:  None     <- never persisted
lastEmptyAt:    None     <- never persisted
noDataCount:    1        <- only 1 of 2 failures recorded
dormant:        False    <- should be True after 2 strikes
lastUpdated:    None
```

The scraper's in-flight stdout literally prints `(dormant: 2 consecutive empty attempts)` right next to the 2nd failure -- proving the dormant promotion is computed but never persisted.

**Impact:**
- Wasted scraper cycles re-fetching coins that will keep returning unparseable data.
- Bot-detection exposure (predictable re-pulls of the same key).
- Freshness telemetry shows misleading "P0 stale" entries that are actually broken.
- Empty-dataset fix from #267H gives stale entries free credit because their `lastFetchedAt` is `None` (the recently-confirmed-stale gate can't fire).

**Root cause (hypothesis -- to verify):** `scripts/terapeak-export.py` (or its caller `run-surface-freshness-loop.sh` meta-sync step) treats the Azure round-trip as the sole authoritative source for meta updates. When Azure returns non-JSON (HTML auth page) or HTTP error, the local-only path is short-circuited instead of falling back to writing local state.

**Proposed fix (one of, or both):**

1. **Fail-open meta persistence:** If the Azure meta POST/GET fails, still write the local in-memory deltas (`lastFetchedAt`, `lastEmptyAt`, `noDataCount`, `dormant` flag) to `data/terapeak-meta.json` directly. Treat Azure as eventually-consistent, not authoritative.
2. **HTTP 422 = empty:** Any 422 from the Azure import endpoint should be treated as a confirmed-empty outcome for that coin. Bump `noDataCount`, set `lastEmptyAt`, promote to dormant after the 2nd strike -- same as a real "0 tables on page" empty.

Fix 2 is the narrow patch; Fix 1 is the structural one. Recommend doing both: Fix 2 short-term to unblock the current scraper, Fix 1 when there's time to test.

**Acceptance:**
- After 2 consecutive HTTP 422 outcomes for the same coin, the coin is marked dormant in `data/terapeak-meta.json` and excluded from subsequent freshness passes.
- `lastFetchedAt` is non-null for every coin the scraper has touched (regardless of Azure POST result).
- The 3 known-affected coins above stop appearing in new passes (or get explicitly dormant-promoted).
- Regression test in `__tests__/` exercises the meta-write path with a mocked Azure 422 response.

**Files (expected):**
- `scripts/terapeak-export.py` (meta-sync handler around HTTP 422 / non-JSON response)
- Possibly `scripts/run-surface-freshness-loop.sh` if the meta-sync invocation lives there
- New `__tests__/terapeakExportMetaPersistence.test.js` (or `.py` equivalent if the logic stays Python-side)

**Related:**
- #267H (empty-dataset skip in lookupComps) -- this issue means #267H's gate is bypassed for these specific stuck coins.
- #245 (freshness safeguards) -- the dormancy classifier works correctly; the bug is upstream of it, in the meta writer.
- The `meta sync returned non-JSON payload` warning has been present in logs for a while -- worth a one-shot audit to see how many coins have `lastFetchedAt=None` cluster-wide.

**Resolved 2026-06-16 (PR #132 -- wave-1/269h-import-422-self-heal):** Server-side self-healing added to `/api/terapeak/import` and `/api/terapeak/import-text`. New helper `_stampNoDataMeta(searchTerm, clientPage1At)` in `src/routes/terapeakRoute.js` writes `{ noDataAt, noDataCount: prev+1, page1At }` via `terapeakService.updateDatasetMeta` on the zero-comp 422 branch, wrapped in try/catch so meta-write failure cannot mask the 422. Two consecutive 422s now trip `DORMANT_MIN_NO_DATA_COUNT=2` and the coin is excluded from subsequent passes. Regression test: `__tests__/terapeakImport422SelfHeal.test.js` (10 cases). Follow-ups tracked in #271H.

---

### #271H. Followups from PR #132 deep review -- noDataCount cap, integration test, /report-no-data parity [P3 -- TECH-DEBT / TEST-HARDENING] -- DONE 2026-06-19 (PR #163)

**Origin:** Deep code review of PR #132 (#269H fix) surfaced four non-blocking quality issues that were deferred from the merge so Wave 1 could ship clean. Bundling here.

**Items:**

1. **Cap `noDataCount` at 5 in `_stampNoDataMeta`** (review finding M-1). The helper in `src/routes/terapeakRoute.js` currently does an unconditional `prevCount + 1`, while the existing `importComps` dormancy path caps at `NO_DATA_CAP = 5` (proved by `__tests__/terapeakServiceNoDataStamp.test.js` "noDataCount is capped at 5"). Functionally harmless above 5 but inconsistent. One-line change + one test case.

2. **End-to-end integration test joining route + classifier** (review finding M-2). The current proof of the first #269H acceptance bullet ("coin is marked dormant after 2 consecutive 422s and excluded from subsequent passes") is transitive: PR #132 tests assert `noDataCount=2`, separate classifier tests assert `noDataCount>=2 + recent noDataAt -> isDormant -> shouldSkipRefresh skip=true`. Add one test (`__tests__/terapeakImport422DormancyIntegration.test.js`) that posts two 422s with the real `terapeakService` against a temp store, then calls `freshnessClassifier.classify` and `shouldSkipRefresh` on the resulting meta and asserts `isDormant: true` and `{ skip: true, reason: 'dormant' }`. ~30 lines.

3. **Wrap `/report-no-data` `updateDatasetMeta` in try/catch** (review finding m-1). The prior-art handler at `src/routes/terapeakRoute.js:405` does NOT wrap its `updateDatasetMeta` call -- if the meta-write throws, the route returns 500. Should mirror the throw-safety pattern from `_stampNoDataMeta` and return 200 (or 500-with-context) instead of leaking the storage error to the python client. One try/catch + one test case.

4. **`/report-no-data` regression test** (review finding m-2). The endpoint has zero test coverage today. Add `__tests__/terapeakReportNoDataRoute.test.js` with 4 cases: 400 on missing searchTerm, 200 + meta-write on new dataset, 200 + increment on existing entry with noDataCount=1, payload shape unchanged. Reuses the mock pattern from `__tests__/terapeakImport422SelfHeal.test.js`. ~50 lines.

**Acceptance:**
- Items 1 + 3 land as code changes in `src/routes/terapeakRoute.js`.
- Items 2 + 4 land as new test files.
- `npm test` passes with all 4 changes applied.
- No regression in the 10 cases already shipped in `__tests__/terapeakImport422SelfHeal.test.js`.
- Pre-existing failing suites (`freshnessReport`, `freshnessReportDeepPaginate`, `imageProxyRoute`) remain out of scope -- track separately.

**Files (expected):**
- MOD `src/routes/terapeakRoute.js` (cap + try/catch)
- NEW `__tests__/terapeakImport422DormancyIntegration.test.js`
- NEW `__tests__/terapeakReportNoDataRoute.test.js`
- MOD `__tests__/terapeakImport422SelfHeal.test.js` (one extra case for the cap)

**Sizing:** ~150 lines total. Could ride along with Wave 2 (silent-drift suite) or Wave 3, or land as a quick standalone PR between waves.

**Related:**
- #269H (parent fix) -- now closed.
- Wave 2 / Wave 3 of the senior-QA test plan -- these followups should not block the silent-drift suite.

---

### #273H. `auditDuplicateKeys` <-> `identifierPersistence` jest-worker race on `data/terapeak-meta.json` [P2 -- TEST-INFRA / CI-FLAKE] -- DONE 2026-06-18 (PR #153)

**Resolution (PR #153, merge commit `f8ce824`):** Shipped fix #1 from the options list (preferred). Added a `_resolveMetaSidecarPath()` hook in `src/services/terapeakService.js` (`process.env.META_PATH || path.join(__dirname, '../../data/terapeak-meta.json')`) and the same env hook on `scripts/generate-freshness-report.js`. New `__tests__/setup/meta-path.js` jest `setupFiles` entry creates a per-worker tmpdir, seeds it with the real meta file, and points `process.env.META_PATH` at the tmp copy. `__tests__/freshnessReport*.test.js` updated to pass `env: process.env` explicitly to `execFileSync` (jest sandboxes `process.env`, so child processes do NOT inherit `setupFiles` mutations by default). `__tests__/identifierPersistence.test.js` prefers `process.env.META_PATH` for its direct writes. `package.json` registers the setup hook and ignores `__tests__/setup/` from test discovery. `__tests__/auditDuplicateKeys.test.js` and `scripts/audit-duplicate-keys.js` were intentionally left untouched -- both stay pointed at the real repo path as the canary. Verification at merge: targeted META suites (9 files, 154 tests) x20 with `--maxWorkers=auto` -> 20/20 green; full suite 3x back-to-back -> 3923/3923 each; `data/terapeak-meta.json` sha256 unchanged before vs after each full run.

**Origin:** Three Dependabot PRs in a row (#123 eslint, #134 Wave 2 Batch G, #125 csv-parse 7.0.0) have failed CI on the *exact same* assertion -- `__tests__/auditDuplicateKeys.test.js:53` `expect(metaHashAfter).toBe(metaHashBefore)` -- despite the change under review having zero relationship to `audit-duplicate-keys.js` or to the meta sidecar. Each time, the suite passes when run in isolation (`npx jest __tests__/auditDuplicateKeys.test.js` -> 5/5 green), and each PR was force-merged with `--admin`. The pattern is now a tax on every dependency bump and any future PR that happens to spin up the right worker layout.

**Root cause (verified):**

- `__tests__/auditDuplicateKeys.test.js` is intentionally a read-only safety probe: it `sha256`s `data/terapeak-meta.json` in `beforeAll`, runs the audit script, then `sha256`s it again in the `does NOT mutate data/terapeak-meta.json` test and asserts equality (see lines 12, 21-27, 50-53).
- `__tests__/identifierPersistence.test.js` writes the **same file path** (`path.join(__dirname, '../data/terapeak-meta.json')`, line 10) at lines 108 and 127 to set up fixtures, and restores the original in `afterAll`.
- Jest defaults to parallel workers. When the two suites land on different workers and overlap, the identifierPersistence write lands between the audit suite's `beforeAll` hash and its `metaHashAfter` hash -- producing the deterministic `Expected: ffc3e0e4... Received: 8335b521...` failure seen in the CI logs (job 81730207197). Same hashes on every reproduction confirms it is a write race, not a stochastic data corruption.

**Other suites currently entangled in the same shared-fixture surface area (they go flaky together):**
- `__tests__/imageProxyRoute.test.js`
- `__tests__/freshnessReport.test.js`
- `__tests__/freshnessReportDeepPaginate.test.js`
- `__tests__/terapeakDataIntegrity.test.js`
- `__tests__/terapeakImportEviction.test.js`
- `__tests__/mergeDuplicateKeys.test.js`

All pass cleanly when run in isolation. The root cause for each is the same class: production code paths under test read or hash repo-root state files (`data/terapeak-meta.json`, `cache/*.json`) while sibling tests write them.

**Acceptance:**

Pick one of the three fixes below. Any one of them closes the issue; preference order is 1 > 2 > 3.

1. **`META_PATH` env override + tmpdir** (preferred -- ~30 lines, no perf cost). Add a `META_PATH` env-var hook to `src/services/terapeakService.js` (`META_SIDECAR_PATH = process.env.META_PATH || path.join(__dirname, '../../data/terapeak-meta.json')`) and route every test that writes the sidecar (`identifierPersistence`, the two `freshnessReport*` suites, anything in the entangled list above) through `fs.mkdtempSync` + `process.env.META_PATH = tmpFile` in `beforeAll`. The `auditDuplicateKeys` suite stays pointed at the real repo path -- but no other worker can touch it because no other test still writes there.

2. **Jest project group with `--runInBand` for shared-fixture suites** (~10 lines `jest.config.js` change). Move the entangled suites into a `projects: [{ displayName: 'shared-fixtures', testMatch: [...], maxWorkers: 1 }, { displayName: 'unit', testMatch: ['<rootDir>/__tests__/**/*.test.js'] }]` layout. Cheaper to ship but trades CI speed for safety.

3. **Move the audit's `beforeAll` snapshot inside the test** + use a content-equal compare against an in-memory copy taken just before `runScript()`. Robust but adds an extra read per test run and only fixes the audit suite -- the other six suites remain flaky.

**Verification:**

- Reproduce: run `npx jest __tests__/identifierPersistence.test.js __tests__/auditDuplicateKeys.test.js --maxWorkers=2` (no `--runInBand`) in a loop of ~10 invocations on `main` -- expect at least one failure with `Expected ffc3e0e4... Received 8335b521...`.
- Fix is good when: same loop produces 10/10 green AND `npm test` (full suite) shows zero auditDuplicateKeys failures across 5 consecutive runs.
- Adversarial: the next Dependabot PR (whichever lands first after the fix) must reach all-green CI without `--admin` override.

**Files (expected, fix #1):**
- MOD `src/services/terapeakService.js` (env-var hook, one line)
- MOD `__tests__/identifierPersistence.test.js` (route writes to tmp path)
- MOD `__tests__/freshnessReport.test.js` and `freshnessReportDeepPaginate.test.js` (same)
- MOD `__tests__/terapeakDataIntegrity.test.js`, `terapeakImportEviction.test.js`, `mergeDuplicateKeys.test.js` if they also write the sidecar
- No change to `__tests__/auditDuplicateKeys.test.js` -- it stays as the canary

**Sizing:** ~80-120 lines depending on how many sibling suites need rerouting. Standalone PR; should not ride along with feature work.

**Related:**
- PR #123 (eslint bump) -- merged with `--admin`, CI red on this exact failure.
- PR #134 (Wave 2 Batch G) -- initial CI red on same failure, passed on retry.
- PR #125 (csv-parse 7.0.0) -- merged with `--admin` 2026-06-16, CI red on same failure.
- Job that exhibits the canonical failure: `https://github.com/Eloso-chi/coin-price-finder-agent/actions/runs/27637987660/job/81730207197`.

---

### #274H. `dedupeRecords` merge-strategy decision -- first-wins silently discards corrected re-scrape payloads [P3 -- CORRECTNESS / DATA-QUALITY] -- DONE 2026-06-19 (PR #165)

**Resolution (PR #165, merge commit `4076e95`):** Shipped **option 3 (field-merge)** per user decision. `dedupeRecords` in `src/services/auctionPriceService.js` now does: when two records share the `LotNo|Auctioneer|Date|Price` key, non-null/non-undefined fields from the incoming record overwrite the existing values; null/undefined incoming fields do NOT clobber existing non-null values. Existing records are shallow-cloned before merge so caller arrays are not mutated in place. Intra-incoming key collisions also field-merge into the first record. The `added` counter unchanged (collisions still don't count as new). Falsy-but-defined values (`0`, `""`, `false`) ARE treated as present and win -- only `null`/`undefined` are 'absent'. Test `__tests__/auctionDedupCollision.test.js` "records sharing the key but differing in non-key fields" rewritten to assert the new field-merge contract; FOUR new cases added (null/undefined preservation, falsy-but-defined wins, shallow-clone contract, intra-incoming field-merge). Verification at merge: 32/32 in collision + errorPaths suites, 3995/3995 full suite. Deep review on the fix returned APPROVED FOR MERGE with zero S1/S2 findings; two S3 follow-ups logged but not blockers (monitoring-threshold sanity-check and end-to-end Heritage re-grade integration test).

**Origin:** Surfaced by the retroactive deep review of PR #135 (Wave 3 test build-out, finding S3 in `__tests__/auctionDedupCollision.test.js`).

**Issue:** `src/services/auctionPriceService.js:156` (`dedupeRecords`) keys auction records on `LotNo|Auctioneer|Date|Price`. When two records share the same key but differ in non-key fields (e.g., the second scrape carries a corrected grade `MS66` instead of the originally-misread `MS65`), the **existing record wins** and the incoming corrected payload is silently dropped. The Wave 3 test `auctionDedupCollision.test.js` "records sharing the key but differing in non-key fields are dedup'd" documents this behavior as a contract, but the deep review flagged that it is more likely a latent bug than a desired contract.

**Concrete consequence:** Heritage / Stack's Bowers occasionally re-publish corrected metadata (grade, holder, lot description) after the auction closes. The first scrape captures the original; a follow-up pull intended to refresh metadata is a no-op because `dedupeRecords` discards the corrected payload. The user sees stale grade/holder values for the affected lots.

**Decision required:** Pick ONE of:

1. **Keep first-wins** (current behavior). Acceptable only if the team confirms that auction houses' post-close edits are not relevant for valuation. Update the test comment in `__tests__/auctionDedupCollision.test.js` to make the intentional choice explicit.

2. **Switch to last-wins.** Trivial change (~3 lines) -- replace the `keySet` short-circuit with an "overwrite existing index" pass. Risk: a stale or partial re-scrape could overwrite richer data with thinner data.

3. **Field-merge** (preferred if any auction metadata is actionable). For records sharing a key, prefer non-null incoming values field-by-field over existing values. Slightly more code (~15-20 lines), preserves the richest payload across multiple pulls.

**Acceptance:**

- Decision documented in this entry and in `src/services/auctionPriceService.js` above the `dedupeRecords` function.
- If option 2 or 3 is chosen, `__tests__/auctionDedupCollision.test.js` test "records sharing the key but differing in non-key fields are dedup'd" is rewritten to assert the new contract (corrected `grade: 'MS66'` wins, or non-null fields merge through).
- If option 1 is chosen, the existing test stays but the comment is rewritten to "INTENTIONAL: first-wins -- post-close auction edits are not consumed".
- No regression in `auctionPriceService.test.js`.

**Files (option 3, expected):**
- MOD `src/services/auctionPriceService.js` (`dedupeRecords` body + doc comment)
- MOD `__tests__/auctionDedupCollision.test.js` (rewrite the differing-payload test)

**Related:**
- PR #135 (Wave 3 test build-out) -- shipped the test that documents the current contract.
- Review report finding S3 #5.

---

### #275H. `mintages.normalizeSeries` throws TypeError on non-string input vs `pcgsNumbers.lookupPCGSNumber` returns null -- API contract inconsistency [P4 -- TECH-DEBT] -- OPEN 2026-06-16

**Origin:** Surfaced by the retroactive deep review of PR #135 (Wave 3 test build-out, finding S3 in `__tests__/dataFileIntegrity.test.js`).

**Issue:** Two adjacent data-lookup APIs in the same domain have opposite defensive behavior for non-string `series` arguments:

- `src/data/mintages.js:2233` (`normalizeSeries`) -- does `series.toLowerCase()` without an `instanceof String` / `typeof` check. Crashes with `TypeError: series.toLowerCase is not a function` for non-string non-nullish input.
- `src/data/pcgsNumbers.js:819` (`lookupPCGSNumber`) -- does `String(series).trim()` internally, so non-string inputs are tolerated and return `null` gracefully.

Reproducible by `lookupMintage(123, 1921, 'P')` vs `lookupPCGSNumber(123, 1921, 'P')`.

**Concrete consequence:** If any caller ever passes a non-string `series` (e.g., a route reads `req.query.series` and receives an array because the client sent `?series=a&series=b`, or a downstream pipeline forwards a number), `lookupMintage` 500s the whole request while `lookupPCGSNumber` quietly returns null. The inconsistent behavior makes it hard to write a single defensive caller.

**Fix:** Add a `typeof series !== 'string'` guard at the top of `normalizeSeries`:

```js
function normalizeSeries(series) {
  if (!series || typeof series !== 'string') return null;
  const s = series.toLowerCase().trim()
    // ...rest unchanged
}
```

**Acceptance:**

- One-line guard added to `src/data/mintages.js#normalizeSeries`.
- `__tests__/dataFileIntegrity.test.js` "throws TypeError for non-string series" test rewritten to assert `lookupMintage(123, 1921, 'P').mintage === null` instead of `.toThrow(TypeError)`.
- `__tests__/dataFileIntegrity.test.js` "normalizeSeries accepts nullish and string inputs without throwing" test extended to cover non-string non-nullish (e.g., `normalizeSeries(123)` -> null).
- No regression in `mintages.test.js`.

**Sizing:** ~1 line of production change, ~6 lines of test rewrite. Low priority -- bug is only reachable via caller error today.

**Related:**
- PR #135 (Wave 3 test build-out) -- shipped the test documenting the current (inconsistent) behavior.
- Review report finding S3 #6.

---

### #277H. Colorized / specialty-variant coins -- end-to-end disambiguation, comp filtering, and FMV math [P2 -- FEATURE / PRICING-ACCURACY] -- Phases 1-2 DONE 2026-06-21; Phases 3-4 OPEN

**Origin:** Conversation 2026-06-16 after 25-coin pricing-health run. Question: "how should we deal with colorized coins?" Triggered a full audit of how variant coins (colorized, gilded, privy, high-relief, antiqued, burnished, proof, reverse-proof) flow through search, dataset storage, comp filtering, and valuation.

**Numismatic context:** A mint-issued colorized 1 oz Silver Perth Lunar shares dies + silver content + face value with the BU sibling, but has 1/10 - 1/30 the mintage and retails at 2-5x spot vs the BU's 1.05-1.30x. Aftermarket "novelty" colorized coins (third-party-painted ASEs etc.) trade at a *discount* under base BU -- same word, opposite price direction. Sub-tiers (proof-colorized, gilded-and-colorized, full-color vs spot-color) add a second axis.

**Audit findings:**

- **G1. No UI variant picker.** [public/index.html](public/index.html) has no `<select>` for variant/label. Users must guess and type "colorized" into the free-text query for any of the downstream variant code to engage.
- **G2. Single Terapeak dataset per coin.** [src/services/terapeakService.js](src/services/terapeakService.js) keys by normalized search string; BU and colorized comps for the same coin commingle unless the original aggregator query already included "colorized". Sales aggregator + freshness report cannot see variant coverage separately.
- **G3. Variant filter treats all specialty variants as one bucket.** [src/services/ebayService.js](src/services/ebayService.js#L643-L688) and [src/services/ebayService.js](src/services/ebayService.js#L1079-L1118) score and hard-filter against a flat `VARIANT_TOKENS` array. A "colorized" search keeps "gilded" comps, distorting FMV across variant families.
- **G4. Valuation premium clamp is variant-blind.** [src/services/valuationService.js](src/services/valuationService.js#L173-L180) `bullion-spot-premium` mode caps silver premium at +100% and gold at +40%. Legitimate colorized 1oz Perth Lunars regularly retail $80-$180 vs $35-$40 spot -- a 2-5x premium that the clamp truncates. Systematic underestimate for variant coins.
- **G5. No mint-issue vs aftermarket distinction.** Aftermarket painted ASEs / Morgans pull a "colorized" search's FMV in the wrong direction.
- **G6. PCGS price guide not queried with the variant cert#.** Variant-specific wholesale anchor unused.
- **G7. "High filter attrition 65%" warning has no UX off-ramp** (observed on 2010 Perth Lunar Tiger deep-dive; FMV $65.17, range $37.94-$92.40, confidence 48/100). User sees the warning but has no path to disambiguate.

**Proposed phased approach** (each phase is its own PR; later phases depend on earlier ones for clean data):

- **Phase 1 -- Disambiguation at input (low risk).** Add a "Variant" `<select>` to the search form populated from a curated subset of `ALLOWED_LABELS` in [src/data/constants.js](src/data/constants.js#L80-L88): *Auto-detect (default), Standard (BU), Proof, Reverse Proof, Colorized, Gilded, Privy, High Relief, Antiqued, Burnished*. Wires into existing `req.body.label` pipe -- no server changes needed for the UI. When `label` is set, append a canonical token to the Terapeak dataset key so colorized comps land in their own bucket (old keys keep working alongside). Render a clickable variant chip on results.
- **Phase 2 -- Variant-aware comp filtering (medium risk). DONE 2026-06-21.** Refactor comp filtering in [src/services/ebayService.js](src/services/ebayService.js) to a **colorized-first policy**: hard filtering/scoring treats only colorized as a strong pricing variant. Rule: for non-colorized queries, filter out colorized comps; for colorized queries, keep colorized comps or plain BU and drop other specialty-family-only comps. Keep mint-issue vs aftermarket sub-classifier for colorized (+10 for "Perth Mint / RCM / Royal Mint / with COA / PCGS Colorized / NGC Colorized"; -10 for "novelty / painted by / custom / art coin / hand painted"). Privy remains informational metadata, not a hard FMV-separating filter.
- **Phase 3 -- Variant-aware valuation (higher risk).** Add `variantPremiumProfile` to [src/services/valuationService.js](src/services/valuationService.js) opts. When `label === 'Colorized'` and `isBullion`: raise `maxPremium` from 1.00 -> 5.00 for silver, 0.40 -> 2.00 for gold; use variant-filtered comp median only; if <5 variant-matching comps, return `null` FMV with `dataSource='insufficient-variant-comps'` (don't fall back to spot -- wrong number, not missing). Wire PCGS price-guide to use the variant cert# when `expected.finish === 'Colorized'`.
  - **Update 2026-06-19:** The proof-specific slice of this phase ships separately in #282H under a stricter contract: instead of widening `maxPremium` for proof, the engine now SKIPS the `bullion-spot-premium` branch entirely when proof / reverse-proof intent is set, using the existing proof-only comp pool via the standard comp-blend path (raw-blend / certified-blend).
  - **Update 2026-06-21:** Phase 3 rollout is now scoped to colorized-first valuation behavior. Privy stays informational (telemetry/explanation) unless later data proves a consistent FMV effect.
- **Phase 4 -- Dataset hygiene (pipeline).** One-time migration script: scan existing Terapeak datasets, split variant-heavy ones (>10% variant tokens) into variant-suffixed keys. Dry-run + audit + approval gate before write. Update `sales-aggregator.py` + `freshnessReport` to recognize the new keys.

**Recommendation:** Ship Phase 1 first as its own PR. Small, reversible, gives users disambiguation today, and starts collecting cleanly-tagged search data needed to validate Phases 2-4. Phases 2-3 depend on 1-2 weeks of variant-tagged comp data before tuning new premium ceilings.

**Open questions (deferred until pickup):**

1. Phase 1 only, or full roadmap approved as separate sequential PRs?
2. Variant labels beyond the curated 9 -- should "First Strike / Early Releases" be treated as FMV-affecting variants or are they slab-only?
3. Aftermarket novelty colorized handling -- exclude entirely from comps when `label='Colorized'`, or price in own bucket with different premium ceiling? Recommendation: exclude (safer until validated).
4. Does PCGS price-guide endpoint accept a designation filter, or must we maintain a local variant cert# map?

**Acceptance (Phase 1):**

- Search form exposes Variant `<select>` matching curated label subset.
- Selecting a variant routes to a variant-suffixed Terapeak dataset key (old keys still work).
- Result page shows clickable variant chip; clicking clears or swaps.
- Existing pricing-health 25-coin run remains GREEN (no regression on non-variant queries).

**Sizing:** Phase 1 ~150-250 lines (UI select + 1-2 small server wiring touches + dataset-key suffix). Phases 2-4 sized after Phase 1 lands.

**Related:**
- 2010 Perth Lunar Tiger deep-dive (this session) -- FMV $65.17, conf 48, "65% filter attrition" warning.
- [src/data/constants.js](src/data/constants.js#L80-L88) `ALLOWED_LABELS`.
- [src/services/ebayService.js](src/services/ebayService.js#L643-L688) variant scoring.
- [src/services/ebayService.js](src/services/ebayService.js#L1079-L1118) variant hard filter.
- [src/services/valuationService.js](src/services/valuationService.js#L169-L195) bullion-spot-premium clamp.
- [src/services/terapeakService.js](src/services/terapeakService.js) dataset keying.
- [src/utils/coinIntent.js](src/utils/coinIntent.js) `FINISH_CANONICAL` (already normalizes most variant words).

---

### #278H. `imageProxyRoute.test.js` `accepts .<ext>` cases hit live `en.numista.com` -- recurring CI flake [P2 -- TEST-INFRA / CI-FLAKE] -- DONE 2026-06-19

**Resolution (2026-06-19):** Fix shipped to `__tests__/imageProxyRoute.test.js` -- `https.get` is now stubbed at file scope (via a top-level `beforeAll`/`afterAll`), so any test in the file that reaches the upstream-fetch stage gets an immediate synthetic error and the route's error handler responds 502. The route's URL-parser, allowlist, and path-extension parser still run end-to-end; only the live network call is short-circuited.

The stub deliberately covers BOTH originally-failing test blocks:
- `path extension validation > accepts .<ext>` (6 cases) -- the direct flake source from PR #159.
- `SSRF host allowlist > allows en.numista.com` and `allows www.numista.com` (2 cases) -- same network-dependency profile, hadn't flaked yet but would have eventually (deep-review S3 finding rolled into the same PR).

The `upstream response handling` describe block is intentionally untouched -- it uses a real localhost `http.createServer` on 127.0.0.1, which the route reaches via `http.get` (not `https.get`), so the stub never intercepts it.

Verified:
- `npx jest __tests__/imageProxyRoute.test.js` -- 28/28 in 0.63 s (was 4.4 s pre-fix).
- Full suite `npx jest` -- 130/130 suites, 3981/3981 tests in 88 s (was 115 s; whole-suite speedup from eliminating network waits).

**Related:**
- #250 (Numista allowlist baseline -- DONE 2026-06-18).
- #273H (jest-worker race on `terapeak-meta.json` -- DONE 2026-06-18 PR #153). Same flake-class, different mechanism.

**Files:** `__tests__/imageProxyRoute.test.js`

---

### #279H. Page-1 export loop still blocks on synchronous upload per coin -- overlap upload with next scrape [P2 -- PERFORMANCE / SCRAPER] -- OPEN 2026-06-19

**Problem:** `scripts/terapeak-export.py` still uploads each CSV synchronously in the main page-1 loop (`ok, msg = upload_csv(...)`). The browser waits on network/API latency before starting the next coin. Deep pagination already has async upload overlap, but page-1 does not.

**Proposed change:**
1. Switch page-1 loop to use `upload_csv_async(...)` and drain with `drain_upload()` at safe boundaries.
2. Preserve current semantics for no-data/dormant progression (422 handling and `report-no-data`).
3. Add final guaranteed drain on all exits (normal completion, session-expired stop, crash stop).
4. Keep a fallback path: if async upload times out repeatedly, fall back to synchronous upload for remainder of run.

**Expected gain:**
- Overlap hides most per-coin upload wait.
- Estimated +5% to +15% end-to-end throughput in current loop shape.
- Practical pass-level savings: roughly 40 to 100 seconds for 27-35 coin passes, depending on API latency.

**Acceptance:**
- No ingestion regressions (new/dup counts remain stable vs baseline over matched sample).
- No lost final upload on early exit.
- Pass runtime reduced on A/B comparison over at least 3 passes each.

**Files:** `scripts/terapeak-export.py`

---

### #280H. Static "human behavior" delays are conservative and always-on -- add adaptive pacing by risk signal [P2 -- BOT-EVASION / PERFORMANCE] -- OPEN 2026-06-19

**Problem:** The scraper always applies heavy idle/scroll/pause behavior even when session health is stable. This reduces throughput substantially and may be overpaying for stealth on low-risk stretches.

**Proposed change:**
1. Introduce pacing modes (`normal`, `elevated`) driven by runtime risk signals.
2. Risk-up triggers: redirects/challenge hints, rising no-export streak, repeated timeout/crash, frequent 422/no-valid-comps for a block of terms.
3. In `normal`: shorten baseline delays and reduce extra idle/scroll loops.
4. In `elevated`: restore/increase current delays, add longer breaks, recycle browser sooner.
5. Expose env toggles for operators (`SCRAPER_PACING_MODE`, optional thresholds) with safe defaults.

**Expected gain:**
- Better average throughput without removing anti-bot behavior.
- Estimated +15% to +30% faster in stable sessions while retaining conservative fallback when risk rises.

**Acceptance:**
- No increase in bot-block stop frequency over a one-week observation window.
- Improved pass completion speed in stable windows.
- Logs show pacing mode transitions and trigger reason.

**Files:** `scripts/terapeak-export.py`, `scripts/sales-aggregator.py`

---

### #281H. Loop orchestration does redundant full freshness/report work and pure random queueing -- optimize for burn-down efficiency [P3 -- OPERATIONS / PERFORMANCE] -- OPEN 2026-06-19

**Problem:** The loop currently runs full sync/report cycles multiple times per pass and uses fully shuffled queue order. This helps randomness but leaves easy efficiency gains on the table for P0/P1 burn-down.

**Proposed change:**
1. Keep randomness but switch from pure shuffle to weighted shuffle (priority-aware random ordering).
2. Reduce redundant report generation when a stage made zero ingestion changes.
3. Optional cadence split: quick report every pass, full report every N passes.
4. Preserve current `--include-thin` and backlog semantics.

**Expected gain:**
- Lower per-pass orchestration overhead.
- Faster urgent backlog depletion without deterministic access patterns.
- Estimated +8% to +20% effective burn-down improvement (combined ordering + overhead reduction).

**Acceptance:**
- No change to classification correctness vs current freshness report.
- Measurable reduction in per-pass non-scrape overhead.
- P0 queue decline rate improves across comparable run windows.

**Files:** `scripts/run-surface-freshness-loop.sh`, `scripts/generate-freshness-report.js`, `scripts/terapeak-export.py`

---

### #282H. Proof valuation: skip spot-premium math, Greysheet anchor for BU fallback, weight sanity cap [P2 -- CORRECTNESS / PRICING-ACCURACY] -- DONE 2026-06-20 (PR #167)

**Origin:** 143-coin Libertad pricing-health run (cache/health-report-libertads-20260619-193020.json) returned 78 HEALTHY / 14 YELLOW / **51 RED**. The 51 REDs split into three root causes:

1. **30 proof Silver Libertads (1986-2025)** all collapsed to FMV $123-$129 regardless of date. Classifier `rp-melt-floor` flagged them: proof intent + >=10 surviving proof comps + method `bullion-spot-premium`. Root cause: `bullion-spot-premium` branch in [src/services/valuationService.js](src/services/valuationService.js#L173-L180) fires for any `isBullion=true` query and clamps premium to spot * 2 for silver / spot * 1.4 for gold. For proof coins whose real market price is $100-$500+ regardless of metal content, this silently truncates real collector premiums and collapses dozens of distinct dates to one number. The proof pool isolation gate (lines L80-86, added in #184 / #260W) was already correct -- the bug was that the spot-premium override ran AFTER pool selection and ignored the carefully-filtered proof comp median.

2. **"1000oz gold libertad" -> FMV $4,156,700.** Junk Terapeak dataset whose stored comp titles were all "L#NNNN 1/1000oz Gold ... Niue novelty" pieces selling for $21-$60. `detectWeightFromTitle` in [src/utils/coinMetalProfile.js](src/utils/coinMetalProfile.js) parsed "1000oz" -> 1000 troy oz, spotPrice = gold_spot * 1000, all 39 comps then dropped by meltFloor, fell to `bullion-spot-only` -> spotPrice ($4.15M). Casa de Moneda has never struck a 1000oz coin -- this is a typo / phantom dataset.

3. **Out of scope for this ticket:** 2024 Mexico 1 oz Gold Libertad shows 99/118 comps dropped as metalMismatch (silver comps polluting the gold dataset) and 2025 Silver Libertad Proof shows 84 prefilterStrikeSplit drops (year-too-new heuristic). Both are dataset-hygiene / prefilter tuning issues tracked separately.

**Numismatic context:** Numismatic premium for proof and reverse-proof coins is structurally decoupled from spot. Limited mintage + slab grade + key-date status set the price, not silver/gold spot. The spot+premium model is the WRONG model for proof, not just the wrong constant -- widening `maxPremium` would not fix it. Pool isolation already gives a clean proof-only ebayMedian; the engine just needs to use it.

**Approved changes (this PR):**

- **Fix 1 -- skipSpotMath gate.** Add `const skipSpotMath = wantsProof || wantsReverseProof;` near the blend section in [src/services/valuationService.js](src/services/valuationService.js). Guard BOTH the `bullion-spot-premium` gate (L173) AND the `bullion-spot-only` / `bullion-greysheet-anchor` fallback gate (L213) with `&& !skipSpotMath`. Proof traffic with proof comps flows to the comp-blend path (raw-blend / certified-blend) which correctly uses the proof-only ebayMedian + PCGS guide + Greysheet. Proof traffic with NO proof comps and no guide / Greysheet returns null FMV with a sharper explanation citing "no proof comps; BU not substituted (would give a wrong number, not a missing one)".

- **Fix 2 -- weight sanity cap.** Add `MAX_PLAUSIBLE_WEIGHT_OZ = 200` constant to [src/utils/coinMetalProfile.js](src/utils/coinMetalProfile.js) and guard the integer-oz match in `detectWeightFromTitle`. Returns `null` for anything above 200 oz rather than silently rewriting "1000oz" to 1000. 200oz ceiling is generous enough to accept any retail bullion bar (100oz silver is the largest commonly-listed; the 1-tonne Perth Mint gold coin is one-of-a-kind, not retail). Refusing is safer than silently rewriting user input -- callers fall through to other detection paths or treat weight as unknown.

- **Fix 3 -- Greysheet-anchor BU fallback ladder.** Revise the bullion-no-comps fallback in [src/services/valuationService.js](src/services/valuationService.js#L213) to a 2-step ladder (BU only; proof skipped by `skipSpotMath`):
  1. If `greysheetVal != null && greysheetVal >= spotPrice * 0.8` -> `fmv = 0.7 * greysheetVal + 0.3 * spotPrice`, method `bullion-greysheet-anchor`. Greysheet is dealer wholesale (CDN), licensed and curated; when it sits meaningfully above spot it represents a real, defensible bullion FMV. The 30% spot weight keeps the number responsive to metal-price moves. The 80%-of-spot guard rejects nominal / stale Greysheet rows that would drag FMV well below current metal value.
  2. Otherwise -> legacy `bullion-spot-only` (FMV = spot, 0% premium). Unchanged behavior for the case where no anchoring is possible.

- **Documentation updates (this PR):** This BACKLOG entry; cross-reference note in #277H Phase 3 (below) explaining that the proof-specific slice ships here instead of being folded into the larger variant-disambiguation phase; FMV-mode section in [docs/memory/decision-engine-spec.md](docs/memory/decision-engine-spec.md) updated to describe the new `bullion-greysheet-anchor` method and the proof skip-gate.

**Deferred (NOT in this PR):**

- One-off admin DELETE for the phantom "1000oz gold libertad" Terapeak dataset (operator action after merge).
- Dataset-hygiene investigation for 2024 Mexico 1 oz Gold Libertad metalMismatch drops.
- prefilterStrikeSplit tuning for 2025 (new-year) coins.

**Acceptance:**

- 30 `rp-melt-floor` RED proof Libertads disappear from the next pricing-health run. Some proof coins with very thin pools may newly surface as YELLOW low-confidence (honest reporting -- previously masked by the false-positive FMV).
- "1000oz gold libertad" row either drops to ~$40 with low confidence (Fix 2 reroutes weight detection) or is filtered out entirely.
- Non-regression: 50-coin random pricing-health stays all-HEALTHY; existing `bullion-spot-premium` BU tests continue to pass.
- New tests pin the contract: proof + 10+ comps avoids spot-premium; proof + 0 comps + no anchors returns null with explicit explanation; BU + no comps + Greysheet >= 80% spot uses `bullion-greysheet-anchor`; BU + no comps + no Greysheet stays on `bullion-spot-only`; 1000oz title returns null weight; 100oz / 200oz / kilo titles unchanged.

**Files:** `src/services/valuationService.js`, `src/utils/coinMetalProfile.js`, `__tests__/coinMetalProfileWeightCap.test.js` (new), `__tests__/valuationServiceProofLadder.test.js` (new), `docs/BACKLOG.md` (this entry + #277H note), `docs/memory/decision-engine-spec.md`.

**Related:**

- #184 (proof pool isolation -- the necessary precondition this PR builds on).
- #260W (reverse-proof pool routing -- same rationale, different tier).
- #277H Phase 3 (variant-aware valuation roadmap -- the colorized / specialty premium-clamp work; this PR ships the proof-specific slice early under a stricter contract).
- #188 (original `bullion-spot-only` fallback -- retained as the bottom of the new ladder).

---

### #283H. Proof / RP bullion uses 30-day half-life like BU -- should use 90-day (collector-paced, not metal-paced) [P3 -- PRICING-ACCURACY] -- DONE 2026-06-20 (PR #169)

**Resolution (PR #169):** Shipped the 5-line override per spec. `computeWeightedMedian` now accepts `wantsProof` and `wantsReverseProof` and computes `halfLifeDays = (isBullion && !wantsProof && !wantsReverseProof) ? 30 : 90`.  Proof / RP bullion now uses the 90-day numismatic curve; BU bullion retains the 30-day curve unchanged.  Both `computeValuation` call sites updated to pass the new flags through.

`computeWeightedMedian` was added to `module.exports` for unit testing (production callers continue to go through `computeValuation`).  11 unit tests added in `__tests__/valuationServiceProofHalfLife.test.js` pinning: (a) the helper's dispatch directly (BU/proof/RP/numismatic combinations + back-compat default args + empty-pool contract) and (b) end-to-end via `computeValuation` for proof / RP / BU intent.  Test scenario: 4 stable comps at $200 sold 200 days ago + 1 fresh outlier at $400 sold today -- under 30-day half-life the fresh outlier dominates (median $400); under 90-day half-life the older comps push back (median $200).  Pinned at 228/228 across all related suites.

**Deferred for future evidence (this PR ships the override only):** open questions 1-3 below remain open.  No "proof-fmv-jumpy" classifier added to `pricing-health` yet; deferred to a separate observability ticket if needed.

---

**[Historical context]**

**Origin:** Surfaced during #282H deep-review discussion. With #282H merged, proof / RP bullion traffic correctly routes through `raw-blend` / `certified-blend` using a proof-only `ebayMedian`. That median is computed by `computeWeightedMedian()` in [src/services/valuationService.js](src/services/valuationService.js#L634-L640), which sets the recency half-life from a single boolean:

```js
const halfLifeDays = isBullion ? 30 : 90;
```

Every bullion query -- BU Silver Eagle, BU Gold Maple, Silver Libertad **Proof**, **Reverse Proof** -- shares the 30-day half-life. The 30-day choice is correct for BU (a generic Silver Eagle is just silver; its price moves with spot), but wrong for proof / RP, which are collector products whose price is driven by mintage, slab grade, and date desirability -- not silver / gold spot. A 2010 Silver Libertad Proof was ~$250 in 2022 silver and ~$250 in 2026 silver.

**Recency weight comparison** (`recencyWeight = 1 / (1 + daysSince / halfLife)`):

| Comp age | `halfLife=30` | `halfLife=90` |
|---|---|---|
| 0 days | 1.00 | 1.00 |
| 30 days | 0.50 | 0.75 |
| 90 days | 0.25 | 0.50 |
| 180 days | 0.14 | 0.33 |
| 365 days | 0.08 | 0.20 |

**Failure modes** (each one is hypothetical until validated with a follow-up health pass; the catastrophic "$127 for every proof date" bug from #282H is already gone):

1. **Thin proof pool with one fresh outlier.** 8 proof comps in the last year, seven at $180-$210, one fresh Best-Offer sale at $400. Under 30-day half-life the $400 comp weighs 0.91 and the year-old $190 comp weighs 0.07 -- weighted median pulls toward the outlier. Under 90-day half-life the older comps push back ~3x harder.
2. **Stale-but-correct comps effectively discarded.** Low-mintage dates (1992 Gold Libertad Proof etc.) often have 4 comps in 12 months. Under 30-day, only the 1-2 most recent dominate, leaving an effective 1-2-comp sample -- no smoothing of buyer-specific noise.
3. **Temporary metal-spike contamination.** If silver spikes 20% in a month, BU Silver Libertad should rally 20% (correct). Proof Libertad historically does not. But the same comps-aging math is applied to both pools, so a proof query mid-spike heavily weights the in-spike sales and reports a phantom 15-20% proof premium that decays as soon as spot reverts.

**Why this didn't surface in #282H validation:** The `rp-melt-floor` classifier in [scripts/lib/pricingHealthClassifiers.js](scripts/lib/pricingHealthClassifiers.js) fires on `method === 'bullion-spot-premium'`. Once #282H reroutes proof traffic to `raw-blend`, the classifier stops looking. FMVs are no longer catastrophically wrong, just noisier than they should be in the most-recent-sale direction. We do not currently have a classifier that catches "proof FMV moved >X% in 30 days without a comparable comp-volume change".

**Proposed change** (5-line override at L640):

```js
const halfLifeDays = (isBullion && !wantsProof && !wantsReverseProof) ? 30 : 90;
```

(`wantsProof` / `wantsReverseProof` would need to be passed through `computeWeightedMedian`'s call sites at L132-133 since those flags currently live in the outer scope.)

**Acceptance:**

- Re-run `pricing-health-full --filter "Libertad Proof"` before and after the change; capture FMV-stability delta (date-to-date FMV variance should narrow).
- Non-regression: BU Silver Eagle / Gold Maple / etc. health classification unchanged (30-day half-life retained for them).
- Add unit test pinning that proof intent on bullion uses 90d half-life and BU on bullion uses 30d.

**Open questions (deferred to pickup):**

1. Is 90 days the right number, or should proof default to the same 90d as numismatics, or to a wider window (e.g. 180d) to handle low-mintage dates with sparse comp history? Probably needs evidence from a follow-up pricing-health pass before deciding.
2. Should this also widen for `bullion-multioz` (5oz / 10oz collector pieces) and proof-bar variants, or strictly proof / RP?
3. Add a "proof FMV stability" classifier to `pricing-health` first (so a regression from the half-life change is observable), or ship the engine change with a manual before/after diff?

**Recommendation:** Land #282H, run libertad pricing-health daily for a week to gather evidence of failure mode (1) or (2), then open this ticket as a separate small PR with the override + tests + before/after report. Do NOT bundle with #282H.

**Files:** [src/services/valuationService.js](src/services/valuationService.js#L132-L133) (signature update for `wantsProof` / `wantsReverseProof` passthrough), [src/services/valuationService.js](src/services/valuationService.js#L634-L640) (`halfLifeDays` calc), `__tests__/valuationServiceProofLadder.test.js` (extend), `scripts/lib/pricingHealthClassifiers.js` (optional new "proof-fmv-jumpy" classifier).

**Related:**

- #282H (proof skip-gate; necessary precondition that proof traffic actually reaches `computeWeightedMedian` instead of the spot+premium override).
- #184 (proof pool isolation).

---

### #276H. `pricing-health-full.js` mislabels missing-credentials as "pipeline-leak" -- pre-flight credential probe needed [P3 -- TOOLING / OPERATIONS] -- DONE 2026-06-16 (PR #140)

**Origin:** First 25-coin pricing-health run after fresh checkout on this workstation. Every coin reported `pipeline-leak (N teak -> 0 comps)` and `null-fmv`, suggesting filter attrition. Root cause was empty `.env` values for `EBAY_APP_ID`, `EBAY_CLIENT_SECRET`, and `PCGS_API_KEY` -- the comp path never ran. The "pipeline-leak" label was misleading because comps were not *dropped*, they were never *fetched*.

**Issue:** `scripts/pricing-health-full.js` has no pre-flight check that upstream APIs are reachable. A missing-credentials environment burns full run time and looks like a pricing-pipeline regression in the output report.

**Fix (shipped on `fix/pricing-health-credential-preflight`):**

- Added a single `/api/price` probe after the `/api/health` check. Inspects `probe.ebay.us.error.message` and `probe.pcgs.limitations[]` for "credentials not configured" / "API key not configured" patterns.
- If detected, prints a `=== CREDENTIALS MISSING ===` block listing each missing service and exits with code `2` (distinct from `1` = server-down).
- Added `--skip-credential-check` flag so Terapeak-only flows can still be tested when upstream auth is intentionally absent.

**Acceptance:**

- Running with empty `.env` exits 2 with the named services in the missing list.
- Running with valid credentials proceeds to the normal sample loop without observable overhead beyond one extra HTTP call.
- `--skip-credential-check` flag bypasses the probe.

**Sizing:** ~35 lines added in `scripts/pricing-health-full.js#main`. No production changes.

**Related:**
- PR #140 (merged 2026-06-16): `fix/pricing-health-credential-preflight` branch.

---

---

### #249. Unattended Scheduler for Local Scraper Path [P3 -- OPERATIONS] -- BACKLOG

**Status:** Deferred. Phase 1 (dual-path scraper -- Surface laptop + Codespace fallback) will be added first. This entry covers the optional automation layer that runs the scraper on a schedule once the manual workflow is validated.

**Why deferred:** Per operator request, manual `--run` invocations for the first ~2 weeks of the local-scraper rollout. Build operator confidence, observe Akamai/eBay session behavior on residential IP, tune batch size and cadence empirically. Only then automate.

**Goal:** Hands-off scraping run on the local machine that:
1. Runs `--check` first; bails (with non-zero exit + log line) if the session is challenged or expired.
2. Runs `--run --limit N` against the priority queue.
3. Logs to a rotating file under `~/cpf-scraper/logs/`.
4. Surfaces failures without spamming success (push notification on `--check` fail, daily summary email/Slack on completion -- optional).

**Platform-specific plans:**
- **Windows / Surface Laptop:** Task Scheduler entry triggered nightly at a configurable hour (default 03:00 local). Wakes-from-sleep optional via "Wake the computer to run this task." Battery: skip if on battery and below 30%.
- **Mac (future):** `launchd` plist under `~/Library/LaunchAgents/com.cpf.scraper.daily.plist` (sample sketched in chat history for #248 session). Runs at next wake if Mac slept through the scheduled time.
- **Linux (future):** systemd user timer + service unit.

**Out of scope:**
- Codespace-side scheduling -- the codespace path is explicitly travel-only / ad-hoc; never automated.
- Multi-account / multi-region. One scraper per local machine, one cookie jar per machine.
- Cloud-hosted scheduler (Azure Function, GitHub Actions). Defeats the residential-IP fix that motivates the local-path approach.

**Pre-requisites (must land first):**
- Dual-path scraper PR (next in line) -- introduces `COOKIE_FILE` env override, runbooks for Surface + Codespace paths, and `scripts/cookie-health-check.py`.
- 2 weeks of stable manual operation from the local machine.

**Risks / open questions:**
- Surface goes on the road with operator -> scheduled run targets the wrong network (hotel WiFi, tether). Mitigation: scheduled job checks egress IP against a known-good prefix before running; if mismatch, skip.
- Cookie jar rotation mid-batch -> partial batch could land on a degraded session. Mitigation: scheduler runs `--check` between every N coins, halts on first challenge.
- Operator forgets the scheduled job exists, queue dries up silently. Mitigation: daily heartbeat ping (low-priority alert if 24h with no scrape activity in Cosmos audit log).

**Estimate:** Small (~150 lines incl. PowerShell scheduler script, docs, the IP-prefix safety guard).

**Open question:** Notification channel. Operator preferences unknown -- email, Pushover, Slack webhook, Discord, Windows toast. Defer to implementation time.

---

### #248. Freshness queue leaks A + B -- Medium-conf low-vol probe + dry-confirmed-thin escalation [P2 -- DATA-QUALITY] -- DONE 2026-06-03 (PR #100)

**Status:** Fixed via two surgical changes that close gaps left by #245 Fix A and #247:
1. `evidence-probe` action -- Medium-confidence `is_low_volume_candidate` entries that have never been runtime-touched (`refreshCount === 0`) are demoted to a single P3 page-1 probe instead of being queued as P0/P1 refresh.
2. `dryConfirmedThin` escalation -- a single dry refresh (`refreshCount >= 1 && lastRefreshNewComps === 0`) on a thin market (`compCount < THIN_MARKET_THRESHOLD`) marks `marketDepth = 'confirmed-thin'` immediately, instead of waiting for `CONFIRMED_THIN_REFRESHES` (=3) cycles.

**Problem:** Two related leaks in the freshness queue, both made visible by the 2026-06-03 safe-176 batch audit (the user's question: "shouldn't some of these fractional silvers be low signal or dormant?"):
- **Leak A (Medium-confidence low-vol):** The High-confidence evidence gate from #245 Fix A only fires on `identifier_confidence === 'High'`. Medium-confidence entries (74 P0 in the 2026-06-03 report -- e.g. `2024 American Gold Eagle 1oz Bu`, `2013 China 1oz Gold Panda`, `1993 China Half Oz Silver Panda`) flow straight through into P0 refresh on every cycle, even though the evidence index already flagged them as probable low-volume. They are not yet provably low-volume (Medium != High), but they also do not deserve P0 treatment. The correct action is one cheap page-1 probe, then re-classify based on runtime data.
- **Leak B (slow confirmed-thin escalation):** Today a thin entry must accumulate `refreshCount >= 3` to be marked `confirmed-thin` and dropped to the 90-day cadence. If a single live refresh on a 5-comp entry adds 0 new listings, that is already definitive proof the market is structurally thin -- waiting for 2 more refreshes burns 2x quota with zero information gain. 917 entries in the 2026-06-03 report match this single-cycle-confirmable shape (`refreshCount=0, 0<compCount<10`); they will compound the queue every two months under the old logic.

**Trigger location:**
- `src/services/freshnessClassifier.js:classify()` -- the `marketDepth` derivation for `compCount < THIN_MARKET_THRESHOLD` only checks `refreshCount >= CONFIRMED_THIN_REFRESHES`.
- `scripts/generate-freshness-report.js` -- the priority-action chain only checks `isHighConfLowVol`, not `isMediumConfLowVol`.

**Hard-number evidence** (report generated 2026-06-03T00:15Z against `data/terapeak-meta.json` post-#247):

| Metric | Value |
|---|---|
| P0 entries total | 731 |
| P0 with `refreshCount = 0` | 731 (100%) -- all P0 today are evidence-hydrated, never runtime-touched |
| P0 with `identifier_source = historical_evidence_index` | 656 (90%) |
| P0 with `is_low_volume_candidate && confidence === 'Medium'` | **74** (these get demoted to evidence-probe/P3 by Leak A fix) |
| P0 with `is_low_volume_candidate && confidence === 'High'` | 0 (already handled by #245 Fix A) |
| All-priority candidates for single-cycle confirmed-thin (`refreshCount=0, 0<compCount<10`) | **917** (these will resolve to `confirmed-thin` after 1 probe instead of 3 under Leak B fix) |

**Top 5 examples (Leak A, would be demoted to evidence-probe/P3):**

| compCount | refreshes | searchTerm |
|---:|---:|---|
| 34 | 0 | 2006 Canada Half Oz Silver Maple Leaf |
| 66 | 0 | 2003 Mexico Tenth Oz Silver Libertad |
| 18 | 0 | 2024 American Gold Eagle 1oz Bu |
| 14 | 0 | 2013 China 1oz Gold Panda |
| 14 | 0 | 1993 China Half Oz Silver Panda |

**Top 5 examples (Leak B, would resolve to confirmed-thin in 1 cycle):**

| compCount | priority | identifier_source | searchTerm |
|---:|---|---|---|
| 1 | P3 | fallback_live | 2003 China Quarter Oz Gold Panda |
| 1 | P3 | fallback_live | 2006 Canada Twentieth Oz Gold Maple Leaf |
| 1 | P3 | fallback_live | 2019 Canada Half Oz Gold Maple Leaf |
| 1 | P3 | historical_evidence_index | Perth Lunar 1997 Ox Gold Half Oz |
| 1 | P3 | fallback_live | 2024 American Gold Eagle Half Oz Bu |

**Why it matters:**
- Leak A: 74 P0s per cycle wasted on entries the evidence index already half-flagged. Equivalent to a 10% phantom-budget tax on every P0 batch.
- Leak B: each affected entry burns 3x the quota and 3x the bot-detection exposure before settling on the same `confirmed-thin` verdict. Compounds in lock-step with the queue size.
- Both interact with PR #98 / migration #246: the cleaner the meta gets, the more these long-tail wastes dominate.

**Fix (two-part, surgical):**

1. `src/services/freshnessClassifier.js`:
   - New helper `_isMediumConfidenceLowVolEvidence(meta)` (parallel to existing `_isHighConfidenceLowVolEvidence`).
   - `classify()` market-depth branch: escalate to `confirmed-thin` if `refreshCount >= CONFIRMED_THIN_REFRESHES OR (refreshCount >= 1 AND lastRefreshNewComps === 0)`.
   - Export the new helper.
2. `scripts/generate-freshness-report.js`:
   - Mirror the `dryConfirmedThin` rule in market-depth derivation (so report and classifier stay in lock-step -- avoids the Fix-D-class wiring oversight).
   - After existing `evidenceLowVolSkip` branch, add `evidenceProbeNeeded = isMediumConfLowVol && refreshCount === 0` and a new action branch `{ actions: ['evidence-probe'], priority: 'P3' }`.

**Files:**
- MOD `src/services/freshnessClassifier.js` (~30 lines incl. helper, comment, classify() change, export)
- MOD `scripts/generate-freshness-report.js` (~20 lines incl. mirror of marketDepth logic + new evidence-probe branch)
- NEW `__tests__/freshnessReportEvidenceGates.test.js` -- 12 assertions covering: Medium-conf low-vol demotion at refreshCount=0, no demotion at refreshCount>=1, High-conf path unchanged, viable bullion unaffected, dryConfirmedThin at refreshCount=1 + lastRefreshNewComps=0, NOT dryConfirmedThin if lastRefreshNewComps>0, classic refreshCount>=3 path preserved, report-classifier parity, helper boundary cases.
- MOD `__tests__/freshnessReport.test.js` -- "LowSignalMarketData -- few comps" expectation updated: Medium-conf low-vol + refreshCount=0 now asserts `evidence-probe` (P3) instead of `monitor-refresh`. Behavioral change, not a regression.

**Expected impact:**
- 74 P0 entries -> demoted to P3 evidence-probe immediately (10% P0 queue reduction).
- 917 thin candidates -> resolve to `confirmed-thin` in 1 cycle vs 3 (~67% quota savings on the long-tail thin band over a refresh window).
- Note: evidence-probe at P3 is NOT run by default by `scripts/terapeak-export.py` (it only runs P0-P2 unless `--include-thin` is passed). That is the desired behavior -- probes are explicit, not automatic.

**Out of scope:**
- `Low` confidence evidence (none in current report). Same shape as Medium could be added later as `evidence-probe` if useful.
- Cosmos-hydrated entries. They have non-zero `refreshCount` so they bypass the evidence-probe gate naturally.
- Re-classifying entries that already passed through the old logic. The fix is forward-only; the next report regeneration will surface the corrected priorities.

**Sequence dependency:** None. Independent of PR #98 and #247 (which is already merged).

**Reference investigation (2026-06-03):** Counts derived inline from `cache/freshness-report.json` (4,666 datasets):
```js
const r = require('./cache/freshness-report.json').datasets;
const p0 = r.filter(d => d.priority === 'P0');                                  // 731
const p0LowVolMed = p0.filter(d => d.identifiers?.is_low_volume_candidate && d.identifiers?.identifier_confidence === 'Medium'); // 74
const probeCandidates = r.filter(d => d.priority !== null && (d.refreshCount || 0) === 0 && d.compCount > 0 && d.compCount < 10); // 917
```

---

### #247. Deep-Paginate Over-Triggers on Evidence-Hydrated Entries [P2 -- DATA-QUALITY] -- DONE 2026-06-02

**Status:** Fixed via 1-line gate change in `scripts/generate-freshness-report.js` (added `&& refreshCount >= 1`). Regression coverage in `__tests__/freshnessReportDeepPaginate.test.js` (4 cases incl. the critical Python-stamped `lastRefreshAt`-only case). Live verification: `deep-paginate` count dropped 407 -> 0 immediately. The 407 entries remain queued via `refresh` and will graduate to deep-paginate naturally on the next cycle once `refreshCount >= 1`.

**Problem:** Freshness triage flags 407 datasets as `deep-paginate` even though they have **`refreshCount = 0`** -- the runtime scraper has never successfully touched them. Their `compCount` values (50-587) come entirely from the `historical_evidence_index` hydration, not from a live page-1 fetch. Deep-paginating them risks spending budget on multi-page scrapes against eBay searches whose underlying listings may no longer exist / may have been re-keyed.

**Trigger location:** `scripts/generate-freshness-report.js:315` (gate `if`; line 314 is the comment)
```js
if (compCount >= 50 && !hasDeepAt && marketDepth === 'viable') {
  actions.push('deep-paginate');
}
```
The gate trusts `compCount` regardless of whether it came from runtime data or evidence-index hydration.

**Hard-number evidence** (report generated 2026-06-02T02:16Z against `data/terapeak-meta.json` at commit `6ce0784`, post-#245):

| Metric | Value |
|---|---|
| Total `deep-paginate` flagged | 407 |
| Of those, `refreshCount = 0` | 407 (100%) |
| Of those, `identifier_source = historical_evidence_index` | 407 (100%) |
| Of those, `hasDeepAt = true` | 0 (gate correctly suppresses re-deep) |
| Of those, `lastRefreshAt` set but `page1At` null (Python-stamped only) | 217 (53%) |
| Of those, neither `lastRefreshAt` nor `page1At` set (pure evidence hydration) | 190 (47%) |
| compCount distribution | 50-99: 213 \| 100-199: 74 \| 200-499: 119 \| 500+: 1 |

**Top 5 examples (all `refreshCount=0`, all `deepAt=null`, all sourced from evidence index):**

| Comps | newestSale | Term |
|---|---|---|
| 587 | 2026-05-02 | Silver Round 1oz Generic |
| 387 | 2026-05-02 | Australian Lunar Silver 1oz Generic |
| 332 | 2026-05-01 | 1982 Mexican Silver Libertad 1oz |
| 325 | 2026-05-03 | Chinese Silver Panda 1oz Generic |
| 323 | 2026-05-?? | Perth Lunar 2016 Monkey Silver 1oz |

The comp counts are *plausible* (these are very common eBay listings) -- this is not a bad-data problem. It's a **dispatch sequencing problem**: deep-pagination should only fire after the cheap page-1 refresh has confirmed the listings still exist on the live marketplace.

**Why it matters:**
- Wastes scrape budget: a deep-pagination run is 5-10 page-loads vs. 1 for page-1.
- Risks bot-detection bursts on stale search terms (cf. INC-004).
- If the evidence-hydrated `compCount` doesn't match what eBay currently surfaces, the deep scrape will dredge up either nothing (wasted) or noise (wrong listings under a re-keyed search term -- cf. #246 duplicates).

**Fix (small):** Add `refreshCount >= 1` to the deep-paginate gate in `scripts/generate-freshness-report.js`:
```js
// Deep-paginate: viable + >=50 comps + not yet deep-paged + at least one runtime-confirmed page-1
if (compCount >= 50 && !hasDeepAt && marketDepth === 'viable' && refreshCount >= 1) {
  actions.push('deep-paginate');
}
```

**Do NOT use `entry.page1At` as the gate.** It is *not* equivalent to `refreshCount >= 1`. The JS terapeak route writes `page1At`; the Python scraper's report path writes only `lastRefreshAt`. Post-Fix D (PR #86), `refreshCount` increments on *either* signal, so it is the canonical "has been runtime-touched" marker. Of the 407 flagged entries, 217 (53%) have `lastRefreshAt` only -- gating on `page1At` would still over-trigger on every one of those. This is the exact wiring-oversight class of bug logged as INC-011; do not repeat it.

After the cheap page-1 refresh runs on these entries (which they're already queued for via `refresh` / `refresh-urgent`), they naturally graduate to `deep-paginate` on the next report -- in the correct sequence.

**Expected impact:** 407 -> ~0 `deep-paginate` immediately. The 407 stay in the `refresh` queue (where they already also are -- the current report shows their action as `refresh+deep-paginate`, so neither goal is lost). Over the next 1-2 scrape cycles, the ones that genuinely have viable depth will re-enter `deep-paginate` legitimately with `refreshCount > 0`.

**Files:**
- MOD `scripts/generate-freshness-report.js` (1-line gate change)
- NEW `__tests__/freshnessReportDeepPaginate.test.js` -- four assertions:
  1. `refreshCount=0, compCount=500, deepAt=null, page1At=null, lastRefreshAt=null` (pure evidence hydration) -> action does NOT include `deep-paginate`.
  2. `refreshCount=0, compCount=500, deepAt=null, page1At=null, lastRefreshAt=<recent>` (Python-stamped only, 53% of current flagged set) -> action does NOT include `deep-paginate`. **Critical regression case** -- gating on `page1At` instead of `refreshCount` would let this through.
  3. `refreshCount=1, compCount=500, deepAt=null` -> action DOES include `deep-paginate`.
  4. `refreshCount=0, compCount=500, deepAt=null, page1At=null, lastRefreshAt=null` -> action set still includes the pre-existing `refresh` (or `refresh-urgent`) entry. The fix must be surgical to the `deep-paginate` push and not affect other actions.
- Verify: re-run `node scripts/generate-freshness-report.js`, expect "deep-paginate" count to drop from 407 to a small number (whatever subset has `refreshCount >= 1` and no `deepAt`).

**Out of scope:**
- Cosmos-hydrated entries are also evidence-only-ish but they at least come from a prior runtime scrape, so they have non-zero `refreshCount`. No change needed there.
- Don't fix in `freshnessClassifier.js`'s `shouldSkipRefresh()` -- this is a report-only action, not a skip decision. The classifier doesn't currently emit `deep-paginate`; only the report does.

**Sequence dependency:** None. Can land independently of #246.

**Reference investigation (2026-06-02):** A one-off node script (not committed, lived in tmpfs during the diagnostic session) loaded `cache/freshness-report.json`, filtered for entries whose `actions` array contained `deep-paginate`, then cross-referenced each against `data/terapeak-meta.json`. Findings: 100% of the 407 flagged had `refreshCount=0` and `identifier_source=historical_evidence_index`. The 217/190 split between `lastRefreshAt`-only and pure-evidence is reproducible by walking the same JSON pair. To re-derive: load both files, filter the report by `(e.actions || []).includes('deep-paginate')`, then for each filtered key check `meta[key].lastRefreshAt` and `meta[key].page1At`.

---

### #185. World Proof Greysheet Year-Specific Fallback [LOW -- DEFERRED]

**Status (May 31, 2026):** Considered for the #24/#198/#185 PR batch but deferred -- design work needed to define the year-specific proof lookup API path (no clean way to construct a year-specific proof query without a PCGS number, which `fetchTypePrice()` doesn't have). Tracked here for future spike.

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

### #261W. Fractional Gold Maple Leaf -- 1/10 and 1/20 oz Pools Collide, FMV $4,987 (10-50x too high) [P1 -- BUG] -- DONE 2026-06-17

**Status:** Fixed in `src/services/ebayService.js`. Both the comp filter and the comp scorer now scale the melt-sanity ceiling by `expected.weight` instead of using a flat full-oz multiplier. Regression test added at [__tests__/fractionalGoldMeltCeiling.test.js](__tests__/fractionalGoldMeltCeiling.test.js) (13 cases covering filter, scorer, boundary, $50 floor, and 1 oz no-op).

**Symptom (discovered 2026-06-04 pricing-health top-100):**
- `Canada 1/10 Gold Maple Leaf`: FMV=$4986.93, conf=92, comps=145, method=`bullion-spot-premium`
- `Canada 1/20 Gold Maple Leaf`: FMV=$4986.93, conf=92, comps=145, method=`bullion-spot-premium`
- Expected: 1/10 oz ~$300-400, 1/20 oz ~$150-200 at June 2026 gold spot. Identical `compCount=145` for both confirmed the same pool was leaking through.

**Root cause (investigation):**
Hypotheses A (weight regex confusion) and B (greysheet map gap for 1/20 oz) were both ruled out:
- `detectWeightFromTitle` regex explicitly enumerates `(1/20|1/10|1/4|1/2)` -- correctly distinguishes them.
- Greysheet entry for 1/20 oz is missing (documented at `data/greysheetTypeMap.js#L50`) but Terapeak is the comp source for these queries, not Greysheet.

Actual cause: two parallel sites used a melt ceiling based on **full-oz melt** instead of **expected-weight melt**.

| Site | Old check | Effective ceiling at $5k/oz spot, 1/20 oz query |
|---|---|---|
| Filter `applyFilters` ~L1010-1024 | `meltPerOz * 1.8` | $9,000 (let 1-oz comps at $5k through) |
| Scorer `scoreMatch` ~L711-714 | `meltPerOz * 2` | $10,000 (no `price-exceeds-melt` penalty) |

For 1/20 oz queries, the old ceilings were `1.8 / 0.05 = 36x` and `2 / 0.05 = 40x` the **expected**-weight melt -- absurdly loose at any spot price; the bug only surfaced visibly once gold spot rose enough that 1-oz comp prices fell under the flat ceiling.

**Fix:**
```js
// Filter
const meltCeiling = Math.max(expected.meltPerOz * expected.weight * 5, 50);
// Scorer
if (comp.totalUsd > expected.meltPerOz * expected.weight * 5 && !detectWeightFromTitle(tLow)) { score -= 20; ... }
```

5x of expected-weight melt is generous enough for typical fractional premiums (1/20 oz gold often carries 100-300% premium over melt). $50 floor keeps the filter tolerant for cheap silver fractionals.

**Verification:**
- `__tests__/fractionalGoldMeltCeiling.test.js`: 13/13 pass
- `applyFilters` / `applyFiltersRegression` / `scoreMatchWeight` / `fractionalGoldMeltCeiling`: 117/117 pass
- Full suite: 3575/3576 (only #273H flake in `terapeakDataIntegrity`, unrelated, 105/105 in isolation)
- The pre-existing `applyFilters -- melt ceiling (fractional)` test at `__tests__/applyFilters.test.js#L149-162` still passes because the new `Math.max(..., 50)` floor (= $50) covers the silver-eagle 0.25 oz @ $30/oz case (raw = $37.50, floored to $50).

**Impact closed:**
- Fractional Gold Maple Leaf 1/10 and 1/20 oz pools no longer collide.
- Same fix applies generically to all fractional bullion: Gold Eagle, Britannia, Krugerrand, Panda fractional, etc.

**Related:** PR #33 (5% weight tolerance for filter), #266W (port same pattern to scorer -- this PR completes the filter+scorer parity by also fixing the melt-sanity branch in both), #244 (telemetry made the discovery possible).

**Files:**
- `src/services/ebayService.js` (filter + scorer, with `#261W` comment markers)
- `__tests__/fractionalGoldMeltCeiling.test.js` (new, 13 cases)

---

### #262W. pricing-health-full.js classifier misses obvious RED issues [P2 -- TOOLING] -- DONE 2026-06-17
- **Symptom**: `scripts/pricing-health-full.js` rated the top-100 run "HEALTHY" (99 GREEN / 1 YELLOW / 0 RED) when it should have surfaced at least 3 RED items:
  - 2023 Reverse Proof Morgan returning silver melt (caught only as YELLOW low-confidence; the 73%-below-expected FMV was not flagged).
  - Canada 1/10 and 1/20 Gold Maple Leaf returning identical $4986.93 (not flagged at all).
- **Root cause**: Classifier rules only flag `attritionPct > threshold` and `confidence < 30`. They do not:
  - Compare related-dataset FMVs (1/10 vs 1/20 vs 1/4 vs 1/2 should be monotonically increasing by weight).
  - Compare FMV to a sanity floor (e.g., RP Morgan should never return melt-only when 150 RP-tagged comps exist).
  - Cross-reference `dealerPremiums.js` benchmark bands (the #196 drift monitor exists separately but is not called from pricing-health-full).
- **Missing data point**: The "ADMIN_API_KEY required for `--full` mode" is not documented in `.github/agents/pricing-health.agent.md`. A missing key silently produces "0 datasets tested -> HEALTHY". Add a hard precondition check.
- **Proposed fix**:
  1. Add a fractional-collision check: for any pair of `{series, weight=A/B}` and `{series, weight=A/(B*2)}` datasets, flag RED if FMVs are within 1% of each other.
  2. Add a melt-floor sanity check: for any RP/proof intent with >=10 surviving Terapeak comps, flag RED if final FMV is within 10% of spot+5% (the bullion-spot-premium method should not win when proof comps exist).
  3. Integrate `dealerPremiums.js` band check directly (call `computePremium` and flag RED if outside the band).
  4. Hard-fail at startup if `--full` mode is set and `ADMIN_API_KEY` is unset.
  5. Update `.github/agents/pricing-health.agent.md` Prerequisites section to call out the env var.
- **Files**: `scripts/pricing-health-full.js`, `.github/agents/pricing-health.agent.md`.
- **Related**: #196 (dealer premium drift monitor), #261W (the fractional-gold finding this missed), #260W (the RP Morgan finding this only partially flagged).
- **Status (2026-06-17)**: All 5 sub-items shipped. Pure classifier logic extracted to `scripts/lib/pricingHealthClassifiers.js` for direct unit testing:
  1. `findFractionalCollisions` -- post-pass over all results; groups by `(metal, series)`, flags 2:1 weight pairs with FMV within 1%.
  2. `classifyRpMeltFloor` -- per-coin; flags RED when proof/RP intent + `usComps >= 10` + `method === 'bullion-spot-premium'`.
  3. `classifyDealerPremium` -- per-coin; calls `lookupPremiumRange` + `computePremium`; flags RED when realized premium is outside the band. Fail-quiet for queries whose series is not in the dealerPremiums coverage table (no false RED).
  4. Hard-fail at startup with `process.exit(3)` if `--full`/`--limit`/`--filter` is set without `ADMIN_API_KEY`. Distinct from server-down (exit 1) and creds-missing (exit 2).
  5. Agent doc Prerequisites + Analysis Rules sections updated with the env var requirement and the three new issue types.
- **Implementation**: NEW `scripts/lib/pricingHealthClassifiers.js`, MOD `scripts/pricing-health-full.js`, MOD `.github/agents/pricing-health.agent.md`, NEW `__tests__/pricingHealthClassifiers.test.js` (33 unit tests), MOD `__tests__/pricingHealthCredentialProbe.test.js` (+8 source-invariant assertions for the new wiring and hard-fail). Full suite: 118 suites / 3616 tests pass.

---

## Scraper Performance -- Additional Open Items

### ~~198. Smart SPA Render Wait Instead of 3s Hard Pause [DONE]~~

**Resolution:** Shipped in PR #67. Replaced the blanket `time.sleep(3)` after `networkidle` with `wait_for_results_render()` / `wait_for_research_page()` helpers in `scripts/terapeak-export.py` (selector-bounded wait keyed on `tr.research-table-header` for results and the keyword input for the research page). Worst-case wall-clock matches the original 3s sleep (used as fallback); typical case returns immediately on selector hit. `scripts/sales-aggregator.py` re-imports both helpers so both flows benefit.

**Files:** `scripts/terapeak-export.py`, `scripts/sales-aggregator.py`

---

### ~~199. Increase Browser Recycle Interval From 40/80 to 120 [DONE]~~

**Resolution:** Recycle threshold is now env-tunable via `BROWSER_RECYCLE_EVERY` in both scrapers. Defaults bumped conservatively:
- `scripts/terapeak-export.py`: 40 -> 80 (2x; matches the previous aggregator default)
- `scripts/sales-aggregator.py`: 80 -> 120 (1.5x, the backlog target)

Ops can override to any value (e.g., `BROWSER_RECYCLE_EVERY=40 python scripts/terapeak-export.py ...`) without code changes if memory pressure returns. Profile RSS in the next long run; raise both defaults further once stability is confirmed.

**Files:** `scripts/terapeak-export.py`, `scripts/sales-aggregator.py`

---

### 229. Align `/api/admin/stale-datasets` with Freshness-Report Exclusions [P1 -- blocks #228 -- DONE]

> Implemented in PR (this branch). Closed by commit `065dcb9`.

**Problem:** `src/services/adminService.js::getStaleDatasets()` (used by `/api/admin/stale-datasets` -> `scripts/refresh-stale.sh`) flagged datasets stale purely on `newestSaleDate < cutoff` and sorted by ageDays. It ignored every exclusion that `scripts/generate-freshness-report.js` applies:

- `noDataCount >= 2 && noDataAgeDays < 60` (dormant)
- `compCount < 10 && refreshCount >= 3` (confirmed-thin)
- `compCount < 10 && lastRefreshDays < 60` (thin-wait)
- `lastRefreshDays < 14` on stale/very-stale datasets (recently-confirmed-stale)
- `consecutiveDryRefreshes >= 2/4` within 30d/60d (dry-refresh-backoff tier 1/2)

**Impact:** Every `refresh-stale.sh` run wasted scrapes on datasets the freshness report would skip. With ~885 recently-confirmed-stale + ~438 dormant in current data, up to ~50% of the top-N stalest list was no-op work. Blocked #228.

**Fix:**
1. New `src/services/freshnessClassifier.js` exports `THRESHOLDS` + `classify()` + `shouldSkipRefresh(meta, now)` -> `{skip, reason, state}` -- single source of truth.
2. `getStaleDatasets()` calls `shouldSkipRefresh()` and filters skipped rows by default; attaches `skipReason` when present; new `summary.skippedCount` + `summary.skippedByReason`.
3. `/api/admin/stale-datasets` accepts `?includeSkipped=true`. `filterRegex` never includes skipped rows so `refresh-stale.sh` stays safe even with `includeSkipped=true`.
4. `generate-freshness-report.js` refactored to import thresholds from the shared classifier. Regression-verified byte-identical output.

**Tests:** 9 new in `__tests__/adminServiceStaleDatasets.test.js`. Pre-existing `adminService.test.js` + `adminRoute.test.js` updated. Full suite: 80 suites / 3052 tests pass.

**Files:** NEW `src/services/freshnessClassifier.js`, MOD `src/services/adminService.js`, MOD `src/routes/adminRoute.js`, MOD `scripts/generate-freshness-report.js`, NEW `__tests__/adminServiceStaleDatasets.test.js`, MOD `__tests__/adminService.test.js`, MOD `__tests__/adminRoute.test.js`, DOCS `README.md` + `docs/ARCHITECTURE.md`.

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

**Status notes:**
- Commit `567dc17` (May 30) refreshed 122 datasets as part of a general loop run -- NOT the targeted sweep.
- Commit `7ec679e` (May 31, "pass 1") refreshed 181 CSVs for #228. Breakdown vs meta-key totals:
  - **ASEs: 92 CSVs refreshed (target ~51) -- COMPLETE / exceeded.**
  - **Libertads: 79 CSVs refreshed (target ~131) -- PARTIAL (~60%).**
  - **Perth Lunars: only 17 of ~436 meta keys touched on May 31; 272 keys have never been scanned; 147 last scanned in April -- BARELY STARTED.**
- Pass 1 appears to have run ASE + Libertad to near-completion then only sampled a token slice of Lunars before terminating.
- **Still open.** Remaining work: ~52 Libertad gaps + Perth Lunar bulk sweep (419 remaining meta keys). Recommend running `python3 scripts/sales-aggregator.py --filter "Perth Lunar"` and `--filter "Lunar"` as a dedicated pass 2.

---

## Tooling & Observability

### #265H. Unified `cpf` launcher + agent-readable status for the Terapeak aggregator [P2 -- TOOLING/OBSERVABILITY] -- OPEN 2026-06-14
- **Problem**: Launching and monitoring the local Terapeak aggregator is fragmented and opaque. To start a run a human needs to remember the WSL distro, source `~/load-cpf-env.sh`, run `~/cpf-go` (with the right combination of `--no-login`, `--loop`, `--pause-between=...`, `--skip-deep`, `--include-thin`, `--focus`, etc.), then watch stdout for the ENTER-to-continue CAPTCHA prompt. To answer "is it still running and how far along is it?" the only signals are `ps`, the mtime of CSVs under `data/terapeak/`, and the `completed`/`failed` counters in `cache/terapeak_export_progress.json`. A Copilot agent (or a returning operator) cannot get a one-shot answer without re-deriving the architecture from the scripts each session -- exactly what happened in the 2026-06-14 chat session that surfaced this item.
- **Goal**: A single top-level name (`cpf`) that covers launch, status, logs, stop, login, and preflight; a structured status file so the agent reads progress in one read instead of inferring from filesystem side-effects; a Windows-side shim so PowerShell can call `cpf <verb>` without `wsl -d ...` quoting gymnastics (which broke twice in the same session, including stripping `&&`/`||` operators).
- **Proposed layers** (do in order; each is independently shippable):
  1. **Memory note** -- write `/memories/repo/aggregator-ops.md` documenting current commands, file locations, failure modes, and what each status value means. Zero code risk; benefits next agent session immediately.
  2. **Unified launcher** `scripts/cpf` (bash, ~150 LOC) dispatches to existing scripts. Subcommands: `start` (login + single pass), `run` (reuse cookies, single pass), `loop` (continuous), `status` (pretty-print the JSON below), `logs` (`tail -F`), `stop` (TERM the loop, wait for graceful exit), `login` (cookie refresh only), `doctor` (preflight: cookie age, server reachable, key set, disk space, Playwright Chromium present). Symlink at `~/cpf`. Does NOT modify existing scripts -- `cpf-go`, `surface`, `terapeak-export.py --login`, `sales-aggregator.py --run` keep working as-is for muscle memory and existing docs.
  3. **Tee logs** to `cache/cpf.log` (rotated daily, kept 7) so `cpf logs` and any agent have a known file to read instead of relying on terminal scrollback.
  4. **Windows shim** `scripts/cpf.ps1` (and a `.cmd` wrapper on PATH) so `cpf status` works from PowerShell -- and from any Copilot agent's `run_in_terminal` -- without the `wsl -d Ubuntu-24.04 -- bash -lc '...'` heredoc dance.
  5. **Structured status file** `cache/cpf-status.json` written on start, per-term, on-error, on-exit, plus a ~30s heartbeat. Schema (proposed):
     ```json
     {
       "state": "running",
       "phase": "page1-refresh",
       "pid": 406,
       "started_at": "2026-06-14T13:54:31Z",
       "last_heartbeat": "2026-06-14T14:02:07Z",
       "current_term": "1880 Morgan Silver Dollar MS65",
       "batch": { "index": 7, "size": 15 },
       "this_run": { "completed": 7, "failed": 1, "uploads_ok": 7, "uploads_failed": 0 },
       "cookies": { "path": "/home/athch/cpf/state/cookies-surface.json", "age_hours": 0.1 },
       "last_bot_strike": null
     }
     ```
     Allowed `state`: `idle | logging-in | running | sleeping | stopped | error | bot-detected`. Allowed `phase`: `page1-refresh | deep-pagination | sleeping | login`. Helper module `scripts/lib/status.py` shared by `terapeak-export.py`, `sales-aggregator.py`, and `run-surface-freshness-loop.sh`. Add unit tests for the helper.
  6. **(Optional)** `.vscode/tasks.json` entries for **CPF: Start / Status / Stop / Logs** so they live in the Command Palette. Skip if YAGNI.
- **Backwards compat**: All existing entry points (`cpf-go`, `./surface`, `python3 scripts/terapeak-export.py --run ...`, `python3 scripts/sales-aggregator.py --run ...`) keep working unchanged. `cpf` is purely additive.
- **Sequencing recommendation**: ship layer 1 (memory note) immediately; ship 2+3+4 (launcher + tee + PS shim) as one PR; ship 5 (status file) as a separate PR with its own tests; defer 6 unless asked.
- **Acceptance criteria**:
  - `cpf status` returns a one-screen summary in <1s, both from inside WSL and from Windows PowerShell.
  - A Copilot agent can answer "is the aggregator running, what phase, and what term?" with a single `cat cache/cpf-status.json` -- no `ps | grep`, no `ls -lt cache/...`, no inference from CSV mtimes.
  - `cpf doctor` exits non-zero with an actionable message when any preflight fails.
  - `cpf logs` shows the last 50 lines and follows new output.
  - Backwards-compat smoke: `~/cpf-go --no-login --loop` still works.
  - Status file write points are unit-tested (no live browser needed).
- **Files (when picked up)**: NEW `scripts/cpf`, NEW `scripts/cpf.ps1`, NEW `scripts/cpf.cmd`, NEW `scripts/lib/status.py`, NEW `/memories/repo/aggregator-ops.md`, edits to `scripts/run-surface-freshness-loop.sh` (tee log + status writes), `scripts/terapeak-export.py` (status writes at term boundaries + errors), `scripts/sales-aggregator.py` (status writes), optional `.vscode/tasks.json`.
- **Open questions to resolve before implementation**:
  - Confirm top-level name -- proposal is `cpf` (matches `~/cpf/` and the existing `cpf-go`); alternatives: `harvest`, `peak`, `comps`, `aggregate`.
  - Confirm scope for the first PR -- layers 1+2+3+4 bundled, or split further.
  - Branch name -- `chore/cpf-unified-launcher` proposed.
- **Status notes**: Surfaced in the 2026-06-14 chat session while running the aggregator end-to-end on the home (H) machine. The session itself hit the friction this item is designed to remove: (a) two PowerShell heredoc attempts had their `&&`/`||` and `if` blocks stripped before reaching WSL, requiring a temp-file workaround; (b) determining run status required ad-hoc probes of `ps`, `terapeak_export_progress.json`, and CSV mtimes instead of reading a single status file. Not blocking the current production aggregator runs.

---

### #264W. Per-machine backlog ID convention (W/H suffix) [P2 -- PROCESS] -- DONE 2026-06-04
- **Problem**: This project is worked on from two machines that may both add backlog items without coordinating. Without per-machine namespacing, the first new entry on each machine claims the same next-integer ID, forcing post-hoc renumbering (e.g., this session: drafted #260-#262, collided with PR #118's #260, renumbered to #261-#263, then again to #260W-#262W).
- **Fix**:
  - New top-level convention in `docs/BACKLOG.rules.md` ("Per-machine ID convention"): every ID from #264W onward carries a `W` (Codespace) or `H` (home workstation) suffix; the two series are independent.
  - `.machine-id` file at repo root holds the single letter; gitignored so it never travels in commits.
  - `scripts/machine-id.sh` reads the file, validates it (must be `W` or `H`), prints the letter on stdout; errors with a setup-instructions message on stderr if missing.
  - `.github/copilot-instructions.md` adds a one-line pointer so any Copilot agent reads the rule on session start.
  - `.github/agents/onboard.agent.md` Phase 0 adds a `.machine-id` existence check + a "next-in-series" scan that prints the next available `#NW` and `#NH`.
  - `.github/pull_request_template.md` adds a reminder line under "Backlog Reference".
- **Grandfathered**: All bare-number IDs (#1 .. #263) keep their bare form forever. No retroactive renames.
- **One-time setup per machine**: `echo W > .machine-id` (Codespace) or `echo H > .machine-id` (home). Verified working on this machine: `scripts/machine-id.sh` -> `W`.
- **Files**: `docs/BACKLOG.rules.md`, `.gitignore`, `scripts/machine-id.sh` (NEW), `.github/copilot-instructions.md`, `.github/agents/onboard.agent.md`, `.github/pull_request_template.md`.

---

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

### ~~193. Historical FMV Drift Monitor [DONE]~~

`scripts/fmv-drift-monitor.js` snapshots FMV for 20 benchmark coins (US + world bullion + bars + numismatic) to `cache/fmv-snapshots.json`. On each run, fetches spot via `/api/metals`, prices each benchmark via `/api/price`, compares against the most recent prior snapshot. Flags bullion drift >5% beyond spot movement and numismatic drift >15% (RED if 2× threshold). Premium-band outliers via #196 table. Keeps last 52 snapshots; exits 2 on RED finding for CI integration. `--no-save` for diagnostic runs, `--json` for machine output.

**Files:** `scripts/fmv-drift-monitor.js`, `src/data/dealerPremiums.js`

---

### ~~195. RRV (Retail Replacement Value) Calculation Mode [DONE]~~

`src/services/valuationService.js` L354-368 computes `rrv` from Greysheet CPG retail when available, falls back to spread-derived markup or default 20%. Returned in valuation payload at L421. Verified May 31, 2026.

---

### ~~196. Dealer Premium Benchmark Table for Bullion Anomaly Detection [DONE]~~

`src/data/dealerPremiums.js` exports `PREMIUM_RANGES` (29 rows covering ASE, AGE 1oz + fractional, Gold Buffalo, Maple, Krugerrand, Panda, Libertad, Britannia, Philharmonic, Kookaburra, Lunar, Platinum Eagle, plus generic 1g/small/1oz gold bars and 1oz/10oz/100oz silver bars). Helpers `lookupPremiumRange(parsed)`, `classifyPremium(premium, range)` → `low|normal|high|unknown`, and `computePremium(fmv, melt)`. Consumed by the #193 drift monitor for premium-outlier flags. 17 unit tests in `__tests__/dealerPremiums.test.js`.

**Files:** `src/data/dealerPremiums.js`, `__tests__/dealerPremiums.test.js`, `scripts/fmv-drift-monitor.js`

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

### ~~#24. Proof Libertad Search Quality [DONE]~~

**Problem:** `sales-aggregator.py` deep-pagination passed the raw `term` (e.g. `1986 Mexico 1oz Silver Libertad Proof`) to `do_search_and_collect()`, pulling in graded/slabbed eBay listings that diluted the raw-proof median. `terapeak-export.py` already mitigated this via `PROOF_NEGATIVE_KEYWORDS` (` -NGC -PCGS -graded -slab -certified`) appended to the `search_query` field of each candidate (lines 351-378). The deep-pagination path was missing this hop.

**Fix (May 31, 2026):** Added `PROOF_NEGATIVE_KEYWORDS`, `_GRADE_SUFFIX_RE`, `_PROOF_COIN_RE`, and `build_search_query()` to `scripts/sales-aggregator.py` (mirrors the `terapeak-export.py` constants). The deep-pagination loop now calls `do_search_and_collect(page, build_search_query(term), ...)` so raw-proof terms get the same exclusions in both the bulk export and the deep re-fetch. Already-graded terms (`MS65`, `PR70`, etc.) and `Proof Set` are intentionally excluded from augmentation.

**Files:** `scripts/sales-aggregator.py` lines ~170-195 (helpers), ~1112 (call site).

---

### ~~#198. Smart Render Wait (Replace `time.sleep(3)`) [DONE]~~

**Problem:** Both scrapers used blanket `time.sleep(3)` after page navigations and post-search waits (7 sites across the two files). Total scrape walks burned ~21s of fixed sleep per candidate even when the SPA rendered in <500ms.

**Fix (May 31, 2026):** Added two helpers to `scripts/terapeak-export.py` -- `wait_for_results_render()` (selector: `tr.research-table-header, [data-testid="no-results"], div.research-no-results, [class*="no-results"]`) and `wait_for_research_page()` (selector: `input[placeholder*="keyword"], input[placeholder*="MPN"], #researchKeywords`). Both wait up to 3000ms for the relevant DOM element with `state="attached"`, falling back to `time.sleep(3)` on timeout. Net effect: fast-path on healthy responses, identical worst-case on bot-throttled runs. `sales-aggregator.py` imports both helpers via `_mod.` Replaced 7 call sites: 3 in `terapeak-export.py` (post-login verify, post-search render, session verify), 4 in `sales-aggregator.py` (session check, page-1 results, pagination, launch verify).

**Files:** `scripts/terapeak-export.py` lines ~210-265 (helpers), 663, 912, 1414 (call sites); `scripts/sales-aggregator.py` lines 99-100 (imports), 416, 651, 788, 1088 (call sites).

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

### ~~218. verifyTokenStrict TTL Cache [DONE]~~

**Resolution:** Added module-level `_strictCache` (Map keyed by username) with default 5s TTL, env-tunable via `STRICT_TOKEN_CACHE_TTL_MS` (set 0 to disable). Fast-path lookup in `verifyTokenStrict` skips the Cosmos/file-store `getUser` round-trip when the cached `(userId, tokenVersion, isAdmin)` matches the JWT. Cache is invalidated on every `_saveUser` (covers grantAdmin/revokeAdmin/changePassword/resetPassword) and on `deleteUser`. Tested in `__tests__/authServiceStrictCache.test.js` (9 tests covering population, all invalidation hooks, userId-mismatch rejection, TTL=0 disable, and TTL expiry re-population).

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

### #265W. Rotate `ADMIN_API_KEY` + remove hardcoded fallback from `scripts/bar-pricing-health.js` [P1 -- SECURITY] -- OPEN 2026-06-17

**Problem:** The production admin API key value is exposed in git history via
a hardcoded fallback in `scripts/bar-pricing-health.js` line 14
(`const API_KEY = process.env.ADMIN_API_KEY || '<literal>';`, present since
commit `d6e0f17`). Anyone with read access to the repo or its fork history can
run `git log -p d6e0f17 -- scripts/bar-pricing-health.js` and recover the
value.

The key has been in Azure Key Vault (`coinpricefinder-kv`, secret
`ADMIN-API-KEY`, App Service Key Vault reference active) since 2026-04-16, so
the production lookup path was always safe -- but the script's fallback turned
local-tooling convenience into a permanent leak.

**Today's state (2026-06-17, after `docs/memory-corpus-migration` PR):**
- Live tree: value sanitized from `docs/memory/terapeak-runbook.md` and
  `docs/memory/terapeak-export-automation.md` (replaced with references to
  `.env` / `scripts/load-secrets.sh`).
- Live tree: value STILL present at `scripts/bar-pricing-health.js:14`.
- Git history: value present in all of the above + the original
  `/memories/repo/` snapshots (machine-local, gitignored, untouched).
- Backup: machine-local `/memories/repo/terapeak-*.md` on the W machine still
  contains the value, by design (backups are not edited).

**Fix (do all of the following in one PR, coordinated between W and H):**

1. **Generate new key** (32+ chars, URL-safe):
   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

2. **Update Azure Key Vault** -- creates a new secret version; the old version
   remains until explicitly disabled:
   ```bash
   az keyvault secret set \
     --vault-name coinpricefinder-kv \
     --name ADMIN-API-KEY \
     --value "<new value>"
   ```

3. **Restart App Service** to pick up the new value (Key Vault reference cache
   can otherwise lag up to 24 h):
   ```bash
   az webapp restart \
     --name coinpricefinder-h3a3b5g0dmdydna4 \
     --resource-group CoinPriceFinder_group-82d5
   ```

4. **Re-sync local `.env` on BOTH machines** (W and H) so local tooling keeps
   working:
   ```bash
   bash scripts/load-secrets.sh    # pulls fresh values from Key Vault
   ```

5. **Remove the hardcoded fallback** in `scripts/bar-pricing-health.js`. Make
   the script fail fast if `ADMIN_API_KEY` is not set, e.g.:
   ```js
   const API_KEY = process.env.ADMIN_API_KEY;
   if (!API_KEY) {
     console.error('ADMIN_API_KEY env var is required. Run: bash scripts/load-secrets.sh');
     process.exit(1);
   }
   ```

6. **Verify** the rotation took effect:
   ```bash
   # The old (leaked) value should now be rejected -- supply it via env to
   # avoid pasting it on the command line:
   #   export OLD_KEY=<paste old value here>
   curl -sS -o /dev/null -w "%{http_code}\n" \
     -X POST https://<app>.azurewebsites.net/api/terapeak/quota/reset \
     -H "x-api-key: $OLD_KEY"              # expect 401/403

   # New value (from refreshed .env) should succeed
   curl -sS -o /dev/null -w "%{http_code}\n" \
     -X POST https://<app>.azurewebsites.net/api/terapeak/quota/reset \
     -H "x-api-key: $ADMIN_API_KEY"        # expect 200
   ```

7. **(Optional) Disable old Key Vault secret version** once both machines have
   the new value and verified:
   ```bash
   # List versions, then disable the prior one
   az keyvault secret list-versions \
     --vault-name coinpricefinder-kv --name ADMIN-API-KEY \
     --query "[?attributes.created < '2026-06-17']" -o table
   az keyvault secret set-attributes \
     --vault-name coinpricefinder-kv --name ADMIN-API-KEY \
     --version <old-version-id> --enabled false
   ```

**Out of scope (do NOT do):** Rewriting git history with `git filter-repo` to
purge the old value. Once rotated, the old value is worthless, and a force-push
on `main` is destructive and breaks every clone. The leak is closed by rotation,
not by erasure.

**Coordination:** Both machines must run step 4 within the same window, or
local tooling on the lagging machine will return 401s. Announce in the shared
notes before starting; verify both machines done before step 7.

**Files:**
- `scripts/bar-pricing-health.js`
- Azure: Key Vault `coinpricefinder-kv` secret `ADMIN-API-KEY`
- Azure: App Service `coinpricefinder-h3a3b5g0dmdydna4`
- Local on W and H: `.env` (gitignored)

**Source:** Discovered during the 2026-06-17 `docs/memory-corpus-migration` PR
audit. See `docs/memory/README.md` "Known remaining exposure" for context.

---

### #266W. `scoreMatch` weight tolerance: port 5% relative check from filter to scorer [P2 -- BUG] -- DONE 2026-06-17

**Status:** Fixed in `src/services/ebayService.js`. Scorer now mirrors the filter's 5% relative tolerance.  Regression test added at [__tests__/scoreMatchWeight.test.js](__tests__/scoreMatchWeight.test.js).

**Problem:** PR #33 (`fix/weight-mismatch-30g-tolerance`) replaced the comp-FILTER weight check from `Math.abs(detW - expected.weight) < 0.01` to a 5% relative tolerance so 2016+ Chinese Silver Pandas (30g actual = 0.9646 oz vs 1.0 oz nominal = 3.5% off) pass.  The comp-SCORER at `scoreMatch` was never updated and still used the 0.01 oz absolute check.  Correct comps (Pandas, and any other bullion where actual metric weight diverges slightly from troy-ounce nominal) were tagged `weight-mismatch` (-35) instead of `weight-match` (+25) -- a 60-point swing that could demote good comps out of the top-K window or downweight their influence on FMV.

**Discovered:** During 2026-06-17 W-branch hygiene review.  The branch `fix/weight-mismatch-30g-tolerance` (archive tag `archive/2026-06-17/fix/weight-mismatch-30g-tolerance`) showed the filter fix landed in main, but cross-check of the scorer in the same file revealed the parallel bug at `scoreMatch`.

**Fix:**
```js
// src/services/ebayService.js (in scoreMatch, around line 687)
const wtRatio = Math.abs(detectedWeight - expected.weight) / Math.max(detectedWeight, expected.weight);
if (wtRatio < 0.05) {
  score += 25; notes.push('weight-match');
} else {
  score -= 35; notes.push('weight-mismatch');
}
```

**Files:**
- `src/services/ebayService.js` (scorer block, ~lines 685-700)
- `__tests__/scoreMatchWeight.test.js` (new, 5 regression cases)

**Related:** PR #33 (filter fix), `#261W` (fractional Gold Maple Leaf has a separate root cause: missing 1/20 oz entry in `data/greysheetTypeMap.js`; not addressed by this fix).

---

### #267W. Bump `multer` to clear high-severity DoS CVEs [P1 -- SECURITY] -- DONE 2026-06-17

**Status:** Fixed via lockfile-only `npm audit fix`. `multer` resolved from `2.1.1` to `2.2.0` (within existing `^2.0.2` range in `package.json`). CI audit gate (`npm audit --audit-level=high --omit=dev`) now passes.

**Problem:** CI test job was failing on every PR (including #143) due to two HIGH-severity DoS advisories against `multer`:
- `GHSA-72gw-mp4g-v24j` -- DoS via deeply nested field names
- `GHSA-3p4h-7m6x-2hcm` -- DoS via incomplete cleanup of aborted uploads

Affected routes (production code paths using `multer`): [src/routes/bulkEvaluateRoute.js](src/routes/bulkEvaluateRoute.js#L8), [src/routes/excelImportRoute.js](src/routes/excelImportRoute.js#L4), [src/routes/terapeakRoute.js](src/routes/terapeakRoute.js#L5).

**Fix:** `npm audit fix` (no `--force`, no breaking changes). Only `package-lock.json` changed -- no API surface change in `multer` 2.1.1 -> 2.2.0.

**Verification:**
- `npm audit --audit-level=high --omit=dev` -> exit 0 (was failing before)
- `__tests__/bulkEvaluateRoute.test.js`, `__tests__/bulkEvaluate.test.js`, `__tests__/excelImport.test.js`, `__tests__/terapeakRoute.test.js` -- 123/123 pass
- Full suite: 3562/3563 (only `terapeakDataIntegrity.test.js` fails in-suite -- known flake #273H, 105/105 pass in isolation, unrelated to this change)

**Out of scope (remaining moderate prod findings):**
- `qs` 6.15.1 (GHSA-q8mj-m7cp-5q26) pinned by `typed-rest-client`; npm cannot bump it without upstream release. Not blocking CI (moderate).
- `uuid` <11.1.1 (GHSA-w5hq-g745-h8pq) requires breaking `exceljs` to 3.4.0 (`--force`). Not blocking CI (moderate). Defer to dedicated upgrade.

**Files:** `package-lock.json` (lockfile-only).

---

### 234. parseDescription Misclassifies "Proof-Like" as Proof [P1] -- DONE 2026-06-02

**Status:** Fixed in `src/services/pcgsService.js` -- the standalone-proof branch now uses `/\bproof\b(?![\s-]*like)/i`. 5 regression cases in `__tests__/pcgsService.test.js` cover `Proof-Like`, `Proof Like`, `DMPL`, `MS64 PL`, and a plain-`Proof` sanity check.

**Source:** numismatic-audit run 2026-06-01 (commit `d85e9bf`).

**Problem:** `parseDescription` in [src/services/pcgsService.js](src/services/pcgsService.js#L365) uses `/\bproof\b/i.test(t)` without the negative-lookahead that `PROOF_RE` in `ebayService.js` and `_detectFinish` in `greysheetTypeMap.js` correctly have. Input `"1881-S Morgan Proof-Like"` returns `{ grade: 'Proof', finish: 'Proof' }` — Proof-Like Morgans get routed to the proof pricing pool instead of the graded MS pool.

**Repro:**
```
node -e "console.log(require('./src/services/pcgsService').parseDescription('1881-S Morgan Proof-Like'))"
// => { grade: 'Proof', finish: 'Proof', series: 'Morgan' }
```

**Fix:** Change line 365 from `/\bproof\b/i.test(t)` to `/\bproof\b(?![\s-]*like)/i.test(t)`.

**Tests:** Add parseDescription cases for `"Proof-Like"`, `"Proof Like"`, `"DMPL"`, `"MS64 PL"` — none should yield `grade === 'Proof'`.

**Impact:** Wrong FMV for any Morgan/Peace dollar with "Proof-Like" in the description when grade is not explicitly stated. PL Morgan premiums differ substantially from true proof Morgan premiums.

---

### 235. parseDescription "BU Proof" Precedence Bug [P2] -- DONE 2026-06-02

**Status:** Fixed in `src/services/pcgsService.js` (option (b) from the spec) -- the standalone-proof branch now also fires when `_gradeSource === 'bu-term'` and clears the BU-derived `grade`/`gradeNum`. Set titles (`Choice BU Proof Set`) are unaffected because the `setMatch` branch above consumes them first. 5 regression cases in `__tests__/pcgsService.test.js`.

**Source:** numismatic-audit run 2026-06-01 (commit `d85e9bf`).

**Problem:** Per SKILL trap table, `"BU Proof Silver Eagle"` should classify as **proof** ("Proof is definitive; BU is informal"). Currently the BU regex at [src/services/pcgsService.js](src/services/pcgsService.js#L277-L289) runs before the proof block, sets `grade='MS60'`, then the `!result.grade` guard at line 365 prevents the proof branch from running.

**Repro:**
```
node -e "console.log(require('./src/services/pcgsService').parseDescription('BU Proof Silver Eagle'))"
// => { grade: 'MS60', series: 'Silver Eagle' }   (expected: grade: 'Proof')
```

**Fix:** Either (a) detect `\bproof\b(?![\s-]*like)` BEFORE the BU regex and skip BU assignment when present, or (b) after BU assignment, if proof is also present in text and no formal numeric grade was matched, override with `grade='Proof'`.

**Impact:** Lower than #234 because the eBay-comp-side `classifyGradeType` is unaffected (already correct), but `parseDescription` drives PCGS price lookups and `pcgs.grade` → `userGrade` plumbing, so PCGS prices and pool-selection signals can be wrong for these titles.

**Tests:** Add cases `"BU Proof Silver Eagle"`, `"Gem BU Proof"`, `"Choice BU Proof Set"` (last should remain `setType='clad'` not graded).

---

### 236. Pool Fallback Leaks Proof Comps Into Graded FMV [P2]

**Source:** numismatic-audit run 2026-06-01 (commit `d85e9bf`).

**Problem:** SKILL audit checklist requires "Pool fallback never mixes proof comps into graded pool or vice versa." [src/services/valuationService.js](src/services/valuationService.js#L68-L70) currently uses `usGraded.length >= 3 ? usGraded : usCompsAll` — `usCompsAll` includes proof comps. The #176 sold-comp swap only redirects to raw when `rawSold.length >= 10 AND gradedSold.length < 5`, so the middle band (e.g. graded=2, raw=5, proof=4) ends up with a mixed graded+proof+raw pool.

**Fix:** Replace `usCompsAll` fallback on lines 69-70 with `[...usGraded, ...usRaw]` (exclude proof). Same for `glComps`.

**Tests:** Add a `computeValuation` case with `userGrade='MS65'`, `usGraded.length=2`, `usProof.length=4`, `usRaw.length=5` — assert chosen `usComps` does not include any proof-typed comps.

**Impact:** Upward bias on graded MS FMV whenever graded pool is thin and proof comps exist in the dataset. Proof typically commands a premium over graded MS.

---

## Testing Strategy Improvements (2026-06-01 assessment)

> Multi-batch plan from Testing Strategy & Quality Enforcement assessment. Each batch is a separate PR/commit chain. Items reference each other; complete in order.

### 237. Testing Batch 1 — Quick Wins + CI Hygiene [P1] — DONE (PR #77, commit `704aefe`)

**Status (2026-06-01):** Merged. Shipped in [PR #77](https://github.com/Eloso-chi/coin-price-finder-agent/pull/77).
- ✅ 1. Coverage reporting in CI (report-only, text/text-summary/json-summary, totals piped to `$GITHUB_STEP_SUMMARY`).
- ✅ 2. `terapeakDataIntegrity` re-enabled. **Caveat:** the May 12 exclusion was NOT stale — it was masking a seed-dependent flake. Fix: `COIN_TEST_SEED=ci-batch1-stable` pinned in the workflow `env:` block. Multi-seed hardening tracked in #239.
- ✅ 3. Post-deploy smoke step: 3-attempt `/api/health` (15s cold-start backoff) + `/api/price` golden-coin FMV sanity band `[$5, $500]`. Fails deploy on either probe.
- ✅ 4. CodeQL — repo flipped to **public** and **CodeQL Default setup** enabled via GitHub UI. The custom workflow at `.github/workflows/codeql.yml` (originally shipped in PR #77) was deleted because Default setup and Advanced setup are mutually exclusive — keeping the workflow caused SARIF uploads to fail with *"CodeQL analyses from advanced configurations cannot be processed when the default setup is enabled."* Default setup auto-maintains action versions / query packs / language detection, which is the right tradeoff for a single-language JS repo.
- ✅ 5. `.github/dependabot.yml` verified present and correct (weekly npm + GH actions, `xlsx` ignored, `dependencies`/`ci` labels). **Secret Protection** (secret scanning + push protection) enabled via GitHub UI.
- ✅ 6. Env-test audit — `__tests__/ebayFetchSoldComps.test.js` and `__tests__/pcgsService.test.js` already use module-level `jest.mock('axios')`; added defensive comments documenting the invariant.
- ✅ 7. Agent sync — `test-monitor` / `test-coverage` Quick Reference tables corrected: `40 suites / 2,043 tests` → `81 suites / 3,065 tests`; documented coverage-in-CI and terapeakDataIntegrity-in-CI.

**All manual follow-ups complete** (repo made public, Code Scanning + Secret Protection enabled, License updated to All Rights Reserved in PR #79).

---

**Original scope (preserved for history):**

**Source:** Testing Strategy assessment 2026-06-01.

**Scope (6 items, all XS-S effort):**
1. Add `--coverage` (text-summary, no threshold yet) to the `Run tests` step in [.github/workflows/main_coinpricefinder-h3a3b5g0dmdydna4.yml](.github/workflows/main_coinpricefinder-h3a3b5g0dmdydna4.yml). Report-only.
2. **Re-enable `terapeakDataIntegrity`** in CI. Drop `|terapeakDataIntegrity` from `testPathIgnorePatterns`. Investigation 2026-06-01 confirmed the test passes 105/105 in ~31s after stabilization commit `e012f23` (May 26); the May 12 exclusion in PR #1 is stale dead config. Adds ~30s to CI test job — accepted.
3. Add **post-deploy smoke step** to the `deploy` job: `curl /api/health` + `curl /api/price?q=1921+Morgan+Silver+Dollar` and assert FMV is in a sane range (>5 < 500). Fails deploy if smoke fails.
4. Add **CodeQL workflow** at `.github/workflows/codeql.yml` using GitHub's default JS template. Weekly schedule + PR triggers.
5. Verify **Dependabot config** exists (commit `08b7578` claims it was added — confirm `.github/dependabot.yml` is present; if not, add weekly npm + GH actions update schedule). Enable **GitHub secret-scanning push protection** as a repo setting (manual step — not in code).
6. **Audit env-reading tests** [__tests__/ebayFetchSoldComps.test.js](__tests__/ebayFetchSoldComps.test.js) and [__tests__/pcgsService.test.js](__tests__/pcgsService.test.js): ensure no real-network call is possible if `EBAY_*`/`PCGS_*` env vars are set. Force `jest.mock('axios')` or equivalent.
7. **Agent sync** — update [.github/agents/test-monitor.agent.md](.github/agents/test-monitor.agent.md) and [.github/agents/test-coverage.agent.md](.github/agents/test-coverage.agent.md) Quick Reference tables: correct stale test count (40 suites / 2,043 tests → current count from `npm test`), note that `terapeakDataIntegrity` is now in CI, note coverage is reported.

**Tests:** Each step is its own observable. Verify the new test job summary shows coverage, terapeakDataIntegrity appears in results, deploy step logs the smoke result, CodeQL alerts surface, Dependabot opens PRs.

**Notes for executor:**
- `terapeakDataIntegrity` adds 30s to CI. If split into a separate `slow` job later (Batch 4), revisit.
- Coverage gate is REPORT-ONLY in batch 1. Hard floor decision deferred to Batch 2 once baseline is known.
- `xlsx` audit exception lives in workflow YAML; do not touch in this batch.
- **Agent sync (#7) is mandatory** — without it, test-monitor will keep reporting stale fact counts and may flag the newly-enabled terapeakDataIntegrity as broken.

---

### 238. Testing Batch 2 — High-Impact Structural [P2] — DONE (PR #81)

**Shipped:**
1. ajv JSON Schema at [src/schemas/priceResponse.schema.js](src/schemas/priceResponse.schema.js) (Draft-07, no `$schema` key) — covers query/identification/pcgs/ebay/valuation/decisions branches with nullable numerics.
2. [src/utils/responseValidator.js](src/utils/responseValidator.js) `validateSchema()` refactored to compile-once ajv singleton; error messages translated back to legacy substring contract; the other three validators (`validateNumericSanity`, `validateSeriesIntegrity`, `validateFMVReasonability`) + `validateResponse()` unchanged. All 418 existing validator tests still pass.
3. Three jsdom frontend test suites added under `__tests__/frontend/` (15 tests). Achieved by adding a `__testing` seam + CommonJS shim to [public/js/my-coins.js](public/js/my-coins.js) — no behavioral change.
4. Soft coverage floor wired via `jest.coverageThreshold` in [package.json](package.json) at statements:68, branches:61, functions:68, lines:70 (5 pts below 2026-06 baseline of 73/66/73/75).
5. Agent sync — updated [.github/agents/test-coverage.agent.md](.github/agents/test-coverage.agent.md) + [.github/agents/test-monitor.agent.md](.github/agents/test-monitor.agent.md) Quick Reference rows (test count → 84/3080, frontend pragma note, schema location, coverage floor values).

**Post-batch state:** 84 suites / 3,080 tests passing. New devDeps: `ajv`, `jest-environment-jsdom`.

---

### 239. Testing Batch 3 — Maturity Layers [P3] — DONE (workstreams 1, 2, 4; workstream 3 split out as #241)

**Shipped (PR #82):**
1. **Multi-seed holdout** — [__tests__/holdoutValidation.test.js](__tests__/holdoutValidation.test.js) now runs across 5 fixed seeds (42, 7, 1337, 2025, 99) with a cross-seed majority gate (>= 3 of 5 seeds must clear the 70% per-seed pass rate). Single-seed legacy mode preserved via `HOLDOUT_SEED` env var. Suite grew from 11 to 56 tests; runtime still ~2s. All 5 seeds currently passing.
2. **Stryker mutation testing** — added `@stryker-mutator/core` + `@stryker-mutator/jest-runner` as devDeps; `stryker.conf.json` scoped to the 3 spec'd files; `npm run test:mutation` script wired; `reports/mutation/`, `.stryker-tmp/`, `stryker.log` gitignored. Baseline captured for `greysheetTypeMap.js`: **75.47%** mutation score (243 killed / 79 survived, 41 min runtime). Surviving mutants documented in README (regex `.*`→`.` on barber/washington quarter rows, string-literal mutations on `metal` fields). Baselines for `pcgsService.js` (~1.5hr) and `ebayService.js` (~4hr) deferred — config is ready, run `npx stryker run --mutate <file>` when capacity allows.
4. **Agent doc sync** — [.github/agents/test-monitor.agent.md](.github/agents/test-monitor.agent.md) + [.github/agents/test-coverage.agent.md](.github/agents/test-coverage.agent.md) updated with Stryker entries.

**Workstream 3 (agent evals)** — split out as #241 below. Realistic implementation requires LLM-API glue (GitHub Models or equivalent) that wasn't in the original spec; broke it out so this batch could ship.

**Post-batch state:** 84 suites / **3,125 tests passing** (was 3,080; +45 from multi-seed holdout). New devDeps: `@stryker-mutator/core`, `@stryker-mutator/jest-runner`.

---

### 242. Stryker mutation baselines for pcgsService.js + ebayService.js [P3]

**Source:** Deferred from #239 workstream 2 (2026-06-02). Config in `stryker.conf.json` already lists both files in `mutate`; only the actual baseline runs are outstanding.

**Scope:**
1. `npx stryker run --mutate services/pcgsService.js` — estimated ~1.5 hr. Record score + (killed/survived) counts in README mutation baseline table.
2. `npx stryker run --mutate services/ebayService.js` — estimated ~4 hr. Same record-keeping.
3. For each: scan the HTML report under `reports/mutation/` for surviving-mutant clusters, document top 2-3 categories in README (same format as `greysheetTypeMap.js` entry).
4. If surviving-mutant patterns suggest a clear test gap (not just equivalent mutants), file a follow-up issue or fix inline.

**Notes for executor:**
- Re-run greysheetTypeMap.js first as a sanity check that the new `enableFindRelatedTests: false` setting hasn't broken the runner; replace the 75.47% number in README if it drifts (likely lower).
- Run during off-hours / in a separate terminal; full ebayService run will hold a Codespace for ~4 hours.
- Optional: split into two PRs (one per file) to avoid one long-running session blocking the other.

**Tests:** Successful Stryker run with HTML report committed-as-not (gitignored) but score numbers + survivor categories updated in README.

---

### 241. Agent prompt regression evals via GitHub Models [P3]

**Source:** Split out from #239 workstream 3 (2026-06-02). Original spec required CI-invoked agent evals; this was infeasible because `.github/agents/*.agent.md` files are VS Code Copilot Chat artifacts with no programmatic invocation path from GitHub Actions. This issue captures the realistic design.

**Scope:**
1. **`scripts/run-agent-eval.js`** — loads `__tests__/agentEvals/<name>.fixture.json` (`{ agent, input, expect: { keyClaims: [...] } }`), reads `.github/agents/<agent>.agent.md`, strips YAML frontmatter, uses body as system prompt. POSTs to GitHub Models inference endpoint (`models.inference.ai.azure.com`) with workflow's `GITHUB_TOKEN`. Asserts every `keyClaim` substring (case-insensitive) appears in response. Exit code 0 = pass, 1 = fail with diff.
2. **`scripts/run-all-evals.js`** — orchestrates all fixtures, writes `eval-results.md`.
3. **Fixtures** in `__tests__/agentEvals/` (NOT a Jest dir):
   - `numismatic-audit.fixture.json` — input code snippet + expected key claims (mint mark checks, key date detection, etc.)
   - `code-reviewer.fixture.json` — input diff + expected review categories (security, scope, style)
4. **`.github/workflows/agent-eval.yml`** — weekly cron + manual `workflow_dispatch`. `permissions: { models: read, issues: write, contents: read }`. On any failure: `gh issue create --title "Agent eval regression $(date +%F)" --body-file eval-results.md --label agent-eval`.
5. **Agent docs** — update test-monitor / test-coverage with eval workflow location + how to add fixtures.

**Caveats:**
- GitHub Models inference uses gpt-4o (or similar), NOT the model VS Code Copilot Chat is currently routing through (Claude). Tests "is this agent prompt still sound for a competent LLM" — not "does Copilot Chat still behave identically."
- For catching `.agent.md` file regressions (someone deletes "always check mint mark" → eval fails), this is sufficient and useful.
- Free tier: ~50 req/day gpt-4o, plenty for weekly evals on 2-5 fixtures. No new secrets needed.

**Tests:** Workflow runs end-to-end via `workflow_dispatch`; intentional regression (mutate fixture's expected claim) produces an issue.

**Notes for executor:**
- Estimated effort: 2-3 hours implementation + ~10 min verifying workflow.
- If GitHub Models GA terms change, fall back to direct OpenAI / Anthropic API with a secret.

---

### 240. Testing Batch 4 — Long-Term Pyramid Maturity [P4]

**Source:** Testing Strategy assessment 2026-06-01. Depends on #237-239.

**Scope:**
1. **Evaluate `zod` migration** — only if Batch 2's ajv schema becomes painful. Single decision point: pick lib for input validation too. Likely SKIP unless TypeScript migration is in play.
2. **Playwright E2E** for 2-3 critical user journeys:
   - Search → see price card
   - Bulk evaluator submit → SSE results stream
   - Admin login → admin chip visible
   Run only on `main` push, not on every PR (too slow).
3. **Two-stage CI** with Jest `projects: [unit, integration, slow]`:
   - `unit` — runs on every push, must pass < 30s
   - `integration` — supertest + pricingPipeline + crossRouteConsistency, < 60s
   - `slow` — terapeakDataIntegrity + holdoutValidation + bulkLotEstimatorHealth, runs in parallel job
4. **Fault injection** on Azure dependencies — use existing axios-mock-adapter to systematically test Cosmos/Blob/SMTP timeout paths.
5. **Agent sync (final)** — update ALL test-related agents to reflect final test pyramid: `unit` / `integration` / `slow` jest projects, Playwright location (e.g., `e2e/*.spec.js`), how to run each project independently. Add a new entry to each agent's Quick Reference noting that `jest.config.js` (not package.json) is the source of truth.

**Tests:** Playwright tests pass in CI for the 3 journeys. CI total time stays under 5 min despite expansion.

**Notes for executor:**
- Playwright will need browser cache in CI — use `actions/cache@v4`.
- `projects:` config requires migrating from `package.json` jest config to `jest.config.js`. Do this here, not earlier.
- Pull #237's `terapeakDataIntegrity` re-enable into the `slow` project at this stage.

---

### #250. Image Proxy Numista Allowlist Baseline Failures [P2 -- TEST STABILITY] -- DONE 2026-06-18 (verified by audit)

**Resolution (2026-06-18 audit):** Both `allows en.numista.com` and `allows www.numista.com` tests now pass on a clean worktree -- `npx jest __tests__/imageProxyRoute.test.js` returns 28/28 green. The fix landed in a downstream PR that touched `src/routes/imageProxyRoute.js` without explicit cross-reference to this entry. Closing as DONE.

**Original problem:** Baseline test failures remained for Numista allowlist behavior in
`__tests__/imageProxyRoute.test.js`:
- `allows en.numista.com`
- `allows www.numista.com`

These failures reproduce on both `origin/main` and the
`chore/surface-one-word-launcher` PR branch, so they are not introduced by the
Surface launcher work.

**Impact:** Full-suite `npm test` remains red, which blocks clean merge gates
and obscures regressions in unrelated PRs.

**Scope:**
1. Reconcile allowlist logic in `src/routes/imageProxyRoute.js` with the
   expected host rules in `__tests__/imageProxyRoute.test.js`.
2. Keep SSRF protections intact (localhost/private ranges/subdomain bypass).
3. Add/adjust targeted assertions only where behavior and security policy are
   explicitly agreed.
4. Re-run and record focused results for `__tests__/imageProxyRoute.test.js`.

**Definition of done:**
- `__tests__/imageProxyRoute.test.js` passes on a clean worktree.
- No weakening of existing SSRF-blocking assertions.
- Backlog status updated in the same PR that lands the fix.

---

### #251. Local vs Codespaces Scraper Parity and Write-Path Hardening [P1 -- OPERATIONS/DATA-INTEGRITY] -- DONE 2026-06-03

**Status:** Shipped. Exporter now has an explicit `UPLOAD_MODE` selector (default `api`), blob mode no longer silently falls back to the API, and an optional `VERIFY_IMPORT=1` switch surfaces deferred-ingestion warnings. Current launcher defaults are split by entrypoint: direct `surface` / `run-surface-freshness-loop.sh` runs default to `UPLOAD_MODE=blob` when unset, while `scripts/terapeak-operator.sh` defaults to `UPLOAD_MODE=api` and exports it before invoking the loop. Runbooks (Surface + travel) and `scripts/README.md` carry the parity matrix and decision table. A source-level contract test pins the contract.

**Verified Azure write-path truths (recorded for reference):**
1. `POST /api/terapeak/import` runs `importComps` immediately and drives freshness/dormancy progression.
2. Cosmos write-through inside `importComps` is best-effort async and gated on `COSMOS_ENDPOINT` + `COSMOS_KEY`.
3. Blob ingestion is deferred to server startup or an explicit `POST /api/terapeak/reimport`.
4. Pre-#251, blob-first success in the exporter could skip immediate API import.

**Files:**
- MOD `scripts/terapeak-export.py` (UPLOAD_MODE + VERIFY_IMPORT + blob-only branch with no API fallback)
- MOD `scripts/run-surface-freshness-loop.sh` (default `UPLOAD_MODE=blob`, exported; warn on non-api runs)
- MOD `docs/runbooks/local-scraper-wsl2.md` (parity matrix + operator notes)
- MOD `docs/runbooks/scraper-travel-mode.md` (parity matrix + operator notes)
- MOD `scripts/README.md` (UPLOAD_MODE section + decision table)
- NEW `__tests__/terapeakExportUploadMode.test.js` (source-contract assertions, all green)

**Out of scope (kept for follow-up):**
- Making Cosmos write-through blocking/transactional inside `/api/terapeak/import`.
- Scheduling/automation layer (already tracked in #249).
- Runtime verification of import completion beyond response-shape checks.

---

### #252. Bullion Strike-Pool Split Misclassifies Graded Bullion as Off-Pool [P1 -- DATA-QUALITY] -- REVERTED 2026-06-23 (PR #154 reverted; correct path forward tracked in #270W)

**REVERTED 2026-06-23 (pool-isolation violation):** PR #154's "merge graded+raw for >=1oz bullion" approach was reverted because it violates the pool-isolation contract documented in `docs/memory/numismatic-terminology.md`: raw, graded, and proof are THREE DISTINCT POOLS as observed by `classifyGradeType()` and must never be merged in FMV computation. Even for modern bullion (Gold Maple, Gold Eagle, Krugerrand, Britannia, Panda), the slab pool trades differently from raw because every series contains scarce dates, varieties, and first-year / anniversary issues -- the cross-pool dispersion is wide enough to make a blended FMV wrong for both pools. PR #154's `+191 survivors` metric was pool pollution, not a correctness improvement. The original symptom (sparse raw-bullion comps producing thin FMV) is a real problem and is now tracked as **#270W** with pool-preserving solutions (adaptive lookback, better Terapeak seeding for raw, two-pool FMV surfacing, honest "insufficient comps" return). Do NOT re-implement pool merging without first re-reading `docs/memory/numismatic-terminology.md` and `/memories/repo/pool-isolation-rule.md`.

**Original resolution (now reverted) -- PR #154, merge commit `7b72a67`:** Implemented the proposed-fix sketch. `src/services/ebayService.js` (around L1438-L1474): when `expected.weight >= 1.0` and the query is neither proof nor explicit-grade, merges the `graded` and `raw` pools instead of dropping graded comps. Proof + reverse-proof comps stay excluded. Strict split is preserved for (a) fractional bullion `< 1oz` (slab premium IS real for 1/10oz Gold Eagle MS70 etc.), (b) explicit slab grade in the query, (c) proof intent, and (d) non-bullion queries with no weight signal. New `prefilterBullionMerge` telemetry bucket (value 0) is emitted on `result.us.removed` whenever the bullion branch fires, and the console log distinguishes `bullion-merge graded+raw, weight=Noz` vs `raw only`. 5 new cases added to `__tests__/ebayFetchSoldComps.test.js` covering the merge, the explicit-slab-grade fallback, the proof-bullion exclusion, the fractional-bullion guard, and the no-weight-signal defensive path. Verification at merge: full suite 3x consecutive -> 3928/3928 passed; lint clean (0 new warnings); ASCII-only confirmed.

**Problem:** The pre-filter strike/grade-pool split in `fetchSoldComps` (introduced for #182, made visible by #244) treats slabbed bullion as off-pool for raw-bullion queries. For a query like `2024 Canada 1 oz Gold Maple Leaf` the parser sets neither `isProof` nor `grade`, so `targetPool = 'raw'`. Any Terapeak comp with `conditionId=2000` (slabbed PCGS/NGC) -- which is a large share of premium bullion listings -- gets classified as `graded` and dropped via `prefilterStrikeSplit` before scoring or filters ever run.

**Evidence (pricing-health Maple run, 2026-06-04, `cache/health-maple-100.json`):** 9 of 13 RED rows are 1oz Gold Maple Leaf datasets (years 2013, 2014, 2015, 2019, 2021, 2022, 2023, 2024, 2025). Top bucket on every one is `prefilterStrikeSplit` (1-45 comps). Concrete worst case: 2025 Canada 1 oz Gold Maple Leaf -- 164 gathered, 3 survived, 98.2% attrition, `prefilterStrikeSplit=45`. The drops are correct *given the rule* but the rule itself is wrong for bullion: graded 1oz Gold Maple still trades at metal + premium, not at a separate "slabbed" tier worth excluding from FMV.

**Why it matters:** Gold bullion is the highest-value category in the catalog ($4500-$5600 FMV per 1oz comp). Losing 75-95% of Terapeak comps systematically biases FMV toward whatever tiny sample survives -- often 1-3 comps, well below the `usMinComps` threshold, which then triggers downstream Browse fallback to active listings (less reliable). The same logic likely affects Gold Eagle, Krugerrand, Britannia, and any other bullion series; #244 only made it visible.

**Proposed fix (sketch -- needs discussion before APPLY):**
1. In `ebayService.js` around line 1393-1400, add a bullion-aware exception to the strike-pool split: when `expected.weight` is set (a strong bullion indicator already used elsewhere for the `_fromGenericDataset` flag) AND user did not specify `isProof` AND did not specify `grade`, merge the `graded` and `raw` pools instead of choosing one. Proof comps stay excluded.
2. Optional secondary signal: expose a `expected.isBullion` flag from the parser (already inferred in priceRoute via `BULLION_1OZ_DEFAULT` / weight detection) and key off that explicitly rather than re-deriving from `expected.weight`.
3. Keep proof exclusion intact -- a Proof Gold Maple is a different market from bullion Gold Maple.
4. Add a new prefilter bucket `prefilterBullionMerge` set to 0 in the bullion branch so operators can see when the new path is taken.

**Repro:** `ADMIN_API_KEY="$(grep '^ADMIN_API_KEY' .env | cut -d= -f2-)" node scripts/pricing-health-full.js --full --filter "Maple" --limit 100 --min 10 --out cache/health-maple-100.json` and inspect any `1 oz Gold Maple Leaf` RED row -- the `prefilterStrikeSplit` bucket should be the dominant drop.

**Acceptance criteria:**
- Re-running the Maple pricing-health drops Gold 1oz RED count from 9 -> 0 (or downgrades to YELLOW with a sensible `usComps`).
- Proof Gold Maple queries still exclude bullion comps (regression test).
- New unit test in `__tests__/ebayFetchSoldComps.test.js` mirroring the existing strike-split tests but with `expected.weight = 31.1` and asserts graded comps survive.
- Telemetry remains attributed (no `[telemetry-leak]` warnings introduced).

**Files (anticipated):** `src/services/ebayService.js` (pre-filter block + classifier call site), `src/routes/priceRoute.js` (optional: emit `expected.isBullion`), `__tests__/ebayFetchSoldComps.test.js`.

**Risk:** Could pull in unwanted graded-premium comps for sub-1oz fractional bullion where the slab premium IS meaningful (1/10oz Gold Eagle MS70 trades well above bullion). Mitigation: gate the merge on `weight >= 31.0g` (full troy ounce or larger) so fractional bullion still uses the original split. Confirm with a second pricing-health run filtered to `Eagle` after the fix lands.

---

### #253. Malformed Dataset Keys Produce Nonsensical FMVs [P2 -- DATA-QUALITY]

**Problem:** Three dataset keys in the Maple pricing-health run are malformed -- they describe weights that don't exist as real products, and one is parser-noise where a fractional weight got tokenized incorrectly. Each produces a 100% attrition RED row, but the more concerning issue is that two of the three return a non-null `fmvCore` extrapolated from spot metal price, which would mislead any caller that ignores `usComps`.

**Evidence (`cache/health-maple-100.json`, 2026-06-04):**

| Coin | gathered | usComps | fmvCore | Issue |
|------|----------|---------|---------|-------|
| `2025 canada 1000oz gold maple leaf` | 65 | 0 | **$4,493,300** | `1000oz` is not a real product; FMV is spot-gold * fictitious weight |
| `2004 canada 12oz silver maple leaf` | 21 | 0 | $890.16 | `12oz` is not a real Silver Maple weight (real: 1, 10, 100, kilo) |
| `2003 canada twentieth oz silver maple leaf` | 18 | 0 | $3.71 | `twentieth oz` is parser noise -- `1/20 oz` tokenized as the word "twentieth" |

**Root cause (suspected, two parts):**
1. **Bad dataset keys present in `data/terapeak-meta.json`** -- the keys exist because at some point the scraper or evidence-index ingested them. They survive every refresh because nothing prunes "impossible weight" datasets.
2. **Parser tolerates fractional weight words** -- `pcgsService.parseDescription` or upstream tokenization converts `1/20 oz` to `twentieth oz`, which is then stored as a dataset key. Real Maple weights are: 1oz, 1/2oz, 1/4oz, 1/10oz, 1/20oz (gold) and 1oz, 10oz, 100oz, kilo (silver). `12oz`, `25oz`, `1000oz` are not in the product lineup.

**Why it matters (and limits):**
- A caller hitting `/api/price` with `query="2025 canada 1000oz gold maple leaf"` gets `fmvCore=4,493,300` with `compCount=0`. Any consumer that only renders FMV and ignores `compCount` / `lowData` / `confidence` will display a 7-figure price. That's a public-API trust issue.
- Limit: these queries are unlikely to come from real users; they come from the dataset key list and the curated Terapeak meta. So the blast radius is the pricing-health script and any internal batch consumer.

**Proposed fix (two-track, both small):**

*Track A -- runtime guard (low risk, lands first):*
1. In `valuationService.js`, when `compCount === 0` AND `fmvCore` was computed from metal melt extrapolation alone, set `confidence = 'unreliable'` and `lowData = true` (most likely already true) AND null out `fmvCore`. Force callers to inspect `dataSource` to see there were zero comps.
2. Add an integration assertion to `__tests__/computeValuation.test.js`: "zero comps + metal-only FMV returns null fmvCore".

*Track B -- intake cleanup (one-shot script, no schema change):*
1. Add `scripts/prune-impossible-weights.js` that walks `data/terapeak-meta.json`, flags keys matching weights outside the known canonical set per series, prints a dry-run list, and (with `--apply`) deletes both the meta entry and the corresponding `data/terapeak/<key>.csv`.
2. Canonical weight whitelist lives in `data/constants.js` next to `BULLION_1OZ_DEFAULT`; populate per-series (Maple, Eagle, Britannia, Panda, Libertad, Krugerrand).
3. Run once on the working tree, commit the diff, then add it to the regular freshness loop so it idempotently catches new mistakes.

**Repro:** `node -e "const r=require('./cache/health-maple-100.json'); console.log(r.results.filter(c=>(c.discovery||{}).usComps===0 && c.issues.some(i=>i.severity==='RED')).map(c=>c.coin))"`

**Acceptance criteria:**
- Track A: no `/api/price` response ever returns a non-null `fmvCore` with `compCount === 0`.
- Track B: `data/terapeak-meta.json` no longer contains `1000oz`, `12oz silver`, `25oz gold`, `twentieth oz` keys (and any siblings the pruner finds). Re-running Maple pricing-health drops the three 100%-attrition RED rows because the keys are gone.
- Backlog entry kept open until both tracks land.

**Files (anticipated):** `src/services/valuationService.js`, `__tests__/computeValuation.test.js`, NEW `scripts/prune-impossible-weights.js`, `data/constants.js` (canonical weight whitelist), `docs/runbooks/local-scraper-wsl2.md` (note the prune step).

**Out of scope:** Upstream parser fix for `1/20 oz` tokenization. Once the bad keys are pruned and the source of new bad keys is identified (likely the evidence-index or an old scraper run), open a follow-up at that boundary.

---

### #254. Route-Layer Silent Drops for Grade / Finish / isProof [P1 -- CORRECTNESS] -- DONE 2026-06-04 (PR #109, #111, #112)

**Status:** All tracks shipped on 2026-06-04:
- Backend `coinIntent` helper + route wiring -- PR #109 (`fix/structured-form-silent-drops`, commits `7b913d6`, `1b61f73`)
- Docs (README + ARCHITECTURE) -- PR #111 (`docs/254-architecture-readme`, commit `1461b13`)
- UI Finish dropdown in Identification -- PR #112 (`feat/finish-dropdown`, commit `04215a0`)
- Live eBay Tracker + Price History silent-drop fix -- commit `7d3826a`
- Reverse-Proof pool separation (the gated follow-up) -- PR #114 (commit `0dd8688`), reinforced by PR #126 (`5da13f0` -- #260W)

**Problem:** Three input fields the structured form, Quick search, and API callers can reasonably send were silently dropped by `priceRoute.js` and `pricingBatchRoute.js`, producing the wrong comp pool (raw / graded / proof) and therefore the wrong FMV with no telemetry indication:

1. `coinData.grade: "MS-65"` -- the route's `expected.grade` derivation read only `pcgs.grade || parsed.grade`, never `coinData.grade`. Structured form happens to work today only because `buildQuery` re-appends the grade to the query text so it round-trips through parsing -- fragile and silently breaks for any external API caller or any future change to `buildQuery`. Repro: `POST /api/price {query:"1921 Morgan Dollar", coinData:{grade:"MS-65"}}` returned 71 raw comps + FMV $82.38 (correct: 21 graded comps + FMV $414.76).
2. `options.isProof: true` and `coinData.isProof: true` -- never read at all. Repro: `POST /api/price {query:"2019 mexican silver libertad", options:{isProof:true}}` returned 60 BU comps + FMV $124.51 (correct: 20 proof comps + FMV $144.41).
3. `coinData.finish: "proof"` (lowercase) -- case-sensitive comparison against literal `"Proof"`. Same Libertad symptom, different shape.

**Evidence:** Full route probe in this session showed all three shapes landing in `targetPool='raw'` and being shredded by the `prefilterStrikeSplit` filter shipped under #244. Telemetry from #244 made the drops *visible* (`prefilterStrikeSplit=141` on the Libertad case) but did not surface them as a route-layer bug until manual investigation.

**UI gap (handled in follow-up):** The Proof checkbox lives in the Grade & Price chip but conceptually belongs with Identification (finish is a coin attribute, not a grade attribute). Quick search has no proof toggle at all; users must type "proof" into the query text. Pruned-by-numismatic-correctness proposal:
- Add a **Finish** dropdown to the Identification chip: `Business Strike (default) | Proof | Reverse Proof | Enhanced Reverse Proof | Matte Proof | Burnished | Satin Finish | Antiqued`.
- Remove the Proof checkbox from the Grade chip (no longer needed -- Finish covers it).
- Prune the Label dropdown to slab pedigree only (`First Strike | Early Releases | First Day of Issue | First Releases`); move Burnished / Reverse Proof / Enhanced Reverse Proof / Satin Finish / Antiqued into Finish (they are finishes, not pedigree labels).
- Keep Silver checkbox (composition flag for proof sets).

**Proposed fix (backend -- THIS PR):**
1. New helper [src/utils/coinIntent.js](src/utils/coinIntent.js): `extractCoinIntent({ coinData, options, parsed, pcgs, isSet })` returns canonicalized `{ grade, finish, isProof, designation }`. User-explicit structured input wins over PCGS heuristics over parsed-from-text. `finish` is normalized to PCGS spelling (`Proof`, `Reverse Proof`, etc.). `isProof` is true if any of finish, designation, grade, explicit flag, or parsed grade signals proof intent. `isSet` always nulls grade and isProof (sets are a separate pool).
2. Both [src/routes/priceRoute.js](src/routes/priceRoute.js) and [src/routes/pricingBatchRoute.js](src/routes/pricingBatchRoute.js) call the helper instead of inline derivation, guaranteeing identical behavior.
3. 25 unit tests in [__tests__/coinIntent.test.js](__tests__/coinIntent.test.js) covering precedence, every alias, set-override, and the three exact regression scenarios from this audit.

**Proposed fix (UI -- follow-up PR `feat/finish-dropdown`):**
Move the Proof checkbox into a Finish dropdown in Identification as described above. Backend already accepts both new and legacy shapes (`coinData.finish: 'Reverse Proof'` lands as-is), so the UI PR is pure HTML + the form-serialization tweak in `public/index.html` and a screenshot in the PR description.

**Proposed fix (pricing accuracy -- follow-up PR `feat/reverse-proof-pool-separation`):**
Gated on data: run pricing-health across a Reverse-Proof slate (2023 RP Morgan, 2019-S Enhanced RP ASE, 2024 RP Eagle) BEFORE writing code to measure current attrition. If meaningful, split `classifyGradeType` to return `'reverse-proof'` as a distinct pool, and have the strike-split filter treat it separately from regular Proof. If small, defer to backlog with the measurement attached.

**Repro for THIS PR:** Re-run the 7-case probe in `/tmp/probe2.sh` (in session log) -- all four "BROKEN" rows now land in the correct pool; Proof Set test still correctly forces raw (isSet wins).

**Acceptance criteria:**
- `extractCoinIntent` is the single source of truth for grade/finish/isProof across both routes.
- 25 helper unit tests pass.
- Full ebay/classify/applyFilters/contract test suite (279 tests) passes.
- Manual repro of all four broken shapes shows correct pool selection.

**Files:**
- NEW [src/utils/coinIntent.js](src/utils/coinIntent.js)
- MOD [src/routes/priceRoute.js](src/routes/priceRoute.js) (use helper)
- MOD [src/routes/pricingBatchRoute.js](src/routes/pricingBatchRoute.js) (use helper)
- NEW [__tests__/coinIntent.test.js](__tests__/coinIntent.test.js) (25 tests)
- MOD [docs/BACKLOG.md](docs/BACKLOG.md) (this entry)

**Out of scope (follow-up PRs):**
- UI Finish dropdown (`feat/finish-dropdown`).
- Reverse Proof pool separation (`feat/reverse-proof-pool-separation`, gated on measurement).
- Designation UI control for DCAM/CAM/FS/FB (parser handles from query text today; UI control is a separate UX project).

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

---

## Reverse Proof Pool Follow-ups (PR #114)

### #255. Split Enhanced Reverse Proof into its own pool [P3 -- DATA-QUALITY] -- BACKLOG
- **Context**: PR #114 (`feat/reverse-proof-pool-separation`) introduced a `'reverse-proof'` grade pool. Both "Reverse Proof" and "Enhanced Reverse Proof" titles classify as `'reverse-proof'` and share the pool. Pool selection uses `expected.finish` to route the query, so the user's selected finish does flow in correctly, but within-pool scoring is the only thing distinguishing RP from ERP comps.
- **Why low priority**: No current coin year issues both a Reverse Proof and an Enhanced Reverse Proof of the same coin (ERP exists only for 2019-S ASE, and that year has no plain RP). The risk is purely hypothetical until the US Mint or another issuer produces both in the same year.
- **Proposed fix**: Add an `'enhanced-reverse-proof'` grade type. `classifyGradeType()` checks for "enhanced reverse proof" before "reverse proof". Pool selection routes `expected.finish === 'Enhanced Reverse Proof'` to the new pool.
- **Files**: `src/services/ebayService.js` (classifier + pool selection), `src/routes/coinHistoryRoute.js` (mirror), tests.
- **Related**: PR #114, #189 (numismatic terminology).

### #256. Auto-extend lookback or year-fan-out for thin Reverse Proof pools [P3 -- DATA-QUALITY] -- BACKLOG
- **Symptom**: Year-specific RP pools can be very thin in the default 180d window (e.g., 2013-W RP returns 3 comps after the PR #114 split). Existing `lowData` flag surfaces this but FMV becomes noisy.
- **Proposed fix**: When `targetPool === 'reverse-proof'` and the surviving pool has <5 comps, extend lookback to 365d before falling back to Browse-only. Also consider widening the year window by +/-1 for RP coins where the same finish is unchanged across multiple years.
- **Files**: `src/services/ebayService.js` (auto-extend logic), `src/services/valuationService.js` (Browse-only threshold for RP pool).
- **Related**: PR #114, #176 (pool fallback before Browse-only).

### #260W. valuationService has no `reverse-proof` pool selector -- RP queries collapse to silver melt [P1 -- BUG -- REGRESSION] -- DONE 2026-06-04 (PR #126)
- **Symptom**: After PR #114, any query that resolves to `targetPool='reverse-proof'` produces FMV at silver-melt-only with `confidence=0` and `compCount=0`, even when the comp-gathering layer returns a healthy pool of comps. Discovered during pricing-health top-100 run on 2026-06-04:
  - 2023 Reverse Proof Morgan Silver Dollar: 203 teak rows -> 150 surviving RP-tagged comps -> `discovery.fmv=$56.31`, `method='raw-blend'`, `compCount=0`, `confidence=0`. `batch.avgEbay=$205.96` on the same comps (3.7x higher) confirms the comps are present but discarded by the valuation engine.
- **Root cause**: PR #114 added `gradeType='reverse-proof'` in `ebayService.js#classifyGradeType` and the `'reverse-proof'` `targetPool` for prefilter, but did NOT propagate `wantsReverseProof` / `isReverseProof` / finish into `valuationService.evaluate()`. The engine only knows three pools:
  ```js
  // valuationService.js lines 45-50
  const usGraded = usCompsAll.filter(c => c.gradeType === 'graded');
  const usRaw    = usCompsAll.filter(c => c.gradeType === 'raw');
  const usProof  = usCompsAll.filter(c => c.gradeType === 'proof');
  ```
  There is no `usReverseProof` filter and no `wantsReverseProof` branch in the pool-selection ladder (lines 53-105). RP-tagged comps fail every filter and the engine falls through to the default raw branch, which selects zero comps because `gradeType !== 'raw'` for the entire pool. The downstream blend collapses to bullion-spot-premium / silver melt.
- **Impact**: Every coin with a Reverse Proof Terapeak dataset returns wrong FMV. Visible damage: 2023 RP Morgan ($56 vs ~$300-900 real). All 2024 RP Eagle, 2013-W RP Buffalo, etc. likely affected; pricing-health top-100 only caught the Morgan because it appeared in the top-comp-count slate.
- **Why measurement-first missed it**: The PR #114 8-coin slate measured **pool contamination** (RP comps appearing in regular Proof queries -- now 0%). It did NOT measure **FMV plausibility** for RP-intent queries. The contamination measurement was passing while the actual FMV was collapsing silently.
- **Proposed fix**:
  1. Pass `isReverseProof` (or normalized `finish`) from routes (`priceRoute.js`, `pricingBatchRoute.js`, `coinHistoryRoute.js`) into `valuationService.evaluate(opts)`.
  2. In `valuationService.js`, after line 43, add:
     ```js
     const wantsReverseProof = !!(opts.isReverseProof) ||
       /reverse[\s-]*proof/i.test(String(opts.finish || ''));
     const usRevProof = usCompsAll.filter(c => c.gradeType === 'reverse-proof');
     const glRevProof = glCompsAll.filter(c => c.gradeType === 'reverse-proof');
     ```
  3. Insert a `wantsReverseProof` branch BEFORE the `wantsProof` branch (lines 55-67) that mirrors the proof pool's "never mix in non-RP comps; flag lowData when thin; explanation when comps excluded" pattern.
  4. Update `usedPool` telemetry at line 432 to include `'reverse-proof'`.
- **Test plan**:
  - Add pricing-health assertion: any coin with `expected.finish='Reverse Proof'` and >=10 Terapeak rows must produce non-null FMV with confidence > 30 (or `lowData=true` flag must be set explicitly, not collapsed to raw).
  - Unit test in `__tests__/valuationService.test.js`: when `opts.isReverseProof=true` and `usCompsAll` has only `gradeType='reverse-proof'` comps, FMV is computed from those comps (not zero).
  - Regression test in `__tests__/valuationService.test.js`: when `opts.isReverseProof=true` but `usCompsAll` is empty for that gradeType, return explicit "no RP comps" explanation rather than falling through to raw.
- **Files**: `src/services/valuationService.js` (primary), `src/routes/priceRoute.js`, `src/routes/pricingBatchRoute.js`, `src/routes/coinHistoryRoute.js`, `src/services/bulkEvaluateService.js` (pass `isReverseProof` through), tests.
- **Related**: PR #114 (introduced the regression), #244 (telemetry fix that made the silent drops visible elsewhere but not this one), #176 (pool fallback patterns to mirror), #256 (auto-extend lookback -- should be implemented ON TOP of this fix, not instead of it).
- **Note on numbering**: This entry uses the new per-machine W/H suffix convention (see #264W). PR #118 from the other machine claimed the bare number #260; this entry coexists as #260W under the new convention.
- **Status (2026-06-17 -- bookkeeping flip)**: Code fix shipped 2026-06-04 in PR #126 (commit `5da13f0` -- "fix(#260W): add reverse-proof pool selector to valuationService"). Backlog entry was not flipped at the time. Verified in `src/services/valuationService.js#L41-L77` (intent detection, `wantsReverseProof` branch, `usRevProof` filter) and `#L456-L470` (`reverseProofCount` telemetry). Detected during #262W investigation; flipped to DONE in a separate doc-only PR.

---

## Scraper Launcher + Meta Sync (June 2026)

### #257. Documentation: cpf-go launcher + terapeak-meta sync [P3 -- DOCS] -- DONE 2026-06-04
- **Scope**: README.md scripts table + Admin endpoints table + "Recent Changes" entries for #258/#259; docs/ARCHITECTURE.md scripts tree + Persistence tiers section (added 4th tier); docs/runbooks/local-scraper-wsl2.md auto-sync callout.
- **PR**: #116 (`feat/255-docs-cpf-go-meta-sync`).
- **Why a separate ticket**: the two underlying work tickets (#258/#259) shipped first with misnumbered commit subjects. This ticket exists so the documentation update itself has a backlog reference.

### #258. WSL scraper launcher (`scripts/cpf-go`) [P2 -- OPERATIONS] -- DONE 2026-06-04
- **Merge commit**: `baf530c` -- subject reads `#252 add scripts/cpf-go launcher + WSL runbook updates (#110)`. The `#252` reference in the subject is a misnumbering -- that slot was already taken on `main` by "Bullion Strike-Pool Split Misclassifies Graded Bullion as Off-Pool [P1]" (unrelated, OPEN). Canonical backlog ticket = **#258**.
- **What shipped**: `scripts/cpf-go` one-command bootstrap + run wrapper for the WSL/Surface scraper path (apt prereqs -> repo clone/pull -> Python venv + Playwright Chromium -> `npm ci` -> env sanity -> optional interactive cookie refresh -> exec/loop `./surface --skip-probe`); `.gitattributes` LF enforcement for `*.sh` and `scripts/cpf-go` (CRLF would crash the freshness loop with `Unknown argument:`); runbook updates in `docs/runbooks/local-scraper-wsl2.md` ("Fast path" section with flag tables and operational guardrails).
- **Flags consumed by `cpf-go`**: `--no-login`, `--loop`, `--pause-between=SEC` (default 300). All other flags forwarded to `./surface`.

### #259. Remote-scraper terapeak-meta sync [P1 -- OPERATIONS/DATA-INTEGRITY] -- DONE 2026-06-04
- **Merge commit**: `53eba23` -- subject reads `#253 sync terapeak-meta from Azure before freshness report (#113)`. The `#253` reference is a misnumbering -- that slot was already taken on `main` by "Malformed Dataset Keys Produce Nonsensical FMVs [P2]" (unrelated, OPEN). Canonical backlog ticket = **#259**.
- **Root cause**: `data/terapeak-meta.json` is the freshness classifier's only input but its only writer (`saveMetaSidecar()` in `src/services/terapeakService.js`) runs server-side. Remote scrapers using `UPLOAD_MODE=api` POST CSVs to Azure for ingest, so their on-disk sidecar is git-frozen and `generate-freshness-report.js` keeps re-targeting the same coins forever -- the loop appears to run at zero efficiency.
- **What shipped**: new admin endpoint `GET /api/admin/terapeak-meta` in `src/routes/adminRoute.js` (streams sidecar with `X-Meta-Mtime` + `X-Meta-Bytes` headers, `Cache-Control: no-store`, requires `ADMIN_API_KEY` via `requireAdminOrKey`); `sync_meta_from_app()` in `scripts/run-surface-freshness-loop.sh` runs before `generate-freshness-report.js` on every pass (curl + JSON validation + atomic `mv -f`); failure modes log `[warn]` and proceed -- never crashes the loop; 4 new tests in `__tests__/adminRoute.test.js`.

### #260. Windows-side terapeak-meta sync (`scripts/sync-terapeak-meta.js`) [P1 -- OPERATIONS/DATA-INTEGRITY] -- DONE 2026-06-04
- **Discovered**: same-day investigation of "why didn't the freshness report move after running cpf-go all day". The #259 fix only covers the remote scraper box -- it pulls Azure -> WSL before each freshness report on that machine. The Windows developer workstation has no such hook, so `node scripts/generate-freshness-report.js` on Windows keeps reading a git-frozen `data/terapeak-meta.json` while the scraper happily updates Azure. Evidence: WSL `terapeak-meta.json` mtime 2026-06-04 14:31 with 268 entries stamped `page1At` today; Windows `terapeak-meta.json` mtime 2026-06-04 13:26 with zero entries from today. Manual `curl /api/admin/terapeak-meta` -> overwrite confirmed the gap was data-flow, not logic.
- **What shipped**:
  - `scripts/sync-terapeak-meta.js` -- Node script using built-in `https` (no new deps). Loads `APP_URL` + `ADMIN_API_KEY` from `.env` or environment; fetches `GET /api/admin/terapeak-meta` with `x-api-key`; validates JSON; backs up existing file to `data/archive/terapeak-meta.before-azure-sync-<ISO>.json` (skippable with `--no-backup`); atomic write via tmp + rename. Exit codes: 0 ok / 1 config / 2 network. Flags: `--check` (report delta, don't write), `--no-backup`, `--quiet`.
  - `package.json` scripts: `npm run sync:meta` -> standalone sync; `npm run freshness` -> sync then regenerate report (the canonical Windows-side workflow now).
  - `.env.example` -- adds documented `APP_URL` + `ADMIN_API_KEY` entries with comment block explaining the freshness flow.
- **Validation**: ran end-to-end against live Azure (5,094 entries / 3.19 MB pulled, JSON validated, atomic write succeeded). `--check` mode correctly reported `+0 bytes, +0 entries` after a baseline sync. Backup path tested separately (works on native Windows; WSL->Windows mount EPERM is a known cross-FS quirk that does not affect the Windows-native path).
- **Operational note**: this is the second leg of the meta-sync triangle. Triangle is now closed:
  - WSL scraper POSTs CSVs -> Azure (via `UPLOAD_MODE=api`)
  - Azure -> WSL pulled by `sync_meta_from_app()` before each freshness report (#259)
  - Azure -> Windows pulled by `npm run sync:meta` on demand (#260)
- **Follow-up candidate (not blocking)**: integrate sync into `generate-freshness-report.js` itself as an opt-in flag (e.g. `--sync-from APP_URL`), so the report is always honest by default on any machine. Track separately if/when raised.

---

### #270W. Restore proper raw-bullion FMV without pool merging [P1 -- DATA-QUALITY] -- OPEN 2026-06-23

**Context:** Replaces the reverted #252. The original symptom is real and still on the table: the 2026-06-04 Maple pricing-health run had 9/13 RED rows on 1oz Gold Maple Leaf datasets, with `prefilterStrikeSplit` as the top drop bucket (1-45 comps per dataset, worst case 2025 Maple Leaf at 164 gathered / 3 survived / 98.2% attrition). PR #154 attempted to fix this by merging the `graded` and `raw` pools for >=1oz bullion. That approach was reverted on 2026-06-23 because it violates the pool-isolation contract in `docs/memory/numismatic-terminology.md` -- raw, graded, and proof are three distinct pools as observed by `classifyGradeType()`, and modern bullion series still contain scarce dates / varieties / first-year issues where the cross-pool dispersion is wide enough to make a blended FMV wrong for both pools.

**Hard constraints (mandatory for any candidate solution):**
1. MUST NOT merge raw + graded comps into a single FMV.
2. MUST NOT merge raw + proof or graded + proof.
3. MUST NOT merge reverse-proof into any other pool.
4. Any computed FMV is attributed to exactly ONE pool; multi-pool reporting requires side-by-side surfacing, not blending.
5. Any PR touching `classifyGradeType`, the `applyFilters` pool gates, or the `prefilterStrikeSplit` block in `src/services/ebayService.js` must cite `docs/memory/numismatic-terminology.md` in the PR body and explain which pool boundary is being crossed and why.

**Options to evaluate (final scope deferred -- user will decide):**

1. **Adaptive lookback for sparse raw-bullion comps.** Today the Terapeak window is fixed. When the raw pool returns fewer than `usMinComps` after strike-split, extend the lookback 120d -> 180d -> 365d on the raw pool only. Pros: simple, deterministic, doesn't touch pool boundaries, leverages the existing freshness pipeline. Cons: only works if older raw comps exist in the dataset; for newly-issued bullion years there may be no fix.

2. **Better Terapeak seeding for raw bullion.** The scraper today seeds queries that bias toward graded inventory (PCGS/NGC URLs tend to surface slabbed comps). Add a raw-bullion seed pass per series (Gold Maple, Gold Eagle, Krugerrand, Britannia, Panda, Libertad) that explicitly excludes `condition=2000` and targets BU / .9999 / Mint / Tube listings. Pros: structural fix at the data layer, no logic change in `ebayService.js`. Cons: requires scraper changes + a refresh cycle before benefit shows up in FMV. Cross-reference: #253 Track B proposes a canonical-weight whitelist in `data/constants.js`; the seeder here must use the same source of truth (do not duplicate the whitelist).

3. **Two-pool FMV surfacing.** Return BOTH `fmvRaw` and `fmvSlab` side-by-side when both pools have enough comps -- as two distinct numbers, never blended. Frontend renders both. The "primary FMV" defaults to the pool inferred from the query (no slab grade -> raw; explicit grade -> slab). Pros: pool-preserving, lets the operator see both numbers directly, fixes the operator-confusion problem that #252 was trying to paper over. Cons: schema change in response, UI work in `/api/price` consumers, conventions for how to display the secondary pool. Concrete precedent (needs verification before implementation): published price guides for bullion typically separate raw spot-plus-spread from certified-condition pricing -- confirm with the Greysheet / CDN-Bid API contract during scoping.

4. **Honest "insufficient comps" return.** When the raw pool is empty after strike-split AND adaptive lookback fails, return `fmvCore: null` + `confidence: 'unreliable'` + `lowData: true` + `dataSource: 'metal-only'`. Force callers to render the gap instead of fabricating a number. Pros: trivial to implement, no pool boundary crossed, no false confidence in thin data. Cons: rolls some current "GREEN with 1-3 comps" rows back to "honest YELLOW" -- this is a feature, not a bug, but it will change pricing-health output.

5. **Looser deny-list / relevance gates on the raw pool specifically.** Audit `applyFilters` to see whether some raw-bullion comps are being dropped by overly-aggressive deny-list / weight-tolerance / spread gates that are appropriate for numismatic series but too tight for liquid bullion. Tighten or loosen per-pool. Pros: keeps the strict pool split but recovers signal from comps that should have passed. Cons: more nuanced; needs a per-pool config and per-series exception list; risk of regressing other categories if not careful.

**Recommended sequence (subject to user approval):**
- Land #4 first (low risk, immediate honesty win).
- Then #1 (adaptive lookback) -- biggest impact for the smallest surface area, no boundary crossed.
- Then evaluate #2 vs #3 based on how much raw signal still remains after the first two.
- #5 is an audit-then-fix; queue it after the first two if pricing-health still RED.

**Acceptance criteria (any candidate fix):**
- 2026-06-04 Maple + Eagle pricing-health re-run: <= 1 RED row on Gold 1oz datasets (down from 9).
- No graded comps appear in any reported raw FMV pool (`result.us.comps` are all `gradeType === 'raw'` when target was raw).
- No proof / reverse-proof comps appear in raw or graded pools (no regression of the existing pool isolation).
- The "primary FMV" returned for a query without an explicit slab grade is computed from raw comps only (or returned as null with `confidence: 'unreliable'` if raw pool is empty).
- New unit tests in `__tests__/ebayFetchSoldComps.test.js` for whichever option(s) ship: each must include a "graded comps do not leak into raw FMV" assertion and a "proof comps do not leak into raw or graded FMV" assertion.

**Files (anticipated, depending on option chosen):** `src/services/ebayService.js` (raw-pool lookback / pool-isolation guards), `src/services/valuationService.js` (honest insufficient-comps return), `src/services/terapeakService.js` (seeding for option 2), `schemas/priceResponse.schema.js` (two-pool surfacing for option 3), `__tests__/ebayFetchSoldComps.test.js`, `__tests__/computeValuation.test.js`, BACKLOG follow-ups.

**Forbidden anti-patterns (record of the 2026-06-18 to 2026-06-23 pollution event):** pool merging in any form, treating slabbed bullion as equivalent to raw bullion in a single FMV stream, using `prefilterStrikeSplit` count as a success metric (it is a correct rejection counter -- a high value is a sparse-pool signal, not a bug to "fix" by widening the gate).

**Cross-reference:** `docs/memory/numismatic-terminology.md` (canonical pool-isolation rule), `/memories/repo/pool-isolation-rule.md` (agent-side mandatory read before any related PR), original symptom in #252 (reverted), related work in #253 / #260W / #244.
