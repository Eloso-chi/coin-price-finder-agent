#!/usr/bin/env bash
# Start or verify the authenticated local display used for interactive login.
set -euo pipefail

DISPLAY_NUMBER="${TERAPEAK_VNC_DISPLAY:-1}"
VNC_PORT="${TERAPEAK_VNC_PORT:-5901}"
NOVNC_PORT="${TERAPEAK_NOVNC_PORT:-6080}"
PASSWORD_FILE="${VNC_PASSWORD_FILE:-$HOME/.vnc/passwd}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/cpf-terapeak-display"
LOG_DIR="$STATE_DIR/logs"
VNC_LOG="$LOG_DIR/vnc.log"
NOVNC_LOG="$LOG_DIR/novnc.log"
VNC_DISPLAY=":$DISPLAY_NUMBER"
PROC_ROOT="${TERAPEAK_PROC_ROOT:-/proc}"
SS_BIN="${TERAPEAK_SS_BIN:-$(command -v ss || true)}"
XTIGERVNC_BIN="${TERAPEAK_XTIGERVNC_BIN:-$(command -v Xtigervnc || true)}"
WEBSOCKIFY_BIN="${TERAPEAK_WEBSOCKIFY_BIN:-$(command -v websockify || true)}"
NOVNC_WEB_DIR="${TERAPEAK_NOVNC_WEB_DIR:-/usr/share/novnc}"

usage() {
  cat <<'EOF'
Usage: bash scripts/terapeak-display.sh start|check|url

  start  Start localhost-only VNC with VncAuth and a noVNC proxy; fail if
         a port is already owned by a process not verified as this display.
  check  Verify DISPLAY, VNC loopback binding/auth command, and noVNC HTTP.
  url    Print the noVNC URL for the local forwarded port.

Set a VNC password first with `mkdir -p ~/.vnc && chmod 700 ~/.vnc && vncpasswd`.
The password is entered directly in the terminal and stored in ~/.vnc/passwd.
EOF
}

fail() {
  printf '[terapeak-display:FAIL] %s\n' "$1" >&2
  exit 1
}

listener_addresses() {
  "$SS_BIN" -H -ltn "sport = :$1" | awk '{print $4}'
}

port_has_listener() {
  [[ -n "$(listener_addresses "$1")" ]]
}

listener_pids() {
  "$SS_BIN" -H -ltnp "sport = :$1" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

verify_process() {
  local pid="$1"
  local expected_exe="$2"
  shift 2
  local executable arguments argument script_interpreter=""
  local -a argv=()
  [[ -r "$PROC_ROOT/$pid/exe" && -r "$PROC_ROOT/$pid/cmdline" ]] || fail "Cannot inspect listener process $pid"
  executable="$(readlink -f "$PROC_ROOT/$pid/exe")" || fail "Cannot resolve listener executable for PID $pid"
  if [[ -r "$expected_exe" ]] && [[ "$(head -n 1 "$expected_exe")" == '#!'* ]]; then
    script_interpreter="$(head -n 1 "$expected_exe" | cut -c3- | awk '{print $1}')"
    [[ "$executable" == "$(readlink -f "$script_interpreter")" ]] || fail "Listener PID $pid is not running under the script interpreter"
  else
    [[ "$executable" == "$(readlink -f "$expected_exe")" ]] || fail "Listener PID $pid executable is not $expected_exe"
  fi
  [[ "$(stat -c '%u' "$PROC_ROOT/$pid")" == "$(id -u)" ]] || fail "Listener PID $pid is not owned by the current user"
  mapfile -d '' -t argv < "$PROC_ROOT/$pid/cmdline"
  arguments="$(printf '%s\n' "${argv[@]}")"
  if [[ -n "$script_interpreter" ]]; then
    grep -Fxq -- "$expected_exe" <<< "$arguments" || fail "Listener PID $pid is not running the expected proxy script"
  fi
  for argument in "$@"; do
    grep -Fxq -- "$argument" <<< "$arguments" || fail "Listener PID $pid is missing expected argument: $argument"
  done
}

verify_unique_option() {
  local pid="$1" option="$2" expected="$3" count=0 index
  local -a argv=()
  mapfile -d '' -t argv < "$PROC_ROOT/$pid/cmdline"
  for ((index = 0; index < ${#argv[@]}; index++)); do
    if [[ "${argv[index]}" == "$option" ]]; then
      count=$((count + 1))
      [[ $((index + 1)) -lt ${#argv[@]} && "${argv[index + 1]}" == "$expected" ]] || \
        fail "Listener PID $pid has unexpected effective value for $option"
    elif [[ "${argv[index]}" == "$option="* ]]; then
      fail "Listener PID $pid uses unsupported or conflicting $option syntax"
    fi
  done
  [[ "$count" -eq 1 ]] || fail "Listener PID $pid must specify $option exactly once"
}

verify_unique_argument() {
  local pid="$1" expected="$2" count=0 argument
  local -a argv=()
  mapfile -d '' -t argv < "$PROC_ROOT/$pid/cmdline"
  for argument in "${argv[@]}"; do
    if [[ "$argument" == "$expected" ]]; then
      count=$((count + 1))
    elif [[ "$expected" == --web=* && "$argument" == --web=* ]]; then
      fail "Listener PID $pid has unexpected effective web root"
    fi
  done
  [[ "$count" -eq 1 ]] || fail "Listener PID $pid must specify $expected exactly once"
}

check_password_file() {
  [[ -f "$PASSWORD_FILE" ]] || fail "VNC password file missing: $PASSWORD_FILE; create it with vncpasswd in your terminal"
  local owner mode
  owner="$(stat -c '%u' "$PASSWORD_FILE")"
  mode="$(stat -c '%a' "$PASSWORD_FILE")"
  [[ "$owner" == "$(id -u)" ]] || fail "VNC password file must be owned by the current user: $PASSWORD_FILE"
  (( (8#$mode & 077) == 0 )) || fail "VNC password file must not be group/world accessible; run chmod 600 '$PASSWORD_FILE'"
}

check_vnc_listener() {
  local addresses address
  addresses="$(listener_addresses "$VNC_PORT")"
  [[ -n "$addresses" ]] || fail "VNC is not listening on port $VNC_PORT; run '$0 start'"
  while IFS= read -r address; do
    case "$address" in
      127.0.0.1:"$VNC_PORT"|\[::1\]:"$VNC_PORT") ;;
      *) fail "VNC listener is not loopback-only ($address); stop and inspect it before login" ;;
    esac
  done <<< "$addresses"

  local pids pid
  pids="$(listener_pids "$VNC_PORT")"
  [[ -n "$pids" ]] || fail "Cannot verify the VNC process on port $VNC_PORT"
  for pid in $pids; do
    verify_process "$pid" "$XTIGERVNC_BIN" \
      "$VNC_DISPLAY" -localhost yes -rfbport "$VNC_PORT" \
      -SecurityTypes VncAuth -PasswordFile "$PASSWORD_FILE"
    verify_unique_option "$pid" -localhost yes
    verify_unique_option "$pid" -rfbport "$VNC_PORT"
    verify_unique_option "$pid" -SecurityTypes VncAuth
    verify_unique_option "$pid" -PasswordFile "$PASSWORD_FILE"
  done
}

check_novnc_listener() {
  local addresses address expected_bind
  addresses="$(listener_addresses "$NOVNC_PORT")"
  [[ -n "$addresses" ]] || fail "noVNC is not listening on port $NOVNC_PORT; run '$0 start'"
  if [[ "${CODESPACES:-false}" == true ]]; then
    expected_bind="0.0.0.0:$NOVNC_PORT"
  else
    expected_bind="127.0.0.1:$NOVNC_PORT"
  fi
  while IFS= read -r address; do
    [[ "$address" == "$expected_bind" ]] || fail "noVNC listener must bind to $expected_bind ($address found)"
  done <<< "$addresses"

  local pids pid
  pids="$(listener_pids "$NOVNC_PORT")"
  [[ -n "$pids" ]] || fail "Cannot verify the noVNC process on port $NOVNC_PORT"
  for pid in $pids; do
    verify_process "$pid" "$WEBSOCKIFY_BIN" \
      "--web=$NOVNC_WEB_DIR" "$expected_bind" "127.0.0.1:$VNC_PORT"
    verify_unique_argument "$pid" "--web=$NOVNC_WEB_DIR"
    verify_unique_argument "$pid" "$expected_bind"
    verify_unique_argument "$pid" "127.0.0.1:$VNC_PORT"
  done
}

display_url() {
  if [[ "${CODESPACES:-false}" == true ]]; then
    [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]] || \
      fail 'Codespaces URL variables are missing (CODESPACE_NAME and GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN)'
    printf 'https://%s-%s.%s/vnc.html?autoconnect=true\n' \
      "$CODESPACE_NAME" "$NOVNC_PORT" "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
  else
    printf '%s\n' "http://localhost:$NOVNC_PORT/vnc.html?host=localhost&port=$NOVNC_PORT"
  fi
}

check_ready() {
  [[ "${DISPLAY:-}" == "$VNC_DISPLAY" || "${DISPLAY:-}" == "$VNC_DISPLAY."* ]] || \
    fail "DISPLAY must be $VNC_DISPLAY for interactive login (current: ${DISPLAY:-unset})"
  check_password_file
  check_vnc_listener
  check_novnc_listener
  curl --fail --silent --show-error --max-time 3 "http://127.0.0.1:$NOVNC_PORT/vnc.html" >/dev/null || \
    fail "noVNC is not reachable on 127.0.0.1:$NOVNC_PORT; run '$0 start'"
  printf '[terapeak-display:READY] authenticated VNC and noVNC are ready\n'
  display_url
}

start_vnc() {
  check_password_file
  [[ -x "$XTIGERVNC_BIN" ]] || fail 'Xtigervnc is not installed'
  [[ -x "$WEBSOCKIFY_BIN" ]] || fail 'websockify is not installed'
  [[ -x "$SS_BIN" ]] || fail 'ss is required to verify listeners'
  command -v curl >/dev/null 2>&1 || fail 'curl is required to verify noVNC'
  [[ -f "$NOVNC_WEB_DIR/vnc.html" ]] || fail "noVNC web files are not installed at $NOVNC_WEB_DIR"
  if [[ "${CODESPACES:-false}" == true ]]; then
    display_url >/dev/null
  fi

  mkdir -p "$LOG_DIR"
  chmod 700 "$STATE_DIR" "$LOG_DIR"
  local vnc_pid="" novnc_pid="" started_vnc=false started_novnc=false
  stop_owned_process() {
    local pid="$1"
    kill "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.05
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  }
  cleanup_started() {
    local rc=$?
    if (( rc != 0 )); then
      [[ -n "$novnc_pid" && "$started_novnc" == true ]] && stop_owned_process "$novnc_pid"
      [[ -n "$vnc_pid" && "$started_vnc" == true ]] && stop_owned_process "$vnc_pid"
    fi
  }
  trap cleanup_started EXIT

  if ! port_has_listener "$VNC_PORT"; then
    nohup "$XTIGERVNC_BIN" "$VNC_DISPLAY" -localhost yes -rfbport "$VNC_PORT" \
      -geometry 1280x800 -SecurityTypes VncAuth -PasswordFile "$PASSWORD_FILE" \
      -AlwaysShared >"$VNC_LOG" 2>&1 </dev/null &
    vnc_pid=$!
    started_vnc=true
    local ready=false
    for _ in {1..40}; do
      if port_has_listener "$VNC_PORT"; then
        ready=true
        break
      fi
      if ! kill -0 "$vnc_pid" 2>/dev/null; then
        fail "Xtigervnc exited during startup; inspect $VNC_LOG"
      fi
      sleep 0.25
    done
    [[ "$ready" == true ]] || fail "Xtigervnc did not listen within 10 seconds; inspect $VNC_LOG"
  fi
  check_vnc_listener

  local novnc_bind="127.0.0.1"
  if [[ "${CODESPACES:-false}" == true ]]; then
    novnc_bind="0.0.0.0"
  fi
  if ! port_has_listener "$NOVNC_PORT"; then
    nohup "$WEBSOCKIFY_BIN" "--web=$NOVNC_WEB_DIR" "$novnc_bind:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" \
      >"$NOVNC_LOG" 2>&1 </dev/null &
    novnc_pid=$!
    started_novnc=true
    local ready=false
    for _ in {1..40}; do
      if curl --fail --silent --max-time 0.1 "http://127.0.0.1:$NOVNC_PORT/vnc.html" >/dev/null 2>&1; then
        ready=true
        break
      fi
      if ! kill -0 "$novnc_pid" 2>/dev/null; then
        fail "noVNC proxy exited during startup; inspect $NOVNC_LOG"
      fi
      sleep 0.15
    done
    [[ "$ready" == true ]] || fail "noVNC did not become ready within 10 seconds; inspect $NOVNC_LOG"
  fi

  export DISPLAY="$VNC_DISPLAY"
  check_ready
  trap - EXIT
  [[ -n "$vnc_pid" ]] && printf 'VNC PID: %s\n' "$vnc_pid"
  [[ -n "$novnc_pid" ]] && printf 'noVNC PID: %s\n' "$novnc_pid"
}

command_name="${1:-}"
case "$command_name" in
  start)
    start_vnc
    ;;
  check)
    [[ -x "$SS_BIN" ]] || fail 'ss is required to verify listeners'
    command -v curl >/dev/null 2>&1 || fail 'curl is required to verify noVNC'
    check_ready
    ;;
  url)
    display_url
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac