#!/usr/bin/env bash
# run-terapeak-import.sh -- All-in-one Terapeak import workflow
#
# Usage:
#   ./scripts/run-terapeak-import.sh                  # Full run (all coins)
#   ./scripts/run-terapeak-import.sh --filter "Morgan" # Only Morgans
#   ./scripts/run-terapeak-import.sh --limit 5         # First 5 coins only
#   ./scripts/run-terapeak-import.sh --resume          # Resume interrupted run
#   ./scripts/run-terapeak-import.sh --skip-login      # Reuse existing cookies
#
# What it does:
#   1. Sets ADMIN_API_KEY (prompts you if not in .env)
#   2. Kills anything on port 3000
#   3. Starts the server in the background
#   4. Verifies the server is healthy
#   5. Tests the import pipeline with a sample CSV
#   6. Opens a browser for you to log in to eBay (waits for you)
#   7. Runs the Terapeak export + upload for all coins
#   8. Shuts down the server when done

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ── Colors for readability ──────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

step() { echo -e "\n${CYAN}${BOLD}── Step $1: $2 ──${NC}"; }
ok()   { echo -e "   ${GREEN}✓ $1${NC}"; }
warn() { echo -e "   ${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "   ${RED}✗ $1${NC}"; exit 1; }

# ── Parse args (pass through to terapeak-export.py) ─────
SKIP_LOGIN=false
EXPORT_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--skip-login" ]]; then
    SKIP_LOGIN=true
  else
    EXPORT_ARGS+=("$arg")
  fi
done

# ── Cleanup on exit ─────────────────────────────────────
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo -e "\n${CYAN}Shutting down server (PID $SERVER_PID)...${NC}"
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null || true
    ok "Server stopped"
  fi
}
trap cleanup EXIT

# ═══════════════════════════════════════════════════════════
# Step 1: Ensure ADMIN_API_KEY is set
# ═══════════════════════════════════════════════════════════
step 1 "Check ADMIN_API_KEY"

# Load from .env if present
if [[ -f .env ]]; then
  EXISTING_KEY=$(grep -oP '(?<=^ADMIN_API_KEY=).+' .env 2>/dev/null || true)
  if [[ -n "$EXISTING_KEY" ]]; then
    export ADMIN_API_KEY="$EXISTING_KEY"
    ok "Loaded ADMIN_API_KEY from .env"
  fi
fi

if [[ -z "${ADMIN_API_KEY:-}" ]]; then
  echo -e "   ${YELLOW}No ADMIN_API_KEY found in .env or environment.${NC}"
  echo -n "   Enter an API key (or press ENTER to generate one): "
  read -r USER_KEY
  if [[ -z "$USER_KEY" ]]; then
    ADMIN_API_KEY="terapeak-$(date +%s)"
    echo "ADMIN_API_KEY=$ADMIN_API_KEY" >> .env
    ok "Generated and saved to .env: $ADMIN_API_KEY"
  else
    ADMIN_API_KEY="$USER_KEY"
    echo "ADMIN_API_KEY=$ADMIN_API_KEY" >> .env
    ok "Saved to .env"
  fi
  export ADMIN_API_KEY
else
  ok "ADMIN_API_KEY is set"
fi

# ═══════════════════════════════════════════════════════════
# Step 2: Kill anything on port 3000
# ═══════════════════════════════════════════════════════════
step 2 "Free port 3000"

PIDS=$(lsof -t -i:3000 2>/dev/null || true)
if [[ -n "$PIDS" ]]; then
  kill $PIDS 2>/dev/null || true
  sleep 1
  ok "Killed existing processes on port 3000"
else
  ok "Port 3000 is free"
fi

# ═══════════════════════════════════════════════════════════
# Step 3: Start the server
# ═══════════════════════════════════════════════════════════
step 3 "Start server"

node server.js &
SERVER_PID=$!
ok "Server starting (PID $SERVER_PID)"

# ═══════════════════════════════════════════════════════════
# Step 4: Wait for server to be ready
# ═══════════════════════════════════════════════════════════
step 4 "Wait for server"

MAX_WAIT=30
WAITED=0
while [[ $WAITED -lt $MAX_WAIT ]]; do
  if curl -sf http://localhost:3000/api/terapeak/datasets > /dev/null 2>&1; then
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
  echo -ne "   Waiting... ${WAITED}s\r"
done

if [[ $WAITED -ge $MAX_WAIT ]]; then
  fail "Server did not start within ${MAX_WAIT}s. Check logs above."
fi
ok "Server is up (took ${WAITED}s)"

# ═══════════════════════════════════════════════════════════
# Step 5: Verify import pipeline with a test CSV
# ═══════════════════════════════════════════════════════════
step 5 "Test import pipeline"

TEST_CSV=$(mktemp /tmp/terapeak-test-XXXXXX.csv)
cat > "$TEST_CSV" << 'CSVEOF'
Item Title,Item ID,Sold Date,Sold Price,Shipping,Condition,Seller,Format
"1886 Morgan Silver Dollar NGC MS64",999999999999,3/15/2026,$142.50,$5.99,Certified,pipeline-test,Auction
CSVEOF

RESPONSE=$(curl -sf -X POST http://localhost:3000/api/terapeak/import \
  -H "x-api-key: $ADMIN_API_KEY" \
  -F "file=@$TEST_CSV" \
  -F "searchTerm=Pipeline Test 1886 Morgan" 2>&1) || true

rm -f "$TEST_CSV"

if echo "$RESPONSE" | grep -q '"newComps"'; then
  ok "Import pipeline works -- test comp stored"
else
  warn "Import test got unexpected response: $RESPONSE"
  warn "Continuing anyway (server auth may need checking)"
fi

# Verify lookup
LOOKUP=$(curl -sf "http://localhost:3000/api/terapeak/lookup?q=Pipeline+Test+1886+Morgan" 2>&1) || true
if echo "$LOOKUP" | grep -q '999999999999'; then
  ok "Lookup works -- test comp found"
else
  warn "Lookup did not return test comp (non-fatal)"
fi

# ═══════════════════════════════════════════════════════════
# Step 6: eBay Login (opens browser for you)
# ═══════════════════════════════════════════════════════════
step 6 "eBay Login"

if [[ "$SKIP_LOGIN" == true ]]; then
  if [[ -f cache/ebay_cookies.json ]]; then
    ok "Skipping login (--skip-login). Using existing cookies."
  else
    fail "No cookies found at cache/ebay_cookies.json. Remove --skip-login."
  fi
else
  # Check if cookies exist and are fresh (< 6 hours old)
  if [[ -f cache/ebay_cookies.json ]]; then
    AGE=$(( ($(date +%s) - $(stat -c %Y cache/ebay_cookies.json 2>/dev/null || echo 0)) / 3600 ))
    if [[ $AGE -lt 6 ]]; then
      echo -e "   ${YELLOW}Existing cookies are ${AGE}h old.${NC}"
      echo -n "   Re-login? (y/N): "
      read -r RELOGIN
      if [[ ! "$RELOGIN" =~ ^[Yy] ]]; then
        ok "Reusing existing cookies"
        SKIP_LOGIN=true
      fi
    fi
  fi

  if [[ "$SKIP_LOGIN" != true ]]; then
    echo ""
    # Detect if we have a display (local machine vs container/Codespace)
    if [[ -n "${DISPLAY:-}" ]] || [[ -n "${WAYLAND_DISPLAY:-}" ]]; then
      echo -e "   ${BOLD}A browser will open. Do the following:${NC}"
      echo -e "   1. Log in to eBay with your email and password"
      echo -e "   2. Complete any CAPTCHA or 2FA prompts"
      echo -e "   3. Once you see the eBay homepage, come back here"
      echo -e "   4. Press ENTER in the terminal when prompted"
      echo ""
      echo -n "   Ready? Press ENTER to open the browser... "
      read -r

      python3 scripts/terapeak-export.py --login
      LOGINRC=$?
    else
      echo -e "   ${YELLOW}No display detected (Codespace/container).${NC}"
      echo -e "   ${BOLD}You'll save cookies from your own browser to a file.${NC}"
      echo ""
      echo -e "   1. Open ${CYAN}https://www.ebay.com${NC} in your browser and log in"
      echo -e "   2. Press F12 to open DevTools -> Console tab"
      echo -e "   3. Paste this line and press Enter:"
      echo ""
      echo -e "      ${CYAN}JSON.stringify(document.cookie.split(\"; \").map(c => { const [n,...v] = c.split(\"=\"); return {name:n,value:v.join(\"=\"),domain:\".ebay.com\",path:\"/\"}; }))${NC}"
      echo ""
      echo -e "   4. Copy the JSON output (starts with [ ends with ])"
      echo -e "   5. Open a NEW file in VS Code: ${CYAN}cache/cookies.json${NC}"
      echo -e "   6. Paste the JSON into that file and save it (Ctrl+S)"
      echo ""
      echo -n "   Press ENTER when the file is saved... "
      read -r

      COOKIE_PATH="cache/cookies.json"
      if [[ ! -f "$COOKIE_PATH" ]]; then
        fail "File not found: $COOKIE_PATH -- create it and try again."
      fi

      python3 scripts/terapeak-export.py --cookie-file "$COOKIE_PATH"
      LOGINRC=$?

      # Clean up temp file (real cookies are now in cache/ebay_cookies.json)
      rm -f "$COOKIE_PATH" 2>/dev/null
    fi

    if [[ $LOGINRC -ne 0 ]]; then
      fail "Login failed. Try again."
    fi
    ok "Login successful, cookies saved"
  fi
fi

# ═══════════════════════════════════════════════════════════
# Step 7: Verify cookies
# ═══════════════════════════════════════════════════════════
step 7 "Verify cookies"

python3 scripts/terapeak-export.py --check
ok "Cookie check complete"

# ═══════════════════════════════════════════════════════════
# Step 8: Run the export
# ═══════════════════════════════════════════════════════════
step 8 "Export Terapeak data"

echo ""
if [[ ${#EXPORT_ARGS[@]} -gt 0 ]]; then
  echo -e "   Export args: ${EXPORT_ARGS[*]}"
else
  echo -e "   Exporting ALL coins (use --filter or --limit to narrow)"
fi

# Show dry run count first
python3 scripts/terapeak-export.py --dry-run "${EXPORT_ARGS[@]}" 2>&1 | tail -3
echo ""
echo -n "   Proceed with export? (Y/n): "
read -r PROCEED
if [[ "$PROCEED" =~ ^[Nn] ]]; then
  echo "   Aborted."
  exit 0
fi

python3 scripts/terapeak-export.py --run "${EXPORT_ARGS[@]}"

# ═══════════════════════════════════════════════════════════
# Step 9: Summary
# ═══════════════════════════════════════════════════════════
step 9 "Done"

# Show dataset count
DS_COUNT=$(curl -sf http://localhost:3000/api/terapeak/datasets 2>/dev/null \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('count', '?'))" 2>/dev/null || echo "?")
ok "Terapeak store now has $DS_COUNT datasets"
echo ""
echo -e "${GREEN}${BOLD}Export complete! The server is still running on port 3000.${NC}"
echo -e "Press Ctrl+C to shut down, or leave it running to use the app."
echo ""

# Keep alive until user hits Ctrl+C (cleanup trap handles shutdown)
wait "$SERVER_PID" 2>/dev/null || true
