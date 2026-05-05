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

### ~~P1. LowRelevance Over-Filtering on Empty-Title Terapeak Comps [WONTFIX]~~

Empty titles are already filtered at CSV import (`rowToComp` returns null). The `lowRelevance` gate (score < 20) only fires for truly irrelevant comps (multiple mismatches: wrong year + wrong series + wrong weight). High attrition on ASE/Krugerrand is caused by eBay's broad search returning off-topic results in the Terapeak dataset, not by the gate threshold. Survival rates (30/100 for ASE, 8/45 for Krugerrand) are adequate for FMV calculation.

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

## Completed (reference)

| # | Item | Commit |
|---|------|--------|
| S0 | Active Listings Guard | Tab check + date validation in both aggregation scripts |
| S1 | Finish Page 1 remaining | Mostly done; 157 remaining are Royal Mint Lunar (no Terapeak data) |
| S3 | Refresh Stale >30d | `0d6c814` -- 1/42 succeeded (all Royal Mint Lunar = no data on eBay) |
| P0-A | MintMismatch over-filtering (over-mintmark) | `a1e02ca` -- matchAll + over-mintmark detection |
| P0-B | Batch route missing year in keywords | `a1e02ca` -- pass year/mint into buildKeywords |
| 111 | Admin Portal | `public/admin.html` + `/api/admin/*` endpoints |
| 112 | Staleness Tracker Endpoint | `GET /api/admin/stale-datasets` |
| 113 | One-Click Refresh Script | `scripts/refresh-stale.sh` |
| 21 | Batch pricing in My Coins | `my-coins.js` `_fetchPricing` (chunks of 25) |
| 22 | Event delegation | `my-coins.js` `_setupDelegation()` |
| 23 | Client-side spot cache | `my-coins.js` 5-min `SPOT_CACHE_TTL` |
| 11-20 | Code review findings (April 2026) | All resolved -- see README "Recent Changes" |
| 1-10 | Account features, labels, agents | All done |
