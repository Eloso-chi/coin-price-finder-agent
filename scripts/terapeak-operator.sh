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
INCLUDE_THIN=false
FOCUS_REGEX=""
COIN_TYPE=""
EXTRA_ARGS=()

STATE_FILE="cache/terapeak-startup-state.json"
LOCK_FILE="cache/terapeak-operator.lock"
LOCK_PID_FILE="cache/terapeak-operator.lock.pid"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CURRENT_STAGE="init"
PYTHON_BIN=""

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
  --include-thin        Include thin-market queue entries
  --focus REGEX         Focus terms matching REGEX
  --coin-type NAME      Built-in alias focus (libertads, morgans, etc.)
  -h, --help            Show this help text

Examples:
  bash scripts/terapeak-operator.sh
  bash scripts/terapeak-operator.sh --no-login --loop --pause-between 600 --page1-batch 25
  bash scripts/terapeak-operator.sh --loop --skip-deep
EOF
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
      PAGE1_BATCH="$2"
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

if ! [[ "$PAUSE_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "pause-between must be a positive integer" >&2
  exit 1
fi

if ! [[ "$PAGE1_BATCH" =~ ^[0-9]+$ ]]; then
  echo "page1-batch must be a positive integer" >&2
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
  write_state "login" "ok" "Interactive login completed"
fi

CURRENT_STAGE="preflight-loop"
write_state "preflight-loop" "running" "Validating cookie health for loop"
bash scripts/terapeak-startup-preflight.sh --env-file "$ENV_FILE" --mode loop
write_state "preflight-loop" "ok" "Loop preflight passed"

while true; do
  CURRENT_STAGE="loop-pass"
  write_state "loop-pass" "running" "Starting pass ${PASS}"
  echo "== Terapeak operator pass ${PASS} =="

  LOOP_ARGS=(
    bash scripts/run-surface-freshness-loop.sh
    --env-file "$ENV_FILE"
    --skip-deep
    --skip-probe
    --page1-batch "$PAGE1_BATCH"
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

  if ! "${LOOP_ARGS[@]}"; then
    write_state "loop-pass" "failed" "Pass ${PASS} failed"
    echo "[operator] Pass ${PASS} failed; exiting." >&2
    exit 1
  fi

  write_state "loop-pass" "ok" "Pass ${PASS} completed"

  if [[ "$LOOP" != true ]]; then
    break
  fi

  echo "[operator] sleeping ${PAUSE_SECONDS}s before next pass"
  sleep "$PAUSE_SECONDS"
  PASS=$((PASS + 1))
done

CURRENT_STAGE="done"
write_state "done" "ok" "Operator run finished successfully" 0
echo "[operator] done"
