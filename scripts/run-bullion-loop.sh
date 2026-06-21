#!/bin/bash
# Continuous stale-bullion export loop.
# Stops on bot detection (non-zero exit) or when all items are done.

cd /workspaces/coin-price-agent
export DISPLAY=:1
export UPLOAD_MODE=blob

BACKLOG="cache/freshness-batch-bullion-stale.json"
LIMIT=50
BATCH=1
TOTAL_EXPORTED=0

echo "=== Stale Bullion Loop Started $(date) ==="
echo "Backlog: $BACKLOG (246 datasets)"
echo "Batch size: $LIMIT"
echo ""

while true; do
    echo "--- Batch $BATCH starting at $(date) ---"
    python3 scripts/terapeak-export.py --run --resume --backlog "$BACKLOG" --limit "$LIMIT"
    EXIT_CODE=$?

    if [ $EXIT_CODE -ne 0 ]; then
        echo ""
        echo "!!! STOPPED: Exit code $EXIT_CODE (likely bot detection or session expired)"
        echo "!!! Completed $TOTAL_EXPORTED items across $((BATCH-1)) full batches"
        echo "!!! Time: $(date)"
        exit $EXIT_CODE
    fi

    TOTAL_EXPORTED=$((TOTAL_EXPORTED + LIMIT))
    echo "Batch $BATCH complete. Total exported so far: ~$TOTAL_EXPORTED"
    echo ""

    # Check if we've covered all 246
    if [ $TOTAL_EXPORTED -ge 246 ]; then
        echo "=== ALL DONE === $TOTAL_EXPORTED items exported across $BATCH batches"
        echo "Finished at $(date)"
        exit 0
    fi

    # Brief pause between batches (human-like)
    echo "Pausing 30s before next batch..."
    sleep 30
    BATCH=$((BATCH + 1))
done
