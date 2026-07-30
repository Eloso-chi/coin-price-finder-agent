#!/usr/bin/env python3
"""Validate #284H Terapeak pass JSONL telemetry."""

import argparse
import json
import sys
from datetime import datetime

REQUIRED_FIELDS = {
    "run_id": str,
    "pass_id": int,
    "started_at": str,
    "ended_at": str,
    "duration_sec": (int, type(None)),
    "batch_size_requested": int,
    "batch_size_executed": int,
    "new_count": int,
    "dup_count": int,
    "no_data_count": int,
    "no_export_count": int,
    "cookie_health_status": str,
    "probe_status": str,
    "challenge_signal_count": int,
    "state_before": str,
    "state_after": str,
    "transition_reason": (str, type(None)),
}
VALID_STATES = {"Normal", "Elevated", "Challenged", "Cooldown"}


def validate_timestamp(value):
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except (AttributeError, TypeError, ValueError):
        return False


def validate_record(record):
    errors = []
    for field, expected_type in REQUIRED_FIELDS.items():
        if field not in record:
            errors.append(f"missing field: {field}")
        elif not isinstance(record[field], expected_type):
            errors.append(f"invalid type for {field}")
    for field in ("started_at", "ended_at"):
        if field in record and not validate_timestamp(record[field]):
            errors.append(f"invalid timestamp: {field}")
    for field in ("state_before", "state_after"):
        if field in record and record[field] not in VALID_STATES:
            errors.append(f"invalid risk state: {field}")
    for field in (
        "pass_id", "batch_size_requested", "batch_size_executed", "new_count",
        "dup_count", "no_data_count", "no_export_count", "challenge_signal_count",
    ):
        if isinstance(record.get(field), int) and record[field] < 0:
            errors.append(f"negative value: {field}")
    return errors


def validate_files(paths):
    results = []
    for path in paths:
        record_count = 0
        try:
            with open(path, encoding="utf-8") as telemetry_file:
                for line_number, line in enumerate(telemetry_file, start=1):
                    record_count += 1
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError as error:
                        results.append({"file": path, "line": line_number, "errors": [f"invalid JSON: {error.msg}"]})
                        continue
                    errors = validate_record(record)
                    if errors:
                        results.append({"file": path, "line": line_number, "errors": errors})
        except OSError as error:
            results.append({"file": path, "line": 0, "errors": [str(error)]})
            continue
        if record_count == 0:
            results.append({"file": path, "line": 0, "errors": ["empty telemetry file"]})
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args(argv)

    failures = validate_files(args.paths)
    report = {
        "valid": not failures,
        "files_checked": len(args.paths),
        "invalid_records": len(failures),
        "failures": failures,
    }
    if args.json_output:
        print(json.dumps(report, indent=2))
    elif failures:
        print(f"Telemetry validation failed: {len(failures)} invalid record(s)")
        for failure in failures:
            print(f"  {failure['file']}:{failure['line']}: {'; '.join(failure['errors'])}")
    else:
        print(f"Telemetry validation passed: {len(args.paths)} file(s)")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())