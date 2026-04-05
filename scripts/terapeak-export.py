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

# Auto-read ADMIN_API_KEY from .env if not set in environment
if not ADMIN_API_KEY:
    env_file = PROJECT_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("ADMIN_API_KEY="):
                ADMIN_API_KEY = line.split("=", 1)[1].strip()
                break

EBAY_RESEARCH_URL = "https://www.ebay.com/sh/research"
EBAY_LOGIN_URL = "https://signin.ebay.com/ws/eBayISAPI.dll?SignIn"

# Human-like delays (seconds) -- staggered to avoid pattern detection
DELAY_BETWEEN_SEARCHES = (8, 18)   # base delay between coins
DELAY_AFTER_EXPORT = (3, 7)        # after clicking Export
DELAY_PAGE_LOAD = (3, 6)           # after navigation
DELAY_TYPING = (0.03, 0.12)        # per-character typing speed
DELAY_BEFORE_CLICK = (0.4, 1.2)    # pause before clicking a button
DELAY_MICRO = (0.2, 0.8)           # tiny pauses between actions

# Every N coins, take a longer "coffee break" to look natural
COFFEE_BREAK_EVERY = (12, 25)      # random interval
COFFEE_BREAK_DURATION = (30, 90)   # 30-90 second pause

import random


def has_display():
    """Check if a graphical display is available (X11/Wayland)."""
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))

def rand_delay(range_tuple):
    """Sleep for a random duration within the given range."""
    time.sleep(random.uniform(*range_tuple))


def human_type(element, text):
    """Type text character by character with random delays, like a human."""
    for ch in text:
        element.type(ch, delay=random.uniform(*DELAY_TYPING) * 1000)  # Playwright delay is in ms
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


# ── Upload to App ───────────────────────────────────────────
def upload_csv(csv_path, search_term):
    """POST a CSV file to the app's Terapeak import endpoint."""
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
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        )
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

    # Wait a bit for SPA to render
    time.sleep(3)

    # Debug: log redirects (keep this -- it's useful)
    actual_url = page.url
    if "/sh/research" not in actual_url:
        print(f"    WARNING: Redirected to {actual_url}")
        page.screenshot(path=str(download_dir / f"_debug_redirect_{search_term[:30]}.png"))

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
    search_input.click()
    search_input.fill("")
    rand_delay(DELAY_MICRO)
    human_type(search_input, search_term)
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
        research_btn.click()
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

    # Scroll down progressively to reveal the sold listings table and Export button
    for scroll_pct in [30, 60, 90, 100]:
        page.evaluate(f'window.scrollTo(0, document.body.scrollHeight * {scroll_pct} / 100)')
        time.sleep(0.5)

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
                         "Shipping", "Condition", "Seller", "Format", "Item URL"])
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

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=use_headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-infobars",
                "--window-size=1280,900",
            ],
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        )

        # Mask webdriver fingerprint
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        """)

        # Load saved cookies
        load_cookies(context)
        page = context.new_page()

        # Verify login
        print("Verifying session...")
        page.goto(EBAY_RESEARCH_URL, wait_until="domcontentloaded")
        time.sleep(3)

        # Debug: capture verification page state
        verify_url = page.url
        print(f"  Verification URL: {verify_url}")
        DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(DOWNLOAD_DIR / "_debug_verify_session.png"))

        if not is_logged_in(page):
            print("ERROR: Session expired. Run --login-manual to refresh cookies.")
            browser.close()
            return

        print("Session valid. Starting exports...\n")

        success = 0
        failed = 0
        uploaded = 0
        next_coffee = random.randint(*COFFEE_BREAK_EVERY)  # take a break after N coins

        for i, entry in enumerate(terms):
            term = entry["term"]
            pct = round((i + 1) / len(terms) * 100)

            print(f"  [{pct:3d}%] {term}...", end=" ", flush=True)

            try:
                csv_path = do_search_and_export(page, term, DOWNLOAD_DIR)

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
                print(f"ERROR: {e}")
                failed += 1
                progress.setdefault("failed", []).append(term)

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

        # Refresh cookies before closing (extends session for next run)
        save_cookies(context)
        browser.close()

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
  python3 scripts/terapeak-export.py --dry-run          # Show what would be exported
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
    parser.add_argument("--filter", type=str, help="Only export terms matching this regex")
    parser.add_argument("--limit", type=int, help="Max number of coins to export")

    args = parser.parse_args()

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
