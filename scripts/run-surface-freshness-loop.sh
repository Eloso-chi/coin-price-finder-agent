#!/usr/bin/env bash
# run-surface-freshness-loop.sh -- Surface/WSL freshness-driven scraper loop
#
# Generates the freshness triage report, runs a page-1 backlog batch through
# terapeak-export.py, refreshes the report, optionally runs deep pagination via
# sales-aggregator.py, then refreshes the report again.
#
# Intended for the PR #250 residential-machine path where COOKIE_FILE points to
# a machine-local cookie jar outside the repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

PYTHON_BIN=""

ENV_FILE=""
STALE_DAYS=15
PAGE1_BATCH=15
DEEP_LIMIT=10
SKIP_DEEP=false
SKIP_PROBE=false
INCLUDE_THIN=false
FOCUS_REGEX=""
COIN_TYPE=""
RUN_BULLION_P01=false
BULLION_P01_LIMIT=12

usage() {
  cat <<'EOF'
Usage: bash scripts/run-surface-freshness-loop.sh [options]

Options:
  --env-file FILE      Source environment variables from FILE before running.
  --stale DAYS         Freshness threshold for report generation (default: 15).
  --page1-batch N      Page-1 backlog batch size for terapeak-export.py (default: 15).
  --deep-limit N       Deep-pagination item limit for sales-aggregator.py (default: 10).
  --skip-deep          Skip the deep-pagination stage.
  --skip-probe         Skip cookie-health-check.py --probe.
  --include-thin       Include P3 thin-market entries in page-1 backlog mode.
  --focus REGEX        Focus queue execution to terms matching REGEX (e.g. "morgan|libertad").
  --coin-type NAME     Focus to a built-in coin family alias (e.g. libertads, morgans).
  --bullion-p01        Run a dedicated P0.1 bullion fast-lane before regular page-1 refresh.
  --bullion-p01-limit N  Max items in the P0.1 bullion pre-pass (default: 12).
  -h, --help           Show this help text.

Required environment:
  APP_URL              App Service base URL used by scraper uploads / status APIs.
  COOKIE_FILE          Per-machine cookie jar path.

Recommended environment:
  ADMIN_API_KEY        Used by status APIs and admin endpoints.

Example:
  bash scripts/run-surface-freshness-loop.sh \
    --env-file ~/.env.surface \
    --page1-batch 15 \
    --deep-limit 10
EOF
}

step() {
  printf '\n== %s ==\n' "$1"
}

resolve_python_bin() {
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

  echo "[freshness-loop] python3 not found and no project venv detected" >&2
  exit 1
}

resolve_focus_regex() {
  if [[ -n "$FOCUS_REGEX" ]]; then
    printf '%s' "$FOCUS_REGEX"
    return
  fi

  if [[ -z "$COIN_TYPE" ]]; then
    return
  fi

  case "${COIN_TYPE,,}" in
    libertad|libertads)
      printf '%s' 'libertad'
      ;;
    morgan|morgans)
      printf '%s' 'morgan'
      ;;
    eagle|eagles)
      printf '%s' 'eagle'
      ;;
    panda|pandas)
      printf '%s' 'panda'
      ;;
    lunar|lunars)
      printf '%s' 'lunar'
      ;;
    barber|barbers)
      printf '%s' 'barber'
      ;;
    *)
      # Fall back to direct regex use for custom names.
      printf '%s' "$COIN_TYPE"
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --stale)
      STALE_DAYS="$2"
      shift 2
      ;;
    --page1-batch)
      PAGE1_BATCH="$2"
      shift 2
      ;;
    --deep-limit)
      DEEP_LIMIT="$2"
      shift 2
      ;;
    --skip-deep)
      SKIP_DEEP=true
      shift
      ;;
    --skip-probe)
      SKIP_PROBE=true
      shift
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
    --bullion-p01)
      RUN_BULLION_P01=true
      shift
      ;;
    --bullion-p01-limit)
      BULLION_P01_LIMIT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Env file not found: $ENV_FILE" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

: "${APP_URL:?APP_URL must be set}"
: "${COOKIE_FILE:?COOKIE_FILE must be set}"

resolve_python_bin

# #251 -- enforce deterministic upload path unless the operator explicitly
# overrides it (e.g. UPLOAD_MODE=blob for a bulk-backfill profile). The
# default is API so freshness/dormancy progression is immediate and the
# Surface/Codespaces flows behave identically.
: "${UPLOAD_MODE:=blob}"
export UPLOAD_MODE
if [[ "$UPLOAD_MODE" != "api" ]]; then
  echo "[warn] UPLOAD_MODE=$UPLOAD_MODE -- non-default; ingestion may be deferred." >&2
fi

if [[ -n "$FOCUS_REGEX" && -n "$COIN_TYPE" ]]; then
  echo "Specify only one of --focus or --coin-type." >&2
  exit 1
fi

FILTER_REGEX="$(resolve_focus_regex)"
if [[ -n "$FILTER_REGEX" ]]; then
  echo "Focus filter active: $FILTER_REGEX"
fi

REPORT_FILE="cache/freshness-report.json"

print_report_summary() {
  "$PYTHON_BIN" - "$REPORT_FILE" <<'PY'
import json
import sys

report_path = sys.argv[1]
with open(report_path, encoding='utf-8') as fh:
    data = json.load(fh)

datasets = data.get('datasets', [])
counts = {}
for item in datasets:
    for action in item.get('actions', []):
        counts[action] = counts.get(action, 0) + 1

for key in [
    'refresh-page1',
    'deep-paginate',
    'needs-data',
    'recently-confirmed-stale',
    'dormant',
    'evidence-probe',
    'monitor-refresh',
    'ok',
]:
    print(f"{key}: {counts.get(key, 0)}")
PY
}

sync_meta_from_app() {
  # #253 -- pull the canonical data/terapeak-meta.json from Azure before
  # generating the freshness report. Without this, the local sidecar is
  # frozen at whatever was committed to git and the report classifies every
  # already-scraped coin as still-stale, so the scraper re-scrapes the same
  # list forever. On failure (missing key, 404, transport error, invalid
  # JSON) we log a warning and proceed with whatever's on disk.
  step "Sync terapeak-meta.json from $APP_URL"
  if [[ -z "${ADMIN_API_KEY:-}" ]]; then
    echo "[warn] ADMIN_API_KEY not set; skipping meta sync (freshness report will use git-frozen sidecar)" >&2
    return 0
  fi
  local tmp
  tmp="$(mktemp -t terapeak-meta.XXXXXX.json)"
  local http_code
  http_code="$(curl -sS -o "$tmp" -w '%{http_code}' \
    -H "x-api-key: $ADMIN_API_KEY" \
    -H 'accept: application/json' \
    --max-time 60 \
    "$APP_URL/api/admin/terapeak-meta" || echo '000')"
  if [[ "$http_code" != "200" ]]; then
    echo "[warn] meta sync got HTTP $http_code; keeping existing data/terapeak-meta.json" >&2
    rm -f "$tmp"
    return 0
  fi
  if ! "$PYTHON_BIN" -c "import json,sys; json.load(open(sys.argv[1]))" "$tmp" >/dev/null 2>&1; then
    echo "[warn] meta sync returned non-JSON payload; keeping existing data/terapeak-meta.json" >&2
    rm -f "$tmp"
    return 0
  fi
  mkdir -p data
  mv -f "$tmp" data/terapeak-meta.json
  local bytes
  bytes="$(stat -c '%s' data/terapeak-meta.json 2>/dev/null || stat -f '%z' data/terapeak-meta.json)"
  echo "  Synced data/terapeak-meta.json (${bytes} bytes) from $APP_URL"
}

generate_report() {
  sync_meta_from_app
  step "Generate freshness report"
  node scripts/generate-freshness-report.js --stale "$STALE_DAYS"
  print_report_summary
}

step "Cookie health check"
"$PYTHON_BIN" scripts/cookie-health-check.py
if [[ "$SKIP_PROBE" != true ]]; then
  "$PYTHON_BIN" scripts/cookie-health-check.py --probe
fi

generate_report

if [[ "$RUN_BULLION_P01" == true ]]; then
  step "Run P0.1 bullion fast-lane batch"
  P01_ARGS=(
    "$PYTHON_BIN" scripts/terapeak-export.py
    --run
    --backlog "$REPORT_FILE"
    --priority-include "P0.1"
    --limit "$BULLION_P01_LIMIT"
  )
  if [[ -n "$FILTER_REGEX" ]]; then
    P01_ARGS+=(--filter "$FILTER_REGEX")
  fi
  "${P01_ARGS[@]}"
  generate_report
fi

step "Run page-1 backlog batch"
PAGE1_ARGS=(
  "$PYTHON_BIN" scripts/terapeak-export.py
  --run
  --backlog "$REPORT_FILE"
  --priority-exclude "P0.1"
  --limit "$PAGE1_BATCH"
)
if [[ "$INCLUDE_THIN" == true ]]; then
  PAGE1_ARGS+=(--include-thin)
fi
if [[ -n "$FILTER_REGEX" ]]; then
  PAGE1_ARGS+=(--filter "$FILTER_REGEX")
fi
"${PAGE1_ARGS[@]}"

generate_report

if [[ "$SKIP_DEEP" != true ]]; then
  step "Run deep-pagination backlog"
  DEEP_ARGS=(
    "$PYTHON_BIN" scripts/sales-aggregator.py
    --backlog "$REPORT_FILE"
    --run
    --limit "$DEEP_LIMIT"
  )
  if [[ -n "$FILTER_REGEX" ]]; then
    DEEP_ARGS+=(--filter "$FILTER_REGEX")
  fi
  "${DEEP_ARGS[@]}"
  generate_report
fi

step "Loop complete"
echo "Surface freshness loop finished successfully."
