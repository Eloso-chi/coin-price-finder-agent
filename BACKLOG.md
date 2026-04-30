# Backlog

Open work items, ordered by priority within each category.
Items marked DONE are kept for historical reference.

---

## Scraping & Data Pipeline

### S0. Active Listings Guard in Scraper [MEDIUM]

**Problem:** When Terapeak has no sold results, eBay may auto-switch to "Active listings" tab. Scraper currently doesn't detect this -- could ingest asking prices as sold comps, contaminating FMV.

**Fix:** In `scripts/terapeak-export.py` (`do_search_and_export`, after DOM scrape):
- Validate "Sold" tab is active before accepting rows
- OR require date column has parseable dates (active listings have no sold date)
- If neither condition met, log warning and skip

**Files:** `scripts/terapeak-export.py`

---

### S2. Page 2+ Deep Pagination [HIGH]

**Problem:** 1,341 coins have exactly 50 rows (page 1 limit) and likely have more data available on page 2+. Enriching these doubles comp coverage for high-volume coins.

**Status:** 131 already enriched (6,332 rows added). 1,341 remaining. ~8 hours total runtime.

**Command:** `python3 scripts/terapeak-page2.py --run --limit N`

**Files:** `scripts/terapeak-page2.py`

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

### 115. GitHub Actions Scheduled Scrape [LOW -- long-term]

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
| S1 | Finish Page 1 remaining | Mostly done; 157 remaining are Royal Mint Lunar (no Terapeak data) |
| S3 | Refresh Stale >30d | `0d6c814` -- 1/42 succeeded (all Royal Mint Lunar = no data on eBay) |
| 111 | Admin Portal | `public/admin.html` + `/api/admin/*` endpoints |
| 112 | Staleness Tracker Endpoint | `GET /api/admin/stale-datasets` |
| 113 | One-Click Refresh Script | `scripts/refresh-stale.sh` |
| 21 | Batch pricing in My Coins | `my-coins.js` `_fetchPricing` (chunks of 25) |
| 22 | Event delegation | `my-coins.js` `_setupDelegation()` |
| 23 | Client-side spot cache | `my-coins.js` 5-min `SPOT_CACHE_TTL` |
| 11-20 | Code review findings (April 2026) | All resolved -- see README "Recent Changes" |
| 1-10 | Account features, labels, agents | All done |
