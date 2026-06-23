# Comp-Data Skill

Domain knowledge for the eBay sold-comp pipeline (`src/services/ebayService.js`)
and the Terapeak ingestion / lookup layer (`src/services/terapeakService.js`).
This SKILL is a routing reference; the canonical operational runbook is
`docs/memory/terapeak-runbook.md`.

Read this SKILL before editing either service or any caller of
`fetchSoldComps` / `lookupComps`. INC-001 (CSV overwrite, $3.72), INC-002
(sidecar race, $2.22), INC-004 (bot detection, $0.56), INC-011 (backfill
truncation, $0.99), and INC-013 (pool-isolation violation, $10.03) all
happened in this surface.

---

## Required Reading Before Editing

| Doc | What it owns |
|---|---|
| `docs/memory/terapeak-runbook.md` | Operational runbook: CSV format, quota, anti-detection, scraper sequencing, deep-pagination |
| `docs/memory/numismatic-terminology.md` | **MANDATORY Pool-Isolation Contract** + `classifyGradeType` semantics |
| `docs/memory/terapeak-export-process.md` | Export-side process discipline (INC-001 + INC-004 context) |
| `docs/WASTE-LEDGER.md` INC-001, INC-002, INC-004, INC-011, INC-013 | Five postmortems with rules added |
| `src/services/ebayService.js` L6-26 | JSDoc GOVERNING DOCS banner -- load-bearing |
| `src/services/terapeakService.js` | No JSDoc banner yet (#271W follow-up); read the lookupComps guard chain at L400-520 |

---

## Hard Rules

These rules are not negotiable. A change that violates any of them must
not merge regardless of test coverage.

1. **`prefilterStrikeSplit` is a strict-equality pool gate, NOT a metric
   to minimize.** The check at `src/services/ebayService.js:1530` is
   `return gt === targetPool;`. Rejected comps are CORRECT rejections, not
   noise. Do not relax this filter to "boost comp count". The regression
   test at `__tests__/ebayFetchSoldComps.test.js:476` pins this; the test
   title literally reads "DO NOT relax without re-reading
   docs/memory/numismatic-terminology.md".
2. **CSV writes go through `_merge_csv()` with the shrink guard. Never
   `.rename(dest)`.** INC-001 destroyed 5 hours of deep-paginated data
   when an export overwrote the merged CSV with a page-1-only file.
   Scraper-side rule lives in `scripts/terapeak-export.py`; the rule is
   here so anyone editing the ingestion path is aware.
3. **All disk writes from `terapeakService.js` MUST be guarded by
   `NODE_ENV=test`.** `saveStore()` (L55) and `saveMetaSidecar()` (L79)
   both have this guard. Adding a new write path without the guard is
   what caused INC-002. The guard returns immediately during tests
   without I/O.
4. **`lookupComps` runs a chain of guards before fuzzy scoring.** The
   guards (year, weight, metal, mint-origin, specialty, grade) are not
   optimization heuristics -- they are correctness gates. Loosening any
   one is a pool-isolation-class risk; cite the relevant `docs/memory/`
   doc and the INC if you must.
5. **Browse API is last-resort.** It returns ACTIVE listings (asking
   prices), not solds. The confidence engine penalizes browse-only
   results (-30 if all asking). Do not promote browse above the cascade
   priority.

---

## Module Map -- `src/services/ebayService.js`

| Export | Lines | Purpose |
|---|---|---|
| `fetchSoldComps(keywords, options, expected)` | L1370-1750+ | Top-level cascade: Terapeak -> Finding (deprecated) -> Browse; returns `{ us, global, usedFallback, apiUsed, lookback }` |
| `buildKeywords(pcgsData, rawQuery, weight, label)` | L1900-1926 | Build eBay search keywords; metal-exclusion gates + demonym normalization |
| `scoreMatch(comp, expected)` | L560-900 | Assign `matchScore` (0-100) + quality label (exact / close / loose) |
| `classifyGradeType(comp)` | L170-235 | Classify into `raw` / `graded` / `proof` / `reverse-proof` pool; conditionId -> certification aspect -> title regex |
| `applyFilters(comps, options, expected)` | L930-1250 | 25+ hard filters in order; returns `{ kept, removed, gathered }` -- `removed.prefilterStrikeSplit` is the pool gate counter |
| `browseSearch(keywords, limit, brandFilter)` | L420-475 | Browse API last-resort (active listings) |
| `dedup(comps)` | L900-915 | Dedup by `itemId` and normalized `title + price` |
| `clearCache()` | L1920 | Flush sold-comps cache |
| `detectMetalFromTitle(title)` | L80-125 | Metal detection with decorative-gold / brand-gold exclusions |

---

## Module Map -- `src/services/terapeakService.js`

| Export | Lines | Purpose |
|---|---|---|
| `parseCSV(csvData, searchTerm)` | L545-700 | Sync CSV parse (`csv-parse/sync`); column mapping, price / date / condition / metal / weight extraction |
| `importComps(searchTerm, comps, opts)` | L100-160 | Merge into in-memory store under `normalizeSearchKey()`; stamps `lastImport`, `importCount`; triggers `saveStore()` + `saveMetaSidecar()` |
| `lookupComps(searchTerm, opts)` | L400-520 | Fuzzy dataset lookup with 15+ guards; merges multi-year datasets if no year in query |
| `listDatasets()` | L750-765 | List stored datasets with counts + metadata |
| `deleteDataset(key)` | L768-776 | Delete one dataset |
| `clearAll()` | L779-781 | Wipe all terapeak data |
| `evictStaleComps(maxDays)` | L784-810 | Drop comps older than `maxDays`; remove empty datasets |
| `purgeStaleCSVs(folderPath, maxDays)` | L813-860 | Delete CSV files (+ companion `.meta`) where all comps are older than `maxDays` |
| `autoImportFolder(folderPath)` | L1650-1750+ | Auto-import CSVs from folder; progress in JSON sidecar |
| `autoImportFromBlob()` | L1750-1858 | Auto-import CSVs from Azure Blob; mirrors `autoImportFolder` |
| `saveStore()` | L52-65 | Debounced (500 ms) write to `cache/terapeak_sold.json`; **NODE_ENV=test guard at L55** |
| `saveMetaSidecar()` | L78-114 | Debounced (500 ms) write to git-tracked `data/terapeak-meta.json`; **NODE_ENV=test guard at L79**; normalizes keys before write |
| `loadMetaSidecar()` | L390-428 | Read aggregationMeta from sidecar at startup |
| `hydrateMetaFromCosmos()` | L430-475 | Read aggregationMeta markers from Cosmos at startup; non-fatal on error |
| `updateDatasetMeta(searchTerm, metaUpdates)` | L865-882 | Update aggregationMeta without importing comps (for `noDataAt` / `noDataCount`) |
| `normalizeSearchKey(term)` | L885-1000+ | Canonicalize search term (lowercase, strip operators, normalize fractions, country / mint aliases); idempotent |

---

## 3-Tier eBay Cascade

`fetchSoldComps` tries sources in priority order, highest fidelity first:

1. **Terapeak** (L1480-1525) -- imported CSV sold data, highest fidelity.
   Falls back to raw-query lookup if normalized keywords miss. Both
   attempts can be combined if they hit different datasets.
2. **Finding API** (L1625-1680) -- `EBAY_FINDING_ENABLED` gated;
   **deprecated Feb 2025**. Tries 90 / 180 / 365 day windowing if
   insufficient comps.
3. **Browse API** (L1680-1750) -- active listings only; lowest priority
   due to asking-price inflation.

Pool gate runs after Terapeak (L1515-1530): `prefilterStrikeSplit` counts
comps whose `classifyGradeType()` does not match `targetPool` and removes
them. See "Hard Rule #1" above.

---

## Attrition Pipeline (applyFilters)

`applyFilters` runs 25+ gates in order. Each rejects with a counter so the
caller can compute attrition percentage (used by confidence scoring).

Order matters. Selected gates:

- Relevance floor (matchScore 20 / 30 / 45 depending on mode)
- Deny-list (`isDenied` from `src/utils/filters.js`)
- Non-bullion denominations
- Set filter, roll filter, proof filter, bar brand filter
- Exclusion terms
- USD-only, metal mismatch, composition mismatch
- Weight mismatch (5 % relative tolerance)
- Precious-metal-content sanity, year mismatch
- Melt-floor, variant filter, type 1 / 2 filter
- Mint-mark filter, denomination filter, series conflict
- Grade-number mismatch
- MAD outlier removal on `totalUsd`

If attrition > 50 %, confidence drops -5; > 70 % -10; > 90 % -20. Adding
new filters changes the attrition signal -- update confidence weighting
considerations in `valuation/SKILL.md` if you add a filter that fires
frequently.

---

## lookupComps Guard Chain

The fuzzy-match path in `terapeakService.lookupComps` runs these guards
in order BEFORE scoring:

1. Empty-dataset guard (#267H) -- skip zero-comp datasets (L422-430)
2. Year mismatch -- reject different year when query specifies year (L432-440)
3. Weight mismatch -- reject if relative weight diff > 5 % (L442-448)
4. Metal mismatch -- reject if dataset metal differs (L450-455)
5. Mint origin (Perth / RoyalMint / RCM / Chinese / Mexican / Austrian) (L457-475)
6. Specialty (proof / burnished / enhanced / type tokens) -- only match queries with those tokens (L477-495)
7. Grade -- reject grade-specific datasets when query has no grade; reject different-grade datasets when query has grade (L497-503)

Then fuzzy scoring with bonuses (generic / metal / weight-compound /
mint-mark / grade / year-specificity) + tiebreakers (L505-520). Multi-year
results merged ONLY if query has no year.

---

## CSV Format and Quota (from terapeak-runbook.md)

CSV expectations (the scraper enforces this; the importer trusts it):

- Sort by "Date last sold" descending before collecting.
- Include "Quantity Sold" column.
- One CSV per coin / variant / search term.
- Upload via `POST /api/terapeak/import` (or auto-import on server start).

Quota and anti-detection (`docs/memory/terapeak-runbook.md` L100-101,
L81-90):

- Terapeak history depth: up to 3 years.
- Page 1 delays: 8-18 s between searches; coffee breaks every 12-25
  coins.
- Page 2+ delays: 2.5-6 s between pages; occasional 4-10 s "reading"
  pauses; 30 % chance of 15-45 s micro-breaks for deep pagination.
- Bot detection killed an export session at 22 % in INC-004. Anti-detection
  is load-bearing.

---

## Environment Variables (eBay client)

| Var | Default | Purpose |
|---|---|---|
| `EBAY_APP_ID` | '' | AppID for Finding API |
| `EBAY_CLIENT_SECRET` | '' | OAuth secret |
| `EBAY_FINDING_ENDPOINT` | `https://svcs.ebay.com/services/search/FindingService/v1` | Finding API endpoint |
| `EBAY_GLOBAL_ID` | `EBAY-US` | Default market |
| `EBAY_ENTRIES_PER_PAGE` | 50 | Page size |
| `EBAY_TIMEOUT_MS` | 10000 | HTTP timeout |
| `EBAY_CACHE_TTL_MS` | 3600000 | Sold-comps cache TTL (1 h) |
| `EBAY_US_MIN_COMPS` | 8 | Minimum US comps before considering fallback |
| `EBAY_THROTTLE_MS` | 1100 | Inter-request throttle |
| `EBAY_FINDING_ENABLED` | `'false'` | Gating for deprecated Finding API |

---

## When You Are About to Edit ebayService.js or terapeakService.js

Run this checklist BEFORE writing code:

- [ ] You have read this SKILL plus the relevant `docs/memory/` doc(s).
- [ ] You have read the JSDoc GOVERNING DOCS banner at
      `src/services/ebayService.js` L6-26.
- [ ] If editing `classifyGradeType` / `applyFilters` /
      `prefilterStrikeSplit`: you have read
      `docs/memory/numismatic-terminology.md` MANDATORY contract and
      `docs/WASTE-LEDGER.md` INC-013 (Mistakes + Rules Added).
- [ ] If editing `saveStore` / `saveMetaSidecar` or adding any disk
      write: you have verified the `NODE_ENV=test` guard at L55 / L79
      and you will replicate it.
- [ ] If editing CSV write path in `scripts/terapeak-export.py`: you
      have read `docs/WASTE-LEDGER.md` INC-001 and confirmed your code
      uses `_merge_csv()` with shrink guard.
- [ ] You have read the regression test at
      `__tests__/ebayFetchSoldComps.test.js:476` and the relevant
      `terapeakService.test.js` cases.

For M / L tier changes to either service, run `@numismatic-audit` Step 5b
(pool-isolation contract check) and PASS before merge.

---

## Cross-References

- `.github/skills/valuation/SKILL.md` -- downstream consumer (FMV / confidence / buy-sell)
- `.github/skills/numismatics/SKILL.md` -- domain knowledge: classification decision tree, MANDATORY Pool-Isolation Contract
- `.github/skills/process-discipline/SKILL.md` Hot Files table -- ebayService.js, terapeakService.js, terapeak-export.py rows
- `.github/skills/workflow/SKILL.md` -- PR workflow, tiered execution, deep-review requirement
- `docs/memory/terapeak-runbook.md` -- operational runbook
- `docs/memory/terapeak-export-process.md` -- scraper-side process discipline
- `docs/memory/numismatic-terminology.md` -- MANDATORY Pool-Isolation Contract + `classifyGradeType` semantics
- `docs/ARCHITECTURE.md` L86-89, L166-180 -- comp data flow in pricing pipeline
- `docs/WASTE-LEDGER.md` INC-001, INC-002, INC-004, INC-011, INC-013
- `src/services/ebayService.js` L6-26 -- file-level JSDoc GOVERNING DOCS banner
