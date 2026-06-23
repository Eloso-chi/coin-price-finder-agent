#!/usr/bin/env bash
# loop-status.sh -- Query current loop execution status
# Usage: bash scripts/loop-status.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

STATE_FILE="$PROJECT_DIR/cache/loop-run-state.json"
LIVE_FILE="$PROJECT_DIR/cache/loop-status-live.json"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "Loop not started yet (no state file found)"
  exit 0
fi

# Get batch number and start time
BATCH=$(jq -r '.batch_number // "?"' "$STATE_FILE" 2>/dev/null || echo "?")
RUN_START=$(jq -r '.run_start_time // 0' "$STATE_FILE" 2>/dev/null || echo "0")

# Convert Unix timestamp to human-readable
if command -v date >/dev/null 2>&1; then
  if [[ "$RUN_START" =~ ^[0-9]+$ ]] && [[ $RUN_START -gt 0 ]]; then
    RUN_START_STR=$(date -d @"$RUN_START" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "unknown")
  else
    RUN_START_STR="$RUN_START"
  fi
else
  RUN_START_STR="$RUN_START"
fi

echo "═══════════════════════════════════════════════════════"
echo "LOOP STATUS"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Batch #:        $BATCH"
echo "  Run started:    $RUN_START_STR"
echo ""

if [[ -f "$LIVE_FILE" ]]; then
  COIN=$(jq -r '.current_coin // "—"' "$LIVE_FILE" 2>/dev/null || echo "—")
  NEW=$(jq -r '.new_comps // "—"' "$LIVE_FILE" 2>/dev/null || echo "—")
  DUPS=$(jq -r '.duplicates // "—"' "$LIVE_FILE" 2>/dev/null || echo "—")
  PCT=$(jq -r '.progress_pct // "—"' "$LIVE_FILE" 2>/dev/null || echo "—")
  STATUS=$(jq -r '.status // "?"' "$LIVE_FILE" 2>/dev/null || echo "?")
  
  echo "  Current coin:   $COIN"
  echo "  New comps:      $NEW"
  echo "  Duplicates:     $DUPS"
  echo "  Progress:       $PCT%"
  echo "  Status:         $STATUS"
else
  echo "  (Waiting for first coin to complete...)"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
