#!/usr/bin/env bash
# Preflight checker for Terapeak startup on local WSL Surface path.
#
# Purpose:
# - Fail fast on unsupported distro/runtime before any long-running work.
# - Validate env wiring and required local tooling.
# - Optionally enforce cookie health when preparing to start loop mode.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

ENV_FILE="$HOME/.env.surface"
MODE="login"
PYTHON_BIN=""

usage() {
  cat <<'EOF'
Usage: bash scripts/terapeak-startup-preflight.sh [options]

Options:
  --env-file FILE    Environment file to source (default: ~/.env.surface)
  --mode MODE        preflight mode: login|loop (default: login)
  -h, --help         Show this help text.

Modes:
  login  Validate runtime/env/tooling required before interactive --login.
  loop   Same as login, plus require HEALTHY cookie state.
EOF
}

fail() {
  echo "[preflight:FAIL] $1" >&2
  exit 1
}

ok() {
  echo "[preflight:OK] $1"
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

  fail "python3 not found and no project venv interpreter detected"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

if [[ "$MODE" != "login" && "$MODE" != "loop" ]]; then
  fail "--mode must be login or loop (got: $MODE)"
fi

if [[ ! -f /etc/os-release ]]; then
  fail "This script must run on Linux/WSL with /etc/os-release available"
fi

# shellcheck disable=SC1091
source /etc/os-release
DISTRO="${PRETTY_NAME:-unknown}"
VER="${VERSION_ID:-unknown}"

if [[ "${ID:-}" != "ubuntu" ]]; then
  fail "Unsupported distro ($DISTRO). Use Ubuntu 24.04 for Terapeak startup"
fi

if [[ "$VER" != "24.04" && "$VER" != "22.04" ]]; then
  fail "Unsupported Ubuntu version ($VER). Use Ubuntu 24.04 or 22.04"
fi
ok "Supported distro detected: $DISTRO"

[[ -f "$ENV_FILE" ]] || fail "Missing env file: $ENV_FILE"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
ok "Loaded env file: $ENV_FILE"

[[ -n "${APP_URL:-}" ]] || fail "APP_URL is missing after sourcing $ENV_FILE"
[[ -n "${COOKIE_FILE:-}" ]] || fail "COOKIE_FILE is missing after sourcing $ENV_FILE"
ok "Required env vars present (APP_URL, COOKIE_FILE)"

command -v node >/dev/null 2>&1 || fail "node not found"
resolve_python_bin
ok "Required runtimes available (python: $PYTHON_BIN, node)"

if [[ -f "$HOME/load-cpf-env.sh" ]]; then
  ok "Found loader helper: $HOME/load-cpf-env.sh"
else
  echo "[preflight:WARN] loader helper missing: $HOME/load-cpf-env.sh"
fi

"$PYTHON_BIN" -c 'import playwright, requests' >/dev/null 2>&1 || \
  fail "Python packages missing (playwright/requests). Install in project venv (.venv, .venv-u24, or .venv-u24b)"
ok "Python packages available (playwright, requests)"

# Browser binary check: ensure at least one Chromium payload exists.
if ! compgen -G "$HOME/.cache/ms-playwright/chromium-*" >/dev/null; then
  fail "Playwright Chromium not installed (~/.cache/ms-playwright/chromium-* missing)"
fi
ok "Playwright Chromium payload present"

if [[ "$MODE" == "loop" ]]; then
  if ! "$PYTHON_BIN" scripts/cookie-health-check.py >/tmp/terapeak-cookie-health.out 2>&1; then
    rc=$?
    cat /tmp/terapeak-cookie-health.out >&2 || true
    fail "Cookie health is not ready for loop start (exit $rc)"
  fi
  ok "Cookie health is READY for loop mode"
fi

echo "[preflight:READY] mode=$MODE env=$ENV_FILE distro=$DISTRO"
