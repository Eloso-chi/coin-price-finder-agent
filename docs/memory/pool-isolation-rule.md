# Pool-Isolation Rule -- MANDATORY READ-FIRST

Migrated from `/memories/repo/` to `docs/memory/` on 2026-07-05.

Before touching ANY of these in `src/services/ebayService.js`:
- `classifyGradeType()`
- `applyFilters()` pool gates
- The strike-split prefilter block (currently around L1488-L1545)
- Anything that crosses raw / graded / proof boundaries

You MUST:
1. Open and re-read `docs/memory/numismatic-terminology.md` (the canonical reference)
2. State explicitly in the PR description WHICH pool boundary is being crossed and WHY
3. Cite the numismatic justification (PCGS / NGC / Sheldon basis), not just "comp count goes up"

## Why this rule exists

PR #252 (merged 2026-06-18, reverted 2026-06-23) merged graded + raw pools for
near-oz bullion on the premise that "slabbed 1oz Gold Maple trades at metal +
premium, not a separate slabbed tier". This is FALSE in the general case:
- Every modern bullion series has rare dates, varieties, anniversary issues,
  first-strike labels, etc. that command real slab premium
- MS-70 + First-Strike combinations on Pandas, Eagles, Maples routinely add
  20-40 percent over raw bullion
- Merging the pools INFLATES the FMV for the median bullion query by silently
  pulling slab premium into the "raw bullion" answer

## The architecture says pools are distinct

`numismatic-terminology.md` Code Mapping table:
> classifyGradeType() -- Assigns comp to raw/graded/proof pool

THREE pools. `valuationService.js` L60-63 correctly splits by pool. Merging
contradicts the contract everywhere else in the codebase.

## What to do INSTEAD when graded-bullion comps are scarce

The real problem behind #252 was: prefilter strict-split was dropping enough
graded comps that the raw pool was too sparse for stable FMV. The correct
fixes are:
1. Wider lookback on the raw pool specifically
2. Better Terapeak seeding for raw bullion datasets
3. Surface raw FMV AND slab FMV separately (two products, two prices, like
   Greysheet bid/ask + greensheet)
4. Return "insufficient comps" honestly rather than fabricating a number from
   a mixed pool

## Failure mode for the agent (do not repeat)

In session a9bc389e-48bf-48ba on 2026-06-22 the agent built PR #176 extending
the #252 floor from 1.0 to 0.9 oz to "fix" 30g Panda attrition. It had this
rule's prerequisite (numismatic-terminology.md) in its own /memories/repo/ and
did not consult it until the user challenged three times. The fix was wrong
on the merits. Cost: ~9-12h engineering across original + extension + revert,
~$17-33 in direct Copilot+Azure cost, plus 5 days of polluted bullion FMV
in production. Do not repeat.

## Detection guard

If a PR you're writing touches strike-split / classifyGradeType / pool gates,
and the body does NOT say "consulted numismatic-terminology.md and the
boundary being crossed is X because Y", STOP and read the doc first.
