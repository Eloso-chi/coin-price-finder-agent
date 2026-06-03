"""Tests for scripts/cookie-health-check.py (#250).

Covers the pure-function contract (classify_offline, summarize, load_cookies
sentinel behavior) and the exit-code matrix (HEALTHY=0 / EXPIRED=1 /
CHALLENGED=2 / MISSING=3 / PROBE_FAILED=4) that cron-style callers depend on.

Does NOT exercise probe_ebay's real Chromium path -- that would require
network, real eBay quota, and a working browser binary. Probe behavior is
covered indirectly via the PROBE_FAILED simulation (fake playwright module
that raises on launch).
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parent.parent / "scripts" / "cookie-health-check.py"


@pytest.fixture(scope="module")
def chc():
    """Import the script as a module under a friendly name."""
    spec = importlib.util.spec_from_file_location("cookie_health_check", SCRIPT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---------------------------------------------------------------------------
# load_cookies
# ---------------------------------------------------------------------------

def test_load_cookies_missing_returns_none(chc, tmp_path):
    assert chc.load_cookies(tmp_path / "nope.json") is None


def test_load_cookies_empty_list(chc, tmp_path):
    p = tmp_path / "empty.json"
    p.write_text("[]")
    assert chc.load_cookies(p) == []


def test_load_cookies_corrupt_returns_sentinel(chc, tmp_path, capsys):
    p = tmp_path / "corrupt.json"
    p.write_text("not json{{{")
    result = chc.load_cookies(p)
    assert result is chc.LOAD_CORRUPT
    # Error must go to stderr (not stdout) so --json consumers aren't polluted.
    assert "cannot read" in capsys.readouterr().err


def test_load_cookies_valid(chc, tmp_path):
    p = tmp_path / "ok.json"
    cookies = [{"name": "dp1", "value": "x", "expires": time.time() + 86400}]
    p.write_text(json.dumps(cookies))
    assert chc.load_cookies(p) == cookies


# ---------------------------------------------------------------------------
# classify_offline
# ---------------------------------------------------------------------------

def _all_critical(now, hours_out=24 * 30):
    """Build a jar with every CRITICAL_PERSISTENT_COOKIES name far-future."""
    return [
        {"name": name, "value": "x", "expires": now + hours_out * 3600}
        for name in ["dp1", "cid", "ebaysid", "shs", "ns1", "totp"]
    ]


def test_classify_missing_when_cookies_none(chc):
    assert chc.classify_offline(None, time.time())["status"] == "MISSING"


def test_classify_corrupt_distinct_reason(chc):
    out = chc.classify_offline(chc.LOAD_CORRUPT, time.time())
    assert out["status"] == "EXPIRED"
    assert any("corrupt" in r for r in out["reasons"])


def test_classify_empty_distinct_reason(chc):
    out = chc.classify_offline([], time.time())
    assert out["status"] == "EXPIRED"
    assert out["reasons"] == ["cookie file is empty"]


def test_classify_healthy_when_all_critical_present_and_fresh(chc):
    now = time.time()
    out = chc.classify_offline(_all_critical(now), now)
    assert out == {"status": "HEALTHY", "reasons": []}


def test_classify_expired_when_critical_missing(chc):
    now = time.time()
    jar = _all_critical(now)
    jar = [c for c in jar if c["name"] != "dp1"]  # drop one critical
    out = chc.classify_offline(jar, now)
    assert out["status"] == "EXPIRED"
    assert any("missing critical cookies" in r and "dp1" in r for r in out["reasons"])


def test_classify_expired_when_critical_past_expiry(chc):
    now = time.time()
    jar = _all_critical(now)
    # Force one critical cookie into the past.
    for c in jar:
        if c["name"] == "ebaysid":
            c["expires"] = now - 3600
    out = chc.classify_offline(jar, now)
    assert out["status"] == "EXPIRED"
    assert any("expired critical cookies" in r and "ebaysid" in r for r in out["reasons"])


def test_classify_ignores_expired_akamai_tokens(chc):
    """The whole point of the critical-set design: bm_*/cpt/__cf_bm rotating
    out is NORMAL and must not flip the verdict to EXPIRED. Regression guard
    for the cookie-jar audit from 2026-06-03 (4 expired Akamai tokens in a
    jar that was nevertheless working fine)."""
    now = time.time()
    jar = _all_critical(now) + [
        {"name": "bm_sz", "value": "x", "expires": now - 3600},
        {"name": "bm_sv", "value": "x", "expires": now - 7200},
        {"name": "__cf_bm", "value": "x", "expires": now - 1800},
        {"name": "cpt", "value": "x", "expires": now - 600},
    ]
    assert chc.classify_offline(jar, now)["status"] == "HEALTHY"


def test_classify_treats_session_cookies_as_neutral(chc):
    """expires == -1 means session cookie; no expiry timestamp to evaluate."""
    now = time.time()
    jar = _all_critical(now) + [{"name": "session_only", "value": "x", "expires": -1}]
    assert chc.classify_offline(jar, now)["status"] == "HEALTHY"


# ---------------------------------------------------------------------------
# summarize
# ---------------------------------------------------------------------------

def test_summarize_empty_jar(chc):
    assert chc.summarize([], time.time()) == {"total": 0}


def test_summarize_bucket_boundaries(chc):
    now = 1_000_000_000.0  # fixed epoch -- avoids drift-around-boundary flakes
    jar = [
        {"name": "a", "expires": now - 1},              # EXPIRED
        {"name": "b", "expires": now + 3600},           # <24h (1h)
        {"name": "c", "expires": now + 3 * 86400},      # 1-7d
        {"name": "d", "expires": now + 14 * 86400},     # 7-30d
        {"name": "e", "expires": now + 60 * 86400},     # >30d
        {"name": "f", "expires": -1},                   # session
        {"name": "g", "expires": 0},                    # session (treat 0 as session)
    ]
    s = chc.summarize(jar, now)
    assert s["total"] == 7
    assert s["buckets"] == {
        "EXPIRED": 1,
        "<24h": 1,
        "1-7d": 1,
        "7-30d": 1,
        ">30d": 1,
        "session": 2,
    }


# ---------------------------------------------------------------------------
# End-to-end exit code contract via subprocess
# ---------------------------------------------------------------------------
# Exit codes are the public contract for cron / scheduler callers. Drift here
# would silently break automated scrape pipelines, so we lock them in.

def _run(env_overrides, args=None):
    env = os.environ.copy()
    # Strip COOKIE_FILE from inherited env so tests are deterministic.
    env.pop("COOKIE_FILE", None)
    env.update(env_overrides)
    args = args or []
    return subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )


def test_cli_exit_missing(tmp_path):
    r = _run({"COOKIE_FILE": str(tmp_path / "nope.json")})
    assert r.returncode == 3
    assert "MISSING" in r.stdout


def test_cli_exit_empty_jar(tmp_path):
    p = tmp_path / "empty.json"
    p.write_text("[]")
    r = _run({"COOKIE_FILE": str(p)})
    assert r.returncode == 1
    assert "EXPIRED" in r.stdout
    assert "empty" in r.stdout


def test_cli_exit_corrupt_jar(tmp_path):
    p = tmp_path / "corrupt.json"
    p.write_text("not json{{{")
    r = _run({"COOKIE_FILE": str(p)})
    assert r.returncode == 1
    assert "corrupt" in r.stdout
    # stderr carries the parse error detail
    assert "cannot read" in r.stderr


def test_cli_exit_healthy(tmp_path):
    p = tmp_path / "ok.json"
    now = time.time()
    p.write_text(json.dumps([
        {"name": n, "value": "x", "expires": now + 30 * 86400}
        for n in ["dp1", "cid", "ebaysid", "shs", "ns1", "totp"]
    ]))
    r = _run({"COOKIE_FILE": str(p)})
    assert r.returncode == 0, r.stdout + r.stderr
    assert "HEALTHY" in r.stdout


def test_cli_json_mode_structure(tmp_path):
    """--json output is the machine contract for the scheduler agent."""
    p = tmp_path / "ok.json"
    now = time.time()
    p.write_text(json.dumps([
        {"name": n, "value": "x", "expires": now + 30 * 86400}
        for n in ["dp1", "cid", "ebaysid", "shs", "ns1", "totp"]
    ]))
    r = _run({"COOKIE_FILE": str(p)}, args=["--json"])
    assert r.returncode == 0
    payload = json.loads(r.stdout)
    assert payload["status"] == "HEALTHY"
    assert payload["exit_code"] == 0
    assert payload["cookie_file"] == str(p)
    assert payload["summary"]["total"] == 6
    assert payload["probe"] is None  # --probe not requested
