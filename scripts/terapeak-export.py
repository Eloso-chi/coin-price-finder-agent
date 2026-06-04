#!/usr/bin/env python3
"""
terapeak-export.py -- Semi-automated Terapeak CSV exporter

Automates the eBay Seller Hub Research (Terapeak) export workflow:
  Phase 1 (manual):  You log in via a visible browser. Cookies are saved.
  Phase 2 (automated): Script searches each coin, exports CSV, uploads to the app.

Usage:
  # First run -- opens browser for manual login, saves cookies:
  python3 scripts/terapeak-export.py --login

  # Export all coins (uses saved cookies):
  python3 scripts/terapeak-export.py --run

  # Export specific coins:
  python3 scripts/terapeak-export.py --run --filter "Morgan"
  python3 scripts/terapeak-export.py --run --filter "Libertad"

  # Export first 10 coins only:
  python3 scripts/terapeak-export.py --run --limit 10

  # Resume from where you left off after interruption:
  python3 scripts/terapeak-export.py --run --resume

  # Refresh stale data (refresh CSVs older than N days):
  python3 scripts/terapeak-export.py --run --refresh --max-age 14
  python3 scripts/terapeak-export.py --run --refresh --max-age 30 --filter "Morgan"

  # Exclude low-signal datasets (fewer than N comps in terapeak-meta.json):
  python3 scripts/terapeak-export.py --run --refresh --max-age 15 --min-comps 10

  # Dry run -- show what would be exported:
  python3 scripts/terapeak-export.py --dry-run

  # Check cookie freshness:
  python3 scripts/terapeak-export.py --check

Requirements:
  pip install playwright requests
  python3 -m playwright install chromium
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("ERROR: playwright not installed. Run: pip install playwright && python3 -m playwright install chromium")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("ERROR: requests not installed. Run: pip install requests")
    sys.exit(1)

# ── Config ──────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent

# #250: COOKIE_FILE env override lets the same script run from multiple machines
# (e.g. Surface laptop on residential IP + Codespace as travel fallback) without
# their cookie jars colliding -- Akamai treats one persistent identity on two
# disparate IPs/fingerprints as a fraud signal and trips CAPTCHA.
# Keep the in-repo default (cache/ebay_cookies.json) so existing single-machine
# workflows are unchanged. Override with e.g. COOKIE_FILE=~/cpf/cookies-surface.json.
COOKIE_FILE = Path(os.path.expanduser(
    os.environ.get("COOKIE_FILE", str(PROJECT_DIR / "cache" / "ebay_cookies.json"))
))
PROGRESS_FILE = PROJECT_DIR / "cache" / "terapeak_export_progress.json"
DOWNLOAD_DIR = PROJECT_DIR / "cache" / "terapeak_downloads"
TERAPEAK_DIR = PROJECT_DIR / "data" / "terapeak"
CSV_DIR = TERAPEAK_DIR  # where to save exported CSVs

APP_URL = os.environ.get("APP_URL", "http://localhost:3000")
ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "")

# Azure Blob config (for direct-to-blob upload, bypassing local server)
BLOB_ACCOUNT = os.environ.get("TERAPEAK_BLOB_ACCOUNT", "")
BLOB_CONTAINER = os.environ.get("TERAPEAK_BLOB_CONTAINER", "")

# Upload mode selection (#251 -- local vs codespaces parity)
#   api  -- POST every CSV to APP_URL /api/terapeak/import (default; deterministic;
#           triggers immediate import + freshness/dormancy progression).
#   blob -- Upload to Azure Blob only; ingestion is DEFERRED until the server's
#           startup blob import or an explicit POST /api/terapeak/reimport call.
#   auto -- Legacy behavior: blob first if configured, fall back to API.
UPLOAD_MODE = os.environ.get("UPLOAD_MODE", "api").strip().lower()
if UPLOAD_MODE not in ("api", "blob", "auto"):
    print(f"[warn] UPLOAD_MODE='{UPLOAD_MODE}' is invalid; falling back to 'api'.")
    UPLOAD_MODE = "api"

# Optional: when set to a truthy value, emit explicit warnings whenever the
# upload path cannot confirm immediate ingestion (e.g. blob mode).
VERIFY_IMPORT = os.environ.get("VERIFY_IMPORT", "").strip().lower() in ("1", "true", "yes", "on")

# Auto-read keys from .env if not set in environment
if not ADMIN_API_KEY or not BLOB_ACCOUNT:
    env_file = PROJECT_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("ADMIN_API_KEY=") and not ADMIN_API_KEY:
                ADMIN_API_KEY = line.split("=", 1)[1].strip()
            elif line.startswith("TERAPEAK_BLOB_ACCOUNT=") and not BLOB_ACCOUNT:
                BLOB_ACCOUNT = line.split("=", 1)[1].strip()
            elif line.startswith("TERAPEAK_BLOB_CONTAINER=") and not BLOB_CONTAINER:
                BLOB_CONTAINER = line.split("=", 1)[1].strip()

EBAY_RESEARCH_URL = "https://www.ebay.com/sh/research"
EBAY_LOGIN_URL = "https://signin.ebay.com/ws/eBayISAPI.dll?SignIn"

# Human-like delays (seconds) -- staggered to avoid pattern detection
DELAY_BETWEEN_SEARCHES = (5, 12)   # base delay between coins
DELAY_AFTER_EXPORT = (2, 5)        # after clicking Export
DELAY_PAGE_LOAD = (2, 4)           # after navigation
DELAY_TYPING = (0.03, 0.10)        # per-character typing speed
DELAY_BEFORE_CLICK = (0.3, 0.9)    # pause before clicking a button
DELAY_MICRO = (0.15, 0.6)          # tiny pauses between actions

# Every N coins, take a longer "coffee break" to look natural
COFFEE_BREAK_EVERY = (20, 40)      # random interval
COFFEE_BREAK_DURATION = (15, 45)   # 15-45 second pause

import random
import math


def has_display():
    """Check if a graphical display is available (X11/Wayland)."""
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))

def rand_delay(range_tuple):
    """Sleep for a random duration within the given range."""
    time.sleep(random.uniform(*range_tuple))


# ── Human mouse/scroll simulation ──────────────────────────
# Distil and similar fingerprinters track mouse trajectory, speed curves,
# and scroll behavior.  Teleporting the cursor is a dead giveaway.

def _bezier_point(t, p0, p1, p2, p3):
    """Cubic bezier interpolation at parameter t."""
    u = 1 - t
    return (u**3 * p0 + 3 * u**2 * t * p1
            + 3 * u * t**2 * p2 + t**3 * p3)


def human_mouse_move(page, target_x, target_y, steps=None):
    """Move mouse along a slightly curved bezier path to (target_x, target_y).
    Mimics natural hand tremor with small random offsets per step."""
    # Get current mouse position (default to a random spot if unknown)
    start_x = getattr(page, '_mouse_x', random.randint(100, 400))
    start_y = getattr(page, '_mouse_y', random.randint(100, 300))

    dist = math.hypot(target_x - start_x, target_y - start_y)
    if steps is None:
        steps = max(12, int(dist / 8) + random.randint(-3, 5))

    # Two random control points for a natural curve
    cp1x = start_x + (target_x - start_x) * 0.3 + random.uniform(-40, 40)
    cp1y = start_y + (target_y - start_y) * 0.2 + random.uniform(-30, 30)
    cp2x = start_x + (target_x - start_x) * 0.7 + random.uniform(-30, 30)
    cp2y = start_y + (target_y - start_y) * 0.8 + random.uniform(-20, 20)

    for i in range(1, steps + 1):
        t = i / steps
        # Ease-out curve: fast start, slow finish (like a real hand)
        t_ease = 1 - (1 - t) ** 2.2
        x = _bezier_point(t_ease, start_x, cp1x, cp2x, target_x)
        y = _bezier_point(t_ease, start_y, cp1y, cp2y, target_y)
        # Tiny tremor
        x += random.uniform(-1.5, 1.5)
        y += random.uniform(-1.5, 1.5)
        page.mouse.move(x, y)
        # Variable speed: faster in the middle, slower at endpoints
        speed = 0.003 + 0.012 * (1 - abs(2 * t - 1))
        time.sleep(speed + random.uniform(0, 0.005))

    # Snap to exact target at the end
    page.mouse.move(target_x, target_y)
    page._mouse_x = target_x
    page._mouse_y = target_y


def human_click(page, element):
    """Move mouse to element center with bezier path, then click."""
    box = element.bounding_box()
    if not box:
        element.click()
        return
    # Click slightly off-center (real users don't hit dead center)
    cx = box["x"] + box["width"] * random.uniform(0.3, 0.7)
    cy = box["y"] + box["height"] * random.uniform(0.35, 0.65)
    human_mouse_move(page, cx, cy)
    rand_delay((0.05, 0.15))
    page.mouse.click(cx, cy)
    rand_delay(DELAY_MICRO)


def human_scroll(page, direction="down", distance=None):
    """Scroll using mouse wheel events with variable speed, like a real scroll wheel."""
    if distance is None:
        distance = random.randint(250, 600)
    # Number of discrete wheel ticks
    ticks = random.randint(4, 10)
    per_tick = distance / ticks
    sign = 1 if direction == "down" else -1

    for _ in range(ticks):
        delta = per_tick * sign + random.uniform(-20, 20)
        page.mouse.wheel(0, delta)
        time.sleep(random.uniform(0.04, 0.18))

    # Tiny pause after scroll, like a human reading
    time.sleep(random.uniform(0.3, 1.0))


def human_idle(page):
    """Simulate a brief idle period -- human looking at the page. Occasionally
    wiggle the mouse a little."""
    idle_time = random.uniform(1.5, 4.0)
    end = time.time() + idle_time
    while time.time() < end:
        if random.random() < 0.3:
            # Small mouse wiggle
            dx = random.uniform(-30, 30)
            dy = random.uniform(-20, 20)
            cx = getattr(page, '_mouse_x', 640) + dx
            cy = getattr(page, '_mouse_y', 450) + dy
            cx = max(10, min(1260, cx))
            cy = max(10, min(880, cy))
            page.mouse.move(cx, cy)
            page._mouse_x = cx
            page._mouse_y = cy
        time.sleep(random.uniform(0.3, 0.8))


# ── Smart render waits (#198) ───────────────────────────────
# Replace blanket `time.sleep(3)` after page transitions with a selector-bounded
# wait. We wait up to `total_seconds` for the relevant DOM element to appear;
# if it arrives early we proceed immediately, otherwise we fall back to a
# fixed sleep covering the remaining budget. Worst-case wall-clock is exactly
# `total_seconds` -- identical to the original blanket sleep.
#
# Note (PR #67 review finding #2): we intentionally only key on positive-render
# selectors (results table / search input). Empty-results selectors were dropped
# because they're speculative and would inflate worst-case waits if they don't
# match the live DOM.

# Terapeak results table marker (set in EXTRACT_TABLE_JS, line 507).
_RESULTS_READY_SELECTOR = 'tr.research-table-header'

# Research-page UI marker for post-goto session verification.
_RESEARCH_PAGE_SELECTOR = (
    'input[placeholder*="keyword"], '
    'input[placeholder*="MPN"], '
    '#researchKeywords'
)


def _wait_for_selector_or_fallback(page, selector, total_seconds):
    """Wait up to `total_seconds` for `selector`, then sleep any remaining
    budget. Worst-case wall-clock == total_seconds (matches original blanket
    sleep). Returns True if the selector appeared, False if we fell back."""
    start = time.monotonic()
    try:
        page.wait_for_selector(selector, timeout=int(total_seconds * 1000), state="attached")
        return True
    except Exception:
        remaining = total_seconds - (time.monotonic() - start)
        if remaining > 0:
            time.sleep(remaining)
        return False


def wait_for_results_render(page, total_seconds=3.0):
    """Wait for the Terapeak results table to render after a search/pagination.
    Worst-case wall-clock == total_seconds. Returns True on selector hit."""
    return _wait_for_selector_or_fallback(page, _RESULTS_READY_SELECTOR, total_seconds)


def wait_for_research_page(page, total_seconds=3.0):
    """Wait for the Terapeak Research page UI (search input) to render after
    a navigation. Worst-case wall-clock == total_seconds."""
    return _wait_for_selector_or_fallback(page, _RESEARCH_PAGE_SELECTOR, total_seconds)


# Characters near each key on a QWERTY keyboard for realistic typos
_NEARBY_KEYS = {
    'a': 'sqwz', 'b': 'vghn', 'c': 'xdfv', 'd': 'sfecx', 'e': 'wrsdf',
    'f': 'dgrtcv', 'g': 'fhtyb', 'h': 'gjyun', 'i': 'ujko', 'j': 'hkuinm',
    'k': 'jloi', 'l': 'kop', 'm': 'njk', 'n': 'bhjm', 'o': 'iklp',
    'p': 'ol', 'q': 'wa', 'r': 'edft', 's': 'adwxz', 't': 'rfgy',
    'u': 'yhji', 'v': 'cfgb', 'w': 'qase', 'x': 'zsdc', 'y': 'tghu',
    'z': 'asx', '1': '2q', '2': '13qw', '3': '24we', '4': '35er',
    '5': '46rt', '6': '57ty', '7': '68yu', '8': '79ui', '9': '80io',
    '0': '9op',
}


def human_type(element, text, page=None):
    """Type text character by character with random delays, like a human.
    Occasionally makes a typo (nearby key), pauses, backspaces, and retypes.
    If page is provided, occasionally pause mid-word (like thinking).

    For long strings (>20 chars), pastes most of the text and types the
    last few characters -- mimics a common copy-paste-then-adjust pattern
    that real users exhibit when entering saved search terms.
    """
    # For long terms, paste the bulk and type the tail (natural copy-paste)
    PASTE_THRESHOLD = 20
    TAIL_LEN = random.randint(4, 8)
    if len(text) > PASTE_THRESHOLD and page:
        paste_part = text[:-TAIL_LEN]
        type_part = text[-TAIL_LEN:]
        # Clipboard paste (Ctrl+V / Meta+V)
        element.fill(paste_part)
        time.sleep(random.uniform(0.2, 0.5))
        # Place cursor at end and type remaining chars naturally
        element.press("End")
        time.sleep(random.uniform(0.1, 0.3))
        text = type_part  # fall through to char-by-char loop below

    for i, ch in enumerate(text):
        # ~4% chance of typo on letters/digits (skip spaces and punctuation)
        if ch.lower() in _NEARBY_KEYS and random.random() < 0.04:
            # Type a wrong (nearby) key
            wrong = random.choice(_NEARBY_KEYS[ch.lower()])
            if ch.isupper():
                wrong = wrong.upper()
            element.type(wrong, delay=random.uniform(*DELAY_TYPING) * 1000)
            # Brief pause -- "oh wait, that's wrong"
            time.sleep(random.uniform(0.15, 0.45))
            element.press("Backspace")
            time.sleep(random.uniform(0.08, 0.2))
            # Now type the correct character
        element.type(ch, delay=random.uniform(*DELAY_TYPING) * 1000)
        # Occasional mid-word pause (thinking about what to type next)
        if page and random.random() < 0.06 and i > 0:
            time.sleep(random.uniform(0.3, 0.8))
    rand_delay(DELAY_MICRO)


# ── Cookie Management ───────────────────────────────────────
def save_cookies(context):
    """Save browser cookies to disk."""
    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    cookies = context.cookies()
    with open(COOKIE_FILE, "w") as f:
        json.dump(cookies, f, indent=2)
    print(f"  Saved {len(cookies)} cookies to {COOKIE_FILE}")


def load_cookies(context):
    """Load saved cookies into browser context."""
    if not COOKIE_FILE.exists():
        return False
    with open(COOKIE_FILE) as f:
        cookies = json.load(f)
    # Normalize for Playwright: sameSite must be Strict|Lax|None
    VALID_SAME_SITE = {"Strict", "Lax", "None"}
    for c in cookies:
        ss = c.get("sameSite", "")
        if ss not in VALID_SAME_SITE:
            # Map common Cookie-Editor values
            mapped = {"strict": "Strict", "lax": "Lax", "none": "None",
                      "no_restriction": "None", "unspecified": "Lax"}
            c["sameSite"] = mapped.get(ss.lower(), "Lax") if ss else "Lax"
        # Remove fields Playwright doesn't accept
        for key in ["hostOnly", "storeId", "id"]:
            c.pop(key, None)
    context.add_cookies(cookies)
    print(f"  Loaded {len(cookies)} cookies from {COOKIE_FILE}")
    return True


def check_cookies():
    """Check if saved cookies exist and are recent."""
    if not COOKIE_FILE.exists():
        print("No saved cookies found. Run with --login first.")
        return False
    mtime = datetime.fromtimestamp(COOKIE_FILE.stat().st_mtime)
    age_hours = (datetime.now() - mtime).total_seconds() / 3600
    print(f"Cookie file: {COOKIE_FILE}")
    print(f"Last saved: {mtime.strftime('%Y-%m-%d %H:%M:%S')} ({age_hours:.1f} hours ago)")
    if age_hours > 12:
        print("WARNING: Cookies may be expired. Run --login to refresh.")
        return False
    print("Cookies look fresh.")
    return True


# ── Progress Tracking ───────────────────────────────────────
def load_progress():
    """Load export progress (for --resume)."""
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {"completed": [], "failed": [], "last_run": None}


def save_progress(progress):
    """Save export progress."""
    PROGRESS_FILE.parent.mkdir(parents=True, exist_ok=True)
    progress["last_run"] = datetime.now().isoformat()
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=2)


# ── Search Terms ────────────────────────────────────────────
# Negative keywords appended to proof searches to exclude graded/slabbed results.
# These items are captured by their own graded-specific search terms instead.
PROOF_NEGATIVE_KEYWORDS = " -NGC -PCGS -graded -slab -certified"

# Pattern to detect proof search terms that are NOT already grade-specific.
# A term like "1986 Mexico 1oz Silver Libertad Proof" is raw-proof.
# A term like "1986 Morgan Silver Dollar MS65" is already grade-specific.
# Exclude "Proof Set" which are sealed government sets, not individual coins.
import re as _re
_GRADE_SUFFIX_RE = _re.compile(r'\b(MS|PR|PF|SP|AU|XF|EF|VF|VG|AG|FR|PO)\s*\d{1,2}\+?\s*$', _re.IGNORECASE)
_PROOF_COIN_RE = _re.compile(r'\bproof\b(?![\s\-_/]*set)', _re.IGNORECASE)


def get_search_terms():
    """Get search terms from existing CSV filenames in data/terapeak/."""
    terms = []
    for f in sorted(TERAPEAK_DIR.glob("*.csv")):
        meta = f.with_suffix(".meta")
        if meta.exists():
            term = meta.read_text().strip()
        else:
            term = f.stem.replace("_", " ")

        # Build search query: append negative keywords for raw proof coin searches
        # (not proof sets, not already-graded searches)
        search_query = term
        if _PROOF_COIN_RE.search(term) and not _GRADE_SUFFIX_RE.search(term):
            search_query = term + PROOF_NEGATIVE_KEYWORDS

        terms.append({"term": term, "filename": f.name, "search_query": search_query})
    return terms


# ── CSV Merge (preserves deep-paginated data on refresh) ────
def _merge_csv(new_csv_path, existing_csv_path):
    """Merge new CSV rows into existing CSV, deduplicating by Item ID and
    title+price+date.  Returns the path of the merged file (always existing_csv_path).
    If the existing file doesn't exist, simply moves new_csv into place."""
    if not existing_csv_path.exists():
        new_csv_path.rename(existing_csv_path)
        return existing_csv_path

    # Read existing rows
    existing_rows = {}  # dedup key -> row
    existing_ids = set()
    header = None
    with open(existing_csv_path, "r", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        for row in reader:
            if len(row) < 4:
                continue
            item_id = row[1].strip() if len(row) > 1 else ""
            title = row[0].strip().lower()[:80]
            price = row[3].strip() if len(row) > 3 else ""
            date = row[2].strip() if len(row) > 2 else ""
            dedup_key = f"{title}|{price}|{date}"
            if item_id:
                existing_ids.add(item_id)
            existing_rows[dedup_key] = row

    # Read new rows and merge
    new_count = 0
    with open(new_csv_path, "r", newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        new_header = next(reader, None)
        if header is None:
            header = new_header
        for row in reader:
            if len(row) < 4:
                continue
            item_id = row[1].strip() if len(row) > 1 else ""
            title = row[0].strip().lower()[:80]
            price = row[3].strip() if len(row) > 3 else ""
            date = row[2].strip() if len(row) > 2 else ""
            # Skip if item ID already exists
            if item_id and item_id in existing_ids:
                continue
            dedup_key = f"{title}|{price}|{date}"
            if dedup_key in existing_rows:
                continue
            existing_rows[dedup_key] = row
            if item_id:
                existing_ids.add(item_id)
            new_count += 1

    # Shrink guard: refuse to write if merged result would be smaller than existing
    all_rows = list(existing_rows.values())
    existing_row_count = sum(1 for _ in open(existing_csv_path, encoding="utf-8")) - 1  # minus header
    if len(all_rows) < existing_row_count:
        print(f"    SHRINK GUARD: merged ({len(all_rows)}) < existing ({existing_row_count}) -- keeping existing")
        if new_csv_path.exists() and new_csv_path != existing_csv_path:
            new_csv_path.unlink()
        return existing_csv_path

    # Write merged result (sorted by date descending for readability)
    # Sort by sold date descending (column index 2)
    def sort_key(row):
        try:
            from datetime import datetime as _dt
            return _dt.strptime(row[2].strip().strip('"'), "%b %d, %Y")
        except (ValueError, IndexError):
            return datetime.min
    all_rows.sort(key=sort_key, reverse=True)

    with open(existing_csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if header:
            writer.writerow(header)
        writer.writerows(all_rows)

    # Clean up temp file
    if new_csv_path.exists() and new_csv_path != existing_csv_path:
        new_csv_path.unlink()

    return existing_csv_path


# ── Upload to Azure Blob Storage ────────────────────────────
def upload_to_blob(csv_path):
    """Upload a CSV file directly to Azure Blob Storage.
    Returns (True, message) on success, (False, message) on failure."""
    if not BLOB_ACCOUNT or not BLOB_CONTAINER:
        return False, "Blob not configured (set TERAPEAK_BLOB_ACCOUNT + TERAPEAK_BLOB_CONTAINER)"
    try:
        from azure.storage.blob import BlobServiceClient
        from azure.identity import DefaultAzureCredential
    except ImportError:
        return False, "azure-storage-blob or azure-identity not installed"

    try:
        blob_name = os.path.basename(csv_path)
        url = f"https://{BLOB_ACCOUNT}.blob.core.windows.net"
        credential = DefaultAzureCredential()
        service = BlobServiceClient(url, credential=credential)
        container = service.get_container_client(BLOB_CONTAINER)
        with open(csv_path, "rb") as f:
            container.upload_blob(blob_name, f, overwrite=True,
                                  content_settings={"content_type": "text/csv"})
        size_kb = os.path.getsize(csv_path) / 1024
        return True, f"blob:{blob_name} ({size_kb:.1f} KB)"
    except Exception as e:
        return False, f"Blob upload error: {e}"


# ── Upload to App ───────────────────────────────────────────
def upload_csv(csv_path, search_term, aggregation_meta=None):
    """Upload a CSV honoring UPLOAD_MODE.

    Modes (set via the UPLOAD_MODE env var):
      api  -- POST to APP_URL /api/terapeak/import. Immediate import +
              freshness/dormancy progression. Recommended default.
      blob -- Upload only to Azure Blob. Ingestion is DEFERRED until server
              startup blob import or a POST to /api/terapeak/reimport. No API
              fallback in this mode; failures are returned to the caller.
      auto -- Legacy: blob first if configured, fall back to API.

    aggregation_meta (optional dict): keys like page1At, deepAt, maxPageReached,
    lastRefreshAt to track aggregation depth per dataset.
    """
    # Pure blob mode -- explicit, no API fallback
    if UPLOAD_MODE == "blob":
        if not (BLOB_ACCOUNT and BLOB_CONTAINER):
            return False, ("UPLOAD_MODE=blob but TERAPEAK_BLOB_ACCOUNT/"
                           "TERAPEAK_BLOB_CONTAINER are unset")
        ok, msg = upload_to_blob(csv_path)
        if ok and VERIFY_IMPORT:
            print(f"    [verify] blob upload ok; ingestion DEFERRED until "
                  f"server startup or /api/terapeak/reimport ({msg})")
        elif ok:
            # Brief note so logs make the deferred nature obvious even without VERIFY_IMPORT
            print(f"    [blob mode] ingestion deferred -- run reimport to surface {msg}")
        return ok, msg

    # Auto (legacy) mode -- try blob first when configured, then API
    if UPLOAD_MODE == "auto" and BLOB_ACCOUNT and BLOB_CONTAINER:
        ok, msg = upload_to_blob(csv_path)
        if ok:
            if VERIFY_IMPORT:
                print(f"    [verify] auto-mode blob path succeeded; "
                      f"ingestion DEFERRED ({msg})")
            return True, msg
        # Blob failed -- fall back to server POST
        print(f"    [blob fallback] {msg}")

    # api mode (default) and auto-mode fallthrough -- POST to server
    url = f"{APP_URL}/api/terapeak/import"
    headers = {}
    if ADMIN_API_KEY:
        headers["x-api-key"] = ADMIN_API_KEY

    try:
        with open(csv_path, "rb") as f:
            files = {"file": (os.path.basename(csv_path), f, "text/csv")}
            data = {"searchTerm": search_term}
            # Include aggregationMeta fields if provided
            if aggregation_meta:
                for k, v in aggregation_meta.items():
                    if v is not None:
                        data[k] = str(v)
            resp = requests.post(url, files=files, data=data, headers=headers, timeout=30)

        if resp.status_code == 200:
            result = resp.json()
            imp = result.get("import", {})
            return True, f"{imp.get('newComps', '?')} new, {imp.get('duplicatesSkipped', '?')} dups"
        elif resp.status_code == 401:
            return False, "Auth failed -- set ADMIN_API_KEY env var"
        elif resp.status_code == 429:
            return False, "Quota exceeded"
        else:
            return False, f"HTTP {resp.status_code}: {resp.text[:200]}"
    except requests.exceptions.ConnectionError:
        return False, f"Cannot connect to {APP_URL} -- is the server running?"
    except Exception as e:
        return False, str(e)


import threading

# Last async upload result -- checked before starting the next coin
_last_upload_result = {"ok": None, "msg": None, "term": None, "thread": None}

def upload_csv_async(csv_path, search_term, aggregation_meta=None, cleanup=False):
    """Fire-and-forget wrapper around upload_csv. Runs the upload in a
    background thread so the next coin's navigation can start immediately.
    Call drain_upload() before the next upload to log the previous result.
    If cleanup=True, deletes csv_path after upload finishes."""
    # Drain any pending upload first
    drain_upload()

    def _worker():
        try:
            ok, msg = upload_csv(csv_path, search_term, aggregation_meta)
            _last_upload_result["ok"] = ok
            _last_upload_result["msg"] = msg
        except Exception as e:
            _last_upload_result["ok"] = False
            _last_upload_result["msg"] = str(e)
        finally:
            if cleanup:
                try:
                    Path(csv_path).unlink(missing_ok=True)
                except Exception:
                    pass

    _last_upload_result["term"] = search_term
    _last_upload_result["ok"] = None
    t = threading.Thread(target=_worker, daemon=True)
    _last_upload_result["thread"] = t
    t.start()


def drain_upload(timeout=10):
    """Wait for the last async upload to finish and log the result."""
    t = _last_upload_result.get("thread")
    if t is None or not t.is_alive():
        return
    t.join(timeout=timeout)
    term = _last_upload_result.get("term", "?")
    ok = _last_upload_result.get("ok")
    msg = _last_upload_result.get("msg", "?")
    if ok is None:
        print(f"  [async upload] {term}: timed out after {timeout}s")
    elif not ok:
        print(f"  [async upload] {term}: failed -- {msg}")


def _report_no_data(search_term):
    """Notify the server that Terapeak returned no results for this dataset.
    Increments noDataCount so the freshness triage can mark it dormant."""
    url = f"{APP_URL}/api/terapeak/report-no-data"
    headers = {"Content-Type": "application/json"}
    if ADMIN_API_KEY:
        headers["x-api-key"] = ADMIN_API_KEY
    try:
        resp = requests.post(url, json={"searchTerm": search_term}, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            count = data.get("noDataCount", "?")
            if int(count) >= 2:
                print(f"  (dormant: {count} consecutive empty attempts)")
        else:
            print(f"  WARNING: report-no-data failed ({resp.status_code}): {resp.text[:120]}")
    except Exception as e:
        print(f"  WARNING: report-no-data request failed: {e}")


def _is_no_valid_comps_error(msg):
    """Best-effort classifier for upload responses that indicate zero valid
    parsed comps (HTTP 422 no-valid-comps)."""
    if not msg:
        return False
    low = str(msg).lower()
    return "http 422" in low and "no valid comps" in low


# ── Login Flow ──────────────────────────────────────────────
def do_login():
    """Open a visible browser for manual eBay login. Save cookies when done."""
    if not has_display():
        print("\nERROR: No display available (running in a container/Codespace).")
        print("Use --login-manual instead to paste cookies from your own browser.")
        print("")
        print("Quick steps:")
        print("  1. Open https://www.ebay.com in your own browser and log in")
        print("  2. Open DevTools (F12) -> Console tab")
        print("  3. Paste this and press Enter:")
        print("")
        print('     document.cookie.split("; ").map(c => { const [n,...v] = c.split("="); return {name:n,value:v.join("="),domain:".ebay.com",path:"/"}; })')
        print("")
        print("  4. Right-click the output -> Copy Object")
        print("  5. Run: python3 scripts/terapeak-export.py --login-manual")
        print("  6. Paste the JSON when prompted")
        return False

    print("\n=== Manual Login Phase ===")
    print("A browser window will open. Log in to your eBay account normally.")
    print("Handle any CAPTCHA or 2FA prompts yourself.")
    print("Once you're logged in and see the eBay home page, press ENTER here.\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
        )
        vw = 1280 + random.randint(-40, 40)
        vh = 900 + random.randint(-30, 30)
        context = browser.new_context(
            viewport={"width": vw, "height": vh},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/134.0.0.0 Safari/537.36"
            ),
        )
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        """)
        page = context.new_page()

        print("Opening eBay login page...")
        page.goto(EBAY_LOGIN_URL, wait_until="domcontentloaded")

        input("\n>>> Log in to eBay in the browser, then press ENTER here to continue... ")

        # Verify we're logged in by checking for the Research page
        print("Verifying login by navigating to Research tab...")
        page.goto(EBAY_RESEARCH_URL, wait_until="domcontentloaded")
        wait_for_research_page(page)  # #198: selector-bounded, sleep(3) fallback

        # Check if we landed on the research page or got redirected to login
        current_url = page.url
        if "signin" in current_url.lower() or "SignIn" in current_url:
            print("ERROR: Still on login page. Login may have failed.")
            print(f"Current URL: {current_url}")
            browser.close()
            return False

        print(f"Logged in successfully. Current URL: {current_url}")
        save_cookies(context)

        browser.close()
        print("\nLogin complete. Cookies saved. You can now run --run to export data.")
        return True


def do_login_manual():
    """Import cookies by pasting JSON from the user's own browser."""
    print("\n=== Manual Cookie Import ===")
    print("This lets you paste eBay cookies from your own browser.\n")
    print("Steps:")
    print("  1. Open https://www.ebay.com in your browser and make sure you're logged in")
    print("  2. Open DevTools (F12) -> Console tab")
    print("  3. Paste this one-liner and press Enter:\n")
    print('     JSON.stringify(document.cookie.split("; ").map(c => { const [n,...v] = c.split("="); return {name:n,value:v.join("="),domain:".ebay.com",path:"/"}; }))')
    print("")
    print("  4. Copy the entire JSON output (it starts with [ and ends with ])")
    print("  5. Paste it below:\n")

    lines = []
    print(">>> Paste cookie JSON, then press ENTER:")
    while True:
        try:
            line = input()
        except EOFError:
            break
        lines.append(line)
        # If we have what looks like complete JSON, stop immediately
        joined = "\n".join(lines).strip()
        if joined and joined.startswith("[") and joined.endswith("]"):
            break
        if joined and joined.startswith("'[") and joined.endswith("]'"):
            break
        # Also stop on empty line after content
        if not line.strip() and lines:
            break

    raw = "\n".join(lines).strip()
    if not raw:
        print("ERROR: No input received.")
        return False

    # Strip surrounding quotes (browser console wraps JSON.stringify output in quotes)
    if (raw.startswith("'") and raw.endswith("'")) or (raw.startswith('"') and raw.endswith('"')):
        raw = raw[1:-1]

    try:
        cookies = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON: {e}")
        print("Make sure you copied the full output starting with [ and ending with ]")
        return False

    if not isinstance(cookies, list) or len(cookies) == 0:
        print("ERROR: Expected a JSON array of cookie objects.")
        return False

    # Ensure required fields
    for c in cookies:
        if "name" not in c or "value" not in c:
            print(f"ERROR: Cookie missing 'name' or 'value': {c}")
            return False
        c.setdefault("domain", ".ebay.com")
        c.setdefault("path", "/")

    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(COOKIE_FILE, "w") as f:
        json.dump(cookies, f, indent=2)

    print(f"\n  Saved {len(cookies)} cookies to {COOKIE_FILE}")
    print("  You can now run --run to start exporting.")
    return True


def do_cookie_file(filepath):
    """Import cookies from a JSON file."""
    p = Path(filepath)
    if not p.exists():
        print(f"ERROR: File not found: {filepath}")
        return False

    raw = p.read_text().strip()
    # Strip surrounding quotes (browser console wraps output in quotes)
    if (raw.startswith("'") and raw.endswith("'")) or (raw.startswith('"') and raw.endswith('"')):
        raw = raw[1:-1]

    try:
        cookies = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in {filepath}: {e}")
        return False

    if not isinstance(cookies, list) or len(cookies) == 0:
        print("ERROR: Expected a JSON array of cookie objects.")
        return False

    for c in cookies:
        if "name" not in c or "value" not in c:
            print(f"ERROR: Cookie missing 'name' or 'value': {c}")
            return False
        c.setdefault("domain", ".ebay.com")
        c.setdefault("path", "/")

    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(COOKIE_FILE, "w") as f:
        json.dump(cookies, f, indent=2)

    print(f"Saved {len(cookies)} cookies from {filepath} to {COOKIE_FILE}")
    return True


# ── Export Flow ─────────────────────────────────────────────
def is_logged_in(page):
    """Quick check if the page indicates a logged-in session."""
    url = page.url.lower()
    if "signin" in url:
        return False
    # Check cookies for eBay login indicator (sin=in means signed in)
    cookies = page.context.cookies()
    for c in cookies:
        if c.get("name") == "ebay" and "sin" in c.get("value", "") and "in" in c.get("value", ""):
            return True
    # Fallback: check for common logged-in DOM indicators
    try:
        page.wait_for_selector('[data-testid="gh-user-btn"], #gh-ug, .gh-user, #gh-eb-u', timeout=5000)
        return True
    except PlaywrightTimeout:
        # Last resort: check if page content has user-specific elements
        content = page.content()
        if "Sign out" in content or "My eBay" in content:
            return True
        return False


## ── Sort state tracking (#200) ─────────────────────────────
# eBay Terapeak persists the sort preference within a session.
# After the first sort-by-date, subsequent searches keep the same order.
# We skip the 2 sort clicks + 2 networkidle waits for subsequent coins,
# saving ~6s per coin.  Reset on browser recycle.
_sort_confirmed = False


def reset_sort_state():
    """Call after browser recycle to force re-sort on next search."""
    global _sort_confirmed
    _sort_confirmed = False


def do_search_and_export(page, search_term, download_dir):
    """
    Perform a Terapeak search and trigger CSV export.
    Returns the path to the downloaded CSV, or None on failure.
    """
    global _sort_confirmed
    # Navigate to Research page
    page.goto(EBAY_RESEARCH_URL, wait_until="domcontentloaded")
    rand_delay(DELAY_PAGE_LOAD)

    # Simulate human arrival: idle look-around + small scroll
    human_idle(page)
    human_scroll(page, "down", random.randint(80, 200))
    time.sleep(random.uniform(0.5, 1.5))
    human_scroll(page, "up", random.randint(60, 150))

    # Debug: log redirects (keep this -- it's useful)
    actual_url = page.url
    if "/sh/research" not in actual_url:
        print(f"    WARNING: Redirected to {actual_url}")
        page.screenshot(path=str(download_dir / f"_debug_redirect_{search_term[:30]}.png"))
        # Bot detection wall -- return sentinel so caller can abort
        if "distil" in actual_url or "splashui" in actual_url or "block" in actual_url:
            return "BOT_BLOCKED"

    # Find and fill the Terapeak search box (NOT the main eBay search bar)
    # Terapeak input placeholder: "Enter keywords, MPN, UPC, EPID, EAN or ISBN"
    search_selectors = [
        'input[placeholder*="keywords, MPN"]',
        'input[placeholder*="Enter keywords"]',
        'input[placeholder*="keyword"]',
        '#researchKeywords',
        '.research-bar input',
    ]

    search_input = None
    for sel in search_selectors:
        try:
            search_input = page.wait_for_selector(sel, timeout=3000)
            if search_input:
                break
        except PlaywrightTimeout:
            continue

    if not search_input:
        print(f"    ERROR: Cannot find Terapeak search input on Research page")
        page.screenshot(path=str(download_dir / "_debug_no_search.png"))
        return None

    # Clear and type search term like a human
    rand_delay(DELAY_BEFORE_CLICK)
    human_click(page, search_input)
    search_input.fill("")
    rand_delay(DELAY_MICRO)
    human_type(search_input, search_term, page=page)
    rand_delay(DELAY_MICRO)

    # Click the "Research" button (not Enter, which triggers main eBay search)
    research_btn_selectors = [
        'button.search-input-panel__research-button',
        'button.btn--primary:not(#gh-search-btn):has-text("Research")',
    ]
    research_btn = None
    for sel in research_btn_selectors:
        try:
            research_btn = page.wait_for_selector(sel, timeout=5000)
            if research_btn and research_btn.is_visible():
                break
            research_btn = None
        except PlaywrightTimeout:
            continue

    if research_btn:
        rand_delay(DELAY_BEFORE_CLICK)
        human_click(page, research_btn)
    else:
        # Fallback to Enter on the Terapeak input
        rand_delay(DELAY_BEFORE_CLICK)
        search_input.press("Enter")

    rand_delay(DELAY_PAGE_LOAD)

    # Wait for results to load
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except PlaywrightTimeout:
        pass  # Continue anyway -- networkidle can be flaky

    # Extra wait for Terapeak SPA to render results (#198: selector-bounded)
    wait_for_results_render(page)

    # ── S0: Active Listings Guard (tab check) ──────────────────
    # When Terapeak has no sold results, eBay may auto-switch to
    # "Active listings" tab. Detect this and abort early.
    active_tab_detected = page.evaluate("""() => {
        // Look for tab/pill indicating "Active listings" is selected
        const tabs = document.querySelectorAll(
            '[role="tab"][aria-selected="true"], '
            + '.tab--active, .tab-item--active, '
            + 'button[aria-pressed="true"]'
        );
        for (const tab of tabs) {
            const txt = tab.innerText.toLowerCase();
            if (txt.includes('active') && !txt.includes('sold')) return true;
        }
        // Also check for "Active listings" in breadcrumb/heading context
        const headings = document.querySelectorAll('h1, h2, h3, [class*="tab-label"]');
        for (const h of headings) {
            if (h.innerText.toLowerCase().includes('active listings')) return true;
        }
        return false;
    }""")
    if active_tab_detected:
        print(f"    WARNING: Active Listings tab detected (no sold data) -- skipping")
        page.screenshot(path=str(download_dir / f"_debug_active_tab_{search_term[:30]}.png"))
        return None

    # Scroll down progressively with mouse wheel to reveal sold listings table
    for _ in range(random.randint(3, 5)):
        human_scroll(page, "down", random.randint(200, 500))
        time.sleep(random.uniform(0.3, 0.8))
    # Brief idle -- human scanning results
    human_idle(page)

    # ── Sort by "Date last sold" (descending = most recent first) ──
    # Default sort is Best Match.  Clicking the column header once sorts
    # ascending (oldest first); clicking again sorts descending (newest first).
    # We want descending so page 1 captures the most recent sales.
    # Optimization (#200): eBay persists sort within session -- skip after first.
    if not _sort_confirmed:
        try:
            date_header = page.query_selector(
                'th:has-text("Date last sold"), '
                'th:has-text("Date Last Sold"), '
                'button:has-text("Date last sold")'
            )
            if date_header:
                rand_delay(DELAY_BEFORE_CLICK)
                human_click(page, date_header)
                time.sleep(random.uniform(1.5, 3.0))
                try:
                    page.wait_for_load_state("networkidle", timeout=10000)
                except PlaywrightTimeout:
                    pass
                # Check sort direction via JS (handles both th and button inside th)
                sort_dir = date_header.evaluate(
                    "el => (el.getAttribute('aria-sort') || el.closest('th')?.getAttribute('aria-sort') || '')"
                )
                if sort_dir == "ascending":
                    rand_delay(DELAY_BEFORE_CLICK)
                    human_click(page, date_header)
                    time.sleep(random.uniform(1.5, 3.0))
                    try:
                        page.wait_for_load_state("networkidle", timeout=10000)
                    except PlaywrightTimeout:
                        pass
                _sort_confirmed = True
                # Re-scroll after sort reloads
                for _ in range(random.randint(2, 4)):
                    human_scroll(page, "down", random.randint(200, 500))
                    time.sleep(random.uniform(0.3, 0.7))
        except Exception as e:
            print(f"    (sort by date skipped: {e})")

    # Debug: viewport-only screenshot (full_page=True can OOM on heavy pages)
    page.screenshot(path=str(download_dir / f"_debug_after_search_{search_term[:30]}.png"))

    # ── Extract sold listings directly from DOM ──────────────────
    # Terapeak no longer provides a CSV Export button.
    # Read the results table and generate CSV ourselves.
    #
    # Known Terapeak column layout (Apr 2026):
    #   0: Listing (image + title)     4: Total sold (qty)
    #   1: Actions ("Edit")            5: Item sales (total $)
    #   2: Avg sold price + format     6: Bids
    #   3: Avg shipping + % info       7: Date last sold
    #
    # No <tbody> -- <tr> are direct children of <table>.
    # Some rows are policy-violation stubs with only 1 cell -- skip them.
    extracted = page.evaluate("""() => {
        let target = null;
        document.querySelectorAll('table').forEach(t => {
            if (t.querySelector('tr.research-table-header')) target = t;
        });
        if (!target) {
            let bestCount = 0;
            document.querySelectorAll('table').forEach(t => {
                const n = t.querySelectorAll('tr').length;
                if (n > bestCount) { bestCount = n; target = t; }
            });
        }
        if (!target) return { rows: [], tableCount: document.querySelectorAll('table').length };

        const rows = [];
        target.querySelectorAll('tr').forEach(tr => {
            if (tr.querySelector('th')) return;
            const tds = tr.querySelectorAll('td');
            if (tds.length < 6) return;

            // Use innerText split by newline -- first line has the value,
            // subsequent lines have sub-labels ("Fixed price", "100% Free shipping")
            const line0 = (i) => {
                if (i >= tds.length) return '';
                const lines = tds[i].innerText.trim().split('\\n');
                return lines[0] ? lines[0].trim() : '';
            };
            const line1 = (i) => {
                if (i >= tds.length) return '';
                const lines = tds[i].innerText.trim().split('\\n');
                return lines[1] ? lines[1].trim() : '';
            };

            const link = tr.querySelector('a[href*="/itm/"]');
            const title = link ? link.innerText.trim().split('\\n')[0] : '';
            const url = link ? link.href.split('?')[0] : '';

            // Extract item ID from URL or from "Item ID xxx" text
            let itemId = '';
            if (url) {
                const m = url.match(/\\/itm\\/(\\d+)/);
                if (m) itemId = m[1];
            }
            if (!itemId) {
                const txt = tds[0].innerText;
                const m2 = txt.match(/Item ID\\s*(\\d+)/i);
                if (m2) itemId = m2[1];
            }

            rows.push({
                title: title,
                itemId: itemId,
                url: url,
                price: line0(2),       // "$812.40"
                format: line1(2),      // "Fixed price" / "Auction"
                shipping: line0(3),    // "$0.00"
                qty: line0(4),         // "15"
                total: line0(5),       // "$12,185.99"
                bids: line0(6),        // "-" or "5"
                date: line0(7),        // "Mar 30, 2026"
            });
        });
        return { rows, tableCount: document.querySelectorAll('table').length };
    }""")

    rows = extracted.get("rows", [])

    if not rows:
        print(f"    WARNING: No data rows found ({extracted.get('tableCount', 0)} tables on page)")
        page.screenshot(path=str(download_dir / f"_debug_no_data_{search_term[:30]}.png"))
        return None

    # ── S0: Active Listings Guard (date validation) ────────────
    # Sold listings have a parseable date ("Mar 30, 2026").
    # Active listings have no date or show "Active" / blank.
    # If <20% of rows have a valid date, assume active listings page.
    DATE_PATTERN = re.compile(
        r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}',
        re.IGNORECASE
    )
    rows_with_date = sum(1 for r in rows if DATE_PATTERN.search(r.get("date", "")))
    date_ratio = rows_with_date / len(rows) if rows else 0
    if len(rows) >= 3 and date_ratio < 0.2:
        print(f"    WARNING: Only {rows_with_date}/{len(rows)} rows have valid sold dates "
              f"({date_ratio:.0%}) -- likely Active Listings, skipping")
        page.screenshot(path=str(download_dir / f"_debug_no_dates_{search_term[:30]}.png"))
        return None

    # Convert extracted rows to CSV records
    csv_rows = []
    for row in rows:
        title = row.get("title", "")
        price = row.get("price", "")

        # Skip rows with no title and no price (policy-violation stubs)
        if not title and not price:
            continue

        # Use "Item ID" text as fallback title for removed listings
        if not title and row.get("itemId"):
            title = f"[Removed] Item {row['itemId']}"

        # Clean up bids: "-" means no bids
        bids = row.get("bids", "")
        if bids == "-":
            bids = ""

        # Determine condition from format text (Terapeak doesn't show condition directly)
        condition = ""
        format_type = row.get("format", "")

        csv_rows.append([
            title,
            row.get("itemId", ""),
            row.get("date", ""),
            price,
            row.get("shipping", ""),
            condition,
            "",  # seller (not shown in Terapeak table)
            format_type,
            row.get("url", ""),
            row.get("qty", ""),
        ])

    if not csv_rows:
        print(f"    WARNING: Extracted {len(rows)} rows but none had usable title+price")
        page.screenshot(path=str(download_dir / f"_debug_no_data_{search_term[:30]}.png"))
        return None

    # Write CSV
    safe_name = re.sub(r'[^\w\s\-]', '', search_term).replace(' ', '_')[:80]
    csv_path = download_dir / f"{safe_name}.csv"
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Item Title", "Item ID", "Sold Date", "Sold Price",
                         "Shipping", "Condition", "Seller", "Format", "Item URL",
                         "Quantity Sold"])
        writer.writerows(csv_rows)

    # ── Validate date sort order (#200) ────────────────────────
    # If dates are NOT descending, the sort preference was lost (e.g. eBay
    # reset after a redirect).  Clear the flag so next search re-sorts.
    dates_parsed = []
    for r in csv_rows:
        d = r[2]  # Sold Date column
        if d:
            try:
                dates_parsed.append(datetime.strptime(d[:10], "%Y-%m-%d"))
            except (ValueError, IndexError):
                try:
                    dates_parsed.append(datetime.strptime(d[:10], "%m/%d/%Y"))
                except (ValueError, IndexError):
                    pass
    if len(dates_parsed) >= 3:
        # Check if first date >= last date (descending order)
        if dates_parsed[0] < dates_parsed[-1]:
            _sort_confirmed = False  # will re-sort on next search

    return csv_path


def do_export_run(args):
    """Main export loop -- iterate search terms, export CSVs, upload to app."""
    if not args.dry_run and not COOKIE_FILE.exists():
        print("ERROR: No saved cookies. Run --login first.")
        return

    # Prepare directories
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

    # Load search terms
    terms = get_search_terms()
    print(f"Found {len(terms)} search terms from data/terapeak/")

    # Apply filters
    if args.filter:
        pattern = re.compile(args.filter, re.IGNORECASE)
        terms = [t for t in terms if pattern.search(t["term"])]
        print(f"Filtered to {len(terms)} terms matching '{args.filter}'")

    # Apply backlog: read freshness report and keep only datasets needing page1 refresh
    if args.backlog:
        import json as _json
        backlog_path = Path(args.backlog)
        if not backlog_path.exists():
            print(f"ERROR: Backlog file not found: {args.backlog}")
            sys.exit(1)
        with open(backlog_path) as f:
            report = _json.load(f)
        backlog_filter = re.compile(args.filter, re.IGNORECASE) if args.filter else None
        # Only include priority tiers P0-P2 by default (viable markets).
        # P3 (thin-market monitor) is excluded unless --include-thin is passed.
        allowed_priorities = {"P0", "P1", "P2"}
        if getattr(args, "include_thin", False):
            allowed_priorities.add("P3")
        backlog_keys = set()
        backlog_search_terms = {}
        dormant_count = 0
        thin_skipped = 0
        for item in report.get("datasets", []):
            item_search_term = item.get("searchTerm", item["key"])
            if backlog_filter and not (backlog_filter.search(item_search_term) or backlog_filter.search(item["key"])):
                continue
            actions = item.get("actions", [])
            priority = item.get("priority")
            if "dormant" in actions:
                dormant_count += 1
                continue
            # New taxonomy: filter by priority tier
            if priority and priority in allowed_priorities:
                backlog_keys.add(item["key"])
                backlog_search_terms[item["key"]] = item.get("searchTerm", item["key"])
            # Legacy fallback: old action names (no priority field)
            elif priority is None and any(a in actions for a in ("refresh-page1", "needs-data")):
                backlog_keys.add(item["key"])
                backlog_search_terms[item["key"]] = item.get("searchTerm", item["key"])
            elif priority == "P3":
                thin_skipped += 1
        if dormant_count:
            print(f"Skipping {dormant_count} dormant datasets (no Terapeak results on prior attempts)")
        if thin_skipped:
            print(f"Skipping {thin_skipped} thin-market datasets (P3 monitor cadence, use --include-thin to include)")
        # Filter existing terms to backlog keys
        existing_keys = {t["term"] for t in terms}
        before = len(terms)
        terms = [t for t in terms if t["term"] in backlog_keys]
        # Inject needs-data keys that have no CSV yet (new exports).
        # Try to find an existing CSV on disk via word-set matching so we
        # don't create duplicate files with a different naming convention.
        missing_keys = backlog_keys - existing_keys
        _csv_word_lookup = {}
        for _f in sorted(TERAPEAK_DIR.glob("*.csv")):
            _ws = frozenset(_f.stem.lower().replace("_", " ").replace("-", " ").split())
            _csv_word_lookup[_ws] = _f.name
        for key in sorted(missing_keys):
            key_ws = frozenset(key.lower().replace("-", " ").split())
            existing_csv = _csv_word_lookup.get(key_ws)
            if existing_csv:
                # CSV exists under a different naming -- use its filename
                search_term = existing_csv.replace(".csv", "").replace("_", " ")
                if backlog_filter and not (backlog_filter.search(search_term) or backlog_filter.search(key)):
                    continue
                terms.append({"term": search_term, "filename": existing_csv})
            else:
                # Genuinely new -- use the searchTerm from report as eBay query
                st = backlog_search_terms.get(key, key)
                if backlog_filter and not (backlog_filter.search(st) or backlog_filter.search(key)):
                    continue
                filename = re.sub(r'[^\w\s\-]', '', st).replace(' ', '_')[:80] + ".csv"
                terms.append({"term": st, "filename": filename})
        print(f"Backlog mode: {len(terms)} from report ({len(missing_keys)} new, {len(terms) - len(missing_keys)} existing), skipping {before - (len(terms) - len(missing_keys))} not in backlog")

    # Apply resume
    progress = load_progress()
    if args.resume:
        completed = set(progress.get("completed", []))
        before = len(terms)
        terms = [t for t in terms if t["term"] not in completed]
        print(f"Resuming: skipping {before - len(terms)} already completed")

    # Apply refresh mode: only keep coins whose CSV is older than --max-age days
    if args.refresh:
        cutoff = time.time() - (args.max_age * 86400)
        before = len(terms)
        stale_terms = []
        for t in terms:
            csv_path = CSV_DIR / t['filename']
            if not csv_path.exists():
                stale_terms.append(t)  # missing = needs scraping
            elif csv_path.stat().st_mtime < cutoff:
                stale_terms.append(t)  # older than max-age = stale
            # else: fresh enough, skip
        terms = stale_terms
        print(f"Refresh mode (max-age {args.max_age}d): {len(terms)} stale, skipping {before - len(terms)} fresh")

    # Apply terapeak-meta.json based filters (--min-comps, --exclude-low-volume).
    # Both filters read the same sidecar; load it once and share the lookup helper.
    if args.min_comps > 0 or args.exclude_low_volume:
        meta_path = PROJECT_DIR / "data" / "terapeak-meta.json"
        if meta_path.exists():
            import json as _json
            with open(meta_path) as f:
                _meta = _json.load(f)

            def _meta_entry(t):
                # Keys in terapeak-meta.json are lowercased search terms.
                term = t.get('term') or t.get('search_term', '')
                return _meta.get(term.lower()) or _meta.get(term)

            def _apply_meta_filter(terms, predicate, label):
                """Drop terms where predicate(entry) returns True. Logs skip count."""
                kept = []
                skipped = 0
                for t in terms:
                    if predicate(_meta_entry(t)):
                        skipped += 1
                    else:
                        kept.append(t)
                print(f"{label}: skipped {skipped} datasets")
                return kept

            if args.min_comps > 0:
                terms = _apply_meta_filter(
                    terms,
                    lambda entry: ((entry or {}).get('compCount') or 0) < args.min_comps,
                    f"Min-comps filter ({args.min_comps})",
                )

            if args.exclude_low_volume:
                terms = _apply_meta_filter(
                    terms,
                    lambda entry: bool(((entry or {}).get('identifiers') or {}).get('is_low_volume_candidate')),
                    "Exclude-low-volume filter (durable identifiers)",
                )
        else:
            if args.min_comps > 0:
                print(f"WARNING: --min-comps specified but {meta_path} not found, skipping filter")
            if args.exclude_low_volume:
                print(f"WARNING: --exclude-low-volume specified but {meta_path} not found, skipping filter")

    # Priority sort: thin-data CSVs first (fewest existing rows)
    if args.priority:
        def _csv_rows(t):
            csv_path = CSV_DIR / t['filename']
            if csv_path.exists():
                try:
                    return sum(1 for _ in open(csv_path)) - 1  # subtract header
                except Exception:
                    return 999
            return 0  # missing file = top priority
        terms.sort(key=_csv_rows)
        print(f"Priority sort: thin-data coins first")

    # Shuffle to avoid predictable alphabetical access patterns
    # (default on; disable with --no-shuffle when order matters)
    if args.shuffle:
        random.shuffle(terms)
        print(f"Shuffled order for human-like access pattern")

    # Apply limit
    if args.limit:
        terms = terms[:args.limit]

    if not terms:
        print("No terms to process.")
        return

    if args.dry_run:
        print(f"\nDRY RUN -- would export {len(terms)} coins:")
        for i, t in enumerate(terms, 1):
            print(f"  {i}. {t['term']}")
        est_min = len(terms) * 15 / 60  # ~15 sec per coin
        print(f"\nEstimated time: ~{est_min:.0f} minutes")
        return

    print(f"\nExporting {len(terms)} coins...")
    print(f"App URL: {APP_URL}")
    print(f"Admin key: {'configured' if ADMIN_API_KEY else 'NOT SET (uploads will fail)'}")

    # Use headed mode when a display is available (VNC or desktop).
    # Headed mode avoids bot detection (headless gets CAPTCHA'd by eBay).
    use_headless = not has_display()
    if use_headless:
        print("  WARNING: No display detected. Headless mode may trigger CAPTCHA.")
        print("  Tip: Start a VNC server first, then export DISPLAY=:1")
    else:
        print(f"  Using display: {os.environ.get('DISPLAY', 'default')}")

    # ── Browser lifecycle helpers ─────────────────────────────
    # Chromium leaks memory on long-running SPA navigations.
    # Recycle the browser every BROWSER_RECYCLE_EVERY coins to avoid OOM crashes.
    # #199: Bumped default 40 -> 80 to reduce recycle overhead; env-tunable so
    # ops can dial back (e.g., to 40) if memory pressure returns, or raise
    # further (e.g., 120) once stability is confirmed in a long run.
    BROWSER_RECYCLE_EVERY = int(os.environ.get("BROWSER_RECYCLE_EVERY", "80"))

    pw_instance = sync_playwright().start()
    browser = None
    context = None
    page = None

    def launch_browser():
        nonlocal browser, context, page
        if browser:
            try:
                save_cookies(context)
                browser.close()
            except Exception:
                pass
        browser = pw_instance.chromium.launch(
            headless=use_headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-infobars",
                "--window-size=1280,900",
            ],
        )
        vw = 1280 + random.randint(-40, 40)
        vh = 900 + random.randint(-30, 30)
        context = browser.new_context(
            viewport={"width": vw, "height": vh},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/134.0.0.0 Safari/537.36"
            ),
        )
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            window.chrome = { runtime: {} };
        """)
        load_cookies(context)
        page = context.new_page()
        return page

    # Initial launch + verify
    page = launch_browser()
    print("Verifying session...")
    page.goto(EBAY_RESEARCH_URL, wait_until="domcontentloaded")
    wait_for_research_page(page)  # #198: selector-bounded, sleep(3) fallback
    verify_url = page.url
    print(f"  Verification URL: {verify_url}")
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(DOWNLOAD_DIR / "_debug_verify_session.png"))

    if not is_logged_in(page):
        print("ERROR: Session expired. Run --login-manual to refresh cookies.")
        browser.close()
        pw_instance.stop()
        return

    print("Session valid. Starting exports...\n")

    success = 0
    failed = 0
    uploaded = 0
    consecutive_crashes = 0
    consecutive_blocks = 0
    next_coffee = random.randint(*COFFEE_BREAK_EVERY)

    for i, entry in enumerate(terms):
        term = entry["term"]
        search_query = entry.get("search_query", term)
        pct = round((i + 1) / len(terms) * 100)

        # Recycle browser every N coins to prevent OOM
        if i > 0 and i % BROWSER_RECYCLE_EVERY == 0:
            print(f"  ... recycling browser (memory management) ...")
            try:
                page = launch_browser()
                reset_sort_state()
                consecutive_crashes = 0
            except Exception as e:
                print(f"  FATAL: Browser restart failed: {e}")
                break

        print(f"  [{pct:3d}%] {term}...", end=" ", flush=True)

        try:
            csv_path = do_search_and_export(page, search_query, DOWNLOAD_DIR)

            # Bot detection abort
            if csv_path == "BOT_BLOCKED":
                consecutive_blocks += 1
                print(f"BOT BLOCKED ({consecutive_blocks}/3)")
                if consecutive_blocks >= 3:
                    print("\n  BOT DETECTION: 3 consecutive blocks. Stopping.")
                    print("  Wait a few hours before retrying.")
                    save_progress(progress)
                    break
                # Long cooldown before trying the next one
                cooldown = random.uniform(120, 300)
                print(f"  ... cooling down for {cooldown:.0f}s ...")
                time.sleep(cooldown)
                # Recycle browser to get fresh fingerprint
                try:
                    page = launch_browser()
                    reset_sort_state()
                except Exception:
                    pass
                failed += 1
                progress.setdefault("failed", []).append(term)
                continue

            consecutive_blocks = 0

            if csv_path and csv_path.exists():
                # Verify CSV has content
                size = csv_path.stat().st_size
                if size < 50:
                    print(f"EMPTY (file too small: {size}B)")
                    failed += 1
                    progress.setdefault("failed", []).append(term)
                    continue

                # Merge with existing CSV (preserve deep-paginated data)
                dest = CSV_DIR / entry["filename"]
                dest = _merge_csv(csv_path, dest)

                # Upload to app with aggregationMeta
                now = datetime.now().isoformat()
                meta = {"page1At": now}
                if args.refresh:
                    meta["lastRefreshAt"] = now
                ok, msg = upload_csv(dest, term, aggregation_meta=meta)
                if ok:
                    print(f"OK ({msg})")
                    uploaded += 1
                    success += 1
                    progress.setdefault("completed", []).append(term)
                else:
                    print(f"SAVED but upload failed: {msg}")
                    # Treat 422/no-valid-comps as an empty scrape signal so
                    # dormant tracking can converge instead of retrying forever.
                    if _is_no_valid_comps_error(msg):
                        _report_no_data(term)
                    failed += 1
                    progress.setdefault("failed", []).append(term)
            else:
                print("NO EXPORT (no results or button not found)")
                _report_no_data(term)
                failed += 1
                progress.setdefault("failed", []).append(term)

        except PlaywrightTimeout:
            print("TIMEOUT")
            failed += 1
            progress.setdefault("failed", []).append(term)
        except Exception as e:
            err_str = str(e)
            print(f"ERROR: {err_str}")
            failed += 1
            progress.setdefault("failed", []).append(term)

            # Auto-recover from page/browser crashes
            if "crash" in err_str.lower() or "target closed" in err_str.lower():
                consecutive_crashes += 1
                if consecutive_crashes >= 5:
                    print("\n  TOO MANY CRASHES. Stopping to avoid infinite loop.")
                    save_progress(progress)
                    break
                print(f"  ... browser crashed, restarting ({consecutive_crashes}/5) ...")
                try:
                    page = launch_browser()
                except Exception as e2:
                    print(f"  FATAL: Browser restart failed: {e2}")
                    save_progress(progress)
                    break
            else:
                consecutive_crashes = 0

        # Save progress after each item (for resume)
        save_progress(progress)

        # Human-like delay between searches
        if i < len(terms) - 1:
            # Occasional "coffee break" -- long pause to look natural
            if (i + 1) >= next_coffee:
                pause = random.uniform(*COFFEE_BREAK_DURATION)
                print(f"  ... taking a {pause:.0f}s break (human pacing) ...")
                time.sleep(pause)
                next_coffee = i + 1 + random.randint(*COFFEE_BREAK_EVERY)
            else:
                rand_delay(DELAY_BETWEEN_SEARCHES)

        # Re-check login every 25 searches (sessions can expire)
        if (i + 1) % 25 == 0:
            if not is_logged_in(page):
                print("\n  SESSION EXPIRED. Saving progress...")
                save_progress(progress)
                print(f"  Run --login to refresh, then --run --resume to continue.")
                break

    # Cleanup
    try:
        save_cookies(context)
        browser.close()
    except Exception:
        pass
    pw_instance.stop()

    print(f"\n=== Export Complete ===")
    print(f"  Succeeded:  {success}")
    print(f"  Uploaded:   {uploaded}")
    print(f"  Failed:     {failed}")
    print(f"  Remaining:  {len(terms) - success - failed}")
    if failed > 0:
        print(f"\n  Run with --resume to retry failed coins next time.")


# ── CLI ─────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Semi-automated Terapeak CSV exporter",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 scripts/terapeak-export.py --login                 # Browser login (needs display)
  python3 scripts/terapeak-export.py --login-manual          # Paste cookies interactively
  python3 scripts/terapeak-export.py --cookie-file c.json    # Import cookies from file
  python3 scripts/terapeak-export.py --run                   # Export all coins
  python3 scripts/terapeak-export.py --run --limit 10   # Export first 10
  python3 scripts/terapeak-export.py --run --filter "Morgan"  # Morgans only
  python3 scripts/terapeak-export.py --run --resume     # Continue after interruption
  python3 scripts/terapeak-export.py --run --refresh --max-age 30  # Refresh CSVs older than 30 days
  python3 scripts/terapeak-export.py --run --refresh --max-age 14 --filter "Morgan"  # Refresh stale Morgans
  python3 scripts/terapeak-export.py --batch 10              # Smart batch: 10 coins, priority order
  python3 scripts/terapeak-export.py --batch 8 --filter "Perth"  # 8 Perth coins, thinnest first
  python3 scripts/terapeak-export.py --dry-run --priority    # Show order with priority sort
  python3 scripts/terapeak-export.py --check            # Check cookie freshness
        """,
    )
    parser.add_argument("--login", action="store_true", help="Open browser for manual eBay login (needs display)")
    parser.add_argument("--login-manual", action="store_true", help="Paste cookies interactively (for Codespaces)")
    parser.add_argument("--cookie-file", type=str, metavar="PATH", help="Import cookies from a JSON file")
    parser.add_argument("--run", action="store_true", help="Run the export loop (headless in containers)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be exported")
    parser.add_argument("--check", action="store_true", help="Check if cookies are still valid")
    parser.add_argument("--resume", action="store_true", help="Skip already-completed coins")
    parser.add_argument("--refresh", action="store_true", help="Refresh mode: only process coins whose CSV is older than --max-age days")
    parser.add_argument("--max-age", type=int, default=14, metavar="DAYS", help="Max CSV age in days for --refresh mode (default: 14)")
    parser.add_argument("--min-comps", type=int, default=0, metavar="N", help="Skip datasets with fewer than N comps in terapeak-meta.json (excludes low-signal coins, e.g. --min-comps 10)")
    parser.add_argument("--exclude-low-volume", action="store_true", help="Skip datasets tagged identifiers.is_low_volume_candidate in terapeak-meta.json (durable tag from build-evidence-index.js)")
    parser.add_argument("--filter", type=str, help="Only export terms matching this regex")
    parser.add_argument("--limit", type=int, help="Max number of coins to export")
    parser.add_argument("--priority", action="store_true", help="Sort by data quality: thin-data coins first")
    parser.add_argument("--shuffle", action="store_true", default=True, help="Shuffle order for human-like patterns (default: on)")
    parser.add_argument("--no-shuffle", action="store_false", dest="shuffle", help="Disable shuffle (preserve alphabetical order)")
    parser.add_argument("--batch", type=int, metavar="N", help="Run N coins then stop (use with cron/scheduler)")
    parser.add_argument("--backlog", type=str, metavar="FILE", help="Read freshness-report.json and use its refresh-page1 items as work queue")
    parser.add_argument("--include-thin", action="store_true", help="Include P3 thin-market datasets in backlog mode (default: P0-P2 only)")

    args = parser.parse_args()

    # --batch N implies --run --resume --priority --limit N
    if args.batch:
        args.run = True
        args.resume = True
        args.priority = True
        if not args.limit:
            args.limit = args.batch

    ok = True
    if args.login:
        ok = do_login()
    elif args.login_manual:
        ok = do_login_manual()
    elif args.cookie_file:
        ok = do_cookie_file(args.cookie_file)
    elif args.run or args.dry_run:
        do_export_run(args)
    elif args.check:
        check_cookies()
    else:
        parser.print_help()

    if ok is False:
        sys.exit(1)


if __name__ == "__main__":
    main()
