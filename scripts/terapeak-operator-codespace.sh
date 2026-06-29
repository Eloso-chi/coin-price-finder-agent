#!/usr/bin/env bash
# Terapeak operator -- Codespace (W-machine) flavor.
#
# Sibling of scripts/terapeak-operator.sh, which targets the local
# Surface/WSL (H-machine) runtime. This script is for running the Terapeak
# page-1 aggregation loop from a GitHub Codespace.
#
# Differences from the H-machine operator:
#   - No ~/.env.surface dependency. Trusts repo .env and process env.
#   - No /etc/os-release or Ubuntu version check (devcontainer is fixed).
#   - No project venv discovery -- uses system python3.
#   - No real Terapeak quota guard: there is no published Terapeak quota.
#     The in-app counter is a self-imposed politeness signal and is logged
#     each pass for visibility but does NOT stop the loop. Real stop
#     conditions are: pass exit non-zero, cookie health degrade
#     (cookie-health-check.py != HEALTHY), or max-passes reached (if set).
#
#   Default is to loop indefinitely; only --max-passes N installs a cap.
#
# Shared with H operator:
#   - Randomized per-pass batch size (default 15..30) for anti-detection.
#   - Jittered sleep between passes (+/- 90s on a 600s base).
#   - Single-instance lock via flock.
#   - Per-pass log directory + state JSON.
#
# Usage:
#   bash scripts/terapeak-operator-codespace.sh
#   bash scripts/terapeak-operator-codespace.sh --max-passes 8 --batch-min 20 --batch-max 35
#   bash scripts/terapeak-operator-codespace.sh --pause-between 480 --no-jitter
#   bash scripts/terapeak-operator-codespace.sh --include-thin
#
# Required process env:
#   ADMIN_API_KEY  (auto-loaded from repo .env if present)
#
# Optional process env:
#   APP_URL        (default: http://localhost:3000)
#   DISPLAY        (default: :1 -- the VNC display in this devcontainer)
#   COOKIE_FILE    (default: cache/ebay_cookies.json)

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ---- defaults ---------------------------------------------------------------
MAX_PASSES=0          # 0 = unlimited; loops until pass failure or cookie health degrade
BATCH_MIN=15
BATCH_MAX=30
PAUSE_BETWEEN=600
JITTER_SECONDS=90      # +/- this many seconds on the pause
USE_JITTER=true
INCLUDE_THIN=false
DRY_RUN=false
EXTRA_ARGS=()

# ---- runtime ----------------------------------------------------------------
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="cache/terapeak-operator-codespace-passes/${RUN_ID}"
MASTER_LOG="cache/terapeak-operator-codespace_${RUN_ID}.log"
STATE_FILE="cache/terapeak-operator-codespace.state.json"
LOCK_FILE="cache/terapeak-operator-codespace.lock"

usage() {
  cat <<'EOF'
Usage: bash scripts/terapeak-operator-codespace.sh [options]

Options:
  --max-passes N        Optional cap on number of passes (default: 0 = unlimited)
  --batch-min N         Minimum randomized page-1 batch size (default: 15)
  --batch-max N         Maximum randomized page-1 batch size (default: 30)
  --pause-between SEC   Base pause between passes in seconds (default: 600)
  --no-jitter           Disable +/- jitter on pause (default: jitter enabled)
  --jitter-seconds N    Jitter window in seconds; pause is base +/- this (default: 90)
  --include-thin        Include P3 thin-market queue entries
  --dry-run             Show what would run, do not execute passes
  -h, --help            Show this help text

Stop conditions:
  - Pass exits non-zero (session/captcha/server failure)
  - cookie-health-check.py returns anything other than 0 (HEALTHY)
  - --max-passes reached (only if user set it; 0 = unlimited)
EOF
}

# ---- arg parsing ------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-passes)      MAX_PASSES="$2"; shift 2 ;;
    --batch-min)       BATCH_MIN="$2"; shift 2 ;;
    --batch-max)       BATCH_MAX="$2"; shift 2 ;;
    --pause-between)   PAUSE_BETWEEN="$2"; shift 2 ;;
    --jitter-seconds)  JITTER_SECONDS="$2"; shift 2 ;;
    --no-jitter)       USE_JITTER=false; shift ;;
    --include-thin)    INCLUDE_THIN=true; shift ;;
    --dry-run)         DRY_RUN=true; shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 EXTRA_ARGS+=("$1"); shift ;;
  esac
done

if (( BATCH_MIN > BATCH_MAX )); then
  echo "[operator-cs:FAIL] --batch-min ($BATCH_MIN) > --batch-max ($BATCH_MAX)" >&2
  exit 2
fi

mkdir -p "$RUN_DIR" cache

# ---- logging helpers --------------------------------------------------------
log() {
  local line
  line="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
  echo "$line" | tee -a "$MASTER_LOG"
}

fail() {
  log "FAIL: $*"
  write_state "stopped" "fail" "$*"
  exit 1
}

write_state() {
  local stage="$1"
  local status="$2"
  local message="$3"
  cat > "$STATE_FILE" <<JSON
{
  "run_id": "${RUN_ID}",
  "stage": "${stage}",
  "status": "${status}",
  "message": "${message//\"/\\\"}",
  "pass": ${PASS_NUM:-0},
  "max_passes": ${MAX_PASSES},
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
}

# ---- jitter helpers ---------------------------------------------------------
pick_batch_size() {
  if (( BATCH_MIN == BATCH_MAX )); then
    printf '%d' "$BATCH_MIN"
    return
  fi
  if command -v shuf >/dev/null 2>&1; then
    shuf -i "${BATCH_MIN}-${BATCH_MAX}" -n 1
  else
    local span=$((BATCH_MAX - BATCH_MIN + 1))
    printf '%d' $((BATCH_MIN + RANDOM % span))
  fi
}

pick_pause() {
  if [[ "$USE_JITTER" != "true" ]]; then
    printf '%d' "$PAUSE_BETWEEN"
    return
  fi
  local window=$((JITTER_SECONDS * 2 + 1))   # e.g. 181 for +/- 90
  local offset=$((RANDOM % window - JITTER_SECONDS))
  local pause=$((PAUSE_BETWEEN + offset))
  if (( pause < 30 )); then pause=30; fi
  printf '%d' "$pause"
}

# ---- quota probe (informational only) ---------------------------------------
log_quota() {
  local app_url="${APP_URL:-http://localhost:3000}"
  local key="${ADMIN_API_KEY:-}"
  if [[ -z "$key" ]]; then
    log "quota: skipped (ADMIN_API_KEY not set in env)"
    return
  fi
  local body
  body="$(curl -fsS -m 5 "${app_url}/api/terapeak/quota" -H "x-api-key: $key" 2>/dev/null)" || {
    log "quota: probe failed (server down or auth bad) -- continuing anyway"
    return
  }
  local used remaining limit
  used="$(echo "$body" | grep -oE '"used":[0-9]+' | head -1 | grep -oE '[0-9]+')"
  remaining="$(echo "$body" | grep -oE '"remaining":[0-9]+' | head -1 | grep -oE '[0-9]+')"
  limit="$(echo "$body" | grep -oE '"limit":[0-9]+' | head -1 | grep -oE '[0-9]+')"
  log "quota (informational, not enforced): used=${used:-?} remaining=${remaining:-?} limit=${limit:-?}"
}

# ---- preflight --------------------------------------------------------------
preflight_runtime() {
  command -v python3 >/dev/null 2>&1 || fail "python3 not found on PATH"
  command -v node >/dev/null 2>&1   || fail "node not found on PATH"
  command -v curl >/dev/null 2>&1   || fail "curl not found on PATH"
  command -v flock >/dev/null 2>&1  || fail "flock not found (install util-linux)"
  python3 -c 'import playwright, requests' >/dev/null 2>&1 \
    || fail "Python packages missing (playwright, requests)"
  log "runtime ok: python3=$(command -v python3) node=$(command -v node)"
}

preflight_env() {
  # Auto-load repo .env if ADMIN_API_KEY not already set
  if [[ -z "${ADMIN_API_KEY:-}" && -f "$PROJECT_DIR/.env" ]]; then
    # shellcheck disable=SC1091
    set -a; source "$PROJECT_DIR/.env"; set +a
    log "loaded env from .env"
  fi
  [[ -n "${ADMIN_API_KEY:-}" ]] || fail "ADMIN_API_KEY not set (after attempting to source .env)"
  export APP_URL="${APP_URL:-http://localhost:3000}"
  export DISPLAY="${DISPLAY:-:1}"
  export COOKIE_FILE="${COOKIE_FILE:-cache/ebay_cookies.json}"
  log "env ok: APP_URL=$APP_URL DISPLAY=$DISPLAY COOKIE_FILE=$COOKIE_FILE"
}

preflight_server() {
  local app_url="${APP_URL:-http://localhost:3000}"
  if ! curl -fsS -m 5 "${app_url}/api/health" >/dev/null 2>&1; then
    fail "server health check failed at ${app_url}/api/health"
  fi
  log "server ok: ${app_url}/api/health"
}

preflight_cookies() {
  # Returns: 0 HEALTHY, 1 EXPIRED, 2 CHALLENGED, 3 MISSING, 4 PROBE_FAILED
  local rc=0
  python3 scripts/cookie-health-check.py >> "$MASTER_LOG" 2>&1 || rc=$?
  case "$rc" in
    0) log "cookies ok: HEALTHY"; return 0 ;;
    1) fail "cookies EXPIRED -- run scripts/vnc-login.py to refresh" ;;
    2) fail "cookies CHALLENGED (Akamai/captcha) -- run scripts/vnc-login.py and solve" ;;
    3) fail "cookies MISSING at $COOKIE_FILE -- run scripts/vnc-login.py" ;;
    4) log "cookie probe INDETERMINATE (exit 4) -- continuing with caution"; return 0 ;;
    *) fail "cookie-health-check.py unexpected exit $rc" ;;
  esac
}

# ---- single-instance lock ---------------------------------------------------
# Lock correctness lives in flock on FD 9 (kernel releases on process death).
# The .pid sidecar is informational only -- a stale .pid can be left behind by
# SIGKILL, so on conflict we use kill -0 to confirm the holder is alive before
# blaming it. See PR #200 review finding #3.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  conflict_msg="[operator-cs:FAIL] another instance is already running (lock: $LOCK_FILE)"
  if [[ -f "$LOCK_FILE.pid" ]]; then
    other_pid="$(cat "$LOCK_FILE.pid" 2>/dev/null || true)"
    if [[ -n "$other_pid" ]] && kill -0 "$other_pid" 2>/dev/null; then
      conflict_msg="$conflict_msg [pid=$other_pid alive]"
    elif [[ -n "$other_pid" ]]; then
      conflict_msg="$conflict_msg [pid=$other_pid stale -- but flock still held; try again]"
    fi
  fi
  echo "$conflict_msg" >&2
  exit 3
fi
trap 'flock -u 9 2>/dev/null || true; rm -f "$LOCK_FILE.pid" 2>/dev/null || true' EXIT
# Overwrite any stale .pid from a prior SIGKILL'd run (flock acquisition above
# proves no live holder).
echo "$$" > "$LOCK_FILE.pid"

# ---- main -------------------------------------------------------------------
PASS_NUM=0
TOTAL_OK=0
TOTAL_FAIL=0
TOTAL_NEW_ROWS=0

log "=== terapeak-operator-codespace started ==="
log "RUN_ID=$RUN_ID max_passes=${MAX_PASSES:-0}(0=unlimited) batch=${BATCH_MIN}..${BATCH_MAX} pause=${PAUSE_BETWEEN}s jitter=${USE_JITTER}(+/-${JITTER_SECONDS}s) include_thin=${INCLUDE_THIN}"
write_state "starting" "running" "Operator initialized"

preflight_runtime
preflight_env
preflight_server
preflight_cookies

if [[ "$DRY_RUN" == "true" ]]; then
  log "DRY RUN: preflights passed, would execute up to ${MAX_PASSES:-unlimited} passes"
  log_quota
  write_state "dry-run" "ok" "Dry run complete"
  exit 0
fi

while (( MAX_PASSES == 0 || PASS_NUM < MAX_PASSES )); do
  PASS_NUM=$((PASS_NUM + 1))
  PASS_LOG="${RUN_DIR}/pass-$(printf '%04d' "$PASS_NUM").log"
  BATCH_SIZE="$(pick_batch_size)"
  PASS_START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  log ""
  log "--- pass ${PASS_NUM}$( ((MAX_PASSES>0)) && echo " / ${MAX_PASSES}" ) (batch=${BATCH_SIZE}) ---"
  write_state "pass-${PASS_NUM}" "running" "pass ${PASS_NUM} batch=${BATCH_SIZE}"
  log_quota

  # Pre-pass cookie re-check (cheap; catches mid-loop session decay)
  if (( PASS_NUM > 1 )); then
    preflight_cookies
  fi

  # Regenerate freshness report each pass (fresh queue ordering)
  log "regenerating freshness report..."
  if ! node scripts/generate-freshness-report.js >> "$MASTER_LOG" 2>&1; then
    fail "freshness report generation failed"
  fi

  # Build pass args
  PASS_ARGS=(
    scripts/terapeak-export.py --run
    --backlog cache/freshness-report.json
    --limit "$BATCH_SIZE"
  )
  if [[ "$INCLUDE_THIN" == "true" ]]; then
    PASS_ARGS+=(--include-thin)
  fi
  if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
    PASS_ARGS+=("${EXTRA_ARGS[@]}")
  fi

  log "executing -> $PASS_LOG"
  log "  cmd: DISPLAY=$DISPLAY python3 ${PASS_ARGS[*]}"

  PASS_EXIT_RC=0
  DISPLAY="$DISPLAY" python3 "${PASS_ARGS[@]}" > "$PASS_LOG" 2>&1 || PASS_EXIT_RC=$?
  PASS_END_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Always emit structured records, even on failure -- helps post-mortem
  python3 scripts/_parse-terapeak-pass.py \
    --pass-log "$PASS_LOG" \
    --run-id "$RUN_ID" \
    --pass-num "$PASS_NUM" \
    --batch-size "$BATCH_SIZE" \
    --start-ts "$PASS_START_TS" \
    --end-ts   "$PASS_END_TS" \
    --machine "${MACHINE_ID:-W}" \
    --include-thin "$INCLUDE_THIN" \
    >> "$MASTER_LOG" 2>&1 || log "WARN: pass parser failed (non-fatal)"

  if (( PASS_EXIT_RC != 0 )); then
    log "pass ${PASS_NUM} FAILED (exit=$PASS_EXIT_RC); tail of $PASS_LOG:"
    tail -25 "$PASS_LOG" | tee -a "$MASTER_LOG"
    write_state "pass-${PASS_NUM}" "fail" "pass exit $PASS_EXIT_RC"
    fail "stopping loop on pass failure"
  fi

  # Per-pass summary (read structured record we just wrote, falls back to log scrape)
  STATS="$(python3 -c "
import json, sys
try:
    with open('cache/terapeak-runs/passes.jsonl') as f:
        last = list(f)[-1]
    r = json.loads(last)
    print(r['succeeded'], r['failed'], r['empty'], r['new_rows'], r['dup_rows'])
except Exception:
    print('0 0 0 0 0')
" 2>/dev/null)"
  read -r OK_NUM FAIL_NUM EMPTY_NUM NEW_ROWS DUP_ROWS <<< "${STATS:-0 0 0 0 0}"
  OK_NUM="${OK_NUM:-0}"; FAIL_NUM="${FAIL_NUM:-0}"
  EMPTY_NUM="${EMPTY_NUM:-0}"; NEW_ROWS="${NEW_ROWS:-0}"; DUP_ROWS="${DUP_ROWS:-0}"
  TOTAL_OK=$((TOTAL_OK + OK_NUM))
  TOTAL_FAIL=$((TOTAL_FAIL + FAIL_NUM))
  TOTAL_NEW_ROWS=$((TOTAL_NEW_ROWS + NEW_ROWS))
  log "pass ${PASS_NUM} complete: succeeded=${OK_NUM} empty=${EMPTY_NUM} failed=${FAIL_NUM} new_rows=${NEW_ROWS} dup_rows=${DUP_ROWS}"
  write_state "pass-${PASS_NUM}" "ok" "succeeded=${OK_NUM} empty=${EMPTY_NUM} failed=${FAIL_NUM} new_rows=${NEW_ROWS} dup_rows=${DUP_ROWS}"

  if (( MAX_PASSES == 0 || PASS_NUM < MAX_PASSES )); then
    PAUSE="$(pick_pause)"
    log "sleeping ${PAUSE}s before next pass (base=${PAUSE_BETWEEN} jitter=${USE_JITTER})"
    sleep "$PAUSE"
  fi
done

log ""
log "=== terapeak-operator-codespace finished ==="
log "passes_run=${PASS_NUM} total_succeeded=${TOTAL_OK} total_failed=${TOTAL_FAIL} total_new_rows=${TOTAL_NEW_ROWS}"
log "master log: $MASTER_LOG"
log "per-pass logs: $RUN_DIR/"
write_state "finished" "ok" "passes=${PASS_NUM} succeeded=${TOTAL_OK} failed=${TOTAL_FAIL} new_rows=${TOTAL_NEW_ROWS}"
