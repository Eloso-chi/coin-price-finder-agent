#!/usr/bin/env python3
"""
sales-aggregator.py -- Terapeak sales data aggregator (deep pagination)

Supplements the main terapeak-export.py by fetching the SECOND page of
results for high-volume coins (those with exactly 50 rows from page 1).
Appends new rows to the existing CSV and uploads to the app server.

The import pipeline (terapeakService.importComps) deduplicates by itemId
and title+price, so overlapping rows are handled safely.

Usage:
  # Dashboard mode (default -- queries server for priorities):
  python3 scripts/sales-aggregator.py

  # Dry run -- show which coins qualify for page 2 enrichment:
  python3 scripts/sales-aggregator.py --dry-run

  # Enrich all 50-row coins:
  python3 scripts/sales-aggregator.py --run

  # Only Morgans:
  python3 scripts/sales-aggregator.py --run --filter "Morgan"

  # Limit batch size:
  python3 scripts/sales-aggregator.py --run --limit 20

  # Custom row threshold (default: coins with exactly 50 rows):
  python3 scripts/sales-aggregator.py --run --min-rows 45

Requirements:
  Same as terapeak-export.py (playwright, requests, VNC display)
"""

import argparse
import csv
import importlib
import json
import math
import os
import random
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

# ── Import shared functions from terapeak-export.py ─────────
# The filename has dashes, so use importlib to load it as a module.
SCRIPT_DIR = Path(__file__).parent
_spec = importlib.util.spec_from_file_location("terapeak_export", SCRIPT_DIR / "terapeak-export.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)

# Config
PROJECT_DIR = _mod.PROJECT_DIR
COOKIE_FILE = _mod.COOKIE_FILE
DOWNLOAD_DIR = _mod.DOWNLOAD_DIR
TERAPEAK_DIR = _mod.TERAPEAK_DIR
CSV_DIR = _mod.CSV_DIR
APP_URL = _mod.APP_URL
ADMIN_API_KEY = _mod.ADMIN_API_KEY
EBAY_RESEARCH_URL = _mod.EBAY_RESEARCH_URL

# Delays (tuned faster for page2 -- less overhead since we stay on same search)
DELAY_BETWEEN_SEARCHES = (3, 7)
DELAY_PAGE_LOAD = (1.5, 3)
DELAY_BEFORE_CLICK = (0.3, 0.9)
DELAY_MICRO = (0.15, 0.6)
COFFEE_BREAK_EVERY = (30, 55)
COFFEE_BREAK_DURATION = (15, 35)

# Functions
has_display = _mod.has_display
rand_delay = _mod.rand_delay
human_mouse_move = _mod.human_mouse_move
human_click = _mod.human_click
human_scroll = _mod.human_scroll
human_idle = _mod.human_idle
human_type = _mod.human_type
save_cookies = _mod.save_cookies
load_cookies = _mod.load_cookies
is_logged_in = _mod.is_logged_in
get_search_terms = _mod.get_search_terms
upload_csv = _mod.upload_csv

# Browser recycle interval
BROWSER_RECYCLE_EVERY = 80

# Session-level flag: once RPP is set to 50, skip re-checking
_rpp_already_set = False

# ── Bullion series eligible for deep pagination (page 3+) ──
# These high-volume series typically have 100+ sold listings on Terapeak.
BULLION_PATTERNS = [
    r'\blibertad\b',
    r'\bsilver eagle\b',
    r'\bgold eagle\b',
    r'\bpanda\b',
    r'\bperth\b',
    r'\bkookaburra\b',
    r'\bkangaroo\b',
    r'\blunar\b',
    r'\bkoala\b',
    r'\bmaple leaf\b',
    r'\bbritannia\b',
    r'\bkrugerrand\b',
    r'\bphilharmonic\b',
    r'\bgold buffalo\b',
    r'\bplatinum eagle\b',
    r'\bpalladium eagle\b',
    r'\bpolar bear\b',
]
_BULLION_RE = re.compile('|'.join(BULLION_PATTERNS), re.IGNORECASE)

def is_bullion_term(search_term):
    """Return True if the search term matches a bullion series eligible for deep pagination."""
    return bool(_BULLION_RE.search(search_term))


def get_completed_terms_from_log(log_path):
    """Parse a page2 log file and return a set of search terms already processed (OK or NO PAGE 2)."""
    completed = set()
    if not log_path or not Path(log_path).exists():
        return completed
    with open(log_path, "r") as f:
        for line in f:
            # Match lines like: "  [ 48%] 1988 American Silver Eagle... p2:50 ..." or "... NO PAGE 2"
            m = re.match(r'^\s+\[\s*\d+%\]\s+(.+?)\.\.\.', line)
            if m:
                term = m.group(1).strip()
                # Only count lines that completed (OK or NO PAGE 2), not errors
                if 'OK' in line or 'NO PAGE 2' in line:
                    completed.add(term)
    return completed


# ── Candidate Selection ─────────────────────────────────────
def get_candidates(min_rows=50, filter_pattern=None):
    """Find coins with >= min_rows in their CSV (page 1 was full).
    Returns list of dicts with term, filename, row_count."""
    terms = get_search_terms()
    candidates = []

    for entry in terms:
        csv_path = CSV_DIR / entry["filename"]
        if not csv_path.exists():
            continue
        # Count data rows (exclude header)
        with open(csv_path) as f:
            row_count = sum(1 for _ in f) - 1
        if row_count >= min_rows:
            candidates.append({
                "term": entry["term"],
                "filename": entry["filename"],
                "row_count": row_count,
            })

    # Apply filter
    if filter_pattern:
        pattern = re.compile(filter_pattern, re.IGNORECASE)
        candidates = [c for c in candidates if pattern.search(c["term"])]

    return candidates


# ── DOM Extract Table (same JS as terapeak-export.py) ────────
# Extracted here so it can be called on page 2 independently.
EXTRACT_TABLE_JS = """() => {
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
            price: line0(2),
            format: line1(2),
            shipping: line0(3),
            qty: line0(4),
            total: line0(5),
            bids: line0(6),
            date: line0(7),
        });
    });
    return { rows, tableCount: document.querySelectorAll('table').length };
}"""


def do_search_and_collect(page, search_term, download_dir, max_pages=2):
    """
    Search Terapeak for search_term, then navigate to pages 2..max_pages and collect.
    For bullion series, max_pages can be higher (e.g., 6) to capture deeper history.
    Returns (csv_path, row_count) tuple, or None on failure, or "BOT_BLOCKED".
    """
    # Navigate to Research page
    page.goto(EBAY_RESEARCH_URL, wait_until="domcontentloaded")
    rand_delay(DELAY_PAGE_LOAD)

    # Simulate human arrival
    human_idle(page)
    human_scroll(page, "down", random.randint(80, 200))
    time.sleep(random.uniform(0.5, 1.5))
    human_scroll(page, "up", random.randint(60, 150))

    # Check for redirects (bot detection)
    actual_url = page.url
    if "/sh/research" not in actual_url:
        print(f"    WARNING: Redirected to {actual_url}")
        page.screenshot(path=str(download_dir / f"_debug_p2_redirect_{search_term[:30]}.png"))
        if "distil" in actual_url or "splashui" in actual_url or "block" in actual_url:
            return "BOT_BLOCKED"

    # Find Terapeak search input
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
        print(f"    ERROR: Cannot find search input")
        page.screenshot(path=str(download_dir / "_debug_p2_no_search.png"))
        return None

    # Type search term
    rand_delay(DELAY_BEFORE_CLICK)
    human_click(page, search_input)
    search_input.fill("")
    rand_delay(DELAY_MICRO)
    human_type(search_input, search_term, page=page)
    rand_delay(DELAY_MICRO)

    # Click Research button
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
        rand_delay(DELAY_BEFORE_CLICK)
        search_input.press("Enter")

    rand_delay(DELAY_PAGE_LOAD)

    # Wait for page 1 results to load
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except PlaywrightTimeout:
        pass

    time.sleep(3)

    # ── S0: Active Listings Guard (tab check) ──────────────────
    # When Terapeak has no sold results, eBay may auto-switch to
    # "Active listings" tab. Detect this and abort early.
    active_tab_detected = page.evaluate("""() => {
        const tabs = document.querySelectorAll(
            '[role="tab"][aria-selected="true"], '
            + '.tab--active, .tab-item--active, '
            + 'button[aria-pressed="true"]'
        );
        for (const tab of tabs) {
            const txt = tab.innerText.toLowerCase();
            if (txt.includes('active') && !txt.includes('sold')) return true;
        }
        const headings = document.querySelectorAll('h1, h2, h3, [class*="tab-label"]');
        for (const h of headings) {
            if (h.innerText.toLowerCase().includes('active listings')) return true;
        }
        return false;
    }""")
    if active_tab_detected:
        print(f"    WARNING: Active Listings tab detected (no sold data) -- skipping")
        page.screenshot(path=str(download_dir / f"_debug_p2_active_tab_{search_term[:30]}.png"))
        return None

    # Scroll down to reveal results table and pagination
    for _ in range(random.randint(2, 4)):
        human_scroll(page, "down", random.randint(250, 550))
        time.sleep(random.uniform(0.2, 0.5))
    human_idle(page)

    # ── Sort by "Date last sold" (descending = most recent first) ──
    # Default is Best Match.  Click once for ascending, again for descending.
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
            for _ in range(random.randint(2, 3)):
                human_scroll(page, "down", random.randint(200, 500))
                time.sleep(random.uniform(0.2, 0.5))
    except Exception as e:
        print(f"    (sort by date skipped: {e})")

    # Debug screenshot of page 1
    page.screenshot(path=str(download_dir / f"_debug_p2_page1_{search_term[:30]}.png"))

    # ── Set "Results per page" to 50 (max) ──────────────────
    global _rpp_already_set
    if not _rpp_already_set:
        try:
            rpp_select = page.query_selector('select[aria-label="Results per page"]')
            if rpp_select:
                current_val = rpp_select.input_value()
                if current_val != "50":
                    rpp_select.select_option("50")
                    rand_delay(DELAY_PAGE_LOAD)
                    try:
                        page.wait_for_load_state("networkidle", timeout=15000)
                    except PlaywrightTimeout:
                        pass
                    time.sleep(2)
                    for _ in range(random.randint(3, 5)):
                        human_scroll(page, "down", random.randint(300, 600))
                        time.sleep(random.uniform(0.2, 0.5))
                _rpp_already_set = True
        except Exception:
            pass  # Non-critical

    # ── Paginate through pages 2..max_pages and collect each ──
    all_csv_rows = []
    next_selectors = [
        'button.pagination__next:not([disabled])',
        'button[aria-label="Go to next page"]:not([disabled])',
        '.pagination__next',
        'button[aria-label="Next page"]',
        'a[aria-label="Next page"]',
        'nav.pagination button:last-of-type:not([disabled])',
    ]

    for page_num in range(2, max_pages + 1):
        # Find the Next button
        next_btn = None
        for sel in next_selectors:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible() and el.is_enabled():
                    next_btn = el
                    break
            except Exception:
                continue

        if not next_btn:
            if page_num == 2:
                print(f"NO PAGE 2 (pagination not found)")
                page.screenshot(path=str(download_dir / f"_debug_p2_no_pagination_{search_term[:30]}.png"))
                return None
            else:
                # Ran out of pages naturally
                break

        # Click next page
        rand_delay(DELAY_BEFORE_CLICK)
        human_click(page, next_btn)
        rand_delay(DELAY_PAGE_LOAD)

        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except PlaywrightTimeout:
            pass

        time.sleep(3)

        # Scroll to reveal results
        for _ in range(random.randint(2, 3)):
            human_scroll(page, "down", random.randint(200, 500))
            time.sleep(random.uniform(0.2, 0.5))
        human_idle(page)

        # Extract this page's DOM table
        extracted = page.evaluate(EXTRACT_TABLE_JS)
        rows = extracted.get("rows", [])

        if not rows:
            break  # No data on this page -- stop paginating

        # ── S0: Active Listings Guard (date validation) ────────────
        # Sold listings have a parseable date ("Mar 30, 2026").
        # Active listings have no date or show blank. If <20% of rows
        # have a valid date, assume we're on the active listings page.
        _DATE_RE = re.compile(
            r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}',
            re.IGNORECASE
        )
        rows_with_date = sum(1 for r in rows if _DATE_RE.search(r.get("date", "")))
        date_ratio = rows_with_date / len(rows) if rows else 0
        if len(rows) >= 3 and date_ratio < 0.2:
            print(f"    WARNING: Page {page_num} has {rows_with_date}/{len(rows)} valid dates "
                  f"({date_ratio:.0%}) -- likely Active Listings, stopping")
            page.screenshot(path=str(download_dir / f"_debug_p2_no_dates_p{page_num}_{search_term[:30]}.png"))
            break

        page_csv_rows = []
        for row in rows:
            title = row.get("title", "")
            price = row.get("price", "")
            if not title and not price:
                continue
            if not title and row.get("itemId"):
                title = f"[Removed] Item {row['itemId']}"

            bids = row.get("bids", "")
            if bids == "-":
                bids = ""

            page_csv_rows.append([
                title,
                row.get("itemId", ""),
                row.get("date", ""),
                price,
                row.get("shipping", ""),
                "",        # condition
                "",        # seller
                row.get("format", ""),
                row.get("url", ""),
                row.get("qty", ""),
            ])

        if page_csv_rows:
            all_csv_rows.extend(page_csv_rows)
            if max_pages > 2:
                print(f"p{page_num}:{len(page_csv_rows)} ", end="", flush=True)
        else:
            break  # Extracted rows but none usable

        # Human-like pause between pages
        base_delay = random.uniform(1.5, 4.0)
        # Every 4-5 pages, take a longer "reading" pause
        if page_num % random.randint(4, 5) == 0:
            base_delay += random.uniform(3.0, 7.0)
        time.sleep(base_delay)

    if not all_csv_rows:
        print(f"NO USABLE ROWS across pages 2-{max_pages}")
        return None

    # Write to temp CSV (will be merged into the main CSV)
    safe_name = re.sub(r'[^\w\s\-]', '', search_term).replace(' ', '_')[:80]
    csv_path = download_dir / f"{safe_name}_page2.csv"
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Item Title", "Item ID", "Sold Date", "Sold Price",
                         "Shipping", "Condition", "Seller", "Format", "Item URL",
                         "Quantity Sold"])
        writer.writerows(all_csv_rows)

    return csv_path, len(all_csv_rows)


def append_to_csv(main_csv_path, page2_csv_path):
    """Append page 2 rows to the main CSV, deduplicating by composite key
    (Title + Item ID + Sold Date + Sold Price).  Terapeak shows the same Item ID
    across multiple pages because listings sell repeatedly over time.
    We want to keep rows that represent genuinely different data points.
    Title is included so that blank-itemId sub-rows from different listings
    (different sellers/images) with the same date+price are not falsely deduped."""
    # Build composite keys from existing rows
    existing_keys = set()
    with open(main_csv_path, newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        for row in reader:
            # Key: title|itemId|soldDate|soldPrice  (columns 0, 1, 2, 3)
            title = row[0].strip().lower() if len(row) >= 1 else ""
            item_id = row[1].strip() if len(row) >= 2 else ""
            sold_date = row[2].strip() if len(row) >= 3 else ""
            sold_price = row[3].strip() if len(row) >= 4 else ""
            key = f"{title}|{item_id}|{sold_date}|{sold_price}"
            existing_keys.add(key)

    # Read page 2 rows, skip duplicates
    new_rows = []
    skipped = 0
    for row in _read_csv_rows(page2_csv_path):
        title = row[0].strip().lower() if len(row) >= 1 else ""
        item_id = row[1].strip() if len(row) >= 2 else ""
        sold_date = row[2].strip() if len(row) >= 3 else ""
        sold_price = row[3].strip() if len(row) >= 4 else ""
        key = f"{title}|{item_id}|{sold_date}|{sold_price}"
        if key in existing_keys:
            skipped += 1
            continue
        new_rows.append(row)
        existing_keys.add(key)

    if not new_rows:
        return 0

    # Append to main CSV
    with open(main_csv_path, "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(new_rows)

    return len(new_rows)


def _read_csv_rows(csv_path):
    """Read data rows from a CSV, skipping header."""
    with open(csv_path, newline="") as f:
        reader = csv.reader(f)
        next(reader, None)  # skip header
        return list(reader)


# ── Main Export Loop ────────────────────────────────────────
def do_page2_run(args):
    """Main page 2 enrichment loop."""
    if not COOKIE_FILE.exists():
        print("ERROR: No saved cookies. Run terapeak-export.py --login first.")
        return

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

    # Find candidates
    candidates = get_candidates(
        min_rows=args.min_rows,
        filter_pattern=args.filter,
    )

    # Exclude pattern
    if args.exclude:
        exclude_re = re.compile(args.exclude, re.IGNORECASE)
        before = len(candidates)
        candidates = [c for c in candidates if not exclude_re.search(c["term"])]
        print(f"  Exclude: filtered out {before - len(candidates)} coins matching /{args.exclude}/i")

    if not candidates:
        print("No candidates found. All coins have fewer rows than the threshold.")
        return

    # Resume: skip already-completed coins from a previous log
    if args.resume:
        done_terms = get_completed_terms_from_log(args.resume)
        if done_terms:
            before = len(candidates)
            candidates = [c for c in candidates if c["term"] not in done_terms]
            print(f"  Resume: skipping {before - len(candidates)} already-completed coins from {args.resume}")
            if not candidates:
                print("All candidates already completed. Nothing to do.")
                return

    # Shuffle for anti-pattern detection
    random.shuffle(candidates)

    # Apply limit
    if args.limit:
        candidates = candidates[:args.limit]

    if args.dry_run:
        print(f"\nDRY RUN -- {len(candidates)} coins qualify for page 2+ enrichment:")
        bullion_count = 0
        # Sort by row count for display
        for i, c in enumerate(sorted(candidates, key=lambda x: -x["row_count"]), 1):
            is_bull = is_bullion_term(c["term"])
            if is_bull:
                bullion_count += 1
            max_pg = args.max_pages if args.max_pages else (6 if is_bull else 2)
            tag = f"[bullion p2-{max_pg}]" if is_bull else "[p2]"
            print(f"  {i:3d}. {c['term']:<50s}  ({c['row_count']} rows) {tag}")
        est_min = len(candidates) * 20 / 60  # ~20 sec per coin per page
        print(f"\nBullion series: {bullion_count}/{len(candidates)}")
        print(f"Estimated time: ~{est_min:.0f} minutes (more for bullion deep-page)")
        return

    print(f"\nEnriching {len(candidates)} coins with page 2 data...")
    print(f"App URL: {APP_URL}")
    print(f"Admin key: {'configured' if ADMIN_API_KEY else 'NOT SET'}")

    use_headless = not has_display()
    if use_headless:
        print("  WARNING: No display detected. Headless mode may trigger CAPTCHA.")
    else:
        print(f"  Using display: {os.environ.get('DISPLAY', 'default')}")

    # Browser setup
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

    # Launch and verify session
    page = launch_browser()
    print("Verifying session...")
    page.goto(EBAY_RESEARCH_URL, wait_until="domcontentloaded")
    time.sleep(3)
    print(f"  Verification URL: {page.url}")
    page.screenshot(path=str(DOWNLOAD_DIR / "_debug_p2_verify.png"))

    if not is_logged_in(page):
        print("ERROR: Session expired. Run terapeak-export.py --login to refresh.")
        browser.close()
        pw_instance.stop()
        return

    print("Session valid. Starting page 2 enrichment...\n")

    success = 0
    failed = 0
    skipped = 0
    total_new_rows = 0
    consecutive_crashes = 0
    consecutive_blocks = 0
    next_coffee = random.randint(*COFFEE_BREAK_EVERY)

    for i, entry in enumerate(candidates):
        term = entry["term"]
        filename = entry["filename"]
        pct = round((i + 1) / len(candidates) * 100)

        # Recycle browser periodically
        if i > 0 and i % BROWSER_RECYCLE_EVERY == 0:
            print(f"  ... recycling browser ...")
            try:
                page = launch_browser()
                consecutive_crashes = 0
            except Exception as e:
                print(f"  FATAL: Browser restart failed: {e}")
                break

        print(f"  [{pct:3d}%] {term}...", end=" ", flush=True)

        # Bullion series get deeper pagination (up to 6 pages = 300 results)
        # Non-bullion stays at page 2 only (100 results)
        effective_max_pages = args.max_pages if args.max_pages else (6 if is_bullion_term(term) else 2)

        try:
            result = do_search_and_collect(page, term, DOWNLOAD_DIR, max_pages=effective_max_pages)

            # Bot detection
            if result == "BOT_BLOCKED":
                consecutive_blocks += 1
                print(f"BOT BLOCKED ({consecutive_blocks}/3)")
                if consecutive_blocks >= 3:
                    print("\n  BOT DETECTION: 3 consecutive blocks. Stopping.")
                    break
                cooldown = random.uniform(120, 300)
                print(f"  ... cooling down for {cooldown:.0f}s ...")
                time.sleep(cooldown)
                try:
                    page = launch_browser()
                except Exception:
                    pass
                failed += 1
                continue

            consecutive_blocks = 0

            if result is None:
                skipped += 1
                continue

            p2_csv_path, p2_row_count = result
            main_csv_path = CSV_DIR / filename

            # Append page 2 rows to main CSV
            new_count = append_to_csv(main_csv_path, p2_csv_path)

            # Upload the enriched CSV to the app with deep pagination metadata
            now = datetime.now().isoformat()
            deep_meta = {
                "deepAt": now,
                "maxPageReached": effective_max_pages,
            }
            ok, msg = upload_csv(main_csv_path, term, aggregation_meta=deep_meta)
            if ok:
                print(f"OK (+{new_count} new from {p2_row_count} collected, upload: {msg})")
            else:
                print(f"OK (+{new_count} new from {p2_row_count} collected, upload failed: {msg})")

            success += 1
            total_new_rows += new_count

            # Clean up temp file
            try:
                p2_csv_path.unlink()
            except Exception:
                pass

        except PlaywrightTimeout:
            print("TIMEOUT")
            failed += 1
        except Exception as e:
            err_str = str(e)
            print(f"ERROR: {err_str}")
            failed += 1
            if "crash" in err_str.lower() or "target closed" in err_str.lower():
                consecutive_crashes += 1
                if consecutive_crashes >= 5:
                    print("\n  TOO MANY CRASHES. Stopping.")
                    break
                print(f"  ... browser crashed, restarting ({consecutive_crashes}/5) ...")
                try:
                    page = launch_browser()
                except Exception as e2:
                    print(f"  FATAL: Browser restart failed: {e2}")
                    break
            else:
                consecutive_crashes = 0

        # Human-like delay between searches
        if i < len(candidates) - 1:
            if (i + 1) >= next_coffee:
                pause = random.uniform(*COFFEE_BREAK_DURATION)
                print(f"  ... taking a {pause:.0f}s break ...")
                time.sleep(pause)
                next_coffee = i + 1 + random.randint(*COFFEE_BREAK_EVERY)
            elif effective_max_pages > 2 and random.random() < 0.15:
                # Deep pagination coins: 15% chance of a short "scroll break"
                # between coins to vary the rhythm
                micro = random.uniform(10, 25)
                print(f"  ... short pause {micro:.0f}s ...")
                time.sleep(micro)
            else:
                rand_delay(DELAY_BETWEEN_SEARCHES)

        # Re-check login periodically
        if (i + 1) % 25 == 0:
            if not is_logged_in(page):
                print("\n  SESSION EXPIRED. Stopping.")
                break

    # Cleanup
    try:
        save_cookies(context)
        browser.close()
    except Exception:
        pass
    pw_instance.stop()

    print(f"\n=== Page 2 Enrichment Complete ===")
    print(f"  Enriched:   {success}")
    print(f"  New rows:   {total_new_rows}")
    print(f"  No page 2:  {skipped}")
    print(f"  Failed:     {failed}")
    print(f"  Remaining:  {len(candidates) - success - failed - skipped}")


# ── CLI ─────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Terapeak sales data aggregator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 scripts/sales-aggregator.py                           # Dashboard mode (interactive)
  python3 scripts/sales-aggregator.py --dry-run                 # Show candidates
  python3 scripts/sales-aggregator.py --run                     # Enrich all 50-row coins
  python3 scripts/sales-aggregator.py --run --filter "Morgan"   # Morgans only
  python3 scripts/sales-aggregator.py --run --limit 10          # First 10 candidates
  python3 scripts/sales-aggregator.py --run --min-rows 45       # Custom threshold

Dashboard mode (no --run/--dry-run):
  Queries the server for dataset priorities and shows an interactive menu
  to pick which category to aggregate next (stale, needs-deep, thin).
        """,
    )
    parser.add_argument("--run", action="store_true", help="Run page 2+ enrichment")
    parser.add_argument("--dry-run", action="store_true", help="Show candidates without collecting")
    parser.add_argument("--filter", type=str, help="Only enrich terms matching this regex")
    parser.add_argument("--exclude", type=str, help="Exclude terms matching this regex")
    parser.add_argument("--limit", type=int, help="Max number of coins to enrich")
    parser.add_argument("--min-rows", type=int, default=50, help="Min rows to qualify (default: 50)")
    parser.add_argument("--max-pages", type=int, default=None,
                        help="Max pages to collect (default: 6 for bullion, 2 for others)")
    parser.add_argument("--resume", type=str, metavar="LOGFILE",
                        help="Skip coins already completed in this log file (e.g. cache/terapeak_eagles_p2.log)")

    args = parser.parse_args()

    if args.run or args.dry_run:
        do_page2_run(args)
    else:
        dashboard(args)


# ── Dashboard Mode ──────────────────────────────────────────
def dashboard(args):
    """Query the server for dataset priorities and present an interactive menu."""
    print("\n╔══════════════════════════════════════════════════════════════╗")
    print("║           SALES AGGREGATOR — DASHBOARD                      ║")
    print("╚══════════════════════════════════════════════════════════════╝\n")

    if not ADMIN_API_KEY:
        print("ERROR: ADMIN_API_KEY not set. Export it or add to .env")
        return

    headers = {"x-api-key": ADMIN_API_KEY}

    # Fetch full status from server
    try:
        resp = requests.get(f"{APP_URL}/api/terapeak/aggregation-status", headers=headers, timeout=10)
        resp.raise_for_status()
        full_data = resp.json()
    except requests.exceptions.ConnectionError:
        print(f"ERROR: Cannot connect to server at {APP_URL}")
        print("  Start the server first: node server.js")
        return
    except Exception as e:
        print(f"ERROR: Failed to fetch aggregation status: {e}")
        return

    summary = full_data.get("summary", {})
    total = summary.get("total", 0)
    with_page1 = summary.get("withPage1", 0)
    with_deep = summary.get("withDeep", 0)
    needs_deep = summary.get("needsDeep", 0)

    # Fetch category-specific lists
    categories = {}

    # 1. Needs deep pagination (page1 done, comps >= 50, no deep yet)
    try:
        r = requests.get(f"{APP_URL}/api/terapeak/aggregation-status",
                         params={"needs": "deep", "minComps": "50"}, headers=headers, timeout=10)
        r.raise_for_status()
        categories["deep"] = r.json().get("datasets", [])
    except Exception:
        categories["deep"] = []

    # 2. Stale datasets (not refreshed in 14 days)
    try:
        r = requests.get(f"{APP_URL}/api/terapeak/aggregation-status",
                         params={"needs": "refresh", "maxAge": "14"}, headers=headers, timeout=10)
        r.raise_for_status()
        categories["stale"] = r.json().get("datasets", [])
    except Exception:
        categories["stale"] = []

    # 3. Thin datasets (fewer than 20 comps -- need more data)
    all_datasets = full_data.get("datasets", [])
    categories["thin"] = [d for d in all_datasets if d.get("compCount", 0) < 20]

    # ── Display Summary ──────────────────────────────────────
    print(f"  Server:         {APP_URL}")
    print(f"  Total datasets: {total}")
    print(f"  Page 1 done:    {with_page1}/{total}")
    print(f"  Deep done:      {with_deep}/{total}")
    print(f"  Needs deep:     {needs_deep}")
    print()

    # ── Priority Categories ──────────────────────────────────
    menu_items = []

    if categories["deep"]:
        n = len(categories["deep"])
        bullion = [d for d in categories["deep"] if is_bullion_term(d.get("searchTerm", ""))]
        non_bullion = [d for d in categories["deep"] if not is_bullion_term(d.get("searchTerm", ""))]
        print(f"  [1] Needs deep pagination:  {n} datasets ({len(bullion)} bullion, {len(non_bullion)} other)")
        menu_items.append(("deep", categories["deep"]))
    else:
        print(f"  [1] Needs deep pagination:  0 (all caught up!)")

    if categories["stale"]:
        n = len(categories["stale"])
        print(f"  [2] Stale (>14 days):       {n} datasets")
        menu_items.append(("stale", categories["stale"]))
    else:
        print(f"  [2] Stale (>14 days):       0 (all fresh!)")
        menu_items.append(("stale", []))

    if categories["thin"]:
        n = len(categories["thin"])
        print(f"  [3] Thin (<20 comps):       {n} datasets")
        menu_items.append(("thin", categories["thin"]))
    else:
        print(f"  [3] Thin (<20 comps):       0")
        menu_items.append(("thin", []))

    print(f"\n  [4] Show all datasets")
    print(f"  [q] Quit")
    print()

    # ── Interactive Selection ────────────────────────────────
    try:
        choice = input("  Choose [1-4, q]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print("\n  Bye.")
        return

    if choice == "q" or not choice:
        return

    if choice == "4":
        _show_all_datasets(all_datasets)
        return

    choice_idx = int(choice) - 1 if choice.isdigit() else -1
    if choice_idx < 0 or choice_idx >= len(menu_items):
        print("  Invalid choice.")
        return

    category_name, datasets = menu_items[choice_idx]
    if not datasets:
        print("  Nothing in this category.")
        return

    _show_category(category_name, datasets)

    # ── Offer to launch aggregation ─────────────────────────
    print()
    try:
        action = input("  Launch aggregation for this category? [y/N/filter regex]: ").strip()
    except (EOFError, KeyboardInterrupt):
        print("\n  Bye.")
        return

    if not action or action.lower() == "n":
        return

    # Build search terms from the selected datasets
    terms = [d.get("searchTerm", "") for d in datasets if d.get("searchTerm")]

    if action.lower() == "y":
        _launch_run(terms, category_name, filter_pattern=None, args=args)
    else:
        # Treat input as a filter regex
        _launch_run(terms, category_name, filter_pattern=action, args=args)


def _show_all_datasets(datasets):
    """Display a sorted list of all datasets."""
    sorted_ds = sorted(datasets, key=lambda d: d.get("compCount", 0), reverse=True)
    print(f"\n  {'#':>4s}  {'Comps':>5s}  {'Deep?':>5s}  Search Term")
    print(f"  {'─'*4}  {'─'*5}  {'─'*5}  {'─'*50}")
    for i, d in enumerate(sorted_ds[:100], 1):
        deep = "yes" if d.get("aggregationMeta", {}) and d["aggregationMeta"].get("deepAt") else "  -"
        comps = d.get("compCount", 0)
        term = d.get("searchTerm", d.get("key", "?"))
        print(f"  {i:4d}  {comps:5d}  {deep:>5s}  {term}")
    if len(sorted_ds) > 100:
        print(f"\n  ... and {len(sorted_ds) - 100} more (showing top 100 by comp count)")


def _show_category(category_name, datasets):
    """Display datasets in a category."""
    label = {
        "deep": "NEEDS DEEP PAGINATION",
        "stale": "STALE (>14 DAYS)",
        "thin": "THIN (<20 COMPS)",
    }.get(category_name, category_name.upper())

    sorted_ds = sorted(datasets, key=lambda d: d.get("compCount", 0), reverse=True)
    print(f"\n  ── {label} ({len(sorted_ds)} datasets) ──")
    print(f"  {'#':>4s}  {'Comps':>5s}  {'Type':>8s}  Search Term")
    print(f"  {'─'*4}  {'─'*5}  {'─'*8}  {'─'*50}")
    for i, d in enumerate(sorted_ds[:50], 1):
        comps = d.get("compCount", 0)
        term = d.get("searchTerm", d.get("key", "?"))
        tag = "bullion" if is_bullion_term(term) else "coin"
        print(f"  {i:4d}  {comps:5d}  {tag:>8s}  {term}")
    if len(sorted_ds) > 50:
        print(f"\n  ... and {len(sorted_ds) - 50} more (showing top 50)")


def _launch_run(terms, category_name, filter_pattern=None, args=None):
    """Launch aggregation for a set of terms by re-invoking with --run."""
    import subprocess

    # Build filter regex from search terms if no explicit filter
    if filter_pattern:
        filter_arg = filter_pattern
    elif len(terms) <= 20:
        # Build a regex alternation from the terms
        escaped = [re.escape(t) for t in terms]
        filter_arg = "|".join(escaped)
    else:
        # Too many for a regex -- use the category's needs= param as filter
        filter_arg = None

    script_path = Path(__file__).resolve()
    cmd = [sys.executable, str(script_path), "--run"]

    if filter_arg:
        cmd.extend(["--filter", filter_arg])

    if category_name == "deep":
        cmd.extend(["--min-rows", "50"])
    elif category_name == "thin":
        cmd.extend(["--min-rows", "1"])

    # Inherit user's CLI args
    if args and hasattr(args, "limit") and args.limit:
        cmd.extend(["--limit", str(args.limit)])
    if args and hasattr(args, "max_pages") and args.max_pages:
        cmd.extend(["--max-pages", str(args.max_pages)])
    if args and hasattr(args, "exclude") and args.exclude:
        cmd.extend(["--exclude", args.exclude])

    print(f"\n  Launching: {' '.join(cmd)}\n")
    print("─" * 60)

    # Replace this process with the run
    os.execv(sys.executable, cmd)


if __name__ == "__main__":
    main()
