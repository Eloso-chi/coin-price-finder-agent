#!/usr/bin/env bash
# chain-aggregate-session2.sh — Session 2 aggregate: finish leftovers + stale + new gaps
set -euo pipefail
cd "$(dirname "$0")/.."

LOGDIR="cache"
ANTIBOT_PATTERNS="captcha|blocked|forbidden|403|rate.limit|unusual.activity|verify.you|not.a.robot|access.denied"

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

  if ! check_antibot "$logfile"; then
    exit 1
  fi
  echo "  Batch $label complete."
}

echo "=== Session 2 chain aggregate starting at $(date) ==="

# ── Section 1: Unfinished from last night ──
run_batch "Indian Head.*Cent"           "indian_head_cent_s2"
run_batch "Walking Liberty.*Half"       "walking_liberty_half"
run_batch "Liberty V.*Nickel"           "liberty_v_nickel"
run_batch "Standing Liberty.*Quarter"   "standing_liberty_quarter"

# ── Section 2: Stale Morgan refresh ──
run_batch "Morgan Silver Dollar"        "morgan_stale_refresh"

# ── Section 3: World bullion year-specific gaps ──
run_batch "South Africa.*Gold Krugerrand"     "krugerrand"
run_batch "Mexico.*Gold Libertad"             "mexico_gold_libertad"
run_batch "Mexico.*Silver Libertad Proof"     "mexico_silver_libertad_proof"
run_batch "Great Britain.*Gold Britannia"     "gb_gold_britannia"
run_batch "Australia.*Gold Kangaroo"          "aus_gold_kangaroo"
run_batch "Austria.*Gold Philharmonic"        "austria_gold_phil"
run_batch "Australia.*Silver Kookaburra"      "aus_silver_kookaburra"
run_batch "Great Britain.*Silver Britannia"   "gb_silver_britannia"
run_batch "Austria.*Silver Philharmonic"      "austria_silver_phil"

# ── Section 4: US classics remainder ──
run_batch "Capped Bust.*Half"           "capped_bust_half"
run_batch "Trade Dollar"                "trade_dollar"
run_batch "Eisenhower.*Dollar"          "eisenhower_dollar"
run_batch "Shield.*Nickel"              "shield_nickel"
run_batch "Lincoln Wheat.*Cent"         "lincoln_wheat_cent"
run_batch "Seated Liberty"              "seated_liberty"
run_batch "Jefferson.*War.*Nickel"      "jefferson_war_nickel"

# ── Section 5: Stale refresh (sets, maple, panda, buffalo) ──
run_batch "US.*Set\|US.*Proof"          "us_sets_refresh"
run_batch "Canada.*Gold Maple"          "canada_maple_refresh"
run_batch "China.*Panda"                "china_panda_refresh"
run_batch "American Gold Buffalo"       "gold_buffalo_refresh"

echo ""
echo "=== Session 2 complete at $(date) ==="
