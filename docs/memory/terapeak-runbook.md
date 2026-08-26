# Terapeak Export -- Startup Runbook

## Canonical Identity Reclassification

Preview stored-row classification without mutating the store:

```bash
node scripts/reclassify-comps.js
```

The dry run classifies rows as `valid`, `wrong_dataset`, `ambiguous`, or `unknown`. Only a pure weight mismatch may be rerouted; conflicting series, year, mint, metal, grade, finish, designation, or pool is excluded and recorded for rollback. The command writes ignored artifacts under `.local/reclassification/`:

- `identity-reclassification-manifest.json` -- parser version, before/after counts, classification totals, and reroute counts.
- `identity-reclassification-rollback.json` -- original rows removed or moved, including source dataset and index.

Review both artifacts before applying. Apply mode is an operational data mutation and requires explicit approval:

```bash
node scripts/reclassify-comps.js --apply
```

Use `--store <path>` and `--output-dir <path>` for isolated validation. Apply only on the authoritative environment while the application server and all import processes are stopped. The script creates an exclusive `.reclassify.lock`, and live Terapeak persistence defers writes while that lock exists, but an offline apply remains mandatory to eliminate in-flight write races.

The migration holds the source, transformed store, rollback rows, and serialized artifacts in memory. Before applying a production-scale store, ensure free memory comfortably exceeds several times the store size; use an explicit Node heap limit when needed, for example `node --max-old-space-size=4096 scripts/reclassify-comps.js --apply`. The script aborts if the source fingerprint changes after reading and before replacement.

After apply, restart the application to invalidate pricing caches. Re-running after apply must report `storeChanged: false`, `identityUpdated: 0`, and `changed: 0`.

## Quick Start (run these in order)

### 1. VNC Server
```bash
# Check if running:
pgrep -f Xtigervnc && echo "running" || echo "not running"

# If not running:
Xtigervnc :1 -geometry 1280x800 -SecurityTypes None -AlwaysShared &>/dev/null &
sleep 1
bash /usr/share/novnc/utils/novnc_proxy --vnc localhost:5901 --listen 6080 &>/dev/null &

# Access via browser: port 6080 (no password -- SecurityTypes None)
```

### 2. App Server
```bash
kill $(lsof -t -i:3000) 2>/dev/null
cd "$(git rev-parse --show-toplevel)"
```

Then use the execute tool to run `node server.js` with background/async mode.
Do not append `&` or run it synchronously; the server never exits.

### 3. Reset Terapeak Quota
```bash
curl -s -X POST http://localhost:3000/api/terapeak/quota/reset \
  -H "x-api-key: $ADMIN_API_KEY"
# ADMIN_API_KEY is loaded from .env (run `bash scripts/load-secrets.sh` to populate from Azure Key Vault)
```

### 4. eBay Login via VNC
```bash
cd "$(git rev-parse --show-toplevel)" && DISPLAY=:1 python3 scripts/vnc-login.py
# Opens eBay in Playwright browser inside VNC
# Open port 6080 in your browser, solve CAPTCHA/2FA, log in
# Script auto-detects login, then opens /sh/research in the same visible browser
# so you can solve a second challenge before cookies are saved.
# A hard bot-warning stops with exit 2; do not retry or bypass it.
```

### 5. Keepalive (prevents Codespace idle shutdown)
```bash
while true; do echo "keepalive $(date)"; sleep 300; done
# Run as background process
```

**Why this specific shape works (and why a `curl` loop alone does not):**
Per the [GitHub Codespaces idle-timeout docs](https://docs.github.com/en/codespaces/setting-your-user-preferences/setting-your-timeout-period-for-github-codespaces#inactivity-defined),
activity is reset by "typing or using the mouse" **and by** "terminal
activity, either input or output." The `echo` above writes to a real PTY
attached to the codespace shell, which counts as terminal output.

A `nohup curl ... > keepalive.log 2>&1 &` loop -- the obvious-looking
alternative -- does **not** reset the timer: the process has no controlling
terminal (stdout is redirected to a file), so no TTY activity is generated.
Empirically verified 2026-06-29: a codespace died at ~02:50Z despite three
successful `curl` keepalive pings against its own forwarded port.

For unattended long runs (e.g. operator-codespace.sh overnight) prefer
any of:
- `tail -F cache/operator-cs.log` in a VS Code terminal -- streams operator
  activity through a real PTY for as long as the operator is running.
- The `while true; do echo ...; sleep 300; done` loop above, started in a
  VS Code terminal (not via `nohup` + `>` redirect).
- `screen` or `tmux` sessions -- the multiplexer keeps a PTY allocated even
  when no client is attached.

The 240-minute hard cap on idle-timeout still applies; nothing below that
threshold matters as long as PTY output is flowing.

### 6. Launch Page 1 Export
```bash
cd "$(git rev-parse --show-toplevel)" && DISPLAY=:1 python3 scripts/terapeak-export.py --run --resume 2>&1 | tee cache/terapeak_export.log
# --resume skips already-completed coins
# --filter "REGEX" to target specific coins
# --dry-run to preview without collecting
```

### 7. Launch Deep Pagination (Pages 2-5)
```bash
# Dashboard mode (interactive priority menu -- no flags needed):
cd "$(git rev-parse --show-toplevel)" && python3 scripts/sales-aggregator.py

# Direct run:
cd "$(git rev-parse --show-toplevel)" && DISPLAY=:1 python3 scripts/sales-aggregator.py --run --filter "REGEX" --min-rows 25 2>&1 | tee cache/terapeak_p2.log
# Non-gold bullion auto-detects to pages 2-5 (max 250 results)
# Gold bullion and non-bullion: page 2 only (max 100 results)
# --max-pages N to override (e.g. --max-pages 3)
# --dry-run to preview candidates
```

### 8. Resume After Interruption (codespace restart, etc.)
```bash
# Resume uses the previous log to skip already-completed coins:
cd "$(git rev-parse --show-toplevel)" && DISPLAY=:1 python3 scripts/sales-aggregator.py --run --resume cache/terapeak_p2.log --filter "REGEX" --min-rows 25 2>&1 | tee cache/terapeak_p2_resume.log
# --resume LOGFILE is required (path to the interrupted run's log)
# Data is uploaded per-coin, so partial runs save all completed work
# Always commit partial data before resuming so nothing is lost
```

**Recovery checklist after codespace restart:**
1. VNC server (step 1)
2. App server (step 2)
3. eBay login via VNC (step 4) -- cookies expire on restart
4. Commit any uncommitted data: `git add data/terapeak/ && git diff --cached --stat`
5. Resume with `--resume <old-log>` (step 8)

## Long-running operator (codespace / W machine)

`scripts/terapeak-operator-codespace.sh` is the W-machine sibling of
`scripts/terapeak-operator.sh` (which targets the H-machine WSL Surface path
and requires `~/.env.surface`). The codespace flavor:

- Trusts repo `.env` and process env -- no `~/.env.surface` dependency
- Uses system `python3` (no project venv discovery)
- Runs preflight checks: runtime, server health, cookie health
  (`scripts/cookie-health-check.py`)
- Loops with randomized per-pass batch size (30-35 default) and jittered
  pause (600s +/- 90s default) for anti-detection
- Default `--max-passes 0` = unlimited; loops until pass failure or cookie
  health degrade. Set `--max-passes N` to install a cap
- Quota is logged informationally only; never enforced (there is no
  published Terapeak quota -- the in-app counter is a politeness signal)
- Single-instance lock via `flock` on `cache/terapeak-operator-codespace.lock`

```bash
# Run until something stops it (recommended default)
nohup bash scripts/terapeak-operator-codespace.sh > cache/operator-cs.log 2>&1 &

# Capped run, custom batch range
bash scripts/terapeak-operator-codespace.sh --max-passes 4 --batch-min 20 --batch-max 35

# Dry-run -- validate preflights without executing passes
bash scripts/terapeak-operator-codespace.sh --dry-run
```

Per-run artifacts:
- `cache/terapeak-operator-codespace_<RUN_ID>.log` -- master log
- `cache/terapeak-operator-codespace-passes/<RUN_ID>/pass-NNNN.log` -- per-pass logs
- `cache/terapeak-operator-codespace.state.json` -- latest state (overwritten each run)

## Structured run history

The operator appends one record per pass to a JSONL ledger so prior runs
can be reviewed later:

| File | Schema |
|---|---|
| `cache/terapeak-runs/passes.jsonl` | One JSON object per pass (run_id, machine, batch_size, attempted, succeeded, empty, failed, new_rows, dup_rows, duration_sec, ...) |
| `cache/terapeak-runs/coins.jsonl` | One JSON object per coin attempt (run_id, pass, idx, coin, status, new, dups, dormant) |

`scripts/_parse-terapeak-pass.py` does the parsing. It is best-effort and
never fails the operator -- parse errors are logged but the loop continues.

View the ledger with `scripts/show-terapeak-runs.sh`:

```bash
bash scripts/show-terapeak-runs.sh recent          # last 20 passes across all runs
bash scripts/show-terapeak-runs.sh runs            # aggregated rows per run
bash scripts/show-terapeak-runs.sh run <RUN_ID>    # pass-by-pass breakdown
bash scripts/show-terapeak-runs.sh coin morgan     # per-coin history (regex)
bash scripts/show-terapeak-runs.sh totals          # lifetime totals
bash scripts/show-terapeak-runs.sh --since 2026-06-29 runs   # date filter
```

Both ledger files are append-only; no rotation, no truncation. They survive
across runs and codespace stop/resume within the same workspace. The ledger
lives under `cache/` (gitignored), so a fresh clone or recreated codespace
starts from empty. For long-term cross-machine history, periodically sync
`cache/terapeak-runs/*.jsonl` to blob storage or commit a snapshot via a
separate data-checkpoint PR.

Smoke-test the parser before changes: `python3 scripts/test_parse_terapeak_pass.py`
(asserts pass/coin record fields against a synthetic fixture; exit 0 = pass).

### Pacing A/B pilot (#280H)

Baseline remains the production default. Run only one profile at a time and
never bypass the #284H hard-challenge stop or Cooldown gates.

```bash
# A arm
TERAPEAK_PACING_PILOT_ID=pilot-20260812 TERAPEAK_PACING_PROFILE=baseline \
  bash scripts/terapeak-operator-codespace.sh --max-passes 1

# B arm: applies only while the pass starts in Normal risk state
TERAPEAK_PACING_PILOT_ID=pilot-20260812 TERAPEAK_PACING_PROFILE=normal-tuned \
  bash scripts/terapeak-operator-codespace.sh --max-passes 1
```

Use the exact 12-pass crossover order
`A, B, B, A, B, A, A, B, B, A, B, A`, which yields six Normal passes per
arm. Use a fresh pilot ID and the same ID for all 12 runs. Keep machine,
network, browser version, batch range,
`--include-thin`, upload mode, and queue priorities unchanged. The tuned arm
scales centralized exporter idle and action delays to 80%. Elevated and
Cooldown passes force effective `baseline`; scrolling, coffee breaks, and
browser recycling remain unchanged.

Pass telemetry records both `pacing_profile_requested` and
`pacing_profile_effective`. Analyze attempt-weighted speed and safety metrics:

```bash
python3 scripts/analyze-pacing-pilot.py --pilot-id pilot-20260812 cache/terapeak-runs/passes.jsonl
python3 scripts/analyze-pacing-pilot.py --pilot-id pilot-20260812 --json cache/terapeak-runs/passes.jsonl
```

Do not adopt the tuned profile unless it improves seconds per attempt by at
least 10% with no worse challenge, failure, success, or Normal-to-Elevated
rates. The analyzer rejects mixed machine/operator/include-thin cohorts,
incomplete telemetry, outcome-count mismatches, or the wrong crossover order.
Any hard challenge stops the pilot immediately and produces a reject decision.

## Post-run progress PR

After an operator run, preview the exact data files and telemetry totals that
would be committed, then create the data PR:

```bash
bash scripts/commit-terapeak-progress.sh --dry-run
bash scripts/commit-terapeak-progress.sh
```

The helper requires Bash, Git, Python, an authenticated `gh` CLI, and an
`origin` whose `main` exactly matches local `main`. It refuses pre-staged
changes and untracked files outside its conservative Terapeak filename
allowlist. It accepts only regular `data/terapeak/*.csv` files and
`data/terapeak-meta.json`, creates a
`data/terapeak-refresh-<RUN_ID>` branch, pushes it, and opens a PR. The run ID
comes from codespace state when present, otherwise H-machine state; use
`--run-id ID` or `--state-file PATH` to select it explicitly. PR merge remains
manual. If PR creation fails after a successful push, rerun `gh pr create`
against the existing branch. For a clean retry, return to `main` and remove
both the generated remote and local branches first.

## Two Scripts

| Script | Purpose | Pages | When to use |
|--------|---------|-------|-------------|
| `terapeak-export.py` | Page 1 export (initial data) | 1 | New coins, empty CSVs |
| `sales-aggregator.py` | Deep pagination (enrich existing) + dashboard | 2-5 for non-gold bullion; 2 otherwise | CSVs with 25+ rows, or dashboard mode |

Both scripts:
- Sort by "Date last sold" (descending) before collecting
- Include "Quantity Sold" column in CSV output
- Use human-like actions (typing with typos, scrolling, clicking with offset)
- Upload each CSV to localhost:3000 via POST /api/terapeak/import

## Useful Commands

| Action | Command |
|--------|---------|
| Check progress | `tail -20 cache/terapeak_*.log` |
| Count completed | `grep -c "OK (" cache/terapeak_*.log` |
| Count new rows | `grep -oP '\+\K\d+(?= new from)' LOG \| python3 -c "import sys; print(sum(int(l) for l in sys.stdin))"` |
| Check cookies | `python3 scripts/terapeak-export.py --check` |
| Dry run p1 | `python3 scripts/terapeak-export.py --dry-run --filter "REGEX"` |
| Dry run p2 | `python3 scripts/sales-aggregator.py --dry-run --filter "REGEX" --min-rows 25` |
| Server health | `curl -s http://localhost:3000/api/health` |

## Anti-Detection Features
- **Shuffled order** -- coins processed in random order (not alphabetical)
- **Human typing** -- character-by-character at 50-120ms, ~4% typo rate with backspace correction
- **Human click/scroll** -- random offset mouse movements, incremental pixel scrolling
- **Page 1 delays** -- 8-18s between searches, coffee breaks every 12-25 coins
- **Page 2+ delays** -- 2.5-6s between pages, occasional 4-10s "reading" pauses, 30% chance of 15-45s micro-breaks between coins for deep pagination
- **Browser recycling** -- every 80 coins in `terapeak-export.py` and every 120 coins in `sales-aggregator.py` (prevents OOM)

## Bullion Detection (sales-aggregator.py)
18 regex patterns in BULLION_PATTERNS match: Libertad, Silver/Gold Eagle, Panda, Perth (Kookaburra, Kangaroo, Lunar, Koala), RCM (Maple Leaf, Polar Bear), Royal Mint (Britannia), Krugerrand, Philharmonic, Gold Buffalo, Platinum/Palladium Eagle.

`is_bullion_term(term)` returns True if any pattern matches. Non-gold bullion gets pages 2-5; gold bullion and non-bullion get page 2 only.

## Key Facts
- Repository CSV inventory changes continuously; count `data/terapeak/*.csv` locally and use admin endpoints for production truth.
- ADMIN_API_KEY: stored in local `.env` (gitignored) and Azure Key Vault secret `ADMIN-API-KEY` (prod). Bootstrap a fresh machine with `bash scripts/load-secrets.sh`. Never commit the value.
- Cookie file: cache/ebay_cookies.json (gitignored)
- Progress tracking: cache/terapeak_export_progress.json (for --resume)
- Session expires: usually ~24-48 hours; re-login via vnc-login.py
- Terapeak provides up to 3 years of historical paid sales data
- Default sort is Best Match; scripts click "Date last sold" for chronological order
