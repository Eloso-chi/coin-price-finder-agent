#!/usr/bin/env python3
"""Compare baseline and normal-tuned Normal-state Terapeak pilot passes."""

import argparse
import json
import math
import sys

PROFILES = ("baseline", "normal-tuned")
EXPECTED_SEQUENCE = (
    "baseline", "normal-tuned", "normal-tuned", "baseline", "normal-tuned", "baseline",
    "baseline", "normal-tuned", "normal-tuned", "baseline", "normal-tuned", "baseline",
)
REQUIRED_NUMERIC_FIELDS = (
    "attempted", "succeeded", "failed", "empty", "unknown", "duration_sec",
    "challenge_signal_count", "no_export_count",
)
COMPARISON_NUMERIC_FIELDS = ("pacing_batch_min", "pacing_batch_max", "pacing_p01_fixed")
MAX_REPORTED_ERRORS = 20


def load_records(path):
    with open(path, encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {error.msg}") from error


def summarize(records, pilot_id):
    groups = {
        profile: {
            "passes": 0, "attempts": 0, "duration": 0.0, "succeeded": 0,
            "failed": 0, "unknown": 0, "no_export": 0, "challenges": 0,
            "elevated": 0, "cooldown": 0,
        }
        for profile in PROFILES
    }
    sequence = []
    validation_errors = []
    comparison_values = {
        field: set() for field in (
            "machine", "operator", "include_thin", "pacing_batch_min",
            "pacing_batch_max", "pacing_p01_fixed", "pacing_upload_mode",
        )
    }

    def add_error(message):
        if len(validation_errors) < MAX_REPORTED_ERRORS:
            validation_errors.append(message)

    for record in records:
        if record.get("pacing_pilot_id") != pilot_id:
            continue
        if len(sequence) >= len(EXPECTED_SEQUENCE):
            add_error("pilot contains more than 12 scoped passes")
            continue
        if record.get("state_before") != "Normal":
            add_error(f"{record.get('run_id', '?')}: scoped pilot pass must start in Normal")
            continue
        record_errors = []
        for field in REQUIRED_NUMERIC_FIELDS:
            value = record.get(field)
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                record_errors.append(f"{record.get('run_id', '?')}: missing/invalid {field}")
            elif not math.isfinite(float(value)):
                record_errors.append(f"{record.get('run_id', '?')}: non-finite {field}")
        if record_errors:
            for error in record_errors:
                add_error(error)
            continue
        for field in COMPARISON_NUMERIC_FIELDS:
            value = record.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                record_errors.append(f"{record.get('run_id', '?')}: missing/invalid {field}")
        if record_errors:
            for error in record_errors:
                add_error(error)
            continue
        attempts = int(record["attempted"])
        duration = float(record["duration_sec"])
        if attempts <= 0 or duration <= 0:
            add_error(f"{record.get('run_id', '?')}: attempts and duration must be positive")
            continue
        if any(float(record[field]) < 0 for field in REQUIRED_NUMERIC_FIELDS):
            add_error(f"{record.get('run_id', '?')}: numeric telemetry must be non-negative")
            continue
        outcomes = sum(int(record[field]) for field in ("succeeded", "failed", "empty", "unknown"))
        if outcomes != attempts:
            add_error(f"{record.get('run_id', '?')}: outcomes do not sum to attempted")
            continue
        requested = record.get("pacing_profile_requested")
        profile = record.get("pacing_profile_effective")
        if requested not in PROFILES or profile not in PROFILES or requested != profile:
            add_error(f"{record.get('run_id', '?')}: invalid Normal-state profile relationship")
            continue
        sequence.append(profile)
        for field in comparison_values:
            value = record.get(field)
            if value is None:
                add_error(f"{record.get('run_id', '?')}: missing comparison field {field}")
            values = comparison_values[field]
            if len(values) < 2:
                values.add(value)
        group = groups[profile]
        group["passes"] += 1
        group["attempts"] += attempts
        group["duration"] += duration
        for field in ("succeeded", "failed", "unknown"):
            group[field] += int(record[field])
        group["no_export"] += int(record["no_export_count"])
        group["challenges"] += int(record["challenge_signal_count"])
        group["elevated"] += int(record.get("state_after") == "Elevated")
        group["cooldown"] += int(record.get("state_after") == "Cooldown")

    report = {}
    for profile, group in groups.items():
        attempts = group["attempts"]
        passes = group["passes"]
        report[profile] = {
            "passes": passes,
            "attempts": attempts,
            "seconds_per_attempt": round(group["duration"] / attempts, 3) if attempts else None,
            "success_rate": round(group["succeeded"] / attempts, 4) if attempts else None,
            "failure_rate": round(group["failed"] / attempts, 4) if attempts else None,
            "non_success_rate": round((attempts - group["succeeded"]) / attempts, 4) if attempts else None,
            "unknown_rate": round(group["unknown"] / attempts, 4) if attempts else None,
            "no_export_rate": round(group["no_export"] / attempts, 4) if attempts else None,
            "challenges_per_100_attempts": round(group["challenges"] * 100 / attempts, 3) if attempts else None,
            "normal_to_elevated_rate": round(group["elevated"] / passes, 4) if passes else None,
            "normal_to_cooldown_rate": round(group["cooldown"] / passes, 4) if passes else None,
        }

    baseline = report["baseline"]["seconds_per_attempt"]
    tuned = report["normal-tuned"]["seconds_per_attempt"]
    report["speed_improvement_pct"] = (
        round((baseline - tuned) * 100 / baseline, 2)
        if baseline and tuned is not None else None
    )
    comparability_errors = [
        f"mixed {field}: {sorted(str(value) for value in values)}"
        for field, values in comparison_values.items() if len(values) > 1
    ]
    sequence_valid = tuple(sequence) == EXPECTED_SEQUENCE
    if not sequence_valid:
        add_error("pilot does not match required 12-pass crossover sequence")
    hard_challenge = any(groups[profile]["challenges"] > 0 or groups[profile]["cooldown"] > 0 for profile in PROFILES)
    report["pilot_id"] = pilot_id
    report["sequence_valid"] = sequence_valid
    report["validation_errors"] = validation_errors
    report["comparability_errors"] = comparability_errors
    report["hard_challenge"] = hard_challenge
    report["ready"] = not validation_errors and not comparability_errors
    if not report["ready"]:
        report["recommendation"] = "insufficient-data"
    elif hard_challenge:
        report["recommendation"] = "reject"
    else:
        baseline_metrics = report["baseline"]
        tuned_metrics = report["normal-tuned"]
        no_worse = (
            tuned_metrics["success_rate"] >= baseline_metrics["success_rate"]
            and tuned_metrics["failure_rate"] <= baseline_metrics["failure_rate"]
            and tuned_metrics["non_success_rate"] <= baseline_metrics["non_success_rate"]
            and tuned_metrics["unknown_rate"] <= baseline_metrics["unknown_rate"]
            and tuned_metrics["no_export_rate"] <= baseline_metrics["no_export_rate"]
            and tuned_metrics["challenges_per_100_attempts"] <= baseline_metrics["challenges_per_100_attempts"]
            and tuned_metrics["normal_to_elevated_rate"] <= baseline_metrics["normal_to_elevated_rate"]
            and tuned_metrics["normal_to_cooldown_rate"] <= baseline_metrics["normal_to_cooldown_rate"]
        )
        report["recommendation"] = (
            "adopt" if report["speed_improvement_pct"] >= 10 and no_worse else "retain-baseline"
        )
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="cache/terapeak-runs/passes.jsonl")
    parser.add_argument("--pilot-id", required=True)
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args(argv)
    try:
        report = summarize(load_records(args.path), args.pilot_id)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1

    if args.json_output:
        print(json.dumps(report, indent=2))
    else:
        for profile in PROFILES:
            metrics = report[profile]
            print(
                f"{profile}: passes={metrics['passes']} attempts={metrics['attempts']} "
                f"sec/attempt={metrics['seconds_per_attempt']} success={metrics['success_rate']} "
                f"failure={metrics['failure_rate']} challenges/100={metrics['challenges_per_100_attempts']} "
                f"normal->elevated-rate={metrics['normal_to_elevated_rate']} "
                f"normal->cooldown-rate={metrics['normal_to_cooldown_rate']}"
            )
        print(
            f"speed_improvement_pct={report['speed_improvement_pct']} ready={report['ready']} "
            f"recommendation={report['recommendation']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())