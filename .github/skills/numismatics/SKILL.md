# Numismatic Domain Knowledge Skill

## When To Use

Invoke this skill when:
- Classifying coins into raw/graded/proof pools
- Building eBay search keywords for coins
- Writing or modifying filter logic (applyFilters, classifyGradeType, _detectFinish)
- Interpreting grade strings (e.g., "PF69 DCAM", "MS70 PL", "PR-69")
- Debugging FMV discrepancies caused by pool misclassification
- Reviewing code that touches proof/BU/finish/designation detection
- Adding new coin series support

## MANDATORY: Pool-Isolation Contract

**Raw, Graded, and Proof are THREE DISTINCT POOLS.** They trade in three different
markets. They must NEVER be merged in FMV computation. This applies to ALL series,
including modern bullion (Gold Maple, Gold Eagle, Krugerrand, Britannia, Panda,
Libertad).

Canonical source: [`docs/memory/numismatic-terminology.md`](../../../docs/memory/numismatic-terminology.md) -- read end-to-end before any work touching pool routing.

### Why this is mandatory even for "liquid" bullion

Every series contains scarce dates, varieties, and first-year / anniversary /
key-date issues where slabbed comps trade at a different price level than raw
comps of the same coin. Even when the average modern-bullion year trades close
to melt regardless of holder, the cross-pool dispersion is wide enough to make a
blended FMV wrong for both pools.

### Forbidden anti-patterns

| Anti-pattern | Why it's wrong | Code smell to grep for |
|---|---|---|
| Merging graded + raw comps into a single FMV stream | Cross-pool dispersion is wide; result is wrong for both pools | `bullionMerge`, `poolMerge`, `crossPool`, `mergePools` |
| Using a weight threshold (e.g. `>= 1.0 oz`) as license to merge pools | Weight is not a pool boundary; scarce-date dispersion exists at every weight | `weight.*>=.*&&.*pool`, `troyOz.*&&.*graded` |
| Conflating MS-70 slab prices with BU raw prices into a single mean / median | These trade in different markets even when both are "uncirculated" | filter that allows `gt !== targetPool` |
| Reporting a "primary FMV" computed from a blended pool | Hides the dispersion; operator can't tell which market they're pricing against | response shape that has `fmv` without `pool` attribution |
| Treating `prefilterStrikeSplit` count as a success metric | It is a *correct-rejection counter*. A high value means the pool is sparse, not that the gate is broken | code that decreases `prefilterStrikeSplit` by widening the gate |

### Approved patterns for sparse-pool problems (the symptom that tempts merging)

- **Adaptive lookback on the raw pool alone** -- extend the Terapeak window 120d -> 180d -> 365d when raw is sparse, raw only
- **Better Terapeak seeding** for raw-bullion datasets (per-series seed pass that excludes `condition=2000`)
- **Two-pool FMV surfacing** -- return `fmvRaw` and `fmvSlab` side-by-side as distinct numbers; do not blend
- **Honest `fmvCore: null` + `confidence: 'unreliable'`** when the target pool is empty after all recovery attempts

### Code mapping (where the pool boundary is enforced)

| Function | File | Pool-boundary role |
|---|---|---|
| `classifyGradeType()` | `src/services/ebayService.js` | Assigns each comp to exactly one of `raw` / `graded` / `proof` |
| `applyFilters` (strike-split block) | `src/services/ebayService.js` | Drops comps whose `gradeType !== targetPool` -- MUST be strict equality, single-line |
| Pool selection / `wantsProof` / `wantsGraded` | `src/services/valuationService.js` | Chooses which pool feeds FMV; reverse-proof routed to its own pool (#260W) |
| Pool-fallback logic | `src/services/valuationService.js` | When target pool is too sparse, falls back to alternative pool with FULL DISCLOSURE in response (`dataSource`, `confidence`) -- NEVER silent blending |

### History (do not re-implement)

- **PR #154 (#252, merged 2026-06-18, reverted 2026-06-23):** added `isBullionMerge` gate that merged graded + raw for `>= 1.0 oz` bullion. Pool pollution lasted 5 days. Sweeping revert under PR #177. See `docs/WASTE-LEDGER.md` INC-013 ($10.03 direct cost). Tracking for the original sparse-raw symptom is **BACKLOG #270W**.
- Any future PR touching the pool boundary MUST cite `docs/memory/numismatic-terminology.md` in the PR body and explain which boundary is being crossed and why.

## Core Principle

**Proof is a manufacturing method, not a condition.**

A Proof coin is struck with polished dies, multiple strikes, on specially prepared planchets. It produces mirror fields and frosted devices. "Proof" does NOT mean "perfect" -- a PR-63 exists and is worn/spotted.

A Business Strike (MS) coin is struck once on standard planchets for general circulation. These are graded on the Sheldon scale (MS-60 to MS-70 for uncirculated).

These two are **mutually exclusive products** and must NEVER be mixed in the same pricing pool.

---

## Complete Classification Decision Tree

```
Input: comp title + conditionId + aspects
                    |
                    v
   [conditionId present?]
          |              |
         YES             NO
          |              |
   [cid == 2000?]    [Has _certificationAspect?]
      |        |          |            |
     YES      NO         YES          NO
      |        |          |            |
 [PROOF_RE?] [cid 3000/4000]  [PROOF_RE?]  [Title fallback]
   |     |      |              |     |         |
  YES   NO   [PROOF_RE?]     YES   NO     [PROOF_RE?]
   |     |    |     |          |     |      |      |
 proof graded YES  NO       proof  graded  YES    NO
              |     |                       |      |
            proof  raw                    proof  [TPG_RE?]
                                                  |     |
                                                 YES   NO
                                                  |     |
                                               graded  raw
```

## PROOF_RE Pattern

```javascript
const PROOF_RE = /\bproof\b(?![\s-]*like)/i;
```

**Why the lookahead**: "Proof-Like" and "Prooflike" are NOT proofs. They are business strike Morgan/Peace dollars with unusually reflective surfaces. They are graded MS (e.g., "MS-64 PL") and belong in the graded pool.

### Matches (= proof):
- "2023 Silver Eagle Proof"
- "PF69 DCAM Proof"
- "Reverse Proof American Eagle"
- "Matte Proof 1915 Lincoln"

### Does NOT Match (= not proof):
- "1881-S Morgan Prooflike"
- "PCGS MS64 Proof-Like"
- "Deep Mirror Proof-Like"

---

## Finish Detection Reference

| Text Pattern | Detected Finish | Is Proof? | Notes |
|-------------|----------------|-----------|-------|
| "reverse proof" | Reverse Proof | YES | Still a proof, special contrast |
| "enhanced reverse proof" | Enhanced Reverse Proof | YES | 2019 ASE, Pride of Two Nations |
| "proof" (standalone) | Proof | YES | Standard mirror proof |
| "burnished" | Burnished | NO | Special uncirculated (W-mint) |
| "satin finish" | Satin Finish | NO | 2005-2010 mint set coins |
| "antiqued" | Antiqued | NO | Artificial aging applied |
| "high relief" | High Relief | NO | Extra depth in design |
| "colorized" | Colorized | NO | Aftermarket or mint coloring |
| "uncirculated" | Uncirculated | NO | Standard business strike |
| "proof-like" / "prooflike" | (none -- not a finish) | NO | Reflective business strike |
| "DMPL" | (none -- not a finish) | NO | Deep Mirror PL designation |

---

## Grade Prefix to Pool Mapping

| Prefix | Full Name | Pool | Price Universe |
|--------|-----------|------|---------------|
| MS-60 to MS-70 | Mint State | graded | Certified business strike |
| PR-60 to PR-70 | Proof (PCGS) | proof | Certified proof |
| PF-60 to PF-70 | Proof (NGC) | proof | Same as PR |
| SP-60 to SP-70 | Specimen | proof | Treat as proof for pricing |
| AU-50 to AU-58 | About Uncirculated | graded | Certified circulated |
| XF/EF-40/45 | Extremely Fine | graded | Certified circulated |
| VF-20 to VF-35 | Very Fine | graded | Certified circulated |
| F-12/15 | Fine | graded | Certified circulated |
| VG-8/10 | Very Good | graded | Certified circulated |
| G-4/6 | Good | graded | Certified circulated |
| AG-3, FR-2, PO-1 | Low grades | graded | Certified circulated |
| (no prefix -- raw) | Ungraded | raw | Uncertified coins |

---

## eBay Condition IDs for Coins

| conditionId | eBay Label | Meaning | Default Pool |
|-------------|-----------|---------|-------------|
| 2000 | Certified | Slabbed by TPG (PCGS/NGC/ANACS/ICG) | graded (check PROOF_RE) |
| 3000 | Ungraded | Raw, claimed uncirculated | raw (check PROOF_RE) |
| 4000 | Ungraded | Raw, circulated | raw (check PROOF_RE) |
| 1000 | New | Factory sealed (rolls, sets) | raw |
| 1500 | New Other | Opened but uncirculated | raw |

---

## Common eBay Title Traps

| Title Pattern | Naive Classification | Correct Classification | Why |
|--------------|---------------------|----------------------|-----|
| "BU Proof Silver Eagle" | raw (BU) | proof (Proof wins) | Proof is definitive; BU is informal |
| "Proof-Like Morgan MS64 PL" | proof | graded | PL is a designation, not a proof |
| "DCAM Proof" | uncertain | proof | DCAM is a proof designation |
| "Gem BU" | uncertain | raw | "Gem" is marketing, BU = uncirculated |
| "Mirror Finish" | proof? | graded (probably PL) | Mirror ≠ Proof without "proof" keyword |
| "W Mint Burnished" | proof? | graded | Burnished is special uncirculated, NOT proof |
| "Satin Finish 2008-P" | proof? | raw/graded | Satin is a mint set finish, NOT proof |

---

## Type Variants (Hard Filter Rules)

When a query specifies a type variant, comps with the OTHER type must be hard-filtered out:

| Series | Variant | Years | Design Difference |
|--------|---------|-------|-------------------|
| ASE | Type 1 | 1986-2021 | Weinman walking / Mercanti eagle |
| ASE | Type 2 | 2021-present | Walking / Eagle landing with shield |
| AGE | Type 1 | 1986-2021 | Family of eagles reverse |
| AGE | Type 2 | 2021-present | Single eagle head reverse |

**2021 is the transition year** -- both types minted. Must disambiguate.

---

## Audit Checklist

When reviewing classification code, verify:

### Classification (per-comp)
- [ ] `PROOF_RE` has negative lookahead for "like" (both hyphenated and unhyphenated)
- [ ] `classifyGradeType()` checks PROOF_RE for ALL conditionIds (2000, 3000, 4000)
- [ ] `_detectFinish()` checks "reverse proof" BEFORE "proof" (longest match first)
- [ ] `parseDescription()` does not set `grade = 'Proof'` for proof sets (they're products, not grades)
- [ ] `wantsProof` triggers on PR/PF prefix AND explicit `opts.isProof` flag
- [ ] "Burnished" is NOT classified as proof (it's special uncirculated)
- [ ] "Satin Finish" is NOT classified as proof
- [ ] PL/DMPL Morgan/Peace dollars stay in graded pool
- [ ] Type 1/Type 2 hard filter exists when label specifies type

### Pool-isolation (cross-comp) -- CRITICAL
- [ ] `applyFilters` strike-split is strict equality. Current implementation reads `return gt === targetPool;` -- ANY deviation (`||`, `allow*`, weight gate, branching that lets `gt !== targetPool` survive) is a FAIL
- [ ] No code path produces a comp pool where `comps.some(c => c.gradeType !== targetPool)` after filters
- [ ] Pool fallback in `valuationService` never silently blends -- alternate pool selection MUST set `dataSource` and downgrade `confidence`
- [ ] No `isBullionMerge` / `poolMerge` / `crossPool` / `mergePools` symbol exists anywhere in `src/services/` (`grep -rnE 'bullionMerge|poolMerge|crossPool|mergePools' src/` MUST return zero matches)
- [ ] No weight-threshold-as-merge-license pattern (`grep -rnE 'weight.*>=.*&&.*(pool|merge|allow)' src/services/` MUST return zero matches)
- [ ] Response schema attributes every FMV to exactly one pool (no anonymous `fmv` without `pool` field)
- [ ] `prefilterStrikeSplit` is treated as a correct-rejection counter, not a metric to minimize
- [ ] Regression test in `__tests__/ebayFetchSoldComps.test.js` ("DO NOT relax without re-reading...") still asserts strict raw-pool behavior

### Audit invocation
- Run `@numismatic-audit` after any change to `classifyGradeType`, `applyFilters`, `_detectFinish`, `parseDescription`, or `valuationService` pool logic
- Cite [`docs/memory/numismatic-terminology.md`](../../../docs/memory/numismatic-terminology.md) in the PR body when crossing any pool boundary -- explain which boundary, why, and how the existing approved patterns above were ruled out

---

## Sources

- PCGS Grading Standards: https://www.pcgs.com/grades
- PCGS Coin Glossary: https://www.pcgs.com/glossary
- NGC Grading Scale: https://www.ngccoin.com/coin-grading/grading-scale/
- Sheldon Scale: William Sheldon, "Penny Whimsy" (1958)
