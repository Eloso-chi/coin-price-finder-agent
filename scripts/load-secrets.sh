#!/usr/bin/env bash
# load-secrets.sh -- Pull dev secrets from Azure Key Vault into local .env
#
# Usage:
#   scripts/load-secrets.sh              # dry-run: print KEY=<redacted> to stdout
#   scripts/load-secrets.sh --print      # print KEY=value to stdout
#                                        # WARNING: exposes raw secrets via shell
#                                        # scrollback / history / pipes. Prefer --write.
#   scripts/load-secrets.sh --write      # merge into ./.env (chmod 600)
#   scripts/load-secrets.sh --vault NAME # override vault name
#
# Requires: az CLI logged in (`az login`) with get-secret permission on the vault.
# Default vault: coinpricefinder-kv  (see /memories/repo/azure-infrastructure.md)
#
# Mapping: Key Vault names use hyphens (EBAY-APP-ID); env vars use underscores
# (EBAY_APP_ID). The list below is the source of truth for which secrets the
# app needs at runtime to call external APIs.
#
# --write behavior:
#   * Each matching `KEY=...` line in .env is REWRITTEN IN FULL. Inline trailing
#     comments (e.g. `EBAY_APP_ID=x # rotated 2026-01-01`) are lost.
#   * Secrets that SKIP (missing from KV, no access) are left untouched in .env;
#     the previous value is preserved. Edit .env manually to remove stale keys.

set -euo pipefail

# Tight umask so temp files and the final .env are created mode 600, not 644.
# Closes the window between mv and chmod where another local user could read .env.
umask 077

VAULT="${KEYVAULT_NAME:-coinpricefinder-kv}"
MODE="dryrun"

# KV secret name -> env var name
# Keep in sync with .env.example.
SECRETS=(
  "EBAY-APP-ID:EBAY_APP_ID"
  "EBAY-CLIENT-SECRET:EBAY_CLIENT_SECRET"
  "EBAY-CERT-ID:EBAY_CERT_ID"
  "PCGS-API-KEY:PCGS_API_KEY"
  "GREYSHEET-API-KEY:GREYSHEET_API_KEY"
  "GREYSHEET-API-TOKEN:GREYSHEET_API_TOKEN"
  "ADMIN-API-KEY:ADMIN_API_KEY"
  "JWT-SECRET:JWT_SECRET"
)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print)  MODE="print"; shift ;;
    --write)  MODE="write"; shift ;;
    --vault)  VAULT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if ! command -v az >/dev/null 2>&1; then
  echo "ERROR: az CLI not found. Install: https://aka.ms/install-azure-cli" >&2
  exit 1
fi

if ! az account show >/dev/null 2>&1; then
  echo "ERROR: az not logged in. Run: az login" >&2
  exit 1
fi

# Locate repo root (script may be invoked from anywhere)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")"
ENV_FILE="$REPO_ROOT/.env"

fetch_one() {
  # $1 = KV secret name -> echoes value (no trailing newline)
  az keyvault secret show \
    --vault-name "$VAULT" \
    --name "$1" \
    --query value -o tsv 2>/dev/null
}

declare -A FETCHED
echo "Fetching ${#SECRETS[@]} secrets from vault: $VAULT" >&2
for entry in "${SECRETS[@]}"; do
  kv_name="${entry%%:*}"
  env_name="${entry##*:}"
  val="$(fetch_one "$kv_name" || true)"
  if [[ -z "$val" ]]; then
    echo "  SKIP $kv_name (not found or no access)" >&2
    continue
  fi
  FETCHED["$env_name"]="$val"
  echo "  OK   $kv_name -> $env_name" >&2
done

if [[ "$MODE" == "dryrun" ]]; then
  echo "" >&2
  echo "Dry run. Re-run with --write to update $ENV_FILE, or --print to see values." >&2
  for env_name in "${!FETCHED[@]}"; do
    echo "$env_name=<redacted>"
  done
  exit 0
fi

if [[ "$MODE" == "print" ]]; then
  for env_name in "${!FETCHED[@]}"; do
    printf '%s=%s\n' "$env_name" "${FETCHED[$env_name]}"
  done
  exit 0
fi

# --write: merge into .env preserving non-secret lines
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [[ -f "$ENV_FILE" ]]; then
  cp "$ENV_FILE" "$TMP"
else
  : > "$TMP"
fi

for env_name in "${!FETCHED[@]}"; do
  val="${FETCHED[$env_name]}"
  # Use awk index() (literal prefix match) rather than regex so keys with
  # special regex chars still match correctly.
  awk -v k="$env_name" -v v="$val" '
    BEGIN { replaced = 0 }
    {
      if (index($0, k "=") == 1) { print k "=" v; replaced = 1 }
      else { print }
    }
    END { if (!replaced) print k "=" v }
  ' "$TMP" > "$TMP.new" && mv "$TMP.new" "$TMP"
done

mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"
trap - EXIT

echo "" >&2
echo "Wrote $ENV_FILE (mode 600). ${#FETCHED[@]} secret(s) updated." >&2
