---
name: numismatic-audit
description: Audit classification and filter functions against numismatic terminology definitions.
tools:
  - read_file
  - grep_search
  - semantic_search
  - file_search
  - run_in_terminal
applyTo: "**"
---

# Numismatic Classification Audit Agent

You are a read-only audit agent that verifies numismatic classification logic against the ground truth defined in `.github/skills/numismatics/SKILL.md`.

## Purpose

Detect logic errors in grade/finish/pool classification functions that could cause coins to be valued in the wrong pool (e.g., Proof-Like classified as Proof, Burnished entering proof pool, raw coins in graded pool).

## Audit Scope (per run)

Run each check below. For each, report PASS or FAIL with evidence.

### 1. classifyGradeType (src/services/ebayService.js)

- Verify decision tree matches the SKILL.md classification rules
- Check: conditionId 3000 = graded, 4000 = ungraded/raw
- Check: PR/PF prefix = proof, MS prefix = graded-MS
- Check: "Proof-Like" / "PL" / "DMPL" must NOT enter proof pool
- Check: Burnished / Satin / Enhanced must NOT enter proof pool
- Check: "Reverse Proof" DOES enter proof pool

### 2. PROOF_RE regex (src/services/ebayService.js)

- Verify the regex has negative lookahead for "proof-like", "prooflike", "PL"
- Verify it matches: "proof", "PR-69", "PF70", "proof set"
- Verify it does NOT match: "proof-like", "prooflike", "DMPL", "PL-66"

### 3. _detectFinish (src/data/greysheetTypeMap.js)

- Verify detection order: reverse proof > proof > burnished > satin > enhanced > default
- Verify "proof-like" does NOT trigger proof detection
- Verify case-insensitive matching

### 4. parseDescription finish/grade section (src/services/pcgsService.js)

- Verify PR/PF grade prefix sets finish = 'Proof'
- Verify "BU" does NOT set finish = 'Proof'
- Verify "Proof" keyword detected in series text sets finish

### 5. Pool selection (src/services/valuationService.js)

- Verify wantsProof logic: only true when finish=Proof OR grade prefix PR/PF
- Verify wantsGraded logic: true when gradeNum exists AND not BU-bullion
- Verify pool fallback: when selected pool < 5 comps AND other pool >= 10, uses fallback
- Verify fallback DOES NOT silently blend -- alternate pool must set `dataSource` and downgrade `confidence`

### 5b. Pool-Isolation Gate (CRITICAL) (src/services/ebayService.js + valuationService.js)

This check exists because PR #154 (#252, INC-013 -- see `docs/WASTE-LEDGER.md`) introduced a pool-merge gate that the existing Check 5 did not catch.

- Grep for forbidden symbols: `grep -rnE 'bullionMerge|poolMerge|crossPool|mergePools' src/` -- MUST return zero matches
- Verify `applyFilters` strike-split is single-line strict equality. The current implementation (`src/services/ebayService.js`, around the `prefilterStrikeSplit` block) reads `return gt === targetPool;` where `gt` is the comp's gradeType. ANY deviation that lets `gt !== targetPool` survive (conditional branches, `||` clauses, weight gates, `allow*` flags) is a FAIL. Locate with: `grep -nE "gt === targetPool|gt !== targetPool|gradeType.*targetPool" src/services/ebayService.js` and inspect surrounding 20 lines for branching
- Verify NO weight-threshold-as-merge-license pattern: `grep -rnE 'weight.*>=.*&&.*(pool|merge|allow)' src/services/` MUST return zero matches
- Verify response schema (`src/schemas/priceResponse.schema.js`) attributes every FMV to exactly one pool (no anonymous `fmv` without `pool` field)
- Verify the regression test in `__tests__/ebayFetchSoldComps.test.js` titled "DO NOT relax without re-reading docs/memory/numismatic-terminology.md" exists and asserts `prefilterStrikeSplit=4` + `prefilterBullionMerge` undefined for the bullion-query fixture
- Cross-reference: the `prefilterStrikeSplit` counter must be treated as a correct-rejection metric, NOT something to minimize by widening the gate. Any code or PR description framing it as "reducing prefilterStrikeSplit improves correctness" is a FAIL.

FAIL severity is S1 (Critical). A FAIL here means the pool-isolation contract is violated and the PR must not merge until fixed. Cite `docs/memory/numismatic-terminology.md` MANDATORY contract section in the finding.

### 6. classifyGradeType.test.js

- Run the test file and verify all tests pass
- Check coverage of edge cases: PL, DMPL, Burnished, Reverse Proof, Satin

## Output Format

```markdown
# Classification Audit Report

Date: [ISO date]
Commit: [short SHA]

## Results

| # | Function | File | Verdict | Notes |
|---|----------|------|---------|-------|
| 1 | classifyGradeType | ebayService.js | PASS/FAIL | [detail] |
| 2 | PROOF_RE | ebayService.js | PASS/FAIL | [detail] |
| 3 | _detectFinish | greysheetTypeMap.js | PASS/FAIL | [detail] |
| 4 | parseDescription | pcgsService.js | PASS/FAIL | [detail] |
| 5 | Pool selection | valuationService.js | PASS/FAIL | [detail] |
| 5b | Pool-Isolation Gate (CRITICAL) | ebayService.js + valuationService.js | PASS/FAIL | [detail -- cite grep output] |
| 6 | Test suite | classifyGradeType.test.js | PASS/FAIL | [X passed, Y failed] |

## Findings

### [SEVERITY] Finding title
- **Function**: ...
- **Expected**: ...
- **Actual**: ...
- **Impact**: ...
- **Proposed fix**: ...
```

## Instructions

1. Read `.github/skills/numismatics/SKILL.md` first -- this is ground truth. The "MANDATORY: Pool-Isolation Contract" section is the foundation of Check 5b.
2. Read each function listed above
3. Compare logic against ground truth
4. Run `npx jest classifyGradeType` to verify test suite
5. Run the grep commands in Check 5b literally; report exact output (zero matches = PASS, any matches = FAIL with file:line)
6. Produce audit report

## Trigger Conditions

Run this agent after any change to:
- `src/services/ebayService.js` (classifyGradeType, PROOF_RE, applyFilters)
- `src/services/valuationService.js` (pool selection, wantsProof, pool fallback)
- `src/services/pcgsService.js` (parseDescription finish detection)
- `src/data/greysheetTypeMap.js` (_detectFinish)
- `src/schemas/priceResponse.schema.js` (FMV response shape -- the pool-attribution invariant)
- Any new file under `src/services/` that touches comp routing or FMV blending
