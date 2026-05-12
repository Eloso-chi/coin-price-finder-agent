#!/bin/bash
# Continuous batch runner for terapeak-export.py
# Runs batches of 50 from the backlog until bot detection or exhaustion.
# Usage: DISPLAY=:7 bash scripts/run-batches.sh

set -e

BACKLOG="cache/freshness-batch-nogold.json"
BATCH_SIZE=50
BATCH_NUM=1
LOGFILE="/tmp/terapeak-batch-output.log"

cd /workspaces/coin-price-agent

while true; do
    REMAINING=$(python3 -c "import json; d=json.load(open('$BACKLOG')); print(len(d['datasets']))")
    
    if [ "$REMAINING" -eq 0 ]; then
        echo "=== ALL DONE. No more coins in backlog. ==="
        break
    fi
    
    echo ""
    echo "=========================================="
    echo "  BATCH $BATCH_NUM -- $REMAINING coins remaining"
    echo "  $(date)"
    echo "=========================================="
    echo ""
    
    # Run the export, stream output live AND capture to log
    set +e
    python3 scripts/terapeak-export.py \
        --run \
        --backlog "$BACKLOG" \
        --limit "$BATCH_SIZE" \
        --no-shuffle \
        2>&1 | tee "$LOGFILE"
    EXIT_CODE=${PIPESTATUS[0]}
    set -e
    
    # Check for session expiry or bot detection in captured output
    if grep -qiE "session expired|captcha|bot detect|blocked|ERROR:" "$LOGFILE"; then
        echo ""
        echo "=== BATCH $BATCH_NUM FAILED (session/bot issue) ==="
        echo "$(date)"
        break
    fi
    
    if [ $EXIT_CODE -ne 0 ]; then
        echo ""
        echo "=== BATCH $BATCH_NUM FAILED (exit code $EXIT_CODE) ==="
        echo "$(date)"
        break
    fi
    
    # Remove completed coins from backlog (first BATCH_SIZE entries)
    python3 -c "
import json
data = json.load(open('$BACKLOG'))
before = len(data['datasets'])
data['datasets'] = data['datasets'][$BATCH_SIZE:]
after = len(data['datasets'])
json.dump(data, open('$BACKLOG', 'w'), indent=2)
print(f'Trimmed backlog: {before} -> {after}')
"
    
    echo "=== BATCH $BATCH_NUM COMPLETE at $(date) ==="
    BATCH_NUM=$((BATCH_NUM + 1))
    
    # Brief pause between batches to be polite
    echo "Pausing 30s before next batch..."
    sleep 30
done

echo ""
echo "Runner finished at $(date). Completed $((BATCH_NUM - 1)) batches."
