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

  # Refresh stale data (re-scrape CSVs older than N days):
  python3 scripts/terapeak-export.py --run --refresh --max-age 14
  python3 scripts/terapeak-export.py --run --refresh --max-age 30 --filter "Morgan"

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
from datetime import datetime
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
COOKIE_FILE = PROJECT_DIR / "cache" / "ebay_cookies.json"
PROGRESS_FILE = PROJECT_DIR / "cache" / "terapeak_export_progress.json"
DOWNLOAD_DIR = PROJECT_DIR / "cache" / "terapeak_downloads"
TERAPEAK_DIR = PROJECT_DIR / "data" / "terapeak"
CSV_DIR = TERAPEAK_DIR  # where to save exported CSVs

APP_URL = os.environ.get("APP_URL", "http://localhost:3000")
ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "")

# Azure Blob config (for direct-to-blob upload, bypassing local server)
BLOB_ACCOUNT = os.environ.get("TERAPEAK_BLOB_ACCOUNT", "")
BLOB_CONTAINER = os.environ.get("TERAPEAK_BLOB_CONTAINER", "")

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
    If page is provided, occasionally pause mid-word (like thinking)."""
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
def get_search_terms():
    """Get search terms from existing CSV filenames in data/terapeak/."""
    terms = []
    for f in sorted(TERAPEAK_DIR.glob("*.csv")):
        meta = f.with_suffix(".meta")
        if meta.exists():
            term = meta.read_text().strip()
        else:
            term = f.stem.replace("_", " ")
        terms.append({"term": term, "filename": f.name})
    return terms


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
def upload_csv(csv_path, search_term):
    """Upload a CSV: try Azure Blob first, fall back to app server POST."""
    # Try blob upload first (decoupled from local server)
    if BLOB_ACCOUNT and BLOB_CONTAINER:
        ok, msg = upload_to_blob(csv_path)
        if ok:
            return True, msg
        # Blob failed -- fall back to server POST
        print(f"    [blob fallback] {msg}")

    # Fall back to HTTP POST to local server
    url = f"{APP_URL}/api/terapeak/import"
    headers = {}
    if ADMIN_API_KEY:
        headers["x-api-key"] = ADMIN_API_KEY

    try:
        with open(csv_path, "rb") as f:
            files = {"file": (os.path.basename(csv_path), f, "text/csv")}
            data = {"searchTerm": search_term}
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
        time.sleep(3)

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


def do_search_and_export(page, search_term, download_dir):
    """
    Perform a Terapeak search and trigger CSV export.
    Returns the path to the downloaded CSV, or None on failure.
    """
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

    # Extra wait for Terapeak SPA to render results
    time.sleep(3)

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
            # Re-scroll after sort reloads
            for _ in range(random.randint(2, 4)):
                human_scroll(page, "down", random.randint(200, 500))
                time.sleep(random.uniform(0.3, 0.7))
    except Exception as e:
        print(f"    (sort by date skipped: {e})")

    # Debug: viewport-only screenshot (full_page=True can OOM on heavy pages)
    page.screenshot(path=str(download_dir / f"_debug_after_search_{search_term[:30]}.png"))

    # ── Scrape sold listings directly from DOM ──────────────────
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
    scraped = page.evaluate("""() => {
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

    rows = scraped.get("rows", [])

    if not rows:
        print(f"    WARNING: No data rows found ({scraped.get('tableCount', 0)} tables on page)")
        page.screenshot(path=str(download_dir / f"_debug_no_data_{search_term[:30]}.png"))
        return None

    # Convert scraped rows to CSV records
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
        print(f"    WARNING: Scraped {len(rows)} rows but none had usable title+price")
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

    # Apply resume
    progress = load_progress()
    if args.resume:
        completed = set(progress.get("completed", []))
        before = len(terms)
        terms = [t for t in terms if t["term"] not in completed]
        print(f"Resuming: skipping {before - len(terms)} already completed")

    # Apply refresh mode: only keep coins whose CSV is older than --max-age days
    if args.refresh:
        from datetime import datetime, timedelta
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
    BROWSER_RECYCLE_EVERY = 40

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
    time.sleep(3)
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
        pct = round((i + 1) / len(terms) * 100)

        # Recycle browser every N coins to prevent OOM
        if i > 0 and i % BROWSER_RECYCLE_EVERY == 0:
            print(f"  ... recycling browser (memory management) ...")
            try:
                page = launch_browser()
                consecutive_crashes = 0
            except Exception as e:
                print(f"  FATAL: Browser restart failed: {e}")
                break

        print(f"  [{pct:3d}%] {term}...", end=" ", flush=True)

        try:
            csv_path = do_search_and_export(page, term, DOWNLOAD_DIR)

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

                # Copy to data/terapeak/
                dest = CSV_DIR / entry["filename"]
                csv_path.rename(dest) if csv_path != dest else None

                # Upload to app
                ok, msg = upload_csv(dest, term)
                if ok:
                    print(f"OK ({msg})")
                    uploaded += 1
                else:
                    print(f"SAVED but upload failed: {msg}")

                success += 1
                progress.setdefault("completed", []).append(term)
            else:
                print("NO EXPORT (no results or button not found)")
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
  python3 scripts/terapeak-export.py --run --refresh --max-age 30  # Re-scrape CSVs older than 30 days
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
    parser.add_argument("--refresh", action="store_true", help="Re-scrape mode: only process coins whose CSV is older than --max-age days")
    parser.add_argument("--max-age", type=int, default=14, metavar="DAYS", help="Max CSV age in days for --refresh mode (default: 14)")
    parser.add_argument("--filter", type=str, help="Only export terms matching this regex")
    parser.add_argument("--limit", type=int, help="Max number of coins to export")
    parser.add_argument("--priority", action="store_true", help="Sort by data quality: thin-data coins first")
    parser.add_argument("--shuffle", action="store_true", default=True, help="Shuffle order for human-like patterns (default: on)")
    parser.add_argument("--no-shuffle", action="store_false", dest="shuffle", help="Disable shuffle (preserve alphabetical order)")
    parser.add_argument("--batch", type=int, metavar="N", help="Run N coins then stop (use with cron/scheduler)")

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
