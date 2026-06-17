# eBay Search & Filtering Logic Analysis

## Problem Statement
Mexican Silver Libertad 2020 searches return:
- Coins from 1962 (Libertad bullion didn't exist until 1982)
- Non-bullion coins with "libertad" in title
- 1/2 oz mixed with 1 oz results

## Root Causes Identified

### 1. Year Filtering Gap (1962 Libertad Issue)
**Location:** [ebayService.js](ebayService.js#L860-L880)
- Year filtering uses LOOSE tolerance (+/- 1 year for non-bullion, exact for bullion)
- No DATABASE of historical coin existence (e.g., when Libertad production started)
- **Gap:** 1962 Libertad is physically impossible but score doesn't catch it
- **Score Penalty:** -30 for year mismatch (line 867) but only if MULTIPLE years in title and ALL are outside range
- **Problem:** "1962 Libertad" has only ONE year, which matches expected if Libertad was searched generically

### 2. Weight Filtering (1/2 oz vs 1 oz)
**Detection Function:** [ebayService.js#L81-L107](ebayService.js#L81-L107)
- `detectWeightFromTitle()` extracts oz from title
- Returns 0.5 for "1/2 oz", 1 for "1 oz", etc.
- **Weight Match Logic:** [ebayService.js#L533-L543](ebayService.js#L533-L543)
  - Match: +25 points
  - Mismatch: -35 points
  - Not stated: -15 points
- **Hard Filter:** [ebayService.js#L818-L826](ebayService.js#L818-L826)
  - Removes comps with explicit WRONG weight (e.g., 1/2 oz title when 1 oz searched)
  - Tolerance: 0.01 oz
- **Melt Sanity Check:** [ebayService.js#L827-L837](ebayService.js#L827-L837) (fractional)
  - If detected weight is NULL (not stated) AND price > 1.8× full-oz melt, DROP
  - Threshold: 1.8× melt ceiling (generous)

### 3. Bullion Default Weight (1 oz Auto-Assignment)
**Location:** [priceRoute.js#L23-L35](priceRoute.js#L23-L35)
- If no weight specified AND series matches 'libertad', 'silver eagle', etc., DEFAULT to 1 oz
- **List includes:** libertad, silver eagle, gold eagle, maple leaf, britannia, etc.
- **Effect:** "Mexican Silver Libertad 2020" auto-defaults to 1 oz search
- **Then applyFilters() hard-filters 1/2 oz results** [ebayService.js#L818-L826](ebayService.js#L818-L826)

### 4. Deny-List Filtering
**Location:** [filters.js#L2-L15](filters.js#L2-L15)
- Blocks: lots, collection, roll, estate, replica, fake, token, plated, album, folder, whitman
- **Roll exception:** Can be allowed by `{ allowRoll: true }` option
- **Effect:** Rejects multi-coin collections but NOT individual "copy" coins

## Current Filtering Pipeline

### Scoring Phase (per-comp)
[ebayService.js#L272-L581](ebayService.js#L272-L581)

| Factor | Match | Mismatch | Source |
|--------|-------|----------|--------|
| Year | +15 | -30 | Line 300-309 |
| Weight | +25 | -35 | Line 533-543 |
| Mint | +10 | -30 | Line 313-335 |
| Series | +10 | -25 | Line 336-342 |
| Grade | +15 (exact) | -20 (raw vs graded) | Line 349-375 |
| Proof vs BU | -- | -25 | Line 408-416 |
| Metal | +10 | -30 | Line 482-487 |
| PCGS Certification | +5 | -- | Line 500 |

**Baseline score: 50**
**Quality gates:** exact=85+, close=65+, loose=<65

### Hard Filtering Phase
[ebayService.js#L596-L965](ebayService.js#L596-L965)

| Filter | Condition | Effect |
|--------|-----------|--------|
| Relevance Gate | matchScore < 20 (30 for sets) | DROP |
| Deny-List | replica, fake, etc. | DROP |
| Year Mismatch | Bullion: exact; Non-bullion: ±1 tolerance | DROP |
| Weight Mismatch | Detected ≠ Expected (±0.01 oz) | DROP |
| Melt Sanity (Fractional) | No weight detected + price > 1.8× melt | DROP |
| Melt Floor (1oz+) | No weight detected + price < 0.4× melt | DROP |
| Metal Mismatch | Detected metal ≠ Expected | DROP |
| Composition Mismatch | Silver/clad era conflict | DROP |
| Mint Mismatch | Detected mint ≠ Expected | DROP |
| Denomination Mismatch | Quarter vs dime, etc. | DROP |
| Series Conflict | Jefferson vs Buffalo | DROP |
| Variant Mismatch | Gilded/colored when not searched | DROP |
| Proof Mismatch | User wants proof, comp is BU | DROP |
| Set/Roll Matching | Set search needs "set" keyword | DROP |
| MAD Outlier Removal | 3.5σ on price | DROP |

## Market Matrix Route (Live eBay Tracker)
**Location:** [marketRoute.js](marketRoute.js) → [marketAggregator.js](marketAggregator.js)

### Bullion Detection
[marketAggregator.js#L17](marketAggregator.js#L17)
```javascript
const BULLION_SERIES_RE = /\b(silver eagle|libertad|...)\b/i;
```
**Bullion series:** Switch from year×mint matrix → grade×year matrix

### Matrix Building
[marketAggregator.js#L194-L272](marketAggregator.js#L194-L272)

1. Group completed comps by year+mint (or year+grade for bullion)
2. Calculate median from completed sales
3. Extract cheapest BIN from active listings
4. Support grade filtering (`?grade=MS65`)
5. Support weight parameter (`?weight=0.5`)

### Grade Extraction
[marketAggregator.js#L107-L114](marketAggregator.js#L107-L114)
- Pattern: `MS65`, `PR69`, `AU58+`
- Returns "RAW" if no formal grade detected
- Grade filter: Full title match required [marketAggregator.js#L155-L161](marketAggregator.js#L155-L161)

### Year-Dependent Filtering
**Lunar Series:** [marketAggregator.js#L763-L789](marketAggregator.js#L763-L789)
- Perth Lunar Series I: 1996-2007
- Perth Lunar Series II: 2008-2019
- Perth Lunar Series III: 2020-2031
- **Effect:** Perth Year Of The Rooster + year → filters by zodiac year range

## Proposed Fixes for Libertad 2020 Issue

### 1. Add Coin Existence Database
- Map series → production start year
- Example: `{ 'libertad': { bullion_start: 1982, regular_start: null } }`
- Hard-filter comps from before start year
- Location: New file `src/data/coinProduction.js`

### 2. Strengthen Year Validation for Bullion
- For bullion (weight specified): Strict year match without tolerance
- Already implemented for `expected.weight > 0` [ebayService.js#L853](ebayService.js#L853)
- BUT: Relies on `detectWeightFromTitle()` finding weight in comp title
- **Gap:** If comp title says "Libertad 1962" with NO weight, tolerance is +/- 1

### 3. Improve Libertad-Specific Detection
- Add 'libertad' to DENOM_RULES or series-specific validation
- Reject pre-1982 Libertad coins with specific check
- Location: [filters.js#L44-L70](filters.js#L44-L70)

### 4. Add Weight Requirement for Fractional Searches
- If weight < 1 oz, REQUIRE weight in title (no benefit-of-doubt)
- Currently benefit-of-doubt allows unlabeled 1 oz as 1/4 oz[ebayService.js#L540](ebayService.js#L540)
