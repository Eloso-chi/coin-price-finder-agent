#!/usr/bin/env python3
"""Shared #284H risk-state classification for Terapeak operators."""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone

VALID_STATES = ("Normal", "Elevated", "Challenged", "Cooldown")

CHALLENGE_PATTERNS = (
    re.compile(r"BOT_BLOCKED|BOT BLOCKED|BOT DETECTION", re.IGNORECASE),
    re.compile(r"unusual activity", re.IGNORECASE),
    re.compile(r"\b(?:captcha|hcaptcha)\b", re.IGNORECASE),
    re.compile(r"\bHTTP\s+(?:403|429)\b", re.IGNORECASE),
    re.compile(r"(?:/splashui/|/captcha)", re.IGNORECASE),
)

SOFT_RISK_PATTERNS = (
    re.compile(r"\b(?:timeout|timed out)\b", re.IGNORECASE),
    re.compile(r"browser (?:crash|restart failed)", re.IGNORECASE),
    re.compile(r"^NO EXPORT", re.IGNORECASE),
)


def classify_log_lines(lines):
    challenge_count = 0
    soft_risk_count = 0
    for line in lines:
        if any(pattern.search(line) for pattern in CHALLENGE_PATTERNS):
            challenge_count += 1
        elif any(pattern.search(line) for pattern in SOFT_RISK_PATTERNS):
            soft_risk_count += 1
    return {
        "challenge_signal_count": challenge_count,
        "soft_risk_signal_count": soft_risk_count,
    }


def evaluate_transition(current_state, signals, stateful=True):
    if current_state not in VALID_STATES:
        raise ValueError(f"invalid risk state: {current_state}")

    challenge_count = int(signals.get("challenge_signal_count", 0))
    soft_risk_count = int(signals.get("soft_risk_signal_count", 0))

    if challenge_count > 0:
        reason = "hard_challenge_signal"
        return "Cooldown", reason

    if soft_risk_count >= 3:
        reason = "soft_risk_cluster"
        if not stateful:
            return current_state, reason
        return "Elevated", reason

    if current_state == "Elevated" and stateful:
        return "Normal", "clean_pass_after_elevated"

    return current_state, None


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def state_marker_path(path):
    return f"{path}.initialized"


def valid_state_record(state):
    required = {
        "state": str,
        "reason": str,
        "run_id": str,
        "changed_at": str,
    }
    if not isinstance(state, dict) or state.get("state") not in VALID_STATES:
        return False
    if any(not isinstance(state.get(field), expected) or not state[field] for field, expected in required.items()):
        return False
    try:
        datetime.fromisoformat(state["changed_at"].replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def load_state(path):
    try:
        with open(path, encoding="utf-8") as state_file:
            state = json.load(state_file)
    except FileNotFoundError:
        if os.path.exists(state_marker_path(path)):
            return {"state": "Cooldown", "reason": "risk_state_missing_after_initialization"}
        return {"state": "Normal"}
    except (json.JSONDecodeError, OSError):
        return {"state": "Cooldown", "reason": "risk_state_unreadable"}
    if not valid_state_record(state):
        return {"state": "Cooldown", "reason": "risk_state_invalid"}
    return state


def write_state(path, state, reason, run_id):
    record = {
        "state": state,
        "reason": reason,
        "run_id": run_id,
        "changed_at": utc_now(),
    }
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    temp_path = f"{path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as state_file:
        json.dump(record, state_file, indent=2, sort_keys=True)
    os.replace(temp_path, path)
    marker_path = state_marker_path(path)
    with open(marker_path, "a", encoding="utf-8"):
        pass
    for protected_path in (path, marker_path):
        try:
            os.chmod(protected_path, 0o600)
        except OSError:
            pass
    return record


def cooldown_remaining_seconds(state_record, minimum_seconds, now=None):
    if state_record.get("state") != "Cooldown":
        return 0
    changed_at = state_record.get("changed_at")
    if not changed_at:
        return minimum_seconds
    try:
        changed = datetime.fromisoformat(changed_at.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return minimum_seconds
    current = now or datetime.now(timezone.utc)
    elapsed = max(0, int((current - changed).total_seconds()))
    return max(0, minimum_seconds - elapsed)


def cookie_refreshed_after_state(state_record, cookie_path):
    changed_at = state_record.get("changed_at")
    if not changed_at:
        return False
    try:
        changed = datetime.fromisoformat(changed_at.replace("Z", "+00:00"))
        cookie_mtime = datetime.fromtimestamp(os.path.getmtime(cookie_path), timezone.utc)
    except (OSError, TypeError, ValueError):
        return False
    return cookie_mtime >= changed


def parse_bool(value):
    return str(value).lower() in ("1", "true", "yes", "on")


def main(argv=None):
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    current_parser = subparsers.add_parser("current")
    current_parser.add_argument("--state-file", required=True)

    evaluate_parser = subparsers.add_parser("evaluate")
    evaluate_parser.add_argument("--state-file", required=True)
    evaluate_parser.add_argument("--pass-log", required=True)
    evaluate_parser.add_argument("--run-id", required=True)
    evaluate_parser.add_argument("--stateful", default="true")

    challenge_parser = subparsers.add_parser("challenge")
    challenge_parser.add_argument("--state-file", required=True)
    challenge_parser.add_argument("--run-id", required=True)
    challenge_parser.add_argument("--reason", default="cookie_health_challenged")

    reset_parser = subparsers.add_parser("reset")
    reset_parser.add_argument("--state-file", required=True)
    reset_parser.add_argument("--run-id", required=True)
    reset_parser.add_argument("--reason", required=True)

    cooldown_parser = subparsers.add_parser("cooldown-ready")
    cooldown_parser.add_argument("--state-file", required=True)
    cooldown_parser.add_argument("--minimum-seconds", required=True, type=int)

    cookie_parser = subparsers.add_parser("cookie-refreshed")
    cookie_parser.add_argument("--state-file", required=True)
    cookie_parser.add_argument("--cookie-file", required=True)

    args = parser.parse_args(argv)
    if args.command == "current":
        print(load_state(args.state_file).get("state", "Normal"))
        return 0


    if args.command == "cooldown-ready":
        remaining = cooldown_remaining_seconds(
            load_state(args.state_file),
            args.minimum_seconds,
        )
        print(remaining)
        return 0 if remaining == 0 else 2

    if args.command == "cookie-refreshed":
        refreshed = cookie_refreshed_after_state(
            load_state(args.state_file),
            args.cookie_file,
        )
        print("true" if refreshed else "false")
        return 0 if refreshed else 2

    if args.command == "reset":
        write_state(args.state_file, "Normal", args.reason, args.run_id)
        print("Normal")
        return 0

    if args.command == "challenge":
        state_before = load_state(args.state_file).get("state", "Cooldown")
        write_state(args.state_file, "Cooldown", args.reason, args.run_id)
        print("\t".join((state_before, "Cooldown", args.reason, "1", "0")))
        return 0

    state_before = load_state(args.state_file).get("state", "Normal")
    try:
        with open(args.pass_log, "r", encoding="utf-8", errors="replace") as pass_log:
            signals = classify_log_lines(pass_log)
    except FileNotFoundError:
        signals = classify_log_lines(())
    state_after, reason = evaluate_transition(
        state_before,
        signals,
        stateful=parse_bool(args.stateful),
    )
    if state_after == "Cooldown" or (
        parse_bool(args.stateful) and (state_after != state_before or reason)
    ):
        write_state(args.state_file, state_after, reason, args.run_id)
    print("\t".join((
        state_before,
        state_after,
        reason or "none",
        str(signals["challenge_signal_count"]),
        str(signals["soft_risk_signal_count"]),
    )))
    return 0


if __name__ == "__main__":
    sys.exit(main())
