# Decision Engine Spec -- valuationService.js

Core file: `src/services/valuationService.js`
Consumed by: priceRoute, barPriceRoute, pricingBatchRoute, bulkEvaluateService

## FMV Computation -- Three Modes

### 1. Bullion Spot+Premium (method: `bullion-spot-premium`)
- **Trigger**: `isBullion && spotPrice > 0 && ebayMedian > spotPrice * 0.5 && !skipSpotMath`
- **Formula**: `FMV = spotPrice * (1 + premiumPct)`
- **Premium**: derived from `(ebayMedian - spotPrice) / spotPrice`
- **Premium clamp**: [-5%, +40% gold (>$500/oz), +100% silver]
- **Greysheet blend**: if available, 85% spot-premium + 15% wholesale
- **Why**: tracks metal price moves instantly instead of lagging with 30-day median
- **#282H -- skipSpotMath gate**: `skipSpotMath = wantsProof || wantsReverseProof`. Proof and reverse-proof intent SKIP this branch entirely (their premiums are decoupled from spot; clamping at silver_spot * 2 / gold_spot * 1.4 silently collapses dozens of dates to one number). Proof traffic flows to certified-blend / raw-blend using the proof-only comp pool.

### 2. Certified Blend (method: `certified-blend`)
- **Trigger**: `pcgs.verified == true` and not bullion-spot-premium
- **Grade tiers** (from `parseGradeNumber()` + `getGradeTier()`):

| Tier | Grade Range | eBay | PCGS Guide | Auction | Greysheet |
|------|-------------|------|------------|---------|-----------|
| Low  | <=AU58      | 65%  | 10%        | 5%      | 20%       |
| Mid  | MS60-MS66   | 55%  | 15%        | 10%     | 20%       |
| High | MS67+       | 30%  | 20%        | 25%     | 25%       |

- **Rationale**: high-grade coins trade at auction, not eBay commodity market
- **Missing sources**: weights renormalize proportionally via `blendSources()`

### 3. Raw Blend (method: `raw-blend`)
- **Trigger**: no PCGS verification (ungraded/raw coins)
- **Weights**: eBay 70%, PCGS Guide 10%, Greysheet 20%
- **No auction**: raw coins rarely appear in auction records

### Bullion fallback ladder (no eBay comps)

When `isBullion && spotPrice > 0 && ebayMedian == null && !skipSpotMath`, the engine walks a 2-step ladder (#282H, supersedes the bare-spot-only fallback from #188):

1. **`bullion-greysheet-anchor`** -- if `greysheetVal != null && greysheetVal >= spotPrice * 0.8`:
   - `FMV = 0.7 * greysheetVal + 0.3 * spotPrice`
   - Greysheet is dealer wholesale (CDN), licensed and curated; when it sits at least 80% of spot it represents a real, defensible bullion FMV. The 30% spot weight keeps the number responsive to metal-price moves; the 80% guard rejects nominal / stale rows that would drag FMV well below current metal value.
2. **`bullion-spot-only`** -- otherwise:
   - `FMV = spotPrice` (0% premium, conservative floor; preserves #188 behavior).

Proof / reverse-proof intent skips this ladder entirely (`skipSpotMath`). When proof comps are also empty and no proof Greysheet / PCGS guide is available, the engine returns `fmvCore: null` with an explicit explanation citing "no proof comps; BU not substituted (would give a wrong number, not a missing one)".

### Fallback (NO DATA)
- If ALL sources unavailable (no comps, no guide, no Greysheet, AND no usable spot/bullion path): returns `{ fmvCore: null, confidence: 0 }` with a `NO DATA` explanation.

## Weighted Median (eBay component)

`computeWeightedMedian(comps)` -- not a simple median:
- **Recency weight**: `1 / (1 + daysSince / halfLife)`
  - Bullion halfLife = 30 days (rapid metal tracking)
  - Numismatic halfLife = 90 days (slower collector market)
- **Match weight**: `matchScore / 100`
- **Combined**: `recencyWeight * matchWeight`
- Uses `stats.weightedMedian(values, weights)`

## Grade Pool Split

Before valuation, comps are separated into four mutually exclusive pools:
1. `classifyGradeType()` labels each comp as `graded`, `proof`, `reverseProof`, or `raw`
2. If user grade is "Proof"/"PF"/"PR" -> use proof pool **unconditionally** (0 comps returns null FMV; never falls back to raw -- #184)
3. If user grade is "Reverse Proof"/"Rev Pf"/"RP" -> use reverse-proof pool strictly (#260W)
4. If user specified any other grade -> use graded pool strictly (#272W); if `gradedSold === 0` AND no PCGS price guide AND no Greysheet anchor AND `rawSold >= 10`, the engine emits a last-resort raw blend (`poolFallback: true`, -10 confidence, `usedPool: 'raw (fallback)'`, `dataSource.label` unchanged) -- this is the tightened #176 V2 fallback
5. If no grade -> use raw pool strictly (#270W Option #4 / PR #186); no fallback to all-comps
6. **There is no "if preferred pool < 3 comps then use all comps" fallback for any pool.** Pool isolation is mandatory per `docs/memory/numismatic-terminology.md` MANDATORY: Pool-Isolation Contract (see INC-013 in `docs/WASTE-LEDGER.md`).
7. When `totalComps === 0` but a grade-specific guide signal exists (PCGS price guide or Greysheet anchor), the engine emits FMV from the guide and labels the response `dataSource.label = 'guide-only'` (#272W). When no comps and no guide are available and the bullion ladder fires, the label is `'metal-only'`. Otherwise null FMV with an explicit `lowData` flag.

## Confidence Scoring (0-100)

`computeConfidence()` inputs and contributions:

| Factor | Contribution | Notes |
|--------|-------------|-------|
| US comp count | Up to 35-40 pts (logarithmic) | Bar mode: up to 35 pts |
| Dispersion (CV) | Up to 20-25 pts (lower = better) | |
| Match quality | Up to 15-25 pts | |
| PCGS verified | +10 | Not for bars |
| PCGS guide available | +10 | Not for bars |
| Auction data | +5 | |
| Greysheet data | +5 | |
| Greysheet spread <=15% | +5 (liquid market) | |
| Greysheet spread >=40% | -5 (illiquid) | |
| 20+ US comps | +10-15 bonus | |
| Browse fallback used | -5 to -15 | Scaled by US comp count |
| < 5 US comps | -10 | |
| Browse-only (no sold) | -15 | |
| Low population <50 | -15 | |
| Low population 50-99 | -10 | |
| Low population 100-199 | -5 | |

## Buy Spread Tiers (sliding by FMV value)

`buySpreadForValue(fmv)` returns {low, mid, high} multipliers:

| FMV Range | Low | Mid | High | Rationale |
|-----------|-----|-----|------|-----------|
| <= $50    | 60% | 70% | 75%  | Standard commodity margin |
| $50-200   | 70% | 75% | 80%  | Default |
| $200-1K   | 75% | 80% | 85%  | Tightened |
| $1K-5K    | 80% | 85% | 90%  | Tight |
| $5K+      | 85% | 90% | 95%  | Very tight -- high-value coins |

## Sale Context Adjustment

Three modes adjust buy/sell tiers for platform friction:

| Context | Buy Adj | Sell Adj | Label |
|---------|---------|----------|-------|
| `ebay` (default) | 0% | 0% | eBay Retail |
| `private` | +7% | -10% | LCS / Private Sale |
| `wholesale` | -10% | -20% | Dealer Wholesale |

eBay prices include ~13% friction (fees + shipping).

## Sell Tiers

- **Fast**: `ebayMedian * 0.92` (quick liquidation)
- **Normal**: `ebayMedian * 1.00` (market price)
- **Premium**: `ebayMedian * 1.05` (or 1.15 if low pop <200)
- **Offer Floor**: `min(P25, fast)` -- lowest reasonable offer to accept

## Appeal Multiplier

- User-supplied: 1.0x-2.0x for toning/eye appeal
- Clamped `Math.min(2.0, Math.max(1.0, value))`
- Applied to FMV after blend, before range/confidence

## Range Calculation

- `margin = max(stddev, FMV * 0.05)` -- at least 5% spread
- `rangeLow = max(0, FMV - margin)`
- `rangeHigh = FMV + margin`

## Lot-Level Decisions (bulkEvaluateService.js)

After per-coin FMV, `computeLotSummary()` applies:

| Discount | Condition | Amount |
|----------|-----------|--------|
| Size discount | 11-50 coins: 5%, 51-100: 10%, 101-250: 15%, 251+: 20% | 0-20% |
| Confidence penalty | Avg confidence < 60 | 5% |
| Concentration penalty | Any coin > 25% of lot FMV | 3% |

Three buy tiers: cherry-pick (55-65%), fair lot (70-80%), full retail (85-90% minus fees)

## Resilience Patterns

### eBay Service
- **Circuit breaker**: 5-min cooldown per API on failure (ebayService.js L26-32)
- **Throttle**: 1,100ms global minimum between API calls (L42-48)
- **TTLCache**: 1h with JSON disk persistence (survives restarts)
- **Dedup**: in-flight request sharing per cache key

### Metals Spot Price -- 4-Tier Fallback
1. In-memory TTLCache (45min TTL)
2. Disk-persisted cache (stale OK)
3. Disk cache from previous run (any age)
4. Hardcoded prices (last resort -- March 2026 values)

### Greysheet
- Retry with backoff: 429/5xx, up to 2 retries, `1000ms * (attempt + 1)`
- 24h TTLCache with disk persistence
- Negative caching: `null` results cached to avoid repeated calls

### Terapeak
- 180-day stale eviction on startup
- CSV purge for fully-stale files
- 30-min blob re-import timer
- Dedup keys: `title|price|soldDate`

## Known Risks

| Risk | Impact | Where | Mitigation |
|------|--------|-------|------------|
| Stale hardcoded metals fallback | Bullion FMV off 20%+ | metalsSpotPrice.js L22-28 | All 4 providers must fail AND disk cache cold; add staleness flag |
| Browse-only FMV inflation | Asking prices inflate FMV | valuationService.js L186-190 | browseOnly flag + confidence penalty exists; could add 10% haircut |
| Synthetic Terapeak CSVs | Fake data in data/terapeak/ | /memories/repo/synthetic-data-audit.md | 525 original CSVs are script-generated; real data added later |
| Single-process batch timers | Restart kills timers | server.js L250-330 | Timers re-check on startup (Greysheet); blob reimport stateless |
| Bullion series list duplication | New series needs 4 file edits | bulkEvaluateService, marketAggregator, priceRoute, terapeak-page2.py | Extract to shared src/data/bullionSeries.js |

## Response Schema (key fields)

```
{
  valuation: {
    fmvCore, rangeLow, rangeHigh, confidence (0-100),
    lowData (bool), compCount, method, saleContext,
    appealMultiplier, explanation[],
    dataSource: { soldCount, activeCount, browseOnly, soldRatio },
    gradePool: { wantsGraded, usedPool, gradedCount, rawCount },
    greysheetSpread: { spreadPct, liquidity, wholesale, retail },
    bullionSpot: { spotPrice, premiumPct, ebayMedian }
  },
  decisions: {
    buy: { max70, max75, max80, spreadTier, askingPrice, recommendation, notes },
    sell: { fast, normal, premium, offerFloor, notes }
  }
}
```
