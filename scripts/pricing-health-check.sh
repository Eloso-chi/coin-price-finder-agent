#!/usr/bin/env bash
# pricing-health-check.sh -- Single-invocation pricing health report
# Runs all curl calls and outputs structured JSON for the pricing-health agent to analyze.
# Usage: bash scripts/pricing-health-check.sh [BASE_URL]

set -euo pipefail

BASE="${1:-http://localhost:3000}"

# -- Health check --
if ! curl -sf "$BASE/api/health" >/dev/null 2>&1; then
  echo '{"error": "Server not responding at '"$BASE"'/api/health"}' 
  exit 1
fi

# -- Coin selection --
# Golden set (hardcoded queries -- mirrors __tests__/fixtures/golden_coins.json)
GOLDEN_COINS=(
  "1921 Morgan Silver Dollar"
  "1882-S Morgan Silver Dollar"
  "1880-CC Morgan Silver Dollar"
  "1921 Morgan Silver Dollar MS63"
  "2024 American Silver Eagle"
  "1986 American Silver Eagle"
  "2021 American Silver Eagle Type 1"
  "1923 Peace Dollar"
  "2024 South African Krugerrand 1 oz"
  "2023 Mexican Gold Libertad 1 oz"
)

# Terapeak store sample -- pick 4 high-row datasets from different series
TERAPEAK_SAMPLE=$(curl -sf "$BASE/api/terapeak/datasets" | python3 -c "
import json, sys, random
data = json.load(sys.stdin)
ds = data.get('datasets', [])
candidates = [d for d in ds if d.get('compCount', 0) and d.get('compCount', 0) >= 30]
seen_prefix = set()
picks = []
random.seed(42)
random.shuffle(candidates)
for c in candidates:
    st = c.get('searchTerm', '')
    prefix = st.split()[0] if st else ''
    if prefix and prefix not in seen_prefix and len(picks) < 4:
        seen_prefix.add(prefix)
        picks.append(st)
for p in picks:
    print(p)
" 2>/dev/null || true)

# Combine into single array
ALL_COINS=("${GOLDEN_COINS[@]}")
if [[ -n "$TERAPEAK_SAMPLE" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && ALL_COINS+=("$line")
  done <<< "$TERAPEAK_SAMPLE"
fi

# -- Run all checks --
echo "{"
echo '  "timestamp": "'$(date -Iseconds)'",'
echo '  "coinCount": '${#ALL_COINS[@]}','
echo '  "results": ['

FIRST=true
for COIN in "${ALL_COINS[@]}"; do
  if [ "$FIRST" = true ]; then FIRST=false; else echo ","; fi

  # Build JSON-safe and URL-safe versions
  COIN_JSON=$(python3 -c "import json; print(json.dumps(\"\"\"$COIN\"\"\"))")
  COIN_URL=$(python3 -c "import urllib.parse; print(urllib.parse.quote(\"\"\"$COIN\"\"\"))")

  # Step 1: Terapeak lookup
  TEAK=$(curl -sf "$BASE/api/terapeak/lookup?q=$COIN_URL" 2>/dev/null || echo '{"comps":[]}')
  TEAK_ROWS=$(echo "$TEAK" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('comps',[])))" 2>/dev/null || echo "0")

  # Step 2: Price Discovery
  DISC=$(curl -sf -X POST "$BASE/api/price" \
    -H 'Content-Type: application/json' \
    -d "{\"query\": $(echo "$COIN_JSON")}" 2>/dev/null || echo '{}')

  DISC_PARSED=$(echo "$DISC" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    v = d.get('valuation', {}) or {}
    e = d.get('ebay', {}).get('us', {}) or {}
    print(json.dumps({
        'fmv': v.get('fmvCore'),
        'confidence': v.get('confidence'),
        'method': v.get('method'),
        'compCount': v.get('compCount'),
        'lowData': v.get('lowData', False),
        'browseOnly': (v.get('dataSource') or {}).get('browseOnly', False),
        'gradePool': v.get('gradePool'),
        'usComps': len(e.get('comps', [])),
        'gathered': e.get('gathered'),
        'attritionPct': e.get('attritionPct'),
        'removed': e.get('removed', {})
    }))
except:
    print(json.dumps({'error': 'parse_failed'}))
" 2>/dev/null || echo '{"error": "parse_failed"}')

  # Step 3: Batch Pricing
  BATCH=$(curl -sf -X POST "$BASE/api/pricing-batch" \
    -H 'Content-Type: application/json' \
    -d "{\"items\": [{\"query\": $(echo "$COIN_JSON"), \"coinData\": {\"name\": $(echo "$COIN_JSON")}}]}" 2>/dev/null || echo '{"results":[{}]}')

  BATCH_PARSED=$(echo "$BATCH" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    r = (d.get('results') or [{}])[0] or {}
    # Batch route returns fmv/confidence at top level, not nested under valuation
    print(json.dumps({
        'fmv': r.get('fmv') or (r.get('valuation') or {}).get('fmvCore'),
        'confidence': r.get('confidence') or (r.get('valuation') or {}).get('confidence'),
        'method': r.get('method') or (r.get('valuation') or {}).get('method'),
        'compCount': r.get('compCount') or (r.get('valuation') or {}).get('compCount'),
        'avgEbay': r.get('avgEbay')
    }))
except:
    print(json.dumps({'error': 'parse_failed'}))
" 2>/dev/null || echo '{"error": "parse_failed"}')

  # Emit coin result
  echo -n "    {\"coin\": $COIN_JSON, \"teakRows\": $TEAK_ROWS, \"discovery\": $DISC_PARSED, \"batch\": $BATCH_PARSED}"
done

echo ""
echo "  ]"
echo "}"
