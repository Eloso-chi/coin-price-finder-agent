#!/usr/bin/env bash
# bootstrap-surface-wsl.sh
#
# Fast setup helper for PR250 Surface/WSL scraper workflow.
# - Installs required apt packages (with libasound2/libasound2t64 fallback)
# - Creates Python venv and installs Playwright + requests
# - Installs Playwright Chromium
# - Creates ~/cpf/state
# - Writes ~/.env.surface template and ~/load-cpf-env.sh helper
# - Supports persistent key file (~/.config/cpf/admin_api_key, chmod 600)

set -euo pipefail

APP_URL_DEFAULT="https://coinpricefinder-h3a3b5g0dmdydna4.azurewebsites.net"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "== PR250 Surface bootstrap =="
echo "Project: $PROJECT_DIR"

if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  echo "Distro: ${PRETTY_NAME:-unknown}"
  if [[ "${VERSION_ID:-}" == "26.04" ]]; then
    echo "ERROR: Ubuntu 26.04 is currently unsupported by Playwright Chromium in this workflow." >&2
    echo "Use Ubuntu 24.04 or 22.04 for scraper runs." >&2
    exit 2
  fi
fi

cd "$PROJECT_DIR"

echo "\n-- Installing system deps --"
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git \
  libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libxkbcommon0 \
  libpango-1.0-0 libcairo2

# Ubuntu 24.04+ exposes libasound2t64; older distros expose libasound2.
if apt-cache show libasound2t64 >/dev/null 2>&1; then
  sudo apt install -y libasound2t64
elif apt-cache show libasound2 >/dev/null 2>&1; then
  sudo apt install -y libasound2
else
  echo "WARNING: neither libasound2t64 nor libasound2 found; Playwright may fail." >&2
fi

echo "\n-- Python environment --"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -U pip
pip install playwright requests

echo "\n-- Playwright Chromium install --"
python3 -m playwright install chromium

echo "\n-- Surface state directory --"
mkdir -p "$HOME/cpf/state"

ENV_FILE="$HOME/.env.surface"
COOKIE_PATH="$HOME/cpf/state/cookies-surface.json"
KEY_FILE_PATH="$HOME/.config/cpf/admin_api_key"

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
APP_URL=$APP_URL_DEFAULT
COOKIE_FILE=$COOKIE_PATH
ADMIN_API_KEY_FILE=$KEY_FILE_PATH
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE"
else
  echo "$ENV_FILE already exists; leaving it unchanged."
fi

LOADER_FILE="$HOME/load-cpf-env.sh"
cat > "$LOADER_FILE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="$HOME/.env.surface"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

# Default to a locked local secret file when ADMIN_API_KEY is not set inline.
if [[ -z "${ADMIN_API_KEY_FILE:-}" ]]; then
  ADMIN_API_KEY_FILE="$HOME/.config/cpf/admin_api_key"
fi

if [[ -n "${ADMIN_API_KEY:-}" ]]; then
  ADMIN_API_KEY="$(printf '%s' "$ADMIN_API_KEY" | tr -d '\r')"
  export ADMIN_API_KEY
fi

if [[ -z "${ADMIN_API_KEY:-}" ]] && [[ -f "$ADMIN_API_KEY_FILE" ]]; then
  ADMIN_API_KEY="$(tr -d '\r\n' < "$ADMIN_API_KEY_FILE")"
  export ADMIN_API_KEY
fi

if [[ -z "${APP_URL:-}" ]]; then
  echo "APP_URL missing in $ENV_FILE" >&2
  exit 1
fi
if [[ -z "${COOKIE_FILE:-}" ]]; then
  echo "COOKIE_FILE missing in $ENV_FILE" >&2
  exit 1
fi

if [[ "${ADMIN_API_KEY:-}" =~ ^@Microsoft.KeyVault\( ]]; then
  echo "ADMIN_API_KEY is App Service Key Vault reference syntax." >&2
  echo "Use raw secret value in local WSL shell." >&2
  exit 2
fi
if [[ -z "${ADMIN_API_KEY:-}" ]]; then
  echo "ADMIN_API_KEY is not set and no key file was found at: $ADMIN_API_KEY_FILE" >&2
  echo "Run ~/set-cpf-admin-key.sh once, then source ~/load-cpf-env.sh" >&2
  exit 2
fi

echo "Env loaded:"
echo "  APP_URL=$APP_URL"
echo "  COOKIE_FILE=$COOKIE_FILE"
echo "  ADMIN_API_KEY source=${ADMIN_API_KEY_FILE:-inline}"
EOF
chmod +x "$LOADER_FILE"

KEY_SETUP_FILE="$HOME/set-cpf-admin-key.sh"
cat > "$KEY_SETUP_FILE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

KEY_DIR="$HOME/.config/cpf"
KEY_FILE="$KEY_DIR/admin_api_key"

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

read -rsp "Enter raw ADMIN_API_KEY: " ADMIN_API_KEY
echo

if [[ -z "$ADMIN_API_KEY" ]]; then
  echo "ADMIN_API_KEY cannot be empty." >&2
  exit 2
fi
if [[ "$ADMIN_API_KEY" =~ ^@Microsoft.KeyVault\( ]]; then
  echo "Use the raw secret value, not App Service Key Vault reference syntax." >&2
  exit 2
fi

printf '%s' "$ADMIN_API_KEY" > "$KEY_FILE"
chmod 600 "$KEY_FILE"
unset ADMIN_API_KEY

echo "Saved key to $KEY_FILE with mode 600."
EOF
chmod +x "$KEY_SETUP_FILE"

SURFACE_CMD="$PROJECT_DIR/surface"
if [[ -f "$SURFACE_CMD" ]]; then
  chmod +x "$SURFACE_CMD"
fi

BASHRC_FILE="$HOME/.bashrc"
ALIAS_LINE="alias surface='$SURFACE_CMD'"
if [[ -f "$BASHRC_FILE" ]]; then
  if ! grep -Fq "$ALIAS_LINE" "$BASHRC_FILE"; then
    {
      echo
      echo "# coin-price-finder-agent Surface runner"
      echo "$ALIAS_LINE"
    } >> "$BASHRC_FILE"
    echo "Added alias to $BASHRC_FILE: surface"
  else
    echo "Alias already present in $BASHRC_FILE: surface"
  fi
fi

echo "\nBootstrap complete."
echo "Next steps:"
echo "  1) Run ~/set-cpf-admin-key.sh once to persist your key securely"
echo "  2) source ~/load-cpf-env.sh"
echo "  3) python3 scripts/cookie-health-check.py"
echo "  4) python3 scripts/terapeak-export.py --login"
echo "  5) source ~/.bashrc"
echo "  6) surface"
