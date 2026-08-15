# ADR-001: Isolate FMV Comp Pools

- Status: Accepted
- Date: 2026-08-11

## Context

Raw, graded, proof, reverse-proof, and explicitly requested specialty-finish
coins can trade at materially different price levels even when they share a
series, year, metal, and weight. A prior attempt to merge graded and raw bullion
comps increased the number of survivors but polluted FMV results for five days
and required a broad revert (WASTE-LEDGER INC-013).

Sparse target pools are expected. Treating another pool as interchangeable
hides missing evidence and produces a confidently wrong valuation.

## Decision

FMV computation uses mutually exclusive comp pools selected by user intent:

- Raw, graded, proof, and reverse-proof comps remain separate.
- Colorized, antiqued, gilded, burnished, and high-relief requests use only raw
  comps from the exact requested specialty family.
- A thin or empty target pool does not permit an all-comp merge. Approved
  responses include a wider lookback within the same pool, a grade-aware guide
  value, separate pool-specific FMVs, or an explicit null FMV.
- The existing graded-to-raw last-resort path remains narrowly limited to zero
  graded sold comps, at least ten raw sold comps, and no grade-specific PCGS or
  Greysheet signal. It must be disclosed as a fallback and reduce confidence.

Any change to comp classification or pool selection must cite the mandatory
pool-isolation contract and state which boundary it affects.

## Consequences

- FMV represents the requested market instead of a blended neighboring market.
- Sparse pools may return low-confidence or null results more often.
- Data acquisition and lookback improvements must preserve pool identity.
- Pool-selection changes require domain review and regression coverage.

## References

- [Numismatic terminology and mandatory pool contract](../memory/numismatic-terminology.md)
- [Decision engine specification](../memory/decision-engine-spec.md)
- [WASTE-LEDGER INC-013](../WASTE-LEDGER.md#inc-013-pr-154-252-pool-isolation-violation-merged--5-day-fmv-pollution--sweeping-revert-pr-177)
- [Architecture: comp acquisition cascade](../ARCHITECTURE.md#ebay-service----comp-acquisition-cascade)