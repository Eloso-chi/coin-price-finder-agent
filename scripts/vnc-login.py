#!/usr/bin/env python3
"""Quick login helper: opens browser, waits for login, saves cookies, then exits."""
import json, time, sys, os
from pathlib import Path
from playwright.sync_api import sync_playwright

COOKIE_FILE = Path(__file__).parent.parent / "cache" / "ebay_cookies.json"
LOGIN_URL = "https://signin.ebay.com/ws/eBayISAPI.dll?SignIn"
RESEARCH_URL = "https://www.ebay.com/sh/research"

with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=False,
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled",
              "--disable-dev-shm-usage", "--disable-infobars"],
    )
    context = browser.new_context(
        viewport={"width": 1280, "height": 900},
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    )
    # Mask webdriver flag
    context.add_init_script("Object.defineProperty(navigator, 'webdriver', { get: () => false });")

    page = context.new_page()
    page.goto(LOGIN_URL, wait_until="domcontentloaded")
    print("Browser opened to eBay login page.")
    print("Log in via VNC, solve any CAPTCHA/2FA.")
    print("I'll auto-detect when you're logged in...\n")
    sys.stdout.flush()

    # Poll until the page shows a logged-in state (check every 5 seconds)
    logged_in = False
    for attempt in range(120):  # up to 10 minutes
        time.sleep(5)
        try:
            url = page.url
            cookies = context.cookies()
            ebay_c = [c for c in cookies if c.get("name") == "ebay"]
            has_sin = ebay_c and "sin%3Din" in ebay_c[0].get("value", "")

            # Check if not on signin/captcha AND has the sin=in cookie
            if has_sin and "signin" not in url.lower() and "captcha" not in url.lower():
                print(f"  [{attempt*5}s] Detected login! (sin=in cookie found)")
                logged_in = True
                break

            # Also check page content as fallback
            content = page.content()
            if ("Hi " in content or "Sign out" in content) and "signin" not in url.lower() and "captcha" not in url.lower():
                print(f"  [{attempt*5}s] Detected login! (page content check)")
                logged_in = True
                break

            if attempt % 6 == 0:  # every 30 seconds
                print(f"  [{attempt*5}s] Waiting for login... (url: {url[:60]})")
        except Exception:
            pass  # browser navigating, ignore

    if not logged_in:
        print("Timed out waiting for login (10 min). Try again.")
        browser.close()
        sys.exit(1)

    # Navigate to research to verify + pick up extra cookies
    print("Checking login...")
    page.goto(RESEARCH_URL, wait_until="domcontentloaded")
    time.sleep(3)

    url = page.url
    if "captcha" in url.lower() or "signin" in url.lower():
        print(f"Login check failed -- landed on: {url}")
        print("Try solving any remaining CAPTCHA in the VNC browser, then run this script again.")
        browser.close()
        sys.exit(1)

    # Save cookies
    cookies = context.cookies()
    COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(COOKIE_FILE, "w") as f:
        json.dump(cookies, f, indent=2)
    print(f"Saved {len(cookies)} native Playwright cookies to {COOKIE_FILE}")

    # Verify
    ebay_c = [c for c in cookies if c.get("name") == "ebay"]
    if ebay_c and "sin%3Din" in ebay_c[0].get("value", ""):
        print("LOGIN CONFIRMED (sin=in). You can now run --run")
    else:
        print(f"Landing page: {page.title()} -- {url}")
        print("Cookies saved. Try running --run to test.")

    browser.close()
