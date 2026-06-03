#!/usr/bin/env python3
"""
Cookie health check for the Terapeak scraper (#250).

Standalone diagnostic that loads the active cookie jar (COOKIE_FILE env or
cache/ebay_cookies.json default), checks expiry timestamps locally, optionally
makes a low-cost HEAD-equivalent navigation to eBay's Terapeak research page
via Playwright, and reports the verdict with an actionable exit code.

EXIT CODES:
  0  HEALTHY  -- session looks usable. No expired auth cookies; key Akamai
                 bot-mgmt cookies present and within their TTL; if --probe was
                 requested, eBay accepted the session.
  1  EXPIRED  -- one or more critical cookies are past their expiry, or the
                 cookie file is corrupt/unparseable. Manual re-login required
                 (terapeak-export.py --login on a desktop, or --cookie-file
                 paste from a logged-in browser).
  2  CHALLENGED -- session loaded fine but eBay is serving an Akamai/hCaptcha
                   challenge instead of the Terapeak page. Same remedy as
                   EXPIRED but distinct cause (IP reputation / behavioral
                   trip, not stale tokens).
  3  MISSING  -- no cookie file at the resolved path. First-time setup needed.
  4  PROBE_FAILED -- --probe was requested but could not run (no Playwright,
                     chromium launch failed, cookie injection failed). Caller
                     should treat as INDETERMINATE, not HEALTHY.

USAGE:
  python3 scripts/cookie-health-check.py                # offline check only
  python3 scripts/cookie-health-check.py --probe        # also probe eBay
  python3 scripts/cookie-health-check.py --json         # machine-readable
  COOKIE_FILE=~/cpf/cookies-surface.json python3 scripts/cookie-health-check.py

Designed to be cheap, fast (<1s offline, <10s probe), and side-effect-free.
Safe for use in pre-flight scripts or scheduled jobs.
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PROJECT_DIR = Path(__file__).parent.parent
DEFAULT_COOKIE_FILE = PROJECT_DIR / "cache" / "ebay_cookies.json"

# Cookies whose expiry the auth-session genuinely depends on. If any of these
# are past expiry, the session is dead -- not just degraded. Anything Akamai
# bot-mgmt (bm_*, ak_*, __cf_bm, cpt) is auto-rotated on every accepted
# request, so a stale entry there is normal and does NOT mean the session is
# broken; eBay's edge will re-mint them if the underlying identity tier is
# trusted. Excluded from this list on purpose.
#
# How this set was derived: jar inspection on 2026-06-03 (sample size 1, the
# operator's working Terapeak session). eBay does NOT publish this contract,
# so if they rename/replace a critical cookie this offline check will silently
# downgrade to HEALTHY while the real session is dead. After any production
# false-positive, re-run with --probe to confirm and update this set.
CRITICAL_PERSISTENT_COOKIES = {"dp1", "cid", "ebaysid", "shs", "ns1", "totp"}

# Cookies that may not yet exist in a freshly-extracted jar (e.g. browser
# wasn't on devicebind.ebay.com when cookies were exported). Their absence is
# warned, not fatal.
OPTIONAL_PERSISTENT_COOKIES = {"nonsession", "thx_guid", "tmx_guid"}

EBAY_RESEARCH_URL = "https://www.ebay.com/sh/research"


# Sentinel returned by load_cookies() to distinguish a corrupt/unreadable jar
# from an intentionally-empty one. The classifier treats both as EXPIRED but
# emits distinct reason strings so the operator can tell whether to re-login
# (empty) or investigate disk corruption / partial-write (corrupt).
LOAD_CORRUPT = object()


def load_cookies(path: Path):
    """
    Load a Playwright cookie jar.

    Schema expected (matches `context.cookies()` output):
      [{name, value, domain, path, expires, httpOnly, secure, sameSite}, ...]
    where `expires` is a float (seconds since epoch) or -1 for a session
    cookie.

    Returns:
      None          -- file does not exist
      []            -- file exists but contains an empty list (rare; usually a
                       brand-new jar before --login completes)
      LOAD_CORRUPT  -- file exists but is unparseable
      list[dict]    -- normal case
    """
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"ERROR: cannot read {path}: {e}", file=sys.stderr)
        return LOAD_CORRUPT


def classify_offline(cookies, now_ts):
    """Pure local check: which cookies are expired, missing, or healthy."""
    if cookies is None:
        return {"status": "MISSING", "reasons": []}
    if cookies is LOAD_CORRUPT:
        return {"status": "EXPIRED", "reasons": ["cookie file is corrupt or unparseable (see stderr)"]}
    if not cookies:
        return {"status": "EXPIRED", "reasons": ["cookie file is empty"]}

    present = {c.get("name") for c in cookies}
    expired_critical = []
    for c in cookies:
        name = c.get("name")
        exp = c.get("expires", -1)
        # Negative or zero expires == session cookie (no expiry timestamp);
        # browser drops them when context closes. Cannot evaluate offline.
        if exp and exp > 0 and exp < now_ts:
            if name in CRITICAL_PERSISTENT_COOKIES:
                expired_critical.append(name)

    missing_critical = sorted(CRITICAL_PERSISTENT_COOKIES - present)
    reasons = []
    if missing_critical:
        reasons.append(f"missing critical cookies: {missing_critical}")
    if expired_critical:
        reasons.append(f"expired critical cookies: {expired_critical}")

    if missing_critical or expired_critical:
        return {"status": "EXPIRED", "reasons": reasons}
    return {"status": "HEALTHY", "reasons": []}


def summarize(cookies, now_ts):
    """Compact summary of the jar for output."""
    if not cookies:
        return {"total": 0}
    buckets = {"EXPIRED": 0, "<24h": 0, "1-7d": 0, "7-30d": 0, ">30d": 0, "session": 0}
    for c in cookies:
        exp = c.get("expires", -1)
        if not exp or exp <= 0:
            buckets["session"] += 1
            continue
        hours = (exp - now_ts) / 3600
        if hours <= 0:
            buckets["EXPIRED"] += 1
        elif hours < 24:
            buckets["<24h"] += 1
        elif hours < 24 * 7:
            buckets["1-7d"] += 1
        elif hours < 24 * 30:
            buckets["7-30d"] += 1
        else:
            buckets[">30d"] += 1
    return {"total": len(cookies), "buckets": buckets}


def probe_ebay(cookies):
    """
    Optional live probe -- launches headless Chromium with the jar, navigates
    to the research URL, classifies the response. Costs one quota unit.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {"verdict": "SKIPPED", "reason": "playwright not installed"}

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(
                headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            )
        except Exception as e:
            return {"verdict": "SKIPPED", "reason": f"chromium launch failed: {e}"}

        try:
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/134.0.0.0 Safari/537.36"
                ),
            )
            normalized = []
            for c in cookies:
                cc = dict(c)
                ss = cc.get("sameSite")
                if ss not in (None, "Strict", "Lax", "None"):
                    cc["sameSite"] = "None" if ss in ("no_restriction", "unspecified") else "Lax"
                normalized.append(cc)
            try:
                context.add_cookies(normalized)
            except Exception as e:
                return {"verdict": "SKIPPED", "reason": f"cookie injection failed: {e}"}

            page = context.new_page()
            try:
                resp = page.goto(EBAY_RESEARCH_URL, wait_until="domcontentloaded", timeout=15000)
            except Exception as e:
                return {"verdict": "CHALLENGED", "reason": f"navigation failed: {e}"}

            final_url = page.url
            status = resp.status if resp else None
            # Akamai/hCaptcha challenge fingerprints. Conservative -- prefer
            # false CHALLENGED to false HEALTHY because the next step is "go
            # re-login", which is cheap.
            body_snippet = ""
            try:
                body_snippet = page.content()[:4000].lower()
            except Exception:
                pass

            challenge_signals = [
                "captcha" in body_snippet,
                "hcaptcha" in body_snippet,
                "are you a human" in body_snippet,
                "/splashui/" in final_url.lower(),
                "/captcha" in final_url.lower(),
                status is not None and status in (403, 429),
            ]

            if any(challenge_signals):
                return {
                    "verdict": "CHALLENGED",
                    "reason": "Akamai/hCaptcha or HTTP block detected",
                    "final_url": final_url,
                    "status": status,
                }
            # Heuristic for "we landed on the real research page": URL
            # contains /sh/research and not a redirect to signin.
            if "/signin" in final_url.lower() or "/login" in final_url.lower():
                return {"verdict": "EXPIRED", "reason": "redirected to sign-in", "final_url": final_url}
            if "/sh/research" not in final_url.lower():
                return {
                    "verdict": "CHALLENGED",
                    "reason": f"unexpected landing URL: {final_url}",
                    "status": status,
                }
            return {"verdict": "HEALTHY", "final_url": final_url, "status": status}
        finally:
            try:
                browser.close()
            except Exception:
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--probe", action="store_true",
                        help="Also launch headless Chromium and probe eBay (costs 1 quota unit, ~10s)")
    parser.add_argument("--json", action="store_true",
                        help="Output structured JSON to stdout instead of human-readable text")
    args = parser.parse_args()

    cookie_path_str = os.path.expanduser(
        os.environ.get("COOKIE_FILE", str(DEFAULT_COOKIE_FILE))
    )
    cookie_path = Path(cookie_path_str)
    now_ts = time.time()

    cookies = load_cookies(cookie_path)
    offline = classify_offline(cookies, now_ts)
    # Stat once -- avoids a TOCTOU window where the file gets deleted between
    # the report-time stat and the human-readable age computation below.
    mtime_iso = None
    mtime_epoch = None
    try:
        st = cookie_path.stat()
        mtime_epoch = st.st_mtime
        mtime_iso = datetime.fromtimestamp(mtime_epoch, tz=timezone.utc).isoformat()
    except FileNotFoundError:
        pass

    probe_result = None
    if args.probe and offline["status"] == "HEALTHY" and cookies and cookies is not LOAD_CORRUPT:
        probe_result = probe_ebay(cookies)

    # Final verdict precedence:
    # 1. offline EXPIRED/MISSING always wins (no point probing a dead jar)
    # 2. probe CHALLENGED/EXPIRED overrides offline HEALTHY
    # 3. probe SKIPPED when --probe was explicitly requested -> PROBE_FAILED
    #    (do NOT silently report HEALTHY -- a broken chromium install or
    #    missing playwright would otherwise green-light a cron caller)
    status = offline["status"]
    if probe_result and probe_result.get("verdict") in ("CHALLENGED", "EXPIRED"):
        status = probe_result["verdict"]
    elif args.probe and probe_result and probe_result.get("verdict") == "SKIPPED":
        status = "PROBE_FAILED"

    exit_code = {
        "HEALTHY": 0,
        "EXPIRED": 1,
        "CHALLENGED": 2,
        "MISSING": 3,
        "PROBE_FAILED": 4,
    }[status]

    # Normalize sentinels/None to an empty list for the summary -- LOAD_CORRUPT
    # is a sentinel object (truthy, not iterable), so `cookies or []` is not
    # enough.
    cookie_list = cookies if isinstance(cookies, list) else []
    summary = summarize(cookie_list, now_ts)
    report = {
        "status": status,
        "exit_code": exit_code,
        "cookie_file": str(cookie_path),
        "cookie_file_mtime": mtime_iso,
        "checked_at": datetime.now(tz=timezone.utc).isoformat(),
        "offline": offline,
        "summary": summary,
        "probe": probe_result,
    }

    if args.json:
        json.dump(report, sys.stdout, indent=2, default=str)
        print()
    else:
        print(f"Cookie file: {cookie_path}")
        if mtime_iso and mtime_epoch is not None:
            age_h = (now_ts - mtime_epoch) / 3600
            print(f"  Last modified: {mtime_iso}  ({age_h:.1f}h ago)")
        print(f"  Total cookies: {summary.get('total', 0)}")
        if summary.get("buckets"):
            print(f"  Expiry buckets: {summary['buckets']}")
        print(f"  Offline classification: {offline['status']}")
        for r in offline["reasons"]:
            print(f"    - {r}")
        if probe_result is not None:
            print(f"  Live probe verdict: {probe_result.get('verdict')}")
            if probe_result.get("reason"):
                print(f"    reason: {probe_result['reason']}")
            if probe_result.get("final_url"):
                print(f"    final URL: {probe_result['final_url']}")
        print()
        print(f"FINAL STATUS: {status}  (exit code {exit_code})")
        if status == "EXPIRED":
            print("  Remedy: refresh cookies via 'terapeak-export.py --login' (desktop)")
            print("          or 'terapeak-export.py --cookie-file <paste.json>' from a logged-in browser.")
        elif status == "CHALLENGED":
            print("  Remedy: same as EXPIRED. eBay is serving a CAPTCHA challenge,")
            print("          which means the IP/fingerprint is no longer trusted.")
            print("          Avoid further scrape attempts from this machine for a few hours.")
        elif status == "MISSING":
            print("  Remedy: first-time setup. See docs/runbooks/local-scraper-wsl2.md")
        elif status == "PROBE_FAILED":
            print("  Remedy: --probe could not run (see probe.reason above).")
            print("          Install Playwright + Chromium, or omit --probe and")
            print("          rely on the offline classification only.")

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
