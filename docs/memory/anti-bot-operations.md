# Terapeak Anti-Bot Operations

This is the canonical #284H risk-state and escalation contract for local and
Codespace Terapeak operators. Runbooks may summarize it but must not define
different state names or transitions.

## Risk states

| State | Meaning | Operator behavior |
|---|---|---|
| Normal | Cookies are healthy and no risk cluster is present. | Use the configured randomized batch and pause range. |
| Elevated | One pass contains at least three soft signals such as timeouts, browser crashes, or `NO EXPORT` outcomes. | Use 15-20 terms and at least a 900-second pause. One clean pass returns to Normal. |
| Challenged | A hard signal was observed: explicit bot block, unusual-activity page, CAPTCHA/hCaptcha, splash challenge, or HTTP 403/429. | Transient decision state only. Stop the pass immediately; do not retry. |
| Cooldown | Persisted stop state entered from Challenged. | Launch no scraper browser until the wait, re-login, and live-probe gates all pass. |

The executable hard-signal transition is logged as `state_after=Cooldown` with
`transition_reason=hard_challenge_signal`; the reason represents the
Challenged decision between the prior state and persisted Cooldown.

## Escalation and recovery

1. Soft-signal clusters move Normal to Elevated. Continue only with bounded
   smaller batches and longer pauses.
2. Any hard challenge moves the run through Challenged to Cooldown and stops
   the exporter and operator with a nonzero exit.
3. Cooldown lasts at least `TERAPEAK_COOLDOWN_SECONDS` (default 7200 seconds).
4. Local restart requires an interactive login followed by
   `cookie-health-check.py --probe` returning HEALTHY.
5. Codespace restart requires a cookie file refreshed after the incident and
   the same live probe returning HEALTHY.
6. A failed gate leaves Cooldown active. Do not bypass the state file.

Stateful behavior is enabled by default. Set
`TERAPEAK_RISK_STATE_ENABLED=0` only as a rollback during incident diagnosis;
telemetry continues to classify and record signals without adaptive state or
pacing changes. The first-hard-challenge stop remains a non-bypassable safety
invariant in rollback mode.

## Compliance guardrails

- Use only the authorized account, research surface, and data-access workflow.
- Respect applicable site terms, access limits, privacy obligations, and law.
- Do not automate CAPTCHA solving or bypass an access challenge.
- Do not rotate proxies, accounts, cookie jars, IP addresses, fingerprints, or
  machines to evade a block.
- Do not run parallel operators or retry while Cooldown is active.
- Do not collect or persist credentials, private account data, or unrelated
  personal information in logs or telemetry.
- A visible, user-solvable CAPTCHA encountered during the interactive VNC
   login flow may be solved manually by the authorized user. The login helper
   waits for the visible `/sh/research` page to clear before saving cookies.
   This does not authorize automated solving, retries, or bypasses. An
   unusual-activity/security-measure page or other hard bot-warning remains a
   non-bypassable stop and preserves Cooldown.
- A workflow change affecting challenge detection, identity, pacing, or retry
  behavior requires the scraper risk/compliance PR checklist.

## Canonical operator defaults

| Profile | Command | Upload mode | Normal batch/pause | Cooldown re-login proof |
|---|---|---|---|---|
| H local WSL2 | `bash scripts/terapeak-operator.sh --loop` | `api` | 30-35 / 600s | Interactive `--login` in the operator |
| W Codespace | `bash scripts/terapeak-operator-codespace.sh` | Existing exporter environment | 30-35 / 600s +/- jitter | Cookie file modification after incident |
| Explicit bulk backfill | Purpose-built direct command | `blob` | Operator-defined, non-looping | Not a Cooldown bypass |

Both operators emit pass records to `cache/terapeak-runs/passes.jsonl` and
coin records to `cache/terapeak-runs/coins.jsonl`.
