#!/usr/bin/env bash
# Canonical startup launcher for Terapeak local aggregation workflow.
#
# Sequence is strict by design:
# 1) Preflight (runtime + env sanity)
# 2) Optional interactive login
# 3) Loop preflight (requires healthy cookie state)
# 4) Freshness loop pass (skip deep by request)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

ENV_FILE="$HOME/.env.surface"
DO_LOGIN=true
LOOP=false
PAUSE_SECONDS=600
PAGE1_BATCH=15
BATCH_MIN=30
BATCH_MAX=35
USER_PASSED_PAGE1_BATCH=0
INCLUDE_THIN=false
FOCUS_REGEX=""
COIN_TYPE=""
P01_FIXED=15
EXTRA_ARGS=()

STATE_FILE="cache/terapeak-startup-state.json"
LOCK_FILE="cache/terapeak-operator.lock"
LOCK_PID_FILE="cache/terapeak-operator.lock.pid"
RUN_LOG_FILE=""
HISTORY_LOG_FILE="cache/terapeak-operator-history.log"
LATEST_RUN_FILE="cache/terapeak-operator-latest-run.txt"
LATEST_PASS_DIR_FILE="cache/terapeak-operator-latest-pass-dir.txt"
PASS_LOG_ROOT_DIR="cache/terapeak-operator-passes"
PASS_LOG_DIR=""
RISK_STATE_FILE="cache/terapeak-risk-state-H.json"
RISK_STATE_ENABLED="${TERAPEAK_RISK_STATE_ENABLED:-1}"
ELEVATED_BATCH_MIN="${TERAPEAK_ELEVATED_BATCH_MIN:-15}"
ELEVATED_BATCH_MAX="${TERAPEAK_ELEVATED_BATCH_MAX:-20}"
ELEVATED_PAUSE_SECONDS="${TERAPEAK_ELEVATED_PAUSE_SECONDS:-900}"
COOLDOWN_SECONDS="${TERAPEAK_COOLDOWN_SECONDS:-7200}"
export TERAPEAK_RISK_STATE_ENABLED="$RISK_STATE_ENABLED"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CURRENT_STAGE="init"
PYTHON_BIN=""

PASS_LOG_DIR="${PASS_LOG_ROOT_DIR}/${RUN_ID}"

LOCK_FD=0

usage() {
  cat <<'EOF'
Usage: bash scripts/terapeak-operator.sh [options]

Options:
  --env-file FILE       Source env vars from FILE (default: ~/.env.surface)
  --no-login            Skip interactive login and reuse existing cookie jar
  --loop                Keep running passes until one fails
  --pause-between SEC   Sleep between loop passes (default: 600)
  --page1-batch N       Page-1 batch size (default: 15)
  --batch-min N         Min randomized TOTAL page-1 picks per pass (default: 30)
  --batch-max N         Max randomized TOTAL page-1 picks per pass (default: 35)
  --include-thin        Include thin-market queue entries
  --focus REGEX         Focus terms matching REGEX
  --coin-type NAME      Built-in alias focus (libertads, morgans, etc.)
  -h, --help            Show this help text

Examples:
  bash scripts/terapeak-operator.sh
  bash scripts/terapeak-operator.sh --no-login --loop --pause-between 600 --page1-batch 25
  bash scripts/terapeak-operator.sh --loop --batch-min 30 --batch-max 35
  bash scripts/terapeak-operator.sh --loop --skip-deep
EOF
}

pick_batch_size() {
  local lo="$1"
  local hi="$2"

  if (( lo == hi )); then
    printf '%d' "$lo"
    return
  fi

  if command -v shuf >/dev/null 2>&1; then
    shuf -i "${lo}-${hi}" -n 1
  else
    local span=$((hi - lo + 1))
    printf '%d' $((lo + RANDOM % span))
  fi
}

resolve_python_bin() {
  # Prefer active venv, then known project venvs, then system python3.
  if [[ -n "${VIRTUAL_ENV:-}" ]] && [[ -x "$VIRTUAL_ENV/bin/python" ]]; then
    PYTHON_BIN="$VIRTUAL_ENV/bin/python"
    return
  fi

  local candidates=(
    "$PROJECT_DIR/.venv-u24b/bin/python"
    "$PROJECT_DIR/.venv-u24/bin/python"
    "$PROJECT_DIR/.venv/bin/python"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      PYTHON_BIN="$candidate"
      return
    fi
  done

  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
    return
  fi

  echo "[operator] python3 not found and no project venv detected" >&2
  exit 1
}

write_state() {
  local stage="$1"
  local status="$2"
  local message="$3"
  local exit_code="${4:-0}"
  mkdir -p cache
  "$PYTHON_BIN" - "$STATE_FILE" "$stage" "$status" "$message" "$RUN_ID" "$STARTED_AT" "$exit_code" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path, stage, status, message, run_id, started_at, exit_code = sys.argv[1:8]
state = {}
if os.path.exists(path):
    try:
        with open(path, encoding='utf-8') as fh:
            state = json.load(fh)
    except Exception:
        state = {}

state.update({
    "runId": run_id,
    "startedAt": started_at,
    "updatedAt": datetime.now(timezone.utc).isoformat(),
    "stage": stage,
    "status": status,
    "message": message,
    "pid": os.getpid(),
    "exitCode": int(exit_code),
})

if status in ("ok", "failed"):
    state["endedAt"] = datetime.now(timezone.utc).isoformat()

tmp = f"{path}.tmp"
with open(tmp, 'w', encoding='utf-8') as fh:
    json.dump(state, fh, indent=2, sort_keys=True)
os.replace(tmp, path)
PY
}

cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    write_state "$CURRENT_STAGE" "failed" "Operator failed in stage: $CURRENT_STAGE" "$rc" || true
  fi
  if [[ -f "$LOCK_PID_FILE" ]] && [[ "$(cat "$LOCK_PID_FILE" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$LOCK_PID_FILE"
  fi
  exit $rc
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --no-login)
      DO_LOGIN=false
      shift
      ;;
    --loop)
      LOOP=true
      shift
      ;;
    --pause-between)
      PAUSE_SECONDS="$2"
      shift 2
      ;;
    --page1-batch)
      USER_PASSED_PAGE1_BATCH=1
      PAGE1_BATCH="$2"
      shift 2
      ;;
    --batch-min)
      BATCH_MIN="$2"
      shift 2
      ;;
    --batch-max)
      BATCH_MAX="$2"
      shift 2
      ;;
    --include-thin)
      INCLUDE_THIN=true
      shift
      ;;
    --focus)
      FOCUS_REGEX="$2"
      shift 2
      ;;
    --coin-type)
      COIN_TYPE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

resolve_python_bin

mkdir -p cache
mkdir -p "$PASS_LOG_DIR"

RUN_LOG_FILE="cache/terapeak-operator-${RUN_ID}.log"
# Mirror all operator output to run-level and rolling history logs.
exec > >(tee -a "$RUN_LOG_FILE" "$HISTORY_LOG_FILE") 2>&1
printf '%s\n' "$RUN_LOG_FILE" > "$LATEST_RUN_FILE"
printf '%s\n' "$PASS_LOG_DIR" > "$LATEST_PASS_DIR_FILE"
echo "[operator] run log: $RUN_LOG_FILE"
echo "[operator] history log: $HISTORY_LOG_FILE"
echo "[operator] latest run pointer: $LATEST_RUN_FILE"
echo "[operator] latest pass-dir pointer: $LATEST_PASS_DIR_FILE"
# Validate flock before attempting lock
command -v flock >/dev/null 2>&1 || {
  echo "[operator] flock command not found (required for single-instance lock)." >&2
  echo "[operator] Install util-linux package and try again." >&2
  exit 1
}

# Set default UPLOAD_MODE (api for immediate ingestion per runbook-recommended local profile)
: "${UPLOAD_MODE:=api}"
export UPLOAD_MODE

if [[ "$UPLOAD_MODE" != "api" ]]; then
  echo "[operator:INFO] UPLOAD_MODE=$UPLOAD_MODE (inherited from environment)." >&2
fi

exec {LOCK_FD}>"$LOCK_FILE"
if ! flock -n "$LOCK_FD"; then
  holder="$(cat "$LOCK_PID_FILE" 2>/dev/null || echo "unknown")"
  echo "[operator] Another Terapeak operator run is active (pid=$holder). Exiting." >&2
  exit 1
fi
echo "$$" > "$LOCK_PID_FILE"

trap cleanup EXIT

CURRENT_RISK_STATE="$($PYTHON_BIN scripts/_terapeak_risk.py current --state-file "$RISK_STATE_FILE")"
if [[ "$CURRENT_RISK_STATE" == "Cooldown" ]]; then
  CURRENT_STAGE="cooldown-gate"
  if cooldown_remaining="$($PYTHON_BIN scripts/_terapeak_risk.py cooldown-ready \
    --state-file "$RISK_STATE_FILE" \
    --minimum-seconds "$COOLDOWN_SECONDS")"; then
    :
  else
    echo "[operator:risk] Cooldown is active for another ${cooldown_remaining}s; stopping before browser launch." >&2
    exit 1
  fi
  if [[ "$DO_LOGIN" != true ]]; then
    echo "[operator:risk] Cooldown elapsed, but restart requires interactive login (remove --no-login)." >&2
    exit 1
  fi
fi

if ! [[ "$PAUSE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "pause-between must be a positive integer" >&2
  exit 1
fi

if ! [[ "$PAGE1_BATCH" =~ ^[0-9]+$ ]]; then
  echo "page1-batch must be a positive integer" >&2
  exit 1
fi

if ! [[ "$BATCH_MIN" =~ ^[0-9]+$ ]] || ! [[ "$BATCH_MAX" =~ ^[0-9]+$ ]]; then
  echo "batch-min and batch-max must be positive integers" >&2
  exit 1
fi

if (( BATCH_MIN < 1 )) || (( BATCH_MAX < BATCH_MIN )); then
  echo "require 1 <= batch-min <= batch-max" >&2
  exit 1
fi

PASS=1

CURRENT_STAGE="preflight-login"
write_state "preflight-login" "running" "Checking startup prerequisites"
bash scripts/terapeak-startup-preflight.sh --env-file "$ENV_FILE" --mode login
write_state "preflight-login" "ok" "Startup prerequisites satisfied"

if [[ "$DO_LOGIN" == true ]]; then
  CURRENT_STAGE="login"
  write_state "login" "running" "Starting interactive eBay login"
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  "$PYTHON_BIN" scripts/terapeak-export.py --login
  if [[ "$CURRENT_RISK_STATE" == "Cooldown" ]]; then
    if ! "$PYTHON_BIN" scripts/cookie-health-check.py --probe; then
      write_state "cooldown-gate" "failed" "Post-login Cooldown health probe failed" 1
      exit 1
    fi
    CURRENT_RISK_STATE="$($PYTHON_BIN scripts/_terapeak_risk.py reset --state-file "$RISK_STATE_FILE" --run-id "$RUN_ID" --reason "cooldown_elapsed_relogin_and_probe_passed")"
  fi
  write_state "login" "ok" "Interactive login completed"
fi

CURRENT_STAGE="preflight-loop"
write_state "preflight-loop" "running" "Validating cookie health for loop"
PREFLIGHT_LOOP_RC=0
bash scripts/terapeak-startup-preflight.sh --env-file "$ENV_FILE" --mode loop || PREFLIGHT_LOOP_RC=$?
if (( PREFLIGHT_LOOP_RC == 2 )); then
  "$PYTHON_BIN" scripts/_terapeak_risk.py challenge \
    --state-file "$RISK_STATE_FILE" \
    --run-id "$RUN_ID" \
    --reason cookie_health_challenged
  write_state "preflight-loop" "failed" "Cookie health CHALLENGED; Cooldown persisted" 2
  exit 2
elif (( PREFLIGHT_LOOP_RC != 0 )); then
  exit "$PREFLIGHT_LOOP_RC"
fi
write_state "preflight-loop" "ok" "Loop preflight passed"

while true; do
  state_before="$CURRENT_RISK_STATE"
  pass_batch_min="$BATCH_MIN"
  pass_batch_max="$BATCH_MAX"
  if [[ "$RISK_STATE_ENABLED" != "0" && "$state_before" == "Elevated" ]]; then
    pass_batch_min="$ELEVATED_BATCH_MIN"
    pass_batch_max="$ELEVATED_BATCH_MAX"
    echo "[operator:risk] Elevated pacing: batch=${pass_batch_min}..${pass_batch_max}, pause=${ELEVATED_PAUSE_SECONDS}s"
  fi
  pass_page1_batch="$PAGE1_BATCH"
  if [[ "$USER_PASSED_PAGE1_BATCH" != "1" ]]; then
    pass_page1_batch="$(pick_batch_size "$pass_batch_min" "$pass_batch_max")"
    echo "[operator] Pass ${PASS} randomized total page-1 picks=${pass_page1_batch} (range ${pass_batch_min}..${pass_batch_max})"
  elif [[ "$RISK_STATE_ENABLED" != "0" && "$state_before" == "Elevated" ]]; then
    if (( pass_page1_batch < ELEVATED_BATCH_MIN )); then
      pass_page1_batch="$ELEVATED_BATCH_MIN"
    elif (( pass_page1_batch > ELEVATED_BATCH_MAX )); then
      pass_page1_batch="$ELEVATED_BATCH_MAX"
    fi
    echo "[operator] Pass ${PASS} fixed page-1 picks clamped to Elevated range: ${pass_page1_batch}"
  else
    echo "[operator] Pass ${PASS} fixed total page-1 picks=${pass_page1_batch} (user-specified)"
  fi
  pass_extra=$((pass_page1_batch - P01_FIXED))
  if (( pass_extra < 0 )); then
    pass_extra=0
  fi
  echo "[operator] Pass ${PASS} blended queue: P0.1 fixed=${P01_FIXED}, non-P0.1 extra=${pass_extra} (total target=${pass_page1_batch})"

  CURRENT_STAGE="loop-pass"
  write_state "loop-pass" "running" "Starting pass ${PASS}"
  echo "== Terapeak operator pass ${PASS} =="
  PASS_LOG_FILE="${PASS_LOG_DIR}/pass-$(printf '%04d' "$PASS").log"
  : > "$PASS_LOG_FILE"
  echo "[operator] pass log: $PASS_LOG_FILE"
  PASS_START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  LOOP_ARGS=(
    bash scripts/run-surface-freshness-loop.sh
    --env-file "$ENV_FILE"
    --skip-deep
    --skip-probe
    --mixed-page1
    --mixed-p01-fixed "$P01_FIXED"
    --mixed-extra-min "$pass_extra"
    --mixed-extra-max "$pass_extra"
  )
  if [[ "$INCLUDE_THIN" == true ]]; then
    LOOP_ARGS+=(--include-thin)
  fi
  if [[ -n "$FOCUS_REGEX" ]]; then
    LOOP_ARGS+=(--focus "$FOCUS_REGEX")
  fi
  if [[ -n "$COIN_TYPE" ]]; then
    LOOP_ARGS+=(--coin-type "$COIN_TYPE")
  fi
  if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
    LOOP_ARGS+=("${EXTRA_ARGS[@]}")
  fi

  PASS_EXIT_RC=0
  "${LOOP_ARGS[@]}" 2>&1 | tee -a "$PASS_LOG_FILE" || PASS_EXIT_RC=$?
  PASS_END_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  TRANSITION_FILE="${PASS_LOG_FILE}.risk.tsv"
  SUMMARY_FILE="${PASS_LOG_FILE}.summary.json"

  if ! "$PYTHON_BIN" scripts/_parse-terapeak-pass.py \
    --pass-log "$PASS_LOG_FILE" \
    --run-id "$RUN_ID" \
    --pass-num "$PASS" \
    --batch-size "$pass_page1_batch" \
    --start-ts "$PASS_START_TS" \
    --end-ts "$PASS_END_TS" \
    --machine H \
    --operator terapeak-operator \
    --pass-exit-code "$PASS_EXIT_RC" \
    --cookie-health-status HEALTHY \
    --probe-status SKIPPED \
    --state-file "$RISK_STATE_FILE" \
    --stateful "$RISK_STATE_ENABLED" \
    --transition-output "$TRANSITION_FILE" \
    --summary-output "$SUMMARY_FILE"; then
    write_state "loop-pass" "failed" "Pass telemetry write failed" 1
    echo "[operator] Pass telemetry write failed; stopping to preserve the observability contract." >&2
    exit 1
  fi
  IFS=$'\t' read -r state_before state_after transition_reason challenge_signal_count soft_risk_signal_count < "$TRANSITION_FILE"
  rm -f "$TRANSITION_FILE"
  CURRENT_RISK_STATE="$state_after"
  if [[ "$transition_reason" == "none" ]]; then
    transition_reason=""
  fi

  if (( challenge_signal_count > 0 )); then
    write_state "loop-pass" "failed" "Hard challenge detected; risk state is Cooldown" 1
    echo "[operator:risk] Hard challenge detected; stopping now in Cooldown. Do not retry until the probe and re-login gate passes." >&2
    exit 1
  fi

  if (( PASS_EXIT_RC != 0 )); then
    write_state "loop-pass" "failed" "Pass ${PASS} failed"
    echo "[operator] Pass ${PASS} failed; exiting." >&2
    exit 1
  fi

  write_state "loop-pass" "ok" "Pass ${PASS} completed"

  # Print progress metrics after each pass and persist them into pass log.
  bash scripts/operator-monitor.sh "$PROJECT_DIR" "$PASS" "$PASS_LOG_FILE" "$SUMMARY_FILE" | tee -a "$PASS_LOG_FILE"
  rm -f "$SUMMARY_FILE"

  if [[ "$LOOP" != true ]]; then
    break
  fi

  pass_pause_seconds="$PAUSE_SECONDS"
  if [[ "$RISK_STATE_ENABLED" != "0" && "$CURRENT_RISK_STATE" == "Elevated" ]]; then
    pass_pause_seconds="$ELEVATED_PAUSE_SECONDS"
  fi
  echo "[operator] sleeping ${pass_pause_seconds}s before next pass"
  sleep "$pass_pause_seconds"
  PASS=$((PASS + 1))
done

CURRENT_STAGE="done"
write_state "done" "ok" "Operator run finished successfully" 0
echo "[operator] done"
