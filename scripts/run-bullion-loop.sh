#!/bin/bash
# Continuous stale-bullion export loop.
# Stops on bot detection (non-zero exit) or when all items are done.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
export DISPLAY=:1
export UPLOAD_MODE=blob

BACKLOG="cache/freshness-batch-bullion-stale.json"
LIMIT=50
BATCH=1

echo "=== Stale Bullion Loop Started $(date) ==="
echo "Backlog: $BACKLOG"
echo "Batch size: $LIMIT"
echo ""

while true; do
    echo "--- Batch $BATCH starting at $(date) ---"
    BATCH_LOG="$(mktemp)"
    python3 scripts/terapeak-export.py --run --resume --backlog "$BACKLOG" --limit "$LIMIT" 2>&1 | tee "$BATCH_LOG"
    EXIT_CODE=${PIPESTATUS[0]}

    if [ $EXIT_CODE -ne 0 ]; then
        echo ""
        echo "!!! STOPPED: Exit code $EXIT_CODE (likely bot detection or session expired)"
        echo "!!! Completed $((BATCH-1)) full batches"
        echo "!!! Time: $(date)"
        rm -f "$BATCH_LOG"
        exit $EXIT_CODE
    fi

    if grep -q '^No terms to process\.$' "$BATCH_LOG"; then
        rm -f "$BATCH_LOG"
        echo "=== ALL DONE === backlog exhausted after $((BATCH-1)) full batches"
        echo "Finished at $(date)"
        exit 0
    fi
    rm -f "$BATCH_LOG"

    echo "Batch $BATCH complete."
    echo ""

    # Brief pause between batches (human-like)
    echo "Pausing 30s before next batch..."
    sleep 30
    BATCH=$((BATCH + 1))
done
