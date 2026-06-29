#!/usr/bin/env python3
"""Smoke test for scripts/_parse-terapeak-pass.py.

Runs the parser against a synthetic pass log fixture and asserts the resulting
JSONL records match expected counts and per-coin status values.

Run directly:
    python3 scripts/test_parse_terapeak_pass.py

Exit 0 = pass, 1 = fail. Stderr names the failed assertion.

Added under PR #200 review finding #2 (best-effort parser had no regression
coverage; any change to the log-line regexes could silently corrupt the ledger).
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PARSER = os.path.join(HERE, "_parse-terapeak-pass.py")

# Fixture covers:
#  - same-line OK                           -> status=ok
#  - same-line WARNING (no data)            -> status=empty
#  - continuation HTTP 200 + late OK        -> must NOT mark failed (finding #1)
#  - continuation HTTP 422                  -> status=failed, error="HTTP 422"
#  - continuation (dormant: ...)            -> dormant=True, status preserved
#  - continuation NO EXPORT                 -> status=empty
FIXTURE = """\
[  4%] 1889-S Morgan Silver Dollar... OK (124 new, 143 dups)
[  8%] 1884-CC Morgan Silver Dollar... WARNING: No data rows found
[ 12%] 1943 Washington Quarter Silver...
    HTTP 200 OK
    OK (48 new, 15 dups)
[ 16%] 2024 Some Coin That Errors...
    HTTP 422: No valid comps found
[ 20%] 1900-O Morgan Dollar... OK (5 new, 2 dups)
    (dormant: 30 days)
[ 24%] 1925 Standing Liberty Quarter...
NO EXPORT

Succeeded: 3
Failed: 1
"""

EXPECTED_PASS = {
    "attempted": 6,
    "succeeded": 3,       # 1889-S, 1943, 1900-O
    "empty": 2,           # 1884-CC, 1925
    "failed": 1,          # 2024 (HTTP 422)
    "unknown": 0,
    "dormant": 1,         # 1900-O
    "new_rows": 177,      # 124 + 48 + 5
    "dup_rows": 160,      # 143 + 15 + 2
}

# Per-coin status assertions (idx -> expected status)
EXPECTED_COIN_STATUS = {
    1: ("1889-S Morgan Silver Dollar", "ok",     124, 143, False),
    2: ("1884-CC Morgan Silver Dollar", "empty",   0,   0, False),
    3: ("1943 Washington Quarter Silver", "ok",   48,  15, False),
    4: ("2024 Some Coin That Errors",   "failed",  0,   0, False),
    5: ("1900-O Morgan Dollar",          "ok",     5,   2, True),
    6: ("1925 Standing Liberty Quarter", "empty",  0,   0, False),
}


def fail(msg):
    sys.stderr.write(f"FAIL: {msg}\n")
    sys.exit(1)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        log_path = os.path.join(tmp, "pass-0001.log")
        with open(log_path, "w", encoding="utf-8") as f:
            f.write(FIXTURE)
        runs_dir = os.path.join(tmp, "runs")
        env = dict(os.environ, TERAPEAK_RUNS_DIR=runs_dir)
        result = subprocess.run(
            [
                sys.executable, PARSER,
                "--pass-log", log_path,
                "--run-id", "TEST-RUN",
                "--pass-num", "1",
                "--batch-size", "6",
                "--start-ts", "2026-06-29T00:00:00Z",
                "--end-ts",   "2026-06-29T00:01:00Z",
                "--machine",  "W",
                "--include-thin", "false",
            ],
            env=env,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            fail(f"parser exit {result.returncode}\nstdout: {result.stdout}\nstderr: {result.stderr}")

        passes_path = os.path.join(runs_dir, "passes.jsonl")
        coins_path = os.path.join(runs_dir, "coins.jsonl")

        if not os.path.exists(passes_path):
            fail(f"passes.jsonl not created at {passes_path}")
        if not os.path.exists(coins_path):
            fail(f"coins.jsonl not created at {coins_path}")

        with open(passes_path, encoding="utf-8") as f:
            pass_lines = [json.loads(line) for line in f if line.strip()]
        if len(pass_lines) != 1:
            fail(f"expected 1 pass record, got {len(pass_lines)}")
        pass_rec = pass_lines[0]

        for key, expected in EXPECTED_PASS.items():
            actual = pass_rec.get(key)
            if actual != expected:
                fail(f"pass[{key}] expected {expected!r}, got {actual!r}")

        with open(coins_path, encoding="utf-8") as f:
            coin_lines = [json.loads(line) for line in f if line.strip()]
        if len(coin_lines) != len(EXPECTED_COIN_STATUS):
            fail(f"expected {len(EXPECTED_COIN_STATUS)} coin records, got {len(coin_lines)}")

        for rec in coin_lines:
            idx = rec.get("idx")
            if idx not in EXPECTED_COIN_STATUS:
                fail(f"unexpected coin idx {idx}")
            exp_coin, exp_status, exp_new, exp_dups, exp_dormant = EXPECTED_COIN_STATUS[idx]
            if rec.get("coin") != exp_coin:
                fail(f"coin[{idx}] name: expected {exp_coin!r}, got {rec.get('coin')!r}")
            if rec.get("status") != exp_status:
                fail(f"coin[{idx}] status: expected {exp_status!r}, got {rec.get('status')!r}")
            if rec.get("new") != exp_new:
                fail(f"coin[{idx}] new: expected {exp_new}, got {rec.get('new')}")
            if rec.get("dups") != exp_dups:
                fail(f"coin[{idx}] dups: expected {exp_dups}, got {rec.get('dups')}")
            if rec.get("dormant") != exp_dormant:
                fail(f"coin[{idx}] dormant: expected {exp_dormant}, got {rec.get('dormant')}")

    print("PASS: parser smoke test (1 pass record, 6 coin records, all assertions ok)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
