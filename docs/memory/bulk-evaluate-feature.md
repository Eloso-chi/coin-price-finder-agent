# Bulk Evaluate Feature (Lot Evaluator) - Complete Reference

## Overview
The "Lot Evaluator" or "Bulk Evaluate" feature allows users to price 1-500 coins at once, producing per-coin FMV values and lot-level buy recommendations. Implemented as #108 in the codebase.

## Architecture
- **Route**: `POST /api/bulk-evaluate` + `GET /api/bulk-evaluate/:jobId/stream`
- **Service**: `bulkEvaluateService.js`
- **Frontend**: Tab in `public/index.html` with JavaScript event handling
- **Job Model**: In-memory UUID-keyed job store with 1-hour TTL

## Input Formats (3 Options)
1. **Text**: One coin per line, pipe-delimited optional fields: `1921 Morgan Dollar | qty=5 | grade=MS-63 | year=1921 | mint=S | weight=26.73`
2. **JSON**: Array of objects: `[{query: "1921 Morgan Dollar", qty: 5, grade: "MS-63", year: "1921", mintMark: "S", weight: 26.73, series: "Morgan"}]`
3. **Excel**: `.xlsx` file parsed via `mapExcelToBackup()` utility from excelMapper.js

Max 500 coins per evaluation.

## Endpoints

### POST /api/bulk-evaluate
**Request**: multipart (Excel) | JSON body with {items|text} | FormData
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
4. **eBay Comps**: 1 page of sold comps, 90-day lookback via `ebayService.fetchSoldComps()` using expected context
5. **PCGS Lookup**: `pcgsService.resolveFromDescription()` for certification number
6. **Greysheet**: Wholesale pricing via `greysheetService.fetchPriceByPcgsNumber()` or type fallback
7. **Valuation**: `computeValuation()` blends PCGS guide, eBay median (weighted), Greysheet wholesale, spot price premiums → FMV + range + confidence + method

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
  method: "ebay-weighted",       // How FMV was computed
  meltValue: null,               // Metal intrinsic value * qty
  avgEbay: 45.25,                // Median eBay comp price
  compCount: 8,                  // Number of comps found
  greysheet: null,               // Wholesale guide price
  error?: null | "error message" // If pricing failed
}
```

## Lot Summary: Buy Tiers & Pricing Formula

The lot summary applies **three buy tiers** (dealer buy prices) to total FMV:

### Buy Tier Pricing
- **Cherry-Pick** (40-60%): Only buying select high-value coins → 55-65% of FMV (after discounts)
- **Fair Lot** (70-80%): Buying the entire lot at a fair price → 70-80% of FMV (after discounts)
- **Full Retail - Fees** (85-90%): Buying the lot intending to resell at retail after fees → 85-90% of FMV (after discounts)

### Discount Model (Applied to all tiers)
Total Discount = Size Discount + Confidence Penalty + Concentration Penalty

1. **Size Discount** (0-20%):
   - 1-10 coins: 0%
   - 11-50 coins: 5%
   - 51-100 coins: 10%
   - 101-250 coins: 15%
   - 250+ coins: 20%

2. **Confidence Penalty** (0-5%):
   - Avg confidence < 60%: +5% penalty
   - Otherwise: 0%

3. **Concentration Penalty** (0-3% + flags):
   - Single coin > 50% of lot: 3% penalty + HIGH RISK flag
   - Single coin > 25% of lot: MODERATE RISK flag (no penalty)

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
    cherryPick: 2475.00,        // Apply (55-65%) * totalFmv
    fairLot: 3150.00,           // Apply (70-80%) * totalFmv
    fullRetail: 3825.00         // Apply (85-90%) * totalFmv (minus ~13% eBay fees)
  }
}
```

## Valuation Details: Blending Strategy

**FMV Computation** (`valuationService.js`):
- eBay weighted median (match score + recency weights)
- PCGS guide (if available)
- Auction median (if available)
- Spot price + premium (for bullion)
- Greysheet wholesale (reality check at 15% weight for bullion)

**For Bullion**: Uses spot price anchor + premium derived from eBay comps (e.g., spot $22/oz silver + 40% premium = $30.80 retail).

**Confidence Calculation**:
- Comp count (20+ bonus)
- Price consistency (low std dev = high conf)
- Match quality (year/mint/grade overlap)
- Data source (sold > asking prices)
- Greysheet corroboration
- Population rarity
- Dealer spread tightness

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
- Columns: #, Coin, Qty, Grade, FMV (ea), Total FMV, Melt, Comps, Confidence, Method
- Rows added as SSE events arrive
- Color-coded confidence (green ≥70%, amber 50-69%, red <50%)
- Pagination at 50 coins per page

**Lot Summary Card**:
- Key stats: Coins priced, Total FMV, Total Melt, Avg Confidence, Bullion %
- **Buy Tiers Grid** (3 columns):
  - Cherry-Pick: Red color
  - Fair Lot: Amber color
  - Full Retail - Fees: Green color
- Discount breakdown: size, confidence, concentration
- Concentration risk flags: coins over 25% of lot value

**Export**:
- CSV: Tabular format, downloadable
- JSON: Full results + lotSummary + timestamp

## Concurrency & Caching

**Concurrency Control**:
- 10 coins evaluated in parallel per job
- Max 3 concurrent jobs server-wide (throttle with HTTP 429 if exceeded)

**Result Caching**:
- SHA-256 hash of input coin array
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
- **Route**: [src/routes/bulkEvaluateRoute.js](src/routes/bulkEvaluateRoute.js)
- **Service**: [src/services/bulkEvaluateService.js](src/services/bulkEvaluateService.js)
- **Frontend**: [public/index.html](public/index.html) (lines ~1980-2050 UI, ~6199+ JavaScript)
- **Tests**: [__tests__/bulkEvaluateService.test.js]((__tests__/bulkEvaluateService.test.js), [__tests__/bulkEvaluateRoute.test.js](__tests__/bulkEvaluateRoute.test.js)
