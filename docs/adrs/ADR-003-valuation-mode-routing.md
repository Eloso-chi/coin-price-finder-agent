# ADR-003: Route Valuation Modes by Market Behavior

- Status: Accepted
- Date: 2026-08-11

## Context

Bullion and numismatic coins respond to different price signals. Standard raw
bullion tracks current metal value closely, so a historical sold-price median
can lag a fast-moving spot market. Certified, proof, reverse-proof, scarce-date,
and specialty-finish coins derive more value from grade, rarity, mintage, and
collector demand; applying a generic spot-premium clamp can collapse distinct
issues to nearly the same value.

No single blend accurately models both markets.

## Decision

The valuation engine selects among explicit modes after choosing the requested
comp pool:

- Use `bullion-spot-premium` for eligible bullion with usable spot and eBay
  evidence. Derive a bounded premium from the isolated comp median and blend a
  valid Greysheet wholesale signal when available.
- Skip spot-premium math and its bullion fallback ladder for proof and
  reverse-proof intent. These use their isolated comp pool through the normal
  certified or raw blend.
- Use `certified-blend` for PCGS-verified numismatic coins, with grade-tiered
  source weights.
- Use `raw-blend` for unverified raw coins.
- Return an explicit null FMV when the selected mode has no defensible source,
  rather than crossing pools or manufacturing a premium.

## Consequences

- Standard bullion responds promptly to metal-price movement.
- Collector premiums are not capped by commodity assumptions.
- Mode selection and pool selection remain separate, testable decisions.
- Additional modes must define their trigger, source semantics, fallback, and
  confidence effects in the decision-engine specification.

## References

- [Decision engine specification](../memory/decision-engine-spec.md)
- [Numismatic terminology and mandatory pool contract](../memory/numismatic-terminology.md)
- [Architecture: valuation pipeline](../ARCHITECTURE.md)