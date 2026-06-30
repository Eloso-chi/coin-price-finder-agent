#!/usr/bin/env bash
# Codespace keep-alive
# ====================
# Prevents the Codespace from hitting its idle-stop timeout (default 30 min)
# during long unattended sessions: nightly prefetch monitoring, scraper passes
# left running while you step away, etc.
#
# Mechanism
# ---------
# Every INTERVAL seconds (default 300 = 5 min):
#   1. Appends "keepalive <ISO timestamp>" to the log
#   2. Curls http://localhost:3000/api/health (if the server is up) and logs
#      the HTTP status -- this is the actual activity signal that's most
#      likely to register with the orchestrator. The file-write alone may not.
#
# A heartbeat alone is NOT guaranteed to keep Codespaces alive -- GitHub's
# idle detector watches port-forwarding traffic and VS Code/SSH client
# connections, not container-internal disk I/O. The curl is the durable part;
# the file-write is for human-readable progress in the log.
#
# Limitations
# -----------
# - Dies when the Codespace is hard-stopped (not just disconnected).
# - The strongest keep-alive is keeping the VS Code window open. This script
#   is a backup for "I'm away from the laptop but a job is running."
# - The PID file is informational; on Codespace restart the process is gone
#   regardless of what the PID file says, so the script self-cleans stale PIDs.
#
# Usage
# -----
#   # Launch in background (preferred):
#   nohup bash scripts/codespace-keepalive.sh > /dev/null 2>&1 &
#
#   # Or short-form via this script's own launcher block at the bottom:
#   bash scripts/codespace-keepalive.sh --launch
#
#   # Check status:
#   bash scripts/codespace-keepalive.sh --status
#
#   # Stop:
#   bash scripts/codespace-keepalive.sh --stop
#
# Configuration (env vars)
# ------------------------
#   KEEPALIVE_INTERVAL_SEC   default 300 (5 min)
#   KEEPALIVE_HEALTH_URL     default http://localhost:3000/api/health
#   KEEPALIVE_LOG            default cache/keepalive/keepalive.log
#   KEEPALIVE_PID_FILE       default cache/keepalive/keepalive.pid

set -u

INTERVAL_SEC="${KEEPALIVE_INTERVAL_SEC:-300}"
HEALTH_URL="${KEEPALIVE_HEALTH_URL:-http://localhost:3000/api/health}"
LOG_FILE="${KEEPALIVE_LOG:-cache/keepalive/keepalive.log}"
PID_FILE="${KEEPALIVE_PID_FILE:-cache/keepalive/keepalive.pid}"

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

log_line() {
  # Append, never overwrite. Tolerate read-only log dir by silently dropping.
  printf '%s\n' "$1" >> "$LOG_FILE" 2>/dev/null || true
}

write_pid() {
  mkdir -p "$(dirname "$PID_FILE")" 2>/dev/null || true
  printf '%s\n' "$$" > "$PID_FILE"
}

is_pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

cmd_status() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "keepalive: not running (no PID file)"
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  if is_pid_alive "$pid"; then
    echo "keepalive: RUNNING pid=$pid interval=${INTERVAL_SEC}s log=$LOG_FILE"
    echo "  last 3 log lines:"
    tail -3 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
    return 0
  fi
  echo "keepalive: stale PID file (pid=$pid not running)"
  return 2
}

cmd_stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "keepalive: nothing to stop (no PID file)"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)"
  if is_pid_alive "$pid"; then
    kill "$pid" 2>/dev/null && echo "keepalive: stopped pid=$pid"
  else
    echo "keepalive: pid=$pid was not running (stale)"
  fi
  rm -f "$PID_FILE"
}

cmd_launch() {
  # Refuse to start a second instance.
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null)"
    if is_pid_alive "$pid"; then
      echo "keepalive: already running pid=$pid -- not launching another"
      return 1
    fi
    rm -f "$PID_FILE"
  fi
  # Self-relaunch under nohup, detach from this shell.
  nohup bash "$0" --run > /dev/null 2>&1 &
  local newpid="$!"
  # Give the child a moment to write its own PID file.
  sleep 0.5
  echo "keepalive: launched pid=$newpid log=$LOG_FILE interval=${INTERVAL_SEC}s"
}

cmd_run() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  write_pid
  log_line "keepalive START $(now_utc) pid=$$ interval=${INTERVAL_SEC}s url=$HEALTH_URL"

  trap 'log_line "keepalive STOP $(now_utc) pid=$$"; rm -f "$PID_FILE"; exit 0' INT TERM

  while true; do
    local ts http_code
    ts="$(now_utc)"
    # 2s connect timeout, 3s total -- localhost should respond instantly.
    # curl writes 000 to its %{http_code} format string on connection failure
    # AND returns nonzero, so we suppress the nonzero with || true rather than
    # appending another 000 via echo.
    http_code="$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
    [[ -z "$http_code" ]] && http_code='000'
    log_line "keepalive $ts http=$http_code"
    sleep "$INTERVAL_SEC"
  done
}

case "${1:---launch}" in
  --launch|-l) cmd_launch ;;
  --status|-s) cmd_status ;;
  --stop|-k)   cmd_stop ;;
  --run)       cmd_run ;;  # internal entry point under nohup; not for direct use
  --help|-h)
    sed -n '1,/^# Configuration/p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "usage: $0 [--launch|--status|--stop|--help]"
    exit 2
    ;;
esac
