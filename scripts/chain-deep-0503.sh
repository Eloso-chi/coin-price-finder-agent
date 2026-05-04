#!/usr/bin/env bash
# chain-deep-0503.sh -- Deep pagination: batches 3(resume)->5->4->1->2
# Stops on anti-bot detection. Includes codespace keepalive.
set -uo pipefail
cd "$(dirname "$0")/.."

LOGDIR="cache"
DISPLAY=:7
export DISPLAY
ANTIBOT_PATTERNS="captcha|blocked|forbidden|403|rate.limit|unusual.activity|verify.you|not.a.robot|access.denied|BOT DETECTION"

# ── Keepalive: prevent codespace idle shutdown ──
keepalive() {
  while true; do
    sleep 300
    curl -sf http://localhost:3000/api/health > /dev/null 2>&1 || true
    echo "[keepalive] $(date '+%H:%M:%S') -- still running" >> "$LOGDIR/keepalive.log"
  done
}
keepalive &
KEEPALIVE_PID=$!
trap "kill $KEEPALIVE_PID 2>/dev/null; echo 'Keepalive stopped.'" EXIT

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

run_batch() {
  local args="$1"
  local label="$2"
  local logfile="$LOGDIR/terapeak_deep_${label}_0503.log"

  echo ""
  echo "============================================================"
  echo "  BATCH: $label"
  echo "  Started: $(date)"
  echo "  Log: $logfile"
  echo "============================================================"

  eval python3 scripts/terapeak-page2.py $args 2>&1 | tee "$logfile"
  local rc=${PIPESTATUS[0]}

  if ! check_antibot "$logfile"; then
    echo "ABORTING remaining batches."
    exit 1
  fi

  if [[ $rc -ne 0 ]]; then
    echo "  Batch $label exited with code $rc -- continuing to next batch."
  fi

  # Cooldown between batches
  echo "  Batch $label done at $(date). Cooling down 60s..."
  sleep 60
}

echo "=== Deep Pagination Chain Started: $(date) ==="
echo "    Order: 3(resume) -> 5 -> 4 -> 1 -> 2"
echo "    Keepalive PID: $KEEPALIVE_PID"
echo ""

# ── Batch 3 resume: Libertad + Panda + Maple (interrupted, resuming) ──
run_batch "--run --filter \"Libertad|Panda|Maple|Lunar\" --exclude \"[Gg]old\" --min-rows 25 --resume cache/terapeak_deep_batch3_finish_0503.log" "batch3_finish"

# ── Batch 5: Kookaburra + silver rounds/bars ──
run_batch "--run --filter \"Kookaburra|silver round|silver bar\" --exclude \"[Gg]old|[Pp]latinum|[Pp]alladium|90%\" --min-rows 25" "batch5_kook_misc"

# ── Batch 4: Britannia + Krugerrand + Philharmonic (silver only) ──
run_batch "--run --filter \"Britannia|Krugerrand|Philharmonic\" --exclude \"[Gg]old|[Pp]latinum|[Pp]alladium\" --min-rows 25" "batch4_brit_krug_phil"

# ── Batch 1: Silver Eagle ──
run_batch "--run --filter \"Silver Eagle\" --min-rows 25" "batch1_eagles"

# ── Batch 2: Kangaroo + Polar Bear ──
run_batch "--run --filter \"Kangaroo|Polar Bear\" --exclude \"[Gg]old|[Pp]latinum|[Pp]alladium\" --min-rows 25" "batch2_misc_bullion"

echo ""
echo "=== All batches complete at $(date) ==="
echo "    Check logs in cache/terapeak_deep_*_0503.log"
