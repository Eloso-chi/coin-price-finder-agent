#!/usr/bin/env bash
# Operator progress monitoring - displays basic metrics after each pass.
#
# Status output contract:
# - Keep the section headers and key lines stable for downstream status parsing.
# - Required headers:
#     Pass: N
#     Queue status:
#     Recent Coin Results (last pass):
# - Required summary line:
#     Batch total: ...
#   If per-coin rows are unavailable, emit:
#     Batch total: summary-only (succeeded: X, failed: Y) out of N coins
# - This script's output is operational telemetry. Chat status formatting rules
#   are documented in docs/runbooks/local-scraper-wsl2.md (Status report contract).

set -euo pipefail

PROJECT_DIR="${1:-.}"
PASS_NUM="${2:-?}"
SOURCE_LOG="${3:-}"

freshness_report="$PROJECT_DIR/cache/freshness-report.json"

count_staged_csvs() {
  git -C "$PROJECT_DIR" status --short 2>/dev/null | grep -c 'data/terapeak.*\.csv' || true
}

count_total_csvs() {
  find "$PROJECT_DIR/data/terapeak" -name '*.csv' 2>/dev/null | wc -l | tr -d ' '
}

count_actionable() {
  if [[ ! -f "$freshness_report" ]]; then
    echo "0 0 0 0"
    return
  fi

  python3 - "$freshness_report" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as fh:
    data = json.load(fh)

counts = {}
for item in data.get('datasets', []):
    for action in item.get('actions', []):
        counts[action] = counts.get(action, 0) + 1

p0 = counts.get('refresh-page1', 0)
p1 = counts.get('deep-paginate', 0)
p2 = counts.get('needs-data', 0)
print(p0, p1, p2, p0 + p1 + p2)
PY
}

print_recent_coin_results() {
  local latest_log=""
  if [[ -n "$SOURCE_LOG" && -f "$SOURCE_LOG" ]]; then
    latest_log="$SOURCE_LOG"
  else
    latest_log=$(find "$PROJECT_DIR/cache" -maxdepth 1 -name '*.log' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
  fi

  [[ -n "$latest_log" ]] || return

  local batch_size=0
  local batch_line
  batch_line=$(grep -E '^Exporting [0-9]+ coins\.\.\.' "$latest_log" 2>/dev/null | tail -n 1 || true)
  if [[ -n "$batch_line" ]]; then
    batch_size=$(echo "$batch_line" | sed -E 's/^Exporting ([0-9]+) coins\.\.\./\1/')
  fi

  local total_new=0
  local total_dups=0
  local ok_count=0
  local no_export_count=0
  local succeeded_count=0
  local failed_count=0

  local succeeded_line
  succeeded_line=$(grep -E '^  Succeeded:[[:space:]]+[0-9]+' "$latest_log" 2>/dev/null | tail -n 1 || true)
  if [[ -n "$succeeded_line" ]]; then
    succeeded_count=$(echo "$succeeded_line" | sed -E 's/^  Succeeded:[[:space:]]+([0-9]+).*/\1/')
  fi

  local failed_line
  failed_line=$(grep -E '^  Failed:[[:space:]]+[0-9]+' "$latest_log" 2>/dev/null | tail -n 1 || true)
  if [[ -n "$failed_line" ]]; then
    failed_count=$(echo "$failed_line" | sed -E 's/^  Failed:[[:space:]]+([0-9]+).*/\1/')
  fi

  echo "Recent Coin Results (last pass):"
  grep -E '^\s+\[' "$latest_log" 2>/dev/null | grep 'OK (' | while read -r line; do
    case "$line" in
      *'...'*'OK ('*' new, '*')')
        coin=${line#*] }
        coin=${coin%%... OK (*}
        new_count=${line##*OK (}
        new_count=${new_count%% new,*}
        dup_count=${line##*, }
        dup_count=${dup_count%% dups)*}
        printf '  %-50s new:%-4s dups:%-4s\n' "$coin" "$new_count" "$dup_count"
        ;;
    esac
  done

  while IFS= read -r line; do
    new_count=${line##*OK (}
    new_count=${new_count%% new,*}
    dup_count=${line##*, }
    dup_count=${dup_count%% dups)*}
    total_new=$((total_new + new_count))
    total_dups=$((total_dups + dup_count))
    ok_count=$((ok_count + 1))
  done < <(grep -E '^\s+\[[[:space:][:digit:]%]+\].*OK \([0-9]+ new, [0-9]+ dups\)' "$latest_log" 2>/dev/null)

  no_export_count=$(grep -c '^NO EXPORT' "$latest_log" 2>/dev/null || true)

  if [[ "$ok_count" -eq 0 && "$no_export_count" -eq 0 ]]; then
    if [[ "$batch_size" -gt 0 || "$succeeded_count" -gt 0 || "$failed_count" -gt 0 ]]; then
      if [[ "$batch_size" -gt 0 ]]; then
        printf '\nBatch total: summary-only (succeeded: %s, failed: %s) out of %s coins\n' "$succeeded_count" "$failed_count" "$batch_size"
      else
        printf '\nBatch total: summary-only (succeeded: %s, failed: %s)\n' "$succeeded_count" "$failed_count"
      fi
    fi
    return
  fi

  printf '\nBatch total: %s new, %s dups, %s no-export' "$total_new" "$total_dups" "$no_export_count"
  if [[ "$batch_size" -gt 0 ]]; then
    printf ' out of %s coins\n' "$batch_size"
  else
    printf '\n'
  fi
}

staged_csvs=$(count_staged_csvs)
total_csvs=$(count_total_csvs)
read -r p0 p1 p2 actionable < <(count_actionable)

coins_exported=$((staged_csvs * 12 / 15 + staged_csvs))

printf '\nPass: %s\n' "$PASS_NUM"
printf 'CSVs staged: %s\n' "$staged_csvs"
printf 'Total CSV files: %s\n' "$total_csvs"
printf 'Coins exported (est): ~%s\n' "$coins_exported"
printf '\nQueue status:\n'
printf '  refresh-page1: %s\n' "$p0"
printf '  deep-paginate: %s\n' "$p1"
printf '  needs-data:    %s\n' "$p2"
printf '  total action:  %s\n' "$actionable"

print_recent_coin_results
