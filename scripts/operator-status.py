#!/usr/bin/env python3
"""
Print Terapeak operator status in the runbook's status-report contract.

Read-only. Reads cache/terapeak-runs/{passes,coins}.jsonl, the newest pass log, the
operator log (queue counts) and the risk-state file. It never starts, stops or signals a
process and never regenerates the freshness report.

Output, in order:
  1. The contract block (docs/runbooks/local-scraper-wsl2.md "Status report contract"):
     Pass/Batch header, Run totals, per-coin rows (OK and NO DATA only), Batch total,
     Queue, Highlights.
  2. A labelled "Cumulative run view" section with per-pass rows and run totals.

The current batch is the in-progress pass when a newer pass log exists than the last
recorded pass, otherwise the last completed pass. Coin outcomes for an in-progress pass come
from the same parser the operator uses (_parse-terapeak-pass.py), so the two cannot disagree.

Usage:
  python3 scripts/operator-status.py [--project-dir DIR] [--run-id ID] [--passes N]
                                     [--skip-process-check]
Exit codes: 0 printed, 2 no run data found.
"""
import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

PASS_LOG_RE = re.compile(r"^pass-0*(\d+)\.log$")
EXPORTING_RE = re.compile(r"Exporting\s+(\d+)\s+coins")
QUEUE_RE = re.compile(r"^\s{4}(refresh|dormant|ok|deep-paginate)\s+(\d+)\s*$")
# Per-run files differ by operator: H (terapeak-operator.sh) and W (terapeak-operator-codespace.sh).
LAYOUTS = (
    ("terapeak-operator-passes", "terapeak-operator-{run}.log"),
    ("terapeak-operator-codespace-passes", "terapeak-operator-codespace_{run}.log"),
)
QUEUE_LABELS = (("refresh", "stale"), ("ok", "ok"), ("dormant", "dormant"), ("deep-paginate", "deep-paginate pending"))


def load_parser():
    path = os.path.join(SCRIPT_DIR, "_parse-terapeak-pass.py")
    spec = importlib.util.spec_from_file_location("parse_terapeak_pass", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ascii_text(value):
    return str(value).encode("ascii", "replace").decode("ascii")


def num(value):
    """Integer value of a telemetry field; a missing or malformed value counts as 0."""
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def read_jsonl(path):
    records = []
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                if isinstance(record, dict):
                    records.append(record)
    except OSError:
        pass
    return records


def thousands(value):
    return f"{num(value):,}"


def run_dirs(project_dir, run_id=None):
    """Existing per-run pass-log directories across both operator layouts."""
    found = []
    for passes_dir, _ in LAYOUTS:
        base = os.path.join(project_dir, "cache", passes_dir)
        if run_id:
            candidates = [os.path.join(base, run_id)]
        else:
            try:
                candidates = [os.path.join(base, name) for name in os.listdir(base)]
            except OSError:
                continue
        found += [path for path in candidates if os.path.isdir(path)]
    return found


def newest_run_dir(project_dir):
    entries = run_dirs(project_dir)
    return max(entries, key=os.path.getmtime) if entries else None


def choose_run_id(project_dir, passes, requested):
    if requested:
        return requested
    run_dir = newest_run_dir(project_dir)
    if run_dir:
        return os.path.basename(run_dir)
    return passes[-1]["run_id"] if passes else None


def live_pass(project_dir, run_id, last_recorded):
    """Return (number, path) of a pass log newer than the last recorded pass, else None."""
    candidates = []
    for run_dir in sorted(run_dirs(project_dir, run_id), key=os.path.getmtime, reverse=True):
        try:
            names = os.listdir(run_dir)
        except OSError:
            continue
        numbers = [(int(m.group(1)), os.path.join(run_dir, name)) for name in names for m in [PASS_LOG_RE.match(name)] if m]
        if numbers:
            candidates.append(max(numbers))
            break
    if not candidates:
        return None
    number, path = candidates[0]
    return (number, path) if number > last_recorded else None


def queue_counts(project_dir, run_id):
    """Last reported count for each queue tier from the operator log, or None when absent."""
    counts = {key: None for key, _ in QUEUE_LABELS}
    logs = [os.path.join(project_dir, "cache", pattern.format(run=run_id)) for _, pattern in LAYOUTS]
    logs = sorted((path for path in logs if os.path.isfile(path)), key=os.path.getmtime, reverse=True)
    for path in logs[:1]:
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    match = QUEUE_RE.match(line.rstrip("\n"))
                    if match:
                        counts[match.group(1)] = int(match.group(2))
        except OSError:
            pass
    return counts


def risk_state(project_dir):
    machine = ""
    try:
        with open(os.path.join(project_dir, ".machine-id"), encoding="utf-8") as handle:
            machine = handle.read().strip()
    except OSError:
        pass
    candidates = [os.path.join(project_dir, "cache", f"terapeak-risk-state-{machine}.json")] if machine else []
    cache = os.path.join(project_dir, "cache")
    if os.path.isdir(cache):
        for name in sorted(os.listdir(cache)):
            if re.fullmatch(r"terapeak-risk-state-[A-Za-z]\.json", name):
                candidates.append(os.path.join(cache, name))
    for path in candidates:
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("state") is not None:
            return ascii_text(data["state"])
    return None


def operator_process():
    try:
        result = subprocess.run(
            ["pgrep", "-f", r"terapeak-operator(-codespace)?\.sh"],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return "unknown (pgrep unavailable)"
    pids = [pid for pid in result.stdout.split() if pid != str(os.getpid())]
    return f"running (pid {pids[0]})" if pids else "not running"


def result_label(coin):
    status = coin.get("status") or "unknown"
    if status == "ok":
        return "OK"
    if status == "empty":
        notes = [name for name in ("headless", "dormant") if coin.get(name)]
        return f"NO DATA ({', '.join(notes)})" if notes else "NO DATA"
    if status == "failed":
        return None
    return "pending"


def coin_rows(coins):
    rows, failed = [], []
    for coin in coins:
        label = result_label(coin)
        name = ascii_text(coin.get("coin", "?"))
        if label is None:
            failed.append(name)
            continue
        if label == "OK":
            new, dups = str(num(coin.get("new"))), str(num(coin.get("dups")))
        else:
            new = dups = "--"
        rows.append((name, new, dups, label))
    return rows, failed


def render_rows(rows):
    lines = [f"  {'Coin':<35} {'New':>4}  {'Dups':>4}  Result", f"  {'-' * 35} {'-' * 4}  {'-' * 4}  {'-' * 7}"]
    lines += [f"  {name:<35} {new:>4}  {dups:>4}  {label}" for name, new, dups, label in rows]
    return lines


def sums(coins):
    new = sum(num(c.get("new")) for c in coins)
    dups = sum(num(c.get("dups")) for c in coins)
    return new, dups


def tier_lines(tiers, run_fill, fallback_order):
    """P3 fallback lines (#330H); empty unless this pass or the run used a fallback tier.

    Appended rows are what the exporter added to the dataset CSVs; upload `new` counts include rows
    the app already held, so tiers are compared on appended rows.
    """
    yields = tiers.get("tier_yield") if isinstance(tiers.get("tier_yield"), dict) else {}
    filled = num(tiers.get("fallback_filled"))
    if not filled and not run_fill and not any(name != "primary" for name in yields):
        return []
    lines = [f"  P3 fill: {thousands(filled)} slots this pass | {thousands(run_fill)} this run"]
    order = ["primary", *fallback_order]
    names = sorted(yields, key=lambda name: (order.index(name) if name in order else len(order), name))
    parts = []
    for name in names:
        entry = yields[name] if isinstance(yields[name], dict) else {}
        parts.append(f"{ascii_text(name)} {thousands(entry.get('appended_rows'))} ({num(entry.get('items'))} items)")
    if parts:
        lines.append("  Appended rows this pass: " + " | ".join(parts))
    return lines


def build_report(project_dir, run_id, passes, coins_all, parser, show_passes, check_process):
    run_passes = sorted((p for p in passes if p.get("run_id") == run_id), key=lambda p: p["pass"])
    last_recorded = run_passes[-1]["pass"] if run_passes else 0
    live = live_pass(project_dir, run_id, last_recorded)

    live_coins, live_totals, live_batch = [], {}, None
    live_tiers = None
    if live:
        try:
            live_coins, live_totals = parser.parse_pass_log(live[1])
            live_tiers = parser.parse_tier_telemetry(live[1])
            with open(live[1], encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    match = EXPORTING_RE.search(line)
                    if match:
                        live_batch = int(match.group(1))
        except OSError:
            live, live_coins, live_totals = None, [], {}

    completed_new = sum(num(p.get("new_rows")) for p in run_passes)
    completed_dups = sum(num(p.get("dup_rows")) for p in run_passes)
    completed_coins = sum(num(p.get("attempted")) for p in run_passes)
    live_new, live_dups = sums(live_coins)
    run_coins = completed_coins + len(live_coins)
    run_new, run_dups = completed_new + live_new, completed_dups + live_dups

    out = []
    if live:
        rows, failed = coin_rows(live_coins)
        batch = live_batch if live_batch is not None else "?"
        out.append(f"Pass {live[0]} | Batch: {batch} coins | in progress ({len(live_coins)} of {batch} started)")
        current_totals = (live_new, live_dups, live_totals.get("no_export_count", 0), len(live_coins), True)
        current_tiers = live_tiers or {}
    else:
        record = run_passes[-1]
        coins = [c for c in coins_all if c.get("run_id") == run_id and c.get("pass") == record["pass"]]
        rows, failed = coin_rows(coins)
        batch = num(record.get("batch_size_executed")) or num(record.get("attempted")) or len(coins)
        minutes = max(1, round(num(record.get("duration_sec")) / 60))
        out.append(f"Pass {record['pass']} | Batch: {batch} coins | ~{minutes} min (complete)")
        current_totals = (num(record.get("new_rows")), num(record.get("dup_rows")),
                          num(record.get("no_export_count")), batch, False)
        current_tiers = record

    out += ["", f"  Run totals: {thousands(run_coins)} coins | {thousands(run_new)} new | {thousands(run_dups)} dups", ""]
    out += render_rows(rows)
    if failed:
        out.append(f"  ({len(failed)} failed coin(s) not listed: {', '.join(failed)})")
    new, dups, no_export, total, partial = current_totals
    if partial:
        batch_total = f"Batch total (partial): {thousands(new)} new, {thousands(dups)} dups, {no_export} no-export out of {len(live_coins)} coins started"
    else:
        batch_total = f"Batch total: {thousands(new)} new, {thousands(dups)} dups, {no_export} no-export out of {total} coins"
    out += ["", f"  {batch_total}", ""]

    run_fill = sum(num(p.get("fallback_filled")) for p in run_passes) + (num(live_tiers.get("fallback_filled")) if live_tiers else 0)
    fill_lines = tier_lines(current_tiers, run_fill, getattr(parser, "FALLBACK_TIER_ORDER", ()))
    if fill_lines:
        out += fill_lines + [""]

    queue = queue_counts(project_dir, run_id)
    parts = [(f"{thousands(queue[key])} {text}" if queue[key] is not None else f"n/a {text}") for key, text in QUEUE_LABELS]
    out.append("  Queue: " + " | ".join(parts))
    out.append("")

    state = risk_state(project_dir)
    challenges = sum(num(p.get("challenge_signal_count")) for p in run_passes) + num(live_totals.get("challenge_signal_count"))
    cookies = ascii_text((run_passes[-1].get("cookie_health_status") if run_passes else None) or "unknown")
    highlights = []
    if state and state != "Normal":
        highlights.append(f"risk state {state}")
    if challenges:
        highlights.append(f"{challenges} challenge signal(s) in run")
    if cookies not in ("HEALTHY", "unknown"):
        highlights.append(f"cookie health {cookies}")
    if failed:
        highlights.append(f"{len(failed)} failed coin(s) in current pass")
    if run_passes and run_passes[-1].get("no_comps_cluster"):
        highlights.append("no_comps cluster in last pass")
    if current_tiers.get("drained"):
        highlights.append("queue drained: no eligible dataset in any tier")
    out.append("  Highlights: " + ("; ".join(highlights) if highlights else "none"))

    out += ["", f"Cumulative run view (run {ascii_text(run_id)}, {len(run_passes)} completed pass(es)" + (f", pass {live[0]} in progress)" if live else ")")]
    if check_process:
        out.append(f"  Operator process: {operator_process()}")
    out.append(f"  Risk state: {state or 'unknown'} | challenge signals in run: {challenges} | cookie health: {cookies}")
    out.append("")
    out.append(f"  {'Pass':>4}  {'Batch':>5}  {'OK':>4}  {'NO DATA':>7}  {'Failed':>6}  {'no_comps':>8}  {'New':>7}  {'Dups':>6}  Risk state")
    out.append(f"  {'-' * 4}  {'-' * 5}  {'-' * 4}  {'-' * 7}  {'-' * 6}  {'-' * 8}  {'-' * 7}  {'-' * 6}  {'-' * 22}")
    shown = run_passes if show_passes <= 0 else run_passes[-show_passes:]
    hidden = len(run_passes) - len(shown)
    if hidden:
        out.append(f"  ({hidden} earlier pass(es) not shown; totals include them)")
    for p in shown:
        out.append(
            f"  {p['pass']:>4}  {num(p.get('attempted')):>5}  {num(p.get('succeeded')):>4}  {num(p.get('empty')):>7}"
            f"  {num(p.get('failed')):>6}  {num(p.get('no_comps')):>8}  {num(p.get('new_rows')):>7}  {num(p.get('dup_rows')):>6}"
            f"  {ascii_text(p.get('state_before'))} -> {ascii_text(p.get('state_after'))}"
        )
    if live:
        agg = parser.aggregate(live_coins)
        out.append(
            f"  {str(live[0]) + '*':>4}  {len(live_coins):>5}  {agg['ok']:>4}  {agg['empty']:>7}  {agg['failed']:>6}  {agg['no_comps']:>8}"
            f"  {live_new:>7}  {live_dups:>6}  in progress (partial)"
        )
    totals = {key: sum(num(p.get(src)) for p in run_passes) for key, src in
              (("batch", "attempted"), ("ok", "succeeded"), ("empty", "empty"), ("failed", "failed"), ("no_comps", "no_comps"))}
    out.append(
        f"  {'Run':>4}  {thousands(totals['batch']):>5}  {totals['ok']:>4}  {totals['empty']:>7}  {totals['failed']:>6}  {totals['no_comps']:>8}"
        f"  {thousands(completed_new):>7}  {thousands(completed_dups):>6}  completed passes only"
    )
    return "\n".join(out)


def main(argv=None):
    parser_args = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser_args.add_argument("--project-dir", default=os.path.dirname(SCRIPT_DIR), help="repository root (default: this checkout)")
    parser_args.add_argument("--run-id", default=None, help="run id (default: the newest run)")
    parser_args.add_argument("--passes", type=int, default=12, help="per-pass rows to show; 0 shows all (default 12)")
    parser_args.add_argument("--skip-process-check", action="store_true", help="do not look for a running operator process")
    args = parser_args.parse_args(argv)

    runs_dir = os.path.join(args.project_dir, "cache", "terapeak-runs")
    keyed = lambda r: isinstance(r.get("run_id"), str) and isinstance(r.get("pass"), int)
    passes = [r for r in read_jsonl(os.path.join(runs_dir, "passes.jsonl")) if keyed(r)]
    coins = [r for r in read_jsonl(os.path.join(runs_dir, "coins.jsonl")) if keyed(r)]
    run_id = choose_run_id(args.project_dir, passes, args.run_id)
    has_run = run_id and (any(p.get("run_id") == run_id for p in passes) or live_pass(args.project_dir, run_id, 0))
    if not has_run:
        print(f"No operator run data found under {runs_dir}", file=sys.stderr)
        return 2
    try:
        report = build_report(args.project_dir, run_id, passes, coins, load_parser(), args.passes, not args.skip_process_check)
    except (KeyError, TypeError, ValueError, OSError) as exc:
        print(f"Could not interpret operator telemetry under {runs_dir}: {ascii_text(exc)}", file=sys.stderr)
        return 2
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
