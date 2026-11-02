# Bulk Evaluate Feature (Lot Evaluator) - Complete Reference

## Overview
The "Lot Evaluator" or "Bulk Evaluate" feature accepts a non-empty text or JSON lot of up to 500 entries, producing per-coin FMV values and lot-level buy recommendations. Entries after the first 500 are ignored. The advertised Excel path is currently broken and returns HTTP 400; use text or JSON. Implemented as #108 in the codebase.

## Architecture
- **Route**: `POST /api/bulk-evaluate` + `GET /api/bulk-evaluate/:jobId/stream`
- **Service**: `bulkEvaluateService.js`
- **Frontend**: Tab in `public/index.html` with JavaScript event handling
- **Job Model**: In-memory UUID-keyed job store with 1-hour TTL

## Input Formats
1. **Text**: One coin per line, pipe-delimited optional fields: `1921 Morgan Dollar | qty=5 | grade=MS-63 | year=1921 | mint=S | weight=26.73`
2. **JSON**: Array of objects: `[{query: "1921 Morgan Dollar", qty: 5, grade: "MS-63", year: "1921", mintMark: "S", weight: 26.73, series: "Morgan"}]`
3. **Excel (.xlsx): currently unavailable**. The route's Excel adapter calls async `mapExcelToBackup()` synchronously and currently returns HTTP 400 (`No coins found in Excel file`). Use text or JSON until the adapter is corrected.

The API requires at least one coin. Text and JSON parsers keep only the first 500 entries; additional entries are silently ignored. JSON requests share Express's 5 MB body limit. The frontend may impose its own interaction limits.

The JSON route parser currently forwards `query`/`name`/`coin`, `qty`/`quantity`, `grade`, `year`, `mintMark`/`mint`, `weight`, and `series`; it does not forward arbitrary nested `options`. Text input supports `qty`/`quantity`, `grade`, `year`, `mint`, and `weight`. Although the service has an internal `coin.options.timeWindowDays` hook, callers of the current HTTP endpoint cannot set it; they receive the bullion/non-bullion defaults below.

Each query is limited to 300 characters at job creation. JSON strings over 300 characters are truncated by the parser, marked, then rejected by the route; text parsing takes the query as the segment before the first `|` and the route rejects it when that segment exceeds 300 characters (other pipe-delimited fields are not length-checked). Excel input currently fails earlier in its adapter and should not be used until repaired. Text and JSON arrays are sliced to their first 500 entries before the route's length check; extra rows are ignored rather than producing a maximum-count error.

## Endpoints

### POST /api/bulk-evaluate
**Request**: JSON `{items: [...]}` or `{text: "..."}`. Multipart `.xlsx` is advertised by the route but currently returns HTTP 400; see the input limitation above.
**Response**: `{jobId, coinCount}` (HTTP 202 Accepted)

### GET /api/bulk-evaluate/:jobId/stream
**Protocol**: Server-Sent Events (SSE)
**Events**:
- `coin`: Per coin result with FMV, confidence, melt, etc.
- `summary`: Lot summary with buyTiers and discounts
- `done`: Evaluation complete
- `error`: Processing error

Supports late-connect replay of already-completed results.

### GET /api/bulk-evaluate/:jobId
**Response**: Poll endpoint returning `{jobId, status, coinCount, completed, results[], lotSummary, error}`

## Per-Coin Evaluation Pipeline (10 parallel)

For each coin:
1. **Identify**: Parse query via `pcgsService.parseDescription()` → extract year, mint, grade, series, finish (Proof), weight, roll status
2. **Metal Detection**: `getCoinMetalProfile()` → identify if bullion, metal type
3. **Spot Price**: Live metal spot price via `getMetalsSpotPrice()` if bullion
4. **eBay Comps**: up to 3 pages via `ebayService.fetchSoldComps()` using expected context. The initial lookback defaults to 120 days for bullion and 180 days otherwise; a positive `coin.options.timeWindowDays` overrides that request. The eBay service may extend the lookback when its sold-comp pool is thin. Terapeak imported sold data is checked first, with enabled sold-listing API paths used as needed; active Browse listings are a last resort when no sold comps exist.
5. **PCGS Lookup**: `pcgsService.resolveFromDescription()` for PCGS verification, grade guide, population, and any auction median returned by that lookup. Bulk evaluation does not call `auctionPriceService` directly.
6. **Greysheet**: Wholesale pricing via `greysheetService.fetchPriceByPcgsNumber()` or type fallback
7. **Valuation**: `computeValuation()` blends available eBay sold/eligible fallback data, PCGS guide and auction data, Greysheet wholesale, and bullion spot-premium signals according to coin type and available inputs -> FMV + range + confidence + low-data state + comp count + method + explanation. These sources are conditional; unavailable or inapplicable inputs are omitted/renormalized, and proof intent does not fall back to ordinary bullion spot math.

## Output: Per-Coin Result
```
{
  query: "1921 Morgan Dollar",
  qty: 5,
  year: "1921",
  mint: "S",
  series: "Morgan",
  grade: "MS-65",
  weight: 26.73,
  isBullion: false,
  isRoll: false,
  fmv: 45.50,                    // Fair Market Value per coin
  totalFmv: 227.50,              // fmv * qty
  rollQty: null,
  perCoinFmv: null,
  rangeLow: 40.00,
  rangeHigh: 50.00,
  confidence: 82,                // 0-100 confidence score
  lowData: false,                // true when fewer than 3 sold comps support the result
  explanation: [],               // includes SINGLE-COMP ESTIMATE when compCount is 1
  method: "certified-blend",     // Example method; actual method depends on available sources/coin type
  dataSource: { label: "sold-data", soldCount: 8, activeCount: 0, totalComps: 8, soldRatio: 1, browseOnly: false },
  gradePool: { usedPool: "graded", gradedCount: 8, rawCount: 0, proofCount: 0, reverseProofCount: 0, poolFallback: false },
  meltValue: null,               // Metal intrinsic value * qty
  avgEbay: 45.25,                // Median eBay comp price
  compCount: 8,                  // Number of comps found
  greysheet: null,               // Wholesale guide price
  error?: null | "error message" // If pricing failed
}
```

Confidence `0` is preserved in the API, on-screen table, and CSV export. A one-comp result is visibly labeled `Single comp` in the Lot Evaluator. A cross-year cohort result is labeled `Composite`, retains `dataSource` and `gradePool.compositeBasis`, uses a `(composite)` method suffix, and exports a proxy warning to CSV. The shared bullion filter rejects unstated-weight comps above `max(meltPerOz * weight * 5, $50)` for fractional and multi-ounce coins.

## Lot Summary: Buy Tiers & Pricing Formula

The lot summary applies **three buy tiers** (dealer buy prices) to total FMV:

### Buy Tier Pricing
- **Cherry-Pick**: `max(40%, 60% - totalDiscount)` of total FMV
- **Fair Lot**: `max(50%, 75% - totalDiscount)` of total FMV
- **Full Retail - Fees**: `max(60%, 87% - totalDiscount)` of total FMV; the 87% baseline reflects roughly 13% eBay fees

### Discount Model (Applied to all tiers)
Total Discount = Size Discount + Confidence Penalty + Concentration Penalty. The size tier and average-confidence penalty use successfully priced result rows; total FMV includes each priced row multiplied by its quantity.

1. **Size Discount** (0-20%):
   - 1-10 coins: 0%
   - 11-50 coins: 5%
   - 51-100 coins: 10%
   - 101-250 coins: 15%
  - 251+ coins: 20%

2. **Confidence Penalty** (0-5%):
   - Avg confidence < 60%: +5% penalty
   - Otherwise: 0%

3. **Concentration Penalty** (0-3% + flags):
  - Single coin > 50% of total lot FMV: 3% penalty + HIGH RISK flag
  - Single coin > 25% through 50% of total lot FMV: MODERATE RISK flag (no penalty)

### Lot Summary Output
```
{
  coinCount: 100,
  pricedCount: 98,              // How many got an FMV
  failedCount: 1,               // Coins that couldn't be priced
  noPriceCount: 1,              // Priced but FMV=0/null
  totalFmv: 4500.00,            // Sum of per-coin FMV * qty
  totalMelt: 2450.00,           // Sum of melt values
  avgConfidence: 75,            // Average confidence %
  bullionCount: 30,             // How many are bullion
  bullionPct: 35.2,             // % of total FMV that's bullion
  discounts: {
    size: 10.0,                 // % discount for lot size
    confidence: 0.0,            // % penalty for low confidence
    concentration: 0.0,         // % penalty for one large coin
    total: 10.0                 // Sum of all discounts
  },
  concentrationFlags: [
    { query: "1921 Morgan", pctOfLot: 45.3, risk: "moderate" }
  ],
  buyTiers: {
    cherryPick: 2250.00,        // (60% - 10% totalDiscount) * $4,500
    fairLot: 2925.00,           // (75% - 10% totalDiscount) * $4,500
    fullRetail: 3465.00         // (87% - 10% totalDiscount) * $4,500
  }
}
```

## Valuation Details: Blending Strategy

**FMV Computation** (`valuationService.js`):
- eBay weighted median (match score + recency weights)
- PCGS guide (if available)
- Auction median (if available)
- Spot price + premium (for bullion)
- Greysheet wholesale, with an adaptive 5-20% blend weight for bullion when sold comps are available (based on sold-comp count)

**For Bullion**: Non-proof bullion with sold comps uses a spot-price anchor plus a premium derived from recent eBay sold comps. If Greysheet is available, its blend weight is 20% below 5 comps, 15% at 5-9, 10% at 10-19, and 5% at 20+. Without sold comps, a qualifying Greysheet value is blended 70% Greysheet / 30% spot; otherwise spot alone is the fallback. Proof and reverse-proof intent skip this spot fallback ladder.

**Confidence Calculation** (0-100):
- Sample size, price dispersion, and average match quality form the core score; bar, non-PCGS, and PCGS-covered coins use different base weights.
- PCGS verification and guide presence, auction median presence, and Greysheet presence add points where applicable.
- Fallback use and fewer than five US sold comps reduce the score.
- Browse-only data subtracts 30 points; mixed sold/active pools have additional penalties based on the sold ratio.
- Low PCGS population, wide Greysheet wholesale/retail spread, high filter attrition, and graded-to-raw pool fallback can further reduce confidence.
- The final score is rounded and clamped to 0-100. See `docs/memory/decision-engine-spec.md` and `valuationService.computeConfidence()` for the maintained factors and values.

## Frontend UI (Lot Evaluator Tab)

**Input Area**:
- Textarea: Paste text (one coin per line)
- File input: Upload .xlsx
- Button: Switch to JSON input mode

**Progress**:
- Progress bar (0-100%)
- Status text: "Evaluating 5/500..."
- Real-time row appends to results table

**Results Table**:
- Columns: #, Coin, Qty, Grade, FMV (ea), Total FMV, Melt, Comps, Confidence, Warning, Method
- Rows added as SSE events arrive
- Color-coded confidence (green ≥70%, amber 50-69%, red <50%)
- Pagination at 50 coins per page
- Composite rows show a visible warning and `(composite)` method suffix

**Lot Summary Card**:
- Key stats: Coins priced, Total FMV, Total Melt, Avg Confidence, Bullion %
- **Buy Tiers Grid** (3 columns):
  - Cherry-Pick: Red color
  - Fair Lot: Amber color
  - Full Retail - Fees: Green color
- Discount breakdown: size, confidence, concentration
- Concentration risk flags: coins over 25% of lot value

**Export**:
- CSV: Tabular format, downloadable; Warning identifies single-comp and composite estimates
- JSON: Full results + lotSummary + timestamp

## Concurrency & Caching

**Concurrency Control**:
- 10 coins evaluated in parallel per job
- Max 3 concurrent jobs server-wide (throttle with HTTP 429 if exceeded)

**Result Caching**:
- SHA-256 hash of audience and input coin array
- 1-hour TTL
- Replays cached results through `onProgress` callback for instant results on re-submit

**Job Lifecycle**:
- In-memory Map, 1-hour job TTL
- Auto-prune expired jobs on POST
- SSE listeners cleaned up on done/error

## Special Cases

1. **Bullion Detection**: Checks series name (e.g., "Silver Eagle", "Maple Leaf") and can override grade parsing for raw BU coins
2. **Roll/Tube Quantities**: Detects rolls and extracts per-coin FMV if provided (see `getRollQuantity()`)
3. **Proof vs BU**: Explicit proof intent from grade string (PF69, PR69) or term detection
4. **World Bullion**: Treats non-US bullion (e.g., Perth Mint Lunar) with special weighting
5. **Metal Profiling**: Detects platinum, palladium eagles; computes melt for any metal detected
6. **Grade Mismatch Filter**: Filters eBay comps by grade type (graded/raw/proof) matching user intent

## Utilities Used

- `excelMapper.js`: `mapExcelToBackup()` to parse .xlsx → {payload.coins}
- `coinMetalProfile.js`: `getCoinMetalProfile()` for metal detection
- `constants.js`: `zodiacForYear()`, `perthLunarSeries()`, `getRollQuantity()`
- `stats.js`: `median()` for price calculations
- `responseValidator.js`: Validates per-coin output shape

## Tests

- `__tests__/bulkEvaluateService.test.js`: Unit tests for discount formulas, lot summary, cache, concurrency
- `__tests__/bulkEvaluateRoute.test.js`: Parser tests (text, JSON, Excel) + HTTP endpoint smoke tests
- `__tests__/bulkEvaluate.test.js`: Integration tests with mocked services (full workflow)

## Files
- **Route**: [src/routes/bulkEvaluateRoute.js](../../src/routes/bulkEvaluateRoute.js)
- **Service**: [src/services/bulkEvaluateService.js](../../src/services/bulkEvaluateService.js)
- **Frontend**: [public/index.html](../../public/index.html) (lines ~1980-2050 UI, ~6199+ JavaScript)
- **Tests**: [__tests__/bulkEvaluateService.test.js](../../__tests__/bulkEvaluateService.test.js), [__tests__/bulkEvaluateRoute.test.js](../../__tests__/bulkEvaluateRoute.test.js)
