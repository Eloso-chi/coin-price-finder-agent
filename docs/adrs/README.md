# Architecture Decision Records

Architecture Decision Records (ADRs) explain why load-bearing system choices
exist. They summarize accepted decisions; governing operational and domain
contracts remain authoritative where linked.

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-fmv-pool-isolation.md) | Isolate FMV comp pools | Accepted |
| [ADR-002](ADR-002-terapeak-first-comp-cascade.md) | Use a Terapeak-first comp cascade | Accepted |
| [ADR-003](ADR-003-valuation-mode-routing.md) | Route bullion and numismatic valuation modes separately | Accepted |
| [ADR-004](ADR-004-public-admin-audience-gating.md) | Gate response detail by public/admin audience | Accepted |
| [ADR-005](ADR-005-terapeak-anti-bot-state-machine.md) | Use a fail-closed anti-bot risk-state machine | Accepted |

## Template

```markdown
# ADR-NNN: Decision Title

- Status: Proposed | Accepted | Superseded
- Date: YYYY-MM-DD

## Context

What forces the decision?

## Decision

What is the chosen approach?

## Consequences

What becomes easier, harder, or constrained?

## References

- [Governing document](relative-path.md)
```