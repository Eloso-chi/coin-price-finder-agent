# Terapeak Export -- Startup Runbook

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
cd /workspaces/coin-price-agent/src && node server.js
# MUST run as background (isBackground: true) -- it never exits
```

### 3. Reset Terapeak Quota
```bash
curl -s -X POST http://localhost:3000/api/terapeak/quota/reset \
  -H "x-api-key: $ADMIN_API_KEY"
# ADMIN_API_KEY is loaded from .env (run `bash scripts/load-secrets.sh` to populate from Azure Key Vault)
```

### 4. eBay Login via VNC
```bash
cd /workspaces/coin-price-agent && DISPLAY=:1 python3 scripts/vnc-login.py
# Opens eBay in Playwright browser inside VNC
# Open port 6080 in your browser, solve CAPTCHA/2FA, log in
# Script auto-detects login (sin=in cookie) and saves 60 cookies
```

### 5. Keepalive (prevents Codespace idle shutdown)
```bash
while true; do echo "keepalive $(date)"; sleep 300; done
# Run as background process
```

### 6. Launch Page 1 Export
```bash
cd /workspaces/coin-price-agent && DISPLAY=:1 python3 scripts/terapeak-export.py --run --resume 2>&1 | tee cache/terapeak_export.log
# --resume skips already-completed coins
# --filter "REGEX" to target specific coins
# --dry-run to preview without collecting
```

### 7. Launch Deep Pagination (Pages 2-6)
```bash
# Dashboard mode (interactive priority menu -- no flags needed):
cd /workspaces/coin-price-agent && python3 scripts/sales-aggregator.py

# Direct run:
cd /workspaces/coin-price-agent && DISPLAY=:1 python3 scripts/sales-aggregator.py --run --filter "REGEX" --min-rows 25 2>&1 | tee cache/terapeak_p2.log
# Bullion coins auto-detect to pages 2-6 (max 300 results)
# Non-bullion: page 2 only (max 100 results)
# --max-pages N to override (e.g. --max-pages 3)
# --dry-run to preview candidates
```

### 8. Resume After Interruption (codespace restart, etc.)
```bash
# Resume uses the previous log to skip already-completed coins:
cd /workspaces/coin-price-agent && DISPLAY=:1 python3 scripts/sales-aggregator.py --run --resume cache/terapeak_p2.log --filter "REGEX" --min-rows 25 2>&1 | tee cache/terapeak_p2_resume.log
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
- Loops with randomized per-pass batch size (15-30 default) and jittered
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
across runs and codespace restarts.

## Two Scripts

| Script | Purpose | Pages | When to use |
|--------|---------|-------|-------------|
| `terapeak-export.py` | Page 1 export (initial data) | 1 | New coins, empty CSVs |
| `sales-aggregator.py` | Deep pagination (enrich existing) + dashboard | 2-6 | CSVs with 25+ rows, or dashboard mode |

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
- **Browser recycling** -- every 40 coins (prevents OOM)

## Bullion Detection (sales-aggregator.py)
18 regex patterns in BULLION_PATTERNS match: Libertad, Silver/Gold Eagle, Panda, Perth (Kookaburra, Kangaroo, Lunar, Koala), RCM (Maple Leaf, Polar Bear), Royal Mint (Britannia), Krugerrand, Philharmonic, Gold Buffalo, Platinum/Palladium Eagle.

`is_bullion_term(term)` returns True if any pattern matches. Bullion coins get pages 2-6; non-bullion gets page 2 only.

## Key Facts
- ~830+ total CSVs in data/terapeak/ (as of April 13, 2026)
- ADMIN_API_KEY: stored in local `.env` (gitignored) and Azure Key Vault secret `ADMIN-API-KEY` (prod). Bootstrap a fresh machine with `bash scripts/load-secrets.sh`. Never commit the value.
- Cookie file: cache/ebay_cookies.json (gitignored)
- Progress tracking: cache/terapeak_export_progress.json (for --resume)
- Session expires: usually ~24-48 hours; re-login via vnc-login.py
- Terapeak provides up to 3 years of historical paid sales data
- Default sort is Best Match; scripts click "Date last sold" for chronological order
