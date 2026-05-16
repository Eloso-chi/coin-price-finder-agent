#!/usr/bin/env python3
"""Restore deep-paginated CSVs from git history and merge fresh page-1 data.

This script:
1. Reads each affected CSV from the pre-loss commit (416829a)
2. Reads the current (truncated) version
3. Merges both, deduplicating by Item ID and title+price+date
4. Writes the merged result back to disk

Run from project root:
    python3 scripts/restore-and-merge.py
"""
import csv
import os
import subprocess
import sys
from pathlib import Path
from datetime import datetime

PROJECT_DIR = Path(__file__).parent.parent
TERAPEAK_DIR = PROJECT_DIR / "data" / "terapeak"

# Pre-loss commit (last commit before first data-destroying refresh on May 8)
PRE_LOSS_COMMIT = "416829a"

# All 165 affected files
AFFECTED_FILES_PATH = "/tmp/affected_csvs.txt"


def get_csv_from_git(commit, filepath):
    """Retrieve file contents from a git commit."""
    try:
        result = subprocess.run(
            ["git", "show", f"{commit}:{filepath}"],
            capture_output=True, text=True, cwd=str(PROJECT_DIR)
        )
        if result.returncode == 0:
            return result.stdout
        return None
    except Exception:
        return None


def parse_csv_rows(csv_text):
    """Parse CSV text into (header, rows) with dedup keys."""
    rows = {}  # dedup_key -> row
    ids = set()
    header = None

    reader = csv.reader(csv_text.splitlines())
    header = next(reader, None)
    for row in reader:
        if len(row) < 4:
            continue
        item_id = row[1].strip() if len(row) > 1 else ""
        title = row[0].strip().lower()[:80]
        price = row[3].strip() if len(row) > 3 else ""
        date = row[2].strip() if len(row) > 2 else ""
        dedup_key = f"{title}|{price}|{date}"

        if item_id:
            ids.add(item_id)
        rows[dedup_key] = row

    return header, rows, ids


def merge_csvs(old_text, current_text):
    """Merge old (deep-paginated) and current (page-1) CSVs.
    Returns merged CSV text."""
    old_header, old_rows, old_ids = parse_csv_rows(old_text)
    cur_header, cur_rows, cur_ids = parse_csv_rows(current_text)

    # Start with old rows (the deep-paginated data)
    merged = dict(old_rows)
    merged_ids = set(old_ids)

    # Add new rows from current that aren't duplicates
    new_count = 0
    for key, row in cur_rows.items():
        item_id = row[1].strip() if len(row) > 1 else ""
        if item_id and item_id in merged_ids:
            continue
        if key in merged:
            continue
        merged[key] = row
        if item_id:
            merged_ids.add(item_id)
        new_count += 1

    # Sort by date descending
    all_rows = list(merged.values())
    def sort_key(row):
        try:
            return datetime.strptime(row[2].strip().strip('"'), "%b %d, %Y")
        except (ValueError, IndexError):
            return datetime.min
    all_rows.sort(key=sort_key, reverse=True)

    # Use whichever header is available
    header = cur_header or old_header

    # Write to string
    import io
    output = io.StringIO()
    writer = csv.writer(output)
    if header:
        writer.writerow(header)
    writer.writerows(all_rows)
    return output.getvalue(), len(old_rows), len(cur_rows), len(all_rows), new_count


def main():
    if not os.path.exists(AFFECTED_FILES_PATH):
        print(f"ERROR: {AFFECTED_FILES_PATH} not found. Run the affected files extraction first.")
        sys.exit(1)

    with open(AFFECTED_FILES_PATH) as f:
        affected_files = [line.strip() for line in f if line.strip()]

    print(f"=== Restore & Merge: {len(affected_files)} affected files ===")
    print(f"Pre-loss commit: {PRE_LOSS_COMMIT}")
    print()

    restored = 0
    merged_new = 0
    total_rows_recovered = 0
    errors = []

    for filepath in affected_files:
        filename = os.path.basename(filepath)
        disk_path = TERAPEAK_DIR / filename

        # Get old (deep-paginated) version from git
        old_text = get_csv_from_git(PRE_LOSS_COMMIT, filepath)
        if not old_text:
            errors.append(f"  SKIP: {filename} not found in {PRE_LOSS_COMMIT}")
            continue

        # Get current version from disk (may be truncated)
        current_text = ""
        if disk_path.exists():
            current_text = disk_path.read_text(encoding="utf-8")

        # Merge
        merged_text, old_count, cur_count, total_count, new_from_current = merge_csvs(old_text, current_text)

        # Write merged result
        disk_path.write_text(merged_text, encoding="utf-8")

        rows_recovered = total_count - cur_count
        total_rows_recovered += max(0, rows_recovered)
        merged_new += new_from_current
        restored += 1

        status = f"old:{old_count} + cur:{cur_count} -> merged:{total_count}"
        if new_from_current > 0:
            status += f" (+{new_from_current} new from refresh)"
        print(f"  [{restored:3d}/{len(affected_files)}] {filename}: {status}")

    print()
    print(f"=== Summary ===")
    print(f"  Files restored:     {restored}")
    print(f"  Rows recovered:     ~{total_rows_recovered}")
    print(f"  New rows preserved: {merged_new} (from recent refreshes)")
    if errors:
        print(f"  Errors:             {len(errors)}")
        for e in errors:
            print(e)


if __name__ == "__main__":
    main()
