#!/usr/bin/env bash
# refresh-stale.sh -- One-command stale data refresh
#
# Queries the staleness API to find coins with outdated Terapeak data,
# then feeds them into terapeak-export.py automatically.
#
# Prerequisites: VNC running, server running, eBay cookies valid
#   (solve CAPTCHA first via: DISPLAY=:1 python3 scripts/vnc-login.py)
#
# Usage:
#   ./scripts/refresh-stale.sh                    # Refresh top 100 stale (>14 days)
#   ./scripts/refresh-stale.sh --days 60          # Only coins stale >60 days
#   ./scripts/refresh-stale.sh --limit 50         # Cap at 50 coins
#   ./scripts/refresh-stale.sh --dry-run          # Show what would be refreshed
#   ./scripts/refresh-stale.sh --include-empty    # Also refresh empty stubs
#   ./scripts/refresh-stale.sh --full             # Full startup: VNC + server + login + refresh
#
# What it does:
#   1. (--full only) Starts VNC, server, opens login page for CAPTCHA
#   2. Queries GET /api/admin/stale-datasets to find outdated coins
#   3. Builds a filter regex from the stalest datasets
#   4. Runs terapeak-export.py --run --refresh --max-age <days> --filter <regex>
#   5. Monitors for anti-bot signals and stops if detected

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ── Colors ──────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step() { echo -e "\n${CYAN}${BOLD}── $1 ──${NC}"; }
ok()   { echo -e "   ${GREEN}✓ $1${NC}"; }
warn() { echo -e "   ${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "   ${RED}✗ $1${NC}"; exit 1; }

# ── Parse args ──────────────────────────────────────────
STALE_DAYS=14
LIMIT=100
DRY_RUN=false
INCLUDE_EMPTY=false
FULL_STARTUP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days)        STALE_DAYS="$2"; shift 2 ;;
    --limit)       LIMIT="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=true; shift ;;
    --include-empty) INCLUDE_EMPTY=true; shift ;;
    --full)        FULL_STARTUP=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--days N] [--limit N] [--dry-run] [--include-empty] [--full]"
      echo ""
      echo "  --days N          Staleness threshold in days (default: 14)"
      echo "  --limit N         Max coins to refresh (default: 100)"
      echo "  --dry-run         Show what would be refreshed, don't refresh"
      echo "  --include-empty   Also refresh empty stub datasets"
      echo "  --full            Full startup: VNC + server + login + refresh"
      exit 0
      ;;
    *) warn "Unknown arg: $1"; shift ;;
  esac
done

# ── Load admin key ──────────────────────────────────────
if [[ -f .env ]]; then
  ADMIN_API_KEY=$(grep -oP '(?<=^ADMIN_API_KEY=).+' .env 2>/dev/null || true)
  export ADMIN_API_KEY
fi
ADMIN_API_KEY="${ADMIN_API_KEY:-}"

if [[ -z "$ADMIN_API_KEY" ]]; then
  fail "No ADMIN_API_KEY found. Set it in .env or export it."
fi

API_BASE="http://localhost:3000"
ANTIBOT_PATTERNS="captcha|blocked|forbidden|403|rate.limit|unusual.activity|verify.you|not.a.robot|access.denied"

# ── Full startup mode ───────────────────────────────────
SERVER_PID=""
cleanup() {
  if [[ "$FULL_STARTUP" == true ]] && [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "\n${CYAN}Shutting down server (PID $SERVER_PID)...${NC}"
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null || true
    ok "Server stopped"
  fi
}
trap cleanup EXIT

if [[ "$FULL_STARTUP" == true ]]; then
  # ── Start VNC ──
  step "Start VNC"
  if pgrep -f Xtigervnc > /dev/null 2>&1; then
    ok "VNC already running"
  else
    Xtigervnc :1 -geometry 1280x800 -SecurityTypes None -AlwaysShared &>/dev/null &
    sleep 1
    bash /usr/share/novnc/utils/novnc_proxy --vnc localhost:5901 --listen 6080 &>/dev/null &
    sleep 1
    ok "VNC started on port 6080"
  fi

  # ── Start server ──
  step "Start server"
  PIDS=$(lsof -t -i:3000 2>/dev/null || true)
  if [[ -n "$PIDS" ]]; then
    kill $PIDS 2>/dev/null || true
    sleep 1
  fi
  node server.js &
  SERVER_PID=$!
  ok "Server starting (PID $SERVER_PID)"

  # Wait for healthy
  MAX_WAIT=30
  WAITED=0
  while [[ $WAITED -lt $MAX_WAIT ]]; do
    if curl -sf "$API_BASE/api/health" > /dev/null 2>&1; then
      break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
  done
  if [[ $WAITED -ge $MAX_WAIT ]]; then
    fail "Server did not start within ${MAX_WAIT}s"
  fi
  ok "Server healthy (took ${WAITED}s)"

  # ── eBay login ──
  step "eBay Login (solve CAPTCHA in VNC on port 6080)"
  DISPLAY=:1 python3 scripts/vnc-login.py
  ok "Login confirmed"
fi

# ═══════════════════════════════════════════════════════════
# Step 1: Verify prerequisites
# ═══════════════════════════════════════════════════════════
step "Verify prerequisites"

# Server running?
if ! curl -sf "$API_BASE/api/health" > /dev/null 2>&1; then
  fail "Server not running on port 3000. Start it first or use --full."
fi
ok "Server is up"

# Cookies exist?
if [[ ! -f cache/ebay_cookies.json ]]; then
  fail "No cookies at cache/ebay_cookies.json. Log in first or use --full."
fi
COOKIE_AGE=$(( ($(date +%s) - $(stat -c %Y cache/ebay_cookies.json 2>/dev/null || echo 0)) / 3600 ))
if [[ $COOKIE_AGE -gt 24 ]]; then
  warn "Cookies are ${COOKIE_AGE}h old -- they may be expired"
else
  ok "Cookies are ${COOKIE_AGE}h old"
fi

# Display set?
if [[ -z "${DISPLAY:-}" ]]; then
  export DISPLAY=:1
  warn "Set DISPLAY=:1 (was unset)"
else
  ok "DISPLAY=$DISPLAY"
fi

# ═══════════════════════════════════════════════════════════
# Step 2: Query staleness API
# ═══════════════════════════════════════════════════════════
step "Query staleness API (threshold: ${STALE_DAYS} days, limit: ${LIMIT})"

STALE_JSON=$(curl -sf "$API_BASE/api/admin/stale-datasets?days=${STALE_DAYS}&limit=${LIMIT}" \
  -H "x-api-key: $ADMIN_API_KEY" 2>&1) || fail "Failed to query staleness API"

# Parse with Python (available in Codespace)
STALE_INFO=$(echo "$STALE_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
stale = data.get('stale', [])
with_data = [d for d in stale if d.get('compCount', 0) > 0]
empty = [d for d in stale if d.get('compCount', 0) == 0]
include_empty = '$INCLUDE_EMPTY' == 'true'

targets = with_data + (empty if include_empty else [])

# Build filter regex (escape special chars, join with |)
import re
terms = [re.escape(d['searchTerm']) for d in targets]
filter_regex = '|'.join(terms) if terms else ''

# Write regex to temp file (avoids shell escaping issues)
regex_file = '/tmp/terapeak_refresh_regex.txt'
with open(regex_file, 'w') as f:
    f.write(filter_regex)

print(f'TOTAL_STALE={len(stale)}')
print(f'WITH_DATA={len(with_data)}')
print(f'EMPTY={len(empty)}')
print(f'TARGETS={len(targets)}')

# Show summary
for d in with_data[:10]:
    age = d.get('ageDays') or '?'
    print(f'  {age}d  {d[\"compCount\"]:3d} comps  {d[\"searchTerm\"]}', file=sys.stderr)
if len(with_data) > 10:
    print(f'  ... and {len(with_data)-10} more with data', file=sys.stderr)
if empty and include_empty:
    print(f'  + {len(empty)} empty stubs', file=sys.stderr)
elif empty:
    print(f'  ({len(empty)} empty stubs excluded -- use --include-empty to add)', file=sys.stderr)
") 2>&1

# Extract numeric variables (safe -- no spaces in values)
TOTAL_STALE=$(echo "$STALE_INFO" | grep -oP '(?<=^TOTAL_STALE=)\d+' || echo 0)
WITH_DATA=$(echo "$STALE_INFO" | grep -oP '(?<=^WITH_DATA=)\d+' || echo 0)
EMPTY=$(echo "$STALE_INFO" | grep -oP '(?<=^EMPTY=)\d+' || echo 0)
TARGETS=$(echo "$STALE_INFO" | grep -oP '(?<=^TARGETS=)\d+' || echo 0)

# Read regex from temp file
FILTER_REGEX=$(cat /tmp/terapeak_refresh_regex.txt 2>/dev/null || echo "")

# Show details (stderr lines from Python)
echo "$STALE_INFO" | grep -E '^\s+\d+d|^\s+\.\.\.|^\s+\+|^\s+\(' || true

echo ""
echo -e "   ${BOLD}Stale: $TOTAL_STALE total ($WITH_DATA with data, $EMPTY empty)${NC}"
echo -e "   ${BOLD}Targets to refresh: $TARGETS${NC}"

if [[ "$TARGETS" == "0" ]]; then
  echo -e "\n${GREEN}${BOLD}Nothing stale! All data is fresh within ${STALE_DAYS} days.${NC}"
  exit 0
fi

# ═══════════════════════════════════════════════════════════
# Step 3: Run aggregator (or dry-run)
# ═══════════════════════════════════════════════════════════
LOGFILE="cache/terapeak_refresh_$(date +%Y%m%d_%H%M%S).log"

if [[ "$DRY_RUN" == true ]]; then
  step "Dry run -- would refresh ${TARGETS} datasets"
  echo -e "   ${CYAN}Filter regex (first 200 chars):${NC}"
  echo "   ${FILTER_REGEX:0:200}..."
  echo ""
  echo -e "   ${CYAN}Command that would run:${NC}"
  echo "   DISPLAY=:1 python3 scripts/terapeak-export.py --run --refresh --max-age $STALE_DAYS --filter \"<regex>\" 2>&1 | tee $LOGFILE"
  exit 0
fi

step "Scraping ${TARGETS} stale datasets"
echo -e "   Log: ${CYAN}${LOGFILE}${NC}"

# Reset quota before starting
curl -sf -X POST "$API_BASE/api/terapeak/quota/reset" \
  -H "x-api-key: $ADMIN_API_KEY" > /dev/null 2>&1 || warn "Quota reset failed (non-fatal)"
ok "Quota reset"

# Run the aggregator
DISPLAY=:1 python3 scripts/terapeak-export.py \
  --run --refresh --max-age "$STALE_DAYS" \
  --filter "$FILTER_REGEX" \
  2>&1 | tee "$LOGFILE"

# ═══════════════════════════════════════════════════════════
# Step 4: Anti-bot check
# ═══════════════════════════════════════════════════════════
step "Post-refresh checks"

if grep -qiE "$ANTIBOT_PATTERNS" "$LOGFILE" 2>/dev/null; then
  echo ""
  warn "ANTI-BOT SIGNALS DETECTED in log:"
  grep -iE "$ANTIBOT_PATTERNS" "$LOGFILE" | tail -5 | sed 's/^/   /'
  echo ""
  fail "Review the log: $LOGFILE"
fi

# Count results
SUCCEEDED=$(grep -c '^\s*\[.*\].*OK ' "$LOGFILE" 2>/dev/null || echo "0")
FAILED=$(grep -c 'NO EXPORT' "$LOGFILE" 2>/dev/null || echo "0")
ok "Refresh complete: ${SUCCEEDED} succeeded, ${FAILED} no data"

echo ""
echo -e "${GREEN}${BOLD}=== Refresh complete ===${NC}"
echo -e "   Log: $LOGFILE"
echo -e "   Run again to catch any remaining stale data."
