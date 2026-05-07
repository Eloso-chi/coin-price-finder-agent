#!/usr/bin/env bash
# chain-deep-morgan-graded.sh -- Deep pagination for Morgan graded coins ONLY.
# Hard cap: 3 pages total (page 1 already collected; this runs pages 2-3).
# Deterministic: fixed filter, fixed page cap, no optional deeper crawling.
set -euo pipefail
cd "$(dirname "$0")/.."

LOGDIR="cache"
DISPLAY="${DISPLAY:-:7}"
export DISPLAY
LOGFILE="$LOGDIR/terapeak_deep_morgan_graded.log"
ANTIBOT_PATTERNS="captcha|blocked|forbidden|403|rate.limit|unusual.activity|verify.you|not.a.robot|access.denied|BOT DETECTION"

check_antibot() {
  local logfile="$1"
  if grep -qiE "$ANTIBOT_PATTERNS" "$logfile" 2>/dev/null; then
    echo ""
    echo "!! ANTI-BOT SIGNAL DETECTED in $logfile !!"
    grep -iE "$ANTIBOT_PATTERNS" "$logfile" | tail -5
    return 1
  fi
  return 0
}

echo "============================================================"
echo "  DEEP PAGINATION: Morgan Graded Coins"
echo "  Hard cap: 3 pages (pages 2-3 only; page 1 already exists)"
echo "  Started: $(date)"
echo "  Log: $LOGFILE"
echo "============================================================"

python3 scripts/sales-aggregator.py \
  --run \
  --filter "Morgan.*(MS|PR|PF|AU|VF|XF)" \
  --max-pages 3 \
  --min-rows 50 \
  2>&1 | tee "$LOGFILE"

RC=${PIPESTATUS[0]}

if ! check_antibot "$LOGFILE"; then
  echo "Anti-bot detected. Review log: $LOGFILE"
  exit 1
fi

if [[ $RC -ne 0 ]]; then
  echo "Aggregator exited with code $RC."
  exit $RC
fi

echo ""
echo "=== Morgan graded deep pagination complete at $(date) ==="
