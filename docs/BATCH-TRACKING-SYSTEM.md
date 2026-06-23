# Batch Tracking System

**Last updated:** 2026-06-23  
**Status:** Production (Session 2026-06-23)

## Overview

This system provides real-time operational visibility into the continuous Terapeak scraper loop. It tracks:
- **Batch numbers** (incremented every 5 minutes, or on script restart)
- **Live coin progress** (current coin, new comps, dups, % complete)
- **Run state persistence** (timestamps, batch counter)

Enables quick status checks without polling the full loop output.

---

## Architecture

### Components

#### 1. **State File: `cache/loop-run-state.json`**

Persistent batch counter and run timing. Updated on script startup.

```json
{
  "batch_number": 3,
  "run_start_time": 1719099600,
  "batch_start_time": 1719099900
}
```

**Timestamps:** Unix seconds (ISO 8601 available via `date -d @<timestamp>`).

**Initialization:** `manage_batch_state()` in `run-surface-freshness-loop.sh` creates or reads this file, increments batch if >5 minutes elapsed since `batch_start_time`.

---

#### 2. **Live Status File: `cache/loop-status-live.json`**

Current coin and export results. Updated after each coin completes.

```json
{
  "batch_number": 3,
  "current_coin": "1878-S Morgan Silver Dollar",
  "new_comps": 85,
  "duplicates": 130,
  "progress_pct": 73,
  "status": "running",
  "timestamp": "2026-06-23T02:45:22.123456"
}
```

**Fields:**
- `batch_number`: matches `loop-run-state.json`
- `current_coin`: eBay search term just completed
- `new_comps`: fresh comps fetched from Terapeak
- `duplicates`: comps already in the database
- `progress_pct`: percent of batch (e.g., 7/15 coins = 47%)
- `status`: `"running"`, `"failed"`, or `"no-export"`
- `timestamp`: ISO 8601, when status was last updated

**Writer:** `update_live_status()` in `scripts/terapeak-export.py`, called after each coin result.

---

#### 3. **Query Command: `bash scripts/loop-status.sh`**

Human-friendly status query. Reads both state files and formats output.

```bash
$ bash scripts/loop-status.sh

═══════════════════════════════════════════════════════
LOOP STATUS
═══════════════════════════════════════════════════════

  Batch #:        3
  Run started:    2026-06-23 02:42:00

  Current coin:   1878-S Morgan Silver Dollar
  New comps:      85
  Duplicates:     130
  Progress:       73%
  Status:         running

═══════════════════════════════════════════════════════
```

If loop not yet started: `Loop not started yet (no state file found)`.

---

## Implementation Details

### Batch Increment Logic

In `run-surface-freshness-loop.sh`, function `manage_batch_state()`:

```bash
manage_batch_state() {
    local state_file="$PROJECT_DIR/cache/loop-run-state.json"
    local lock_file="$PROJECT_DIR/cache/loop-run-state.lock"
    mkdir -p "$PROJECT_DIR/cache"
    exec 9>"$lock_file"
    flock 9
    
    if [[ ! -f "$state_file" ]]; then
        # First run: initialize
        jq -n --arg ts "$(date -Iseconds)" \
            '{batch_number: 1, run_start_time: ($ts | fromdateiso8601), batch_start_time: ($ts | fromdateiso8601)}' \
            > "$state_file"
        BATCH_NUMBER=1
    else
        local last_batch=$(jq -r '.batch_number' "$state_file")
        local batch_start=$(jq -r '.batch_start_time' "$state_file")
        local now=$(date +%s)
        local elapsed=$((now - batch_start))
        
        if [[ $elapsed -gt 300 ]]; then
            # >5 min since batch start: increment
            jq --arg ts "$(date -Iseconds)" '.batch_number += 1 | .batch_start_time = ($ts | fromdateiso8601)' "$state_file" > /tmp/state.json
            mv /tmp/state.json "$state_file"
            BATCH_NUMBER=$((last_batch + 1))
        else
            # <5 min: keep same batch (restart detection)
            BATCH_NUMBER=$last_batch
        fi
    fi
    flock -u 9
    exec 9>&-
    export BATCH_NUMBER
}
```

**Restart Detection:** If script restarts within 5 minutes of the last batch start, batch number stays the same (e.g., if script crashes at 02:44 and restarts at 02:45, batch#3 continues).

---

### Live Status Updates

In `scripts/terapeak-export.py`, function `update_live_status()`:

```python
def update_live_status(term, new_comps=None, dups=None, progress_pct=None, status="running"):
    """Update live status file for external monitoring (status query)."""
    try:
        batch_num = os.environ.get("BATCH_NUMBER", "1")
        status_file = PROJECT_DIR / "cache" / "loop-status-live.json"
        
        status_data = {
            "batch_number": int(batch_num),
            "current_coin": term,
            "new_comps": new_comps,
            "duplicates": dups,
            "progress_pct": progress_pct,
            "status": status,
            "timestamp": datetime.now().isoformat()
        }
        
        with open(status_file, "w") as f:
            json.dump(status_data, f)
    except Exception:
        pass  # Silent fail, don't interrupt scraping
```

**Calls:** Made at each coin result (success, no-export, failed).

---

## Operational Usage

### During Loop Execution

Query anytime from another terminal:

```bash
bash scripts/loop-status.sh
```

**No downside:** Status queries don't interrupt the loop or consume eBay quota.

### Detecting Bot Blocks

When eBay serves a CAPTCHA challenge during startup, the preflight exits with `CHALLENGED`:

```
FINAL STATUS: CHALLENGED (exit code 2)
Remedy: ...Avoid further scrape attempts from this machine for a few hours.
```

**Action:** Stop. Wait 6-24 hours. Re-login with `--login` flag.

### Checking Batch Progression

After waiting your cooldown, verify batch increments:

```bash
# Start loop
bash run-surface-freshness-loop.sh --env-file ~/.env.surface --page1-batch 15 --deep-limit 2

# After ~6 minutes, in another terminal:
bash scripts/loop-status.sh
# Should show: Batch #: 1

# Wait another ~6 minutes:
bash scripts/loop-status.sh
# Should show: Batch #: 2
```

---

## State Files Location

All under `cache/` (`.gitignore`d, ephemeral):

| File | Scope | Retention |
|------|-------|-----------|
| `loop-run-state.json` | Batch counter, timing | Until script restart (>5 min window) |
| `loop-status-live.json` | Current coin, results | Until next coin completes (1-2 min per coin) |
| `terapeak-startup-state.json` | Startup preflight results | Preserved across loop cycles |
| `freshness-report.json` | Dataset triage | ~24h (regenerated each cycle) |

---

## Integration with Existing Systems

### Batch Number Exported

After `manage_batch_state()` runs, `$BATCH_NUMBER` is available to all downstream steps:

```bash
echo "batch #$BATCH_NUMBER"  # terapeak-export.py loop output
```

Shows in logs as: `batch #1`, `batch #2`, etc.

### CSV Cleanup on Upload Success

When `UPLOAD_MODE=api` (default), CSVs are deleted after successful `POST /api/terapeak/import`:

```python
if UPLOAD_MODE == "api":
    try:
        Path(dest).unlink(missing_ok=True)  # Delete CSV after upload
    except Exception:
        pass
```

This reduces disk clutter in `cache/` while keeping persistent `data/terapeak/*.csv` intact.

---

## Troubleshooting

### State File Not Created

**Symptom:** `Loop not started yet (no state file found)`

**Cause:** Script startup preflight failed (CAPTCHA, network, bad env).

**Fix:** Check `run-surface-freshness-loop.sh` log for `FINAL STATUS: CHALLENGED` or `EXPIRED`. Re-login if needed.

---

### Status File Out of Sync

**Symptom:** `loop-status.sh` shows old coin name.

**Cause:** Status file not updated (network lag, silent exception in `update_live_status()`).

**Fix:** Normal; updates happen after each coin. File age is shown in `timestamp` field.

---

### Batch Number Stuck

**Symptom:** Batch stays at #1 after many cycles.

**Cause:** Script restarted within 5-minute window of last batch start.

**Expected:** This is correct behavior (restart detection). Batch increments only after 5 minutes of real time.

---

## Future Enhancements

- [ ] Dashboard endpoint (`GET /api/admin/loop-status`) serving `loop-status-live.json`
- [ ] Alerting on bot detection (email on `CHALLENGED`)
- [ ] Session duration tracking (time since run_start_time)
- [ ] Per-coin performance metrics (avg comps/min, success rate)

---

## Related Documentation

- [Local Scraper Runbook](local-scraper-wsl2.md) — Daily operations
- [ARCHITECTURE.md](../ARCHITECTURE.md) — System design
- [BACKLOG.md](../BACKLOG.md) — Issue tracking
