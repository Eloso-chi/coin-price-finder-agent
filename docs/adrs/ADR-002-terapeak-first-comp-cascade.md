# ADR-002: Use a Terapeak-First Comp Cascade

- Status: Accepted
- Date: 2026-08-11

## Context

Valuation needs sold prices, sale dates, and enough comparable records to
support confidence scoring. The available sources have different semantics and
availability: the local Terapeak store contains exported sold transactions,
Marketplace Insights provides sold data only with approved access, the Finding
API was decommissioned in February 2025, and Browse returns active listings
rather than completed sales.

Calling live APIs before consulting imported sold data adds latency, consumes
quota, and can replace stronger evidence with weaker asking-price evidence.

## Decision

Comp acquisition follows this ordered cascade:

1. Query the local Terapeak store first. If it supplies enough eligible sold
   comps, skip all live eBay tiers.
2. Reserve Marketplace Insights for additional sold evidence if approved API
   access becomes available. The current code path is unavailable because the
   project does not have that access.
3. Keep the legacy Finding tier disabled by default while the API remains
   decommissioned; do not treat it as an available sold-data source.
4. Use Browse active listings only as the last resort when sold comps are
   unavailable, and apply the documented confidence penalty.

Live API requests are throttled. Applicable sold-data tiers use circuit
breakers; Browse uses bounded retries but is not circuit-protected. Every tier
still passes through common relevance, variant, and pool-isolation filters
before valuation.

## Consequences

- Imported sold evidence is reused without network latency or API quota cost.
- Valuation can operate while both live eBay sold-data tiers are unavailable.
- Browse fallback keeps the product responsive but produces explicitly weaker
  confidence because asking prices are not transactions.
- The unavailable Marketplace Insights path and disabled Finding tier remain
   technical debt and must not be mistaken for working fallbacks.

## References

- [Architecture: comp acquisition cascade](../ARCHITECTURE.md#ebay-service----comp-acquisition-cascade)
- [Finding API decommission context](../memory/finding-api-dead.md)
- [Codebase overview](../memory/codebase-overview.md)
- [Terapeak runbook](../memory/terapeak-runbook.md)