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

ENV_FILE=""
STALE_DAYS=15
PAGE1_BATCH=15
DEEP_LIMIT=10
SKIP_DEEP=false
SKIP_PROBE=false
INCLUDE_THIN=false

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

REPORT_FILE="cache/freshness-report.json"

print_report_summary() {
  python3 - "$REPORT_FILE" <<'PY'
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

generate_report() {
  step "Generate freshness report"
  node scripts/generate-freshness-report.js --stale "$STALE_DAYS"
  print_report_summary
}

step "Cookie health check"
python3 scripts/cookie-health-check.py
if [[ "$SKIP_PROBE" != true ]]; then
  python3 scripts/cookie-health-check.py --probe
fi

generate_report

step "Run page-1 backlog batch"
PAGE1_ARGS=(
  python3 scripts/terapeak-export.py
  --run
  --backlog "$REPORT_FILE"
  --batch "$PAGE1_BATCH"
)
if [[ "$INCLUDE_THIN" == true ]]; then
  PAGE1_ARGS+=(--include-thin)
fi
"${PAGE1_ARGS[@]}"

generate_report

if [[ "$SKIP_DEEP" != true ]]; then
  step "Run deep-pagination backlog"
  python3 scripts/sales-aggregator.py --backlog "$REPORT_FILE" --run --limit "$DEEP_LIMIT"
  generate_report
fi

step "Loop complete"
echo "Surface freshness loop finished successfully."
