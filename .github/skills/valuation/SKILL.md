# Valuation Skill

Domain knowledge for the FMV / confidence / buy-sell decision engine in
`src/services/valuationService.js`. This SKILL is a routing reference; the
canonical algorithm spec is `docs/memory/decision-engine-spec.md`.

Read this SKILL before editing `valuationService.js` or any caller of
`computeValuation`. INC-013 ($10.03 spent) happened because an edit landed
without reading the governing docs.

---

## Required Reading Before Editing

| Doc | What it owns |
|---|---|
| `docs/memory/decision-engine-spec.md` | Canonical FMV / confidence / buy-sell algorithm (3 FMV modes, bullion fallback ladder, weighted median, confidence breakdown, buy/sell tiers, sale-context adjustment) |
| `docs/memory/numismatic-terminology.md` | **MANDATORY Pool-Isolation Contract** (raw / graded / proof / reverse-proof are 4 pools; never merge) |
| `docs/memory/audience-gating.md` | Sale-context (eBay / private / wholesale) effects on buy/sell |
| `docs/WASTE-LEDGER.md` INC-013 | Pool-isolation violation costing $10.03; rules #18-20 |
| `src/services/valuationService.js` L1-27 | JSDoc GOVERNING DOCS banner -- cites the above and is itself load-bearing |

---

## Hard Rules (verbatim from numismatic-terminology.md MANDATORY contract)

These rules are not negotiable. A change that violates any of them must
not merge regardless of test coverage.

1. **Raw, graded, and proof are three distinct pools.** Reverse-proof is a
   fourth pool. They must never be merged in FMV computation. This applies
   to ALL series, including modern bullion (Gold Maple, Gold Eagle,
   Krugerrand, Britannia, Panda, Libertad).
2. **No weight-threshold license to merge.** "It's >= 1 oz bullion" is NOT
   a valid reason to blend graded comps into the raw FMV stream. See
   INC-013 / PR #154 / PR #177 revert.
3. **`fmvCore: null` is the correct answer when the target pool is empty.**
   Set `confidence: 'unreliable'`, explain in the response. Do NOT fall
   back across pools.
4. **`skipSpotMath` gate (#282H):** proof and reverse-proof intent skip
   the bullion spot+premium branch. Their premiums are decoupled from
   spot; clamping them to `silver_spot * 2` / `gold_spot * 1.4` silently
   collapses dozens of dates to one number.

If the change you are making requires merging pools, the change is wrong.
The right answer is one of: adaptive lookback on the single pool, better
Terapeak seeding, two-pool FMV surfacing (`fmvRaw` + `fmvSlab` side by
side), or honest `fmvCore: null`.

---

## Module Map -- `src/services/valuationService.js`

| Export | Lines | Purpose |
|---|---|---|
| `computeValuation(pcgs, ebay, askingPrice, userGrade, opts)` | L39-671 | Top-level entry: routes by pool, picks FMV mode, scores confidence, derives buy/sell, returns full decision payload |
| `computeWeightedMedian(comps, { isBullion, wantsProof, wantsReverseProof })` | L672-806 | Weighted median over comps using `matchScore` + recency half-life (BU bullion 30d, numismatic 90d, proof / RP 90d per #283H) |

Internal helpers worth knowing (not exported but referenced):

- Pool selection / routing -- L58-120
- Graded -> raw fallback (`poolFallback = true`, confidence -10) -- L94-112
- Proof / reverse-proof empty-pool handling (returns `fmvCore: null`) -- L70-80 (RP), L283-292 (proof)
- Bullion spot+premium FMV mode -- L170-195
- Bullion fallback ladder (no eBay comps) -- L197-220
- Certified-blend FMV mode -- L239-260
- Raw-blend FMV mode -- L261-273 (fixed 70 % eBay + 10 % PCGS + 20 % Greysheet, renormalized)
- Confidence scoring -- L585-660
- Buy spread tiers (sliding by FMV value) -- L476-480
- Sale context adjustment -- L482-492
- Sell tiers (Fast / Normal / Premium / OfferFloor) -- L505-511
- `GRADE_WEIGHTS` (low / mid / high tier weights for certified-blend) -- inline L575-577

---

## FMV Modes (summary; canonical spec is decision-engine-spec.md)

The engine picks ONE of three FMV modes per call, based on pool + comp
availability:

1. **bullion-spot-premium** -- `isBullion && spotPrice > 0 && ebayMedian
   > spotPrice * 0.5 && !skipSpotMath`. Derives premium from eBay median;
   clamps to [-5 %, +40 % gold / +100 % silver]; optionally blends 5-20 %
   Greysheet by comp count.
2. **certified-blend** -- graded coin with PCGS Guide / Auction signal.
   Grade-tier-weighted blend of eBay / Guide / Auction / Greysheet with
   weights renormalizing on missing sources.
3. **raw-blend** -- non-graded coin. Fixed 70 / 10 / 20 (eBay / PCGS /
   Greysheet), renormalizing.

Bullion **fallback ladder** (when no eBay comps): step 1 Greysheet anchor
(70 % wholesale + 30 % spot) if wholesale >= 80 % of spot; step 2 bare
spot. Never falls back across pools.

---

## Confidence Scoring (0-100)

Three base profiles + penalties. Caller checks `confidence` and
`confidenceLabel` to gate UI, dealer offers, etc.

Base profiles:

- **Bar mode** -- 35 sample (n/12) + 25 dispersion + 25 match quality;
  bonus +15 if n>=20.
- **PCGS-covered coin** -- 30 sample + 20 dispersion + 15 match + 10
  verified + 10 guide + 5 auction + 5 greysheet.
- **Non-PCGS coin** -- 40 sample + 20 dispersion + 25 match (redistributed
  PCGS points).

Penalties (cumulative, can stack):

- Browse-only: -30 (all asking), -20 (<30 % sold), -10 (<60 % sold)
- Low pop: -15 (pop<50), -10 (pop<100), -5 (pop<200)
- Greysheet spread: +5 (<=15 %), -5 (>=40 %)
- **Pool fallback (graded -> raw): -10** (already signals the data
  quality drop)
- Filter attrition: -20 (>90 %), -10 (>70 %), -5 (>50 %)

---

## Buy / Sell Derivation

Sliding spreads by FMV value (eBay sale context, before adjustment):

| FMV range | Buy P25 | Buy median | Buy P75 |
|---|---|---|---|
| <= $50 | 60 % | 70 % | 75 % |
| $50 - $200 | 70 % | 75 % | 80 % |
| $200 - $1k | 75 % | 80 % | 85 % |
| $1k - $5k | 80 % | 85 % | 90 % |
| > $5k | 85 % | 90 % | 95 % |

Sale-context adjustments (additive, applied to spread percentages):

- eBay: 0 / 0 (default)
- Private sale: +7 % buy, -10 % sell
- Wholesale: -10 % buy, -20 % sell

Sell tiers (against FMV):

- Fast: 92 %
- Normal: 100 %
- Premium: 105 %, or 115 % when low pop
- OfferFloor: min(P25 buy, Fast sell)

---

## When You Are About to Edit valuationService.js

Run this checklist BEFORE writing code:

- [ ] You have read `docs/memory/numismatic-terminology.md` MANDATORY
      Pool-Isolation Contract.
- [ ] You have read `docs/memory/decision-engine-spec.md` section(s)
      relevant to the FMV mode / scoring branch you are changing.
- [ ] You have read `docs/WASTE-LEDGER.md` INC-013 (Mistakes + Rules Added).
- [ ] You have read the JSDoc GOVERNING DOCS banner at
      `src/services/valuationService.js` L1-27.
- [ ] You have read the regression test at
      `__tests__/ebayFetchSoldComps.test.js:476` (pool-isolation guard)
      and `__tests__/valuation.test.js` (if it exists at the time you read
      this) for the surface you are changing.

If your change touches pool routing, FMV mode selection, or the
`skipSpotMath` gate, the PR body MUST cite this SKILL + the contract.
Pre-commit reviewer Data Model Sync check enforces this for pool surfaces.

For M / L tier changes to this file, run `@numismatic-audit` Step 5b
(pool-isolation contract check) and PASS before merge.

---

## Cross-References

- `.github/skills/numismatics/SKILL.md` -- domain knowledge: classification decision tree, finish detection, MANDATORY Pool-Isolation Contract
- `.github/skills/comp-data/SKILL.md` -- upstream comp pipeline (eBay cascade, scoring, attrition, Terapeak)
- `.github/skills/process-discipline/SKILL.md` Hot Files table -- valuationService.js -> INC-013 row
- `.github/skills/workflow/SKILL.md` -- PR workflow, tiered execution, deep-review requirement
- `docs/memory/decision-engine-spec.md` -- canonical algorithm spec
- `docs/memory/numismatic-terminology.md` -- MANDATORY Pool-Isolation Contract
- `docs/memory/audience-gating.md` -- sale-context buy/sell rules
- `docs/ARCHITECTURE.md` L85-86, L184-287 -- valuation engine in pricing flow
- `docs/WASTE-LEDGER.md` INC-013 -- pool-isolation violation postmortem
- `src/services/valuationService.js` L1-27 -- file-level JSDoc GOVERNING DOCS banner
