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

## Generator

`python3 scripts/operator-status.py` prints this report from telemetry (`cache/terapeak-runs/{passes,coins}.jsonl`, the newest pass log, the operator log queue counts and the risk-state file): the runbook contract block for the in-progress or last completed pass, then a labelled cumulative run view. It reads both operator layouts (H: `cache/terapeak-operator-passes/<RUN_ID>/` and `cache/terapeak-operator-<RUN_ID>.log`; W/Codespace: `cache/terapeak-operator-codespace-passes/<RUN_ID>/` and `cache/terapeak-operator-codespace_<RUN_ID>.log`) and reuses the operator's own pass-log parser. Options: `--passes N` (rows shown, 0 for all), `--run-id ID`, `--project-dir DIR`, `--skip-process-check`. Exit code 2 means no run data was found or the telemetry could not be interpreted.

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
| Pacing pilot | `pacing_profile_requested`, `pacing_profile_effective`, `pacing_pilot_id` |

State values are `Normal`, `Elevated`, `Challenged`, and `Cooldown`. A null
`transition_reason` means no transition. Legacy fields such as `pass`,
`new_rows`, and `dup_rows` remain present for existing reports.

Per-pass outcome counts (`attempted`, `succeeded`, `empty`, `failed`,
`unknown`) are derived from the pass log and always satisfy
`attempted = succeeded + empty + failed` with `unknown = 0` for a complete log
(#323H). A coin counts as `failed` for a `TIMEOUT`, an `ERROR:` line, a file
that is too small, a bot block, or any upload error other than the case below.
A coin whose upload the server rejects with HTTP 422 "No valid comps found in
CSV" counts as `empty` and is flagged `no_comps` (#328H): the dataset has no
usable sales, so it is reported as no data rather than as an upload failure.
The pass record carries the `no_comps` count (a subset of `empty`), each
`coins.jsonl` record carries a `no_comps` flag, and the operator
`[parse]` line prints `no_comps=N` after `failed=`. When at least 3 coins, at
least 30% of the batch, and at least twice the successful uploads are no-comps
rejections the record sets `no_comps_cluster` and the operator log gets a
`[parse] WARN no_comps cluster` line: a run of rejections that large points at
a Terapeak export-format change or a server CSV parser fault, not at empty
markets. Both operators stop after such a pass (a data-quality stop that
leaves the risk state unchanged; see `anti-bot-operations.md` item 7), so
investigate before restarting.
The exporter's own `Failed:` tail (`failed_reported`) still counts
`NO EXPORT` and no-comps coins as failed, so it can exceed the parsed `failed`.
Records written before #328H count a no-comps rejection as `failed`, so
failure rates are not directly comparable across that boundary.

P3 fallback fields (#330H): `fallback_filled` is the number of batch slots the
P3 fallback tiers filled in the pass, `tier_yield` maps each tier (and `primary`
for P0 to P2 datasets) to `{items, appended_rows}` where `appended_rows` is the
CSV row delta of each exported dataset (the upload `new` count includes rows the
app already held, so it is not a yield measure), and `drained` is true for the
zero-coin pass on which the exporter found nothing eligible in any tier. Logs
written before #330H yield zeros, an empty `tier_yield` and `false`.
`operator-status.py` prints `P3 fill: N slots this pass | M this run` and
`Appended rows this pass: ...` between `Batch total` and `Queue` only when a
fallback tier was used in the pass or earlier in the run, and adds
`queue drained: no eligible dataset in any tier` to Highlights for a drained
pass.

The default pacing profile is `baseline`. Set
`TERAPEAK_PACING_PROFILE=normal-tuned` only for an approved pilot. The tuned
profile scales centralized idle and action delays to 80% during Normal passes.
Elevated and Cooldown passes always use baseline pacing. Scroll behavior,
coffee breaks, and browser recycling are unchanged. The exporter independently
checks the persisted risk-state file before accepting tuned pacing.

Validate one or more JSONL files in human-readable or JSON form:

```bash
python3 scripts/validate-pass-telemetry.py cache/terapeak-runs/passes.jsonl
python3 scripts/validate-pass-telemetry.py --json cache/terapeak-runs/passes.jsonl
```

<!-- End #284H pass telemetry contract. -->