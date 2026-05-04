#!/usr/bin/env bash
# chain-aggregate.sh — Run multiple terapeak aggregate batches sequentially.
# Watches for anti-bot signals and stops if detected.
#
# Usage: bash scripts/chain-aggregate.sh [PID_TO_WAIT_FOR]

set -euo pipefail
cd "$(dirname "$0")/.."

LOGDIR="cache"
ANTIBOT_PATTERNS="captcha|blocked|forbidden|403|rate.limit|unusual.activity|verify.you|not.a.robot|access.denied"

check_antibot() {
  local logfile="$1"
  if grep -qiE "$ANTIBOT_PATTERNS" "$logfile" 2>/dev/null; then
    echo ""
    echo "!! ANTI-BOT SIGNAL DETECTED in $logfile !!"
    echo "!! Stopping all aggregates. Review the log: $logfile"
    grep -iE "$ANTIBOT_PATTERNS" "$logfile" | tail -5
    return 1
  fi
  return 0
}

run_batch() {
  local filter="$1"
  local label="$2"
  local logfile="$LOGDIR/terapeak_${label}.log"

  echo ""
  echo "========================================"
  echo "  Starting batch: $label"
  echo "  Filter: $filter"
  echo "  Log: $logfile"
  echo "========================================"

  DISPLAY=:1 python3 scripts/terapeak-export.py --run --resume --filter "$filter" 2>&1 | tee "$logfile"

  # Check for anti-bot after each batch
  if ! check_antibot "$logfile"; then
    exit 1
  fi

  echo "  Batch $label complete."
}

# Wait for existing aggregate process if PID given
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then
  echo "Waiting for PID $1 to finish..."
  while kill -0 "$1" 2>/dev/null; do
    sleep 10
  done
  echo "PID $1 finished."

  # Check the Morgan log for anti-bot before continuing
  if ! check_antibot "$LOGDIR/terapeak_morgan_grade.log"; then
    exit 1
  fi
fi

echo ""
echo "=== Chained aggregation starting at $(date) ==="
echo ""

# Batch order: biggest gaps first
run_batch "Barber.*Dime"             "barber_dime"
run_batch "Barber.*Quarter"          "barber_quarter"
run_batch "Barber.*Half"             "barber_half"
run_batch "Mercury.*Dime"            "mercury_dime"
run_batch "Buffalo.*Nickel"          "buffalo_nickel"
run_batch "Indian Head.*Cent"        "indian_head_cent"
run_batch "Walking Liberty.*Half"    "walking_liberty_half"
run_batch "Liberty V.*Nickel"        "liberty_v_nickel"
run_batch "Standing Liberty.*Quarter" "standing_liberty_quarter"

echo ""
echo "=== All chained batches complete at $(date) ==="
