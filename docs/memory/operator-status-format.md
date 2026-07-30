# Operator Status Report Format (user requirement)

Migrated from `/memories/repo/` to `docs/memory/` on 2026-07-05.

When the user asks for "status" (operator/codespace/run), ALWAYS include at minimum:

1. **Current pass number** (and whether it's running, complete, or sleeping)
2. **Coins run** -- this run total + most recent pass count
3. **New rows** -- this run total + most recent pass
4. **Dup rows** -- this run total + most recent pass
5. **Highlights** -- anything unusual: cookie state change, quota rollover, captcha,
   failed pass, ledger errors, server health, codespace uptime past timeout, etc.

Optional but helpful:

- Time since last CSV write (staleness signal)
- Terms in current batch (for focused / partial runs)
- Server-side quota state (if the run is coupled to `POST /api/terapeak/quota/reset`)

Structure the report as a compact table when the run has multiple passes.
Bullet a single-pass status if only one pass has completed. Never dump raw
log lines unless the user asked for logs specifically.

## Rationale

Ad-hoc status reports where the agent invents its own layout make comparisons
across sessions hard and force the user to re-parse each time. Locking a
minimum schema keeps quick check-ins scannable and stops the agent from
padding with irrelevant detail.

## Pass telemetry contract (#284H)

Both canonical operators append one record per attempted pass to
`cache/terapeak-runs/passes.jsonl`, including failed and challenged passes.
Required fields are:

| Group | Fields |
|---|---|
| Identity/time | `run_id`, `pass_id`, `started_at`, `ended_at`, `duration_sec` |
| Batch | `batch_size_requested`, `batch_size_executed` |
| Outcomes | `new_count`, `dup_count`, `no_data_count`, `no_export_count` |
| Health | `cookie_health_status`, `probe_status`, `challenge_signal_count` |
| Risk transition | `state_before`, `state_after`, `transition_reason` |

State values are `Normal`, `Elevated`, `Challenged`, and `Cooldown`. A null
`transition_reason` means no transition. Legacy fields such as `pass`,
`new_rows`, and `dup_rows` remain present for existing reports.

Validate one or more JSONL files in human-readable or JSON form:

```bash
python3 scripts/validate-pass-telemetry.py cache/terapeak-runs/passes.jsonl
python3 scripts/validate-pass-telemetry.py --json cache/terapeak-runs/passes.jsonl
```

<!-- End #284H pass telemetry contract. -->