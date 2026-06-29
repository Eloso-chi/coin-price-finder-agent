#!/usr/bin/env python3
"""
Parse a terapeak-export.py pass log and append structured records to:
  - cache/terapeak-runs/passes.jsonl  (one record per pass)
  - cache/terapeak-runs/coins.jsonl   (one record per coin attempt)

Idempotent within a single invocation; safe to call after each pass. Best-effort:
parsing failures are logged to stderr but do not raise. Output JSONL is
append-only and survives across runs, so 'show-terapeak-runs.sh' can render
historical reports.

Per-coin status values:
  ok        Coin exported with row counts (and counts > 0 or = 0).
  empty     Page loaded but exporter saw "No data rows found".
  failed    HTTP error from server import (e.g. 422 "No valid comps found").
  unknown   Coin line seen but no resolvable outcome.

Per-coin extra flags:
  dormant=true   if exporter logged "(dormant: ..." after the coin line.

Usage:
  python3 scripts/_parse-terapeak-pass.py \
    --pass-log cache/.../pass-0001.log \
    --run-id 20260629T... \
    --pass-num 1 \
    --batch-size 22 \
    --start-ts 2026-06-29T00:42:00Z \
    --end-ts   2026-06-29T00:52:00Z \
    --machine W \
    --include-thin false
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

OUT_DIR = os.environ.get(
    "TERAPEAK_RUNS_DIR",
    os.path.join("cache", "terapeak-runs"),
)
PASSES_PATH = os.path.join(OUT_DIR, "passes.jsonl")
COINS_PATH = os.path.join(OUT_DIR, "coins.jsonl")

# Matches:  "  [ NN%] <Coin Name>...<rest>"
COIN_LINE_RE = re.compile(r"^\s*\[\s*(\d+)%\]\s+(.+?)\.\.\.(.*)$")
OK_RE = re.compile(r"OK\s*\((\d+)\s+new,\s*(\d+)\s+dups\)")
WARN_EMPTY_RE = re.compile(r"WARNING:\s*No data rows found", re.IGNORECASE)
NO_EXPORT_RE = re.compile(r"^NO EXPORT", re.IGNORECASE)
DORMANT_RE = re.compile(r"\(dormant:", re.IGNORECASE)
# Only treat 4xx/5xx HTTP statuses as failures. A bare HTTP 2xx/3xx anywhere
# in a coin's continuation lines (e.g. an upstream "HTTP 200 OK" trace) must
# NOT flip the coin to status=failed. See PR #200 review finding #1.
HTTP_FAIL_RE = re.compile(r"HTTP\s+([45]\d{2})", re.IGNORECASE)
FAILED_TAIL_RE = re.compile(r"^\s*Failed:\s*(\d+)", re.IGNORECASE)
SUCCEEDED_TAIL_RE = re.compile(r"^\s*Succeeded:\s*(\d+)", re.IGNORECASE)


def parse_pass_log(path):
    """Return (coins_list, totals_dict) parsed from a pass log file."""
    coins = []
    current = None  # the in-progress coin record being built across lines
    succeeded = failed = None

    def finalize_current():
        nonlocal current
        if current is None:
            return
        if current.get("status") is None:
            current["status"] = "unknown"
        coins.append(current)
        current = None

    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.rstrip("\n")
                m = COIN_LINE_RE.match(line)
                if m:
                    # New coin starts; close out previous
                    finalize_current()
                    pct, name, rest = m.group(1), m.group(2).strip(), m.group(3)
                    current = {
                        "pct": int(pct),
                        "coin": name,
                        "status": None,
                        "new": 0,
                        "dups": 0,
                        "dormant": False,
                        "error": None,
                    }
                    # Try to resolve outcome on the same line
                    ok = OK_RE.search(rest)
                    if ok:
                        current["status"] = "ok"
                        current["new"] = int(ok.group(1))
                        current["dups"] = int(ok.group(2))
                    elif WARN_EMPTY_RE.search(rest):
                        current["status"] = "empty"
                    continue

                if current is None:
                    # Capture pass-level totals
                    sm = SUCCEEDED_TAIL_RE.match(line)
                    if sm:
                        succeeded = int(sm.group(1))
                        continue
                    fm = FAILED_TAIL_RE.match(line)
                    if fm:
                        failed = int(fm.group(1))
                        continue
                    continue

                # Continuation lines for the current coin
                if WARN_EMPTY_RE.search(line) and current.get("status") in (None,):
                    current["status"] = "empty"
                    continue
                if NO_EXPORT_RE.search(line):
                    if current.get("status") in (None, "empty"):
                        current["status"] = "empty"
                    continue
                if DORMANT_RE.search(line):
                    current["dormant"] = True
                    continue
                http = HTTP_FAIL_RE.search(line)
                if http:
                    current["status"] = "failed"
                    current["error"] = f"HTTP {http.group(1)}"
                    continue
                # Late OK on a continuation line (rare)
                ok = OK_RE.search(line)
                if ok and current.get("status") in (None,):
                    current["status"] = "ok"
                    current["new"] = int(ok.group(1))
                    current["dups"] = int(ok.group(2))

            finalize_current()
    except FileNotFoundError:
        return [], {"succeeded": 0, "failed": 0, "error": "pass_log_missing"}

    totals = {
        "succeeded_reported": succeeded,
        "failed_reported": failed,
    }
    return coins, totals


def aggregate(coins):
    out = {
        "attempted": len(coins),
        "ok": 0,
        "empty": 0,
        "failed": 0,
        "unknown": 0,
        "dormant": 0,
        "new_rows": 0,
        "dup_rows": 0,
    }
    for c in coins:
        status = c.get("status") or "unknown"
        if status in out:
            out[status] += 1
        if c.get("dormant"):
            out["dormant"] += 1
        out["new_rows"] += int(c.get("new") or 0)
        out["dup_rows"] += int(c.get("dups") or 0)
    return out


def ensure_dir(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)


def append_jsonl(path, record):
    ensure_dir(path)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--pass-log", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--pass-num", required=True, type=int)
    p.add_argument("--batch-size", required=True, type=int)
    p.add_argument("--start-ts", default=iso_now())
    p.add_argument("--end-ts", default=iso_now())
    p.add_argument("--machine", default=os.environ.get("MACHINE_ID", "W"))
    p.add_argument("--include-thin", default="false")
    p.add_argument("--operator", default="terapeak-operator-codespace")
    args = p.parse_args(argv)

    coins, totals = parse_pass_log(args.pass_log)
    agg = aggregate(coins)

    # Duration (best-effort)
    try:
        s = datetime.strptime(args.start_ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        e = datetime.strptime(args.end_ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        duration_sec = int((e - s).total_seconds())
    except Exception:
        duration_sec = None

    include_thin = args.include_thin.lower() in ("1", "true", "yes")

    # ---- write pass record ----
    pass_rec = {
        "ts": args.end_ts,
        "run_id": args.run_id,
        "operator": args.operator,
        "machine": args.machine,
        "pass": args.pass_num,
        "batch_size": args.batch_size,
        "include_thin": include_thin,
        "start_ts": args.start_ts,
        "end_ts": args.end_ts,
        "duration_sec": duration_sec,
        "attempted": agg["attempted"],
        "succeeded": agg["ok"],
        "empty": agg["empty"],
        "failed": agg["failed"],
        "unknown": agg["unknown"],
        "dormant": agg["dormant"],
        "new_rows": agg["new_rows"],
        "dup_rows": agg["dup_rows"],
        "succeeded_reported": totals.get("succeeded_reported"),
        "failed_reported": totals.get("failed_reported"),
        "pass_log": args.pass_log,
    }
    append_jsonl(PASSES_PATH, pass_rec)

    # ---- write per-coin records ----
    for idx, c in enumerate(coins, start=1):
        coin_rec = {
            "ts": args.end_ts,
            "run_id": args.run_id,
            "machine": args.machine,
            "pass": args.pass_num,
            "idx": idx,
            "total": len(coins),
            "coin": c["coin"],
            "status": c["status"],
            "new": c["new"],
            "dups": c["dups"],
            "dormant": c["dormant"],
            "error": c["error"],
        }
        append_jsonl(COINS_PATH, coin_rec)

    # Print one-line summary for the operator log
    print(
        f"[parse] pass={args.pass_num} attempted={agg['attempted']} "
        f"ok={agg['ok']} empty={agg['empty']} failed={agg['failed']} "
        f"new_rows={agg['new_rows']} dup_rows={agg['dup_rows']} "
        f"-> {PASSES_PATH}, {COINS_PATH}"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        sys.stderr.write(f"[parse:WARN] {type(e).__name__}: {e}\n")
        sys.exit(0)  # never fail the operator
