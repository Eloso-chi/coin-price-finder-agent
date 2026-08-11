# ADR-004: Gate Response Detail by Audience

- Status: Accepted
- Date: 2026-08-11

## Context

Pricing responses contain provenance useful to administrators but inappropriate
for anonymous consumers. Exposing the internal Terapeak source label creates
compliance and competitive-intelligence risk. The same cached service result
can also be delivered to public and admin callers, including separate
subscribers to one bulk-evaluation job, so mutating shared results would either
leak detail or degrade admin responses.

## Decision

Maintain raw internal results and redact only at the response boundary:

- Admin status is true only when `req.isAdmin === true`, as established by the
  optional admin-context middleware.
- Admin callers receive internal Terapeak provenance on comp-bearing pricing
  responses. Coin history is an explicit exception and always reports the
  normalized public source label.
- Public callers see Terapeak comp `_source` rewritten to `ebay-sold`.
- `redactCompsForPublic` shallow-clones rewritten response branches and never
  mutates cached service or stored job results.
- Streaming bulk results are redacted per subscriber, not when the job result
  is created.

## Consequences

- Public API consumers receive useful comp data without internal provenance.
- Admin diagnostics retain source fidelity.
- New response routes and shapes must explicitly apply audience gating.
- Cache-safety and mixed-audience streaming require regression tests whenever
  redaction behavior changes.

## References

- [Audience-gating contract](../memory/audience-gating.md)
- [Public redaction utility](../../src/utils/redactForPublic.js)
- [Architecture](../ARCHITECTURE.md)