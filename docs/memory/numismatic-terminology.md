# Numismatic Terminology -- Decision Reference

Use this when classifying coins, building filters, or making pricing decisions.

## DO NOT MERGE POOLS -- Pool-Isolation Contract (MANDATORY)

**Raw, Graded, and Proof are THREE DISTINCT POOLS.** They trade in three different
markets. They must never be merged in FMV computation. This applies to ALL series,
including modern bullion (Gold Maple, Gold Eagle, Krugerrand, Britannia, Panda,
Libertad).

**Why this is mandatory even for "liquid" bullion:**

- Every series contains scarce dates, varieties, and first-year / anniversary /
  key-date issues where slabbed comps trade at a different price level than raw
  comps of the same coin. Even when the average modern-bullion year trades
  close to melt regardless of holder, the cross-pool dispersion is wide enough
  to make a blended FMV wrong for both pools.
- Raw, Graded, and Proof are observed by `classifyGradeType()` as three
  distinct pools (see Code Mapping section below). `valuationService.js`
  additionally routes reverse-proof comps to their own pool (see #260W); the
  Proof Subtypes section in this doc describes the manufacturing relationship
  but the code's pool routing is what governs FMV.

**Forbidden anti-patterns:**

- Merging the graded comps into the raw FMV stream for "high-melt-share" coins.
- Conflating MS-70 slab prices with BU raw prices into a single mean / median.
- Using a "weight threshold" (e.g. `>= 1.0 oz`) as a license to merge pools.
- Reporting a "primary FMV" computed from a blended pool.

**Approved patterns for sparse-raw-pool problems** (the symptom that tempts merging):

- Adaptive lookback on the raw pool alone (extend the Terapeak window).
- Better Terapeak seeding for raw-bullion datasets.
- Two-pool FMV surfacing (return `fmvRaw` and `fmvSlab` side-by-side as
  distinct numbers; do not blend).
- Honest `fmvCore: null` + `confidence: 'unreliable'` when the target pool is
  empty after all recovery attempts.

**History:** PR #154 (#252, merged 2026-06-18) implemented bullion-merge gating
in `src/services/ebayService.js` and was reverted on 2026-06-23 because it
violated this contract. The follow-up tracking is **BACKLOG #270W**. Any future
PR touching `classifyGradeType`, the `applyFilters` pool gates, or the
`prefilterStrikeSplit` block must cite this file in the PR body and explain
which pool boundary is being crossed and why.

---

## Strike Types (Manufacturing Method)

| Strike | Definition | Grade Prefix | Mutually Exclusive With |
|--------|-----------|--------------|------------------------|
| Business Strike | Standard production for circulation | MS (Mint State) | Proof |
| Proof | Polished dies, multiple strikes, mirror fields | PR or PF | Business Strike |
| Specimen | Pre-1817 special presentation strikes | SP | Both |

**Key rule**: Proof is a MANUFACTURING METHOD, not a condition/grade. A PR-63 is not "worse" than MS-63 -- they are different products entirely.

## Proof Subtypes (all are still proofs)

- **Proof (standard)** -- mirror fields, frosted devices
- **Reverse Proof** -- frosted fields, mirror devices (inverted contrast)
- **Matte Proof** -- granular/sandblast finish (early 1900s, modern reissues)
- **DCAM / Ultra Cameo** -- deep contrast between frost and mirror (designation, not a type)
- **CAM / Cameo** -- moderate contrast (designation)

## NOT Proofs (common classification traps)

| Term | Actual Meaning | Correct Classification |
|------|---------------|----------------------|
| Proof-Like (PL) | Business strike with mirror surfaces | MS-graded (graded pool) |
| Deep Mirror Proof-Like (DMPL) | Business strike with deep mirrors | MS-graded (graded pool) |
| "BU Proof" (eBay title) | Contradictory -- usually raw proof | proof pool |
| "Gem Proof" | Marketing term for high-grade proof | proof pool |

**Critical filter rule**: `PROOF_RE` must use negative lookahead for "like": `/\bproof\b(?![\s-]*like)/i`

## Grade Prefixes

| Prefix | Meaning | Pool |
|--------|---------|------|
| MS | Mint State (business strike, uncirculated) | graded |
| PR / PF | Proof | proof |
| SP | Specimen | proof (treat as proof for pricing) |
| AU | About Uncirculated (circulated) | graded |
| XF/EF | Extremely Fine | graded |
| VF | Very Fine | graded |
| F | Fine | graded |
| VG | Very Good | graded |
| G | Good | graded |
| AG / FR / PO | About Good / Fair / Poor | graded |

## "BU" Disambiguation

- **BU (Brilliant Uncirculated)** = business strike, uncirculated condition
- BU is NOT a formal grade -- it's informal for ~MS-60 to MS-63
- BU is NEVER proof. If title says "BU" + "Proof", the "Proof" wins for pool classification
- For world bullion (Libertad, Panda, etc.), "BU" means standard issue (not proof/burnished)

## Designations (Do NOT Affect Pool Classification)

These are TPG (PCGS/NGC) designations added AFTER the grade. They do not change strike type:
- First Strike / Early Releases / First Day of Issue -- timing labels
- Full Bell Lines (FBL) -- Franklin halves strike quality
- Full Bands (FB) -- Mercury dimes strike quality
- Full Steps (FS) -- Jefferson nickels strike quality
- Full Head (FH) -- Standing Liberty quarters

## Finish vs Label vs Grade

| Concept | Examples | Affects Pool? | Affects Keywords? |
|---------|----------|---------------|-------------------|
| Finish (strike type) | Proof, Reverse Proof, Burnished | YES | YES |
| Label (designation) | First Strike, Early Releases | NO | YES (search filter) |
| Grade (condition) | MS-69, PR-70, VF-35 | YES (tier) | YES (search filter) |

## Type Variants (Affects Keywords + Hard Filter)

- **Type 1 / Type 2** -- design changes (ASE 2021, AGE 2021). Mutually exclusive.
- **Thin Date / Fat Date** -- die variety. Filter but don't split pools.
- **Small Date / Large Date** -- die variety. Filter but don't split pools.

## Code Mapping

| Function | File | Decision It Makes |
|----------|------|-------------------|
| `classifyGradeType()` | ebayService.js | Assigns comp to raw/graded/proof pool |
| `PROOF_RE` | ebayService.js | Detects proof in titles (with PL lookahead) |
| `_detectFinish()` | greysheetTypeMap.js | Maps text to Greysheet finish key |
| `parseDescription()` | pcgsService.js | Extracts grade, finish, series from free text |
| `wantsProof` | valuationService.js | Determines which pool to price from |
| `computeValuation()` | valuationService.js | Pool selection + fallback logic |
