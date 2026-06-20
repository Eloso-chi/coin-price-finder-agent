#!/usr/bin/env bash
# Preflight checker for Terapeak startup on local WSL Surface path.
#
# Purpose:
# - Fail fast on unsupported distro/runtime before any long-running work.
# - Validate env wiring and required local tooling.
# - Optionally enforce cookie health when preparing to start loop mode.

set -euo pipefail

ENV_FILE="$HOME/.env.surface"
MODE="login"

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

command -v python3 >/dev/null 2>&1 || fail "python3 not found"
command -v node >/dev/null 2>&1 || fail "node not found"
ok "Required runtimes available (python3, node)"

if [[ -f "$HOME/load-cpf-env.sh" ]]; then
  ok "Found loader helper: $HOME/load-cpf-env.sh"
else
  echo "[preflight:WARN] loader helper missing: $HOME/load-cpf-env.sh"
fi

python3 -c 'import playwright, requests' >/dev/null 2>&1 || \
  fail "Python packages missing (playwright/requests). Install in your active venv"
ok "Python packages available (playwright, requests)"

# Browser binary check: ensure at least one Chromium payload exists.
if ! compgen -G "$HOME/.cache/ms-playwright/chromium-*" >/dev/null; then
  fail "Playwright Chromium not installed (~/.cache/ms-playwright/chromium-* missing)"
fi
ok "Playwright Chromium payload present"

if [[ "$MODE" == "loop" ]]; then
  if ! python3 scripts/cookie-health-check.py >/tmp/terapeak-cookie-health.out 2>&1; then
    rc=$?
    cat /tmp/terapeak-cookie-health.out >&2 || true
    fail "Cookie health is not ready for loop start (exit $rc)"
  fi
  ok "Cookie health is READY for loop mode"
fi

echo "[preflight:READY] mode=$MODE env=$ENV_FILE distro=$DISTRO"
