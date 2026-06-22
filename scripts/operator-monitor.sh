#!/usr/bin/env bash
# Operator progress monitoring - displays basic metrics after each pass.

set -euo pipefail

PROJECT_DIR="${1:-.}"
PASS_NUM="${2:-?}"

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
  local latest_log
  latest_log=$(find "$PROJECT_DIR/cache" -maxdepth 1 -name '*.log' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
  [[ -n "$latest_log" ]] || return

  if ! grep -q 'OK (' "$latest_log" 2>/dev/null; then
    return
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
