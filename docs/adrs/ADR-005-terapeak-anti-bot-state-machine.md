# ADR-005: Use a Fail-Closed Terapeak Risk-State Machine

- Status: Accepted
- Date: 2026-08-11

## Context

Terapeak export automation operates on an authorized research surface that can
present timeouts, browser failures, unusual-activity pages, rate limits, and
interactive challenges. Blind retry, parallel operators, or identity changes
would increase account and compliance risk. A previous refresh was terminated
after anti-bot detection at 22 percent completion (WASTE-LEDGER INC-004).

Operational responses must therefore be deterministic, persisted across
restarts, and conservative under uncertain access state.

## Decision

Operators use the canonical four-state model:

- `Normal`: run randomized configured batches and pauses.
- `Elevated`: after a cluster of soft signals, reduce batches to 15-20 terms
  and pause at least 900 seconds; one clean pass returns to Normal.
- `Challenged`: on any hard signal, stop immediately without retry. This is the
  transient decision leading to persisted Cooldown.
- `Cooldown`: launch no scraper browser until the minimum wait, interactive
  re-login or refreshed cookie proof, and live health probe all pass.

Challenge detection never triggers CAPTCHA solving, proxy or account rotation,
parallel operators, or state-file bypass. Rollback may disable adaptive state
transitions and pacing only; the first-hard-challenge stop remains mandatory.

## Consequences

- Throughput decreases during elevated risk and stops during challenges.
- Recovery requires explicit operator action and evidence of healthy access.
- Persisted state prevents process restarts from becoming an implicit retry.
- Changes to identity, challenge detection, pacing, or retries require the
  scraper risk/compliance review checklist.

## References

- [Canonical anti-bot operations contract](../memory/anti-bot-operations.md)
- [Terapeak runbook](../memory/terapeak-runbook.md)
- [WASTE-LEDGER INC-004](../WASTE-LEDGER.md#inc-004-bot-detection----export-session-killed-at-22)