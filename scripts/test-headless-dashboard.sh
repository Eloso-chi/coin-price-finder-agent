#!/usr/bin/env bash
# Smoke test for sales-aggregator.py --no-dashboard mode
# Requires: server running on port 3000, ADMIN_API_KEY set
set -euo pipefail

SCRIPT="scripts/sales-aggregator.py"
cd "$(dirname "$0")/.."
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== Headless Dashboard Smoke Tests ==="
echo ""

# ── 1. --help includes new flags ──
echo "Test 1: --help includes --no-dashboard, --output, --decision"
HELP=$(python3 "$SCRIPT" --help 2>&1)
if echo "$HELP" | grep -q "\-\-no-dashboard" && \
   echo "$HELP" | grep -q "\-\-output" && \
   echo "$HELP" | grep -q "\-\-decision"; then
  pass "--help shows all new flags"
else
  fail "--help missing new flags"
fi

# ── 2. CLI output with --decision q (no interactive prompt) ──
echo "Test 2: --no-dashboard --decision q produces CLI output"
CLI_OUT=$(python3 "$SCRIPT" --no-dashboard --decision q 2>&1)
if echo "$CLI_OUT" | grep -q "HEADLESS DASHBOARD" && \
   echo "$CLI_OUT" | grep -q "Total datasets:" && \
   echo "$CLI_OUT" | grep -q "Recommended:"; then
  pass "CLI output has expected sections"
else
  fail "CLI output missing expected sections"
  echo "$CLI_OUT" | head -5
fi

# ── 3. Markdown output ──
echo "Test 3: --output markdown produces valid Markdown"
MD_OUT=$(python3 "$SCRIPT" --no-dashboard --output markdown --decision q 2>&1)
if echo "$MD_OUT" | grep -q "## Sales Aggregator Dashboard" && \
   echo "$MD_OUT" | grep -q "| Metric | Value |" && \
   echo "$MD_OUT" | grep -q "**Recommendation:**"; then
  pass "Markdown output has expected structure"
else
  fail "Markdown output missing expected structure"
  echo "$MD_OUT" | head -5
fi

# ── 4. JSON output is valid JSON ──
echo "Test 4: --output json produces valid JSON"
JSON_OUT=$(python3 "$SCRIPT" --no-dashboard --output json --decision q 2>&1)
if echo "$JSON_OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'summary' in d; assert 'categories' in d" 2>/dev/null; then
  pass "JSON output is valid and has expected keys"
else
  fail "JSON output invalid or missing keys"
  echo "$JSON_OUT" | head -5
fi

# ── 5. --decision 1 selects deep pagination and shows next command ──
echo "Test 5: --decision 1 auto-selects and shows next command"
D1_OUT=$(python3 "$SCRIPT" --no-dashboard --decision 1 2>&1)
if echo "$D1_OUT" | grep -q "Auto-selected: 1" && \
   echo "$D1_OUT" | grep -qE "Selected:|Nothing in this category"; then
  pass "--decision 1 works non-interactively"
else
  fail "--decision 1 did not produce expected output"
  echo "$D1_OUT" | tail -5
fi

# ── 6. JSON --decision 1 returns structured next-step ──
echo "Test 6: JSON + --decision 1 returns actionable JSON"
JD1_OUT=$(python3 "$SCRIPT" --no-dashboard --output json --decision 1 2>&1)
# JSON mode outputs two JSON objects (dashboard data + decision result) -- parse the last one
LAST_JSON=$(echo "$JD1_OUT" | python3 -c "
import sys, json
text = sys.stdin.read()
# Find the last complete JSON object
objs = []
decoder = json.JSONDecoder()
pos = 0
while pos < len(text):
    try:
        obj, end = decoder.raw_decode(text, pos)
        objs.append(obj)
        pos = end
    except json.JSONDecodeError:
        pos += 1
if objs:
    last = objs[-1]
    if 'selectedCategory' in last or 'error' in last or 'summary' in last:
        print('OK')
    else:
        print('UNEXPECTED')
else:
    print('NO_JSON')
" 2>&1)
if [[ "$LAST_JSON" == "OK" ]]; then
  pass "JSON --decision 1 returns structured result"
else
  fail "JSON --decision 1 unexpected output: $LAST_JSON"
fi

# ── 7. No VNC processes spawned ──
echo "Test 7: --no-dashboard does NOT start VNC"
VNC_BEFORE=$(pgrep -cf Xtigervnc || true)
python3 "$SCRIPT" --no-dashboard --decision q > /dev/null 2>&1
VNC_AFTER=$(pgrep -cf Xtigervnc || true)
if [[ "$VNC_AFTER" -le "$VNC_BEFORE" ]]; then
  pass "No new VNC processes spawned"
else
  fail "VNC process was spawned in --no-dashboard mode"
fi

# ── Summary ──
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
