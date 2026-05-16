"""Tests for _merge_csv() in terapeak-export.py.

Validates:
1. New rows merge into existing without loss
2. Deduplication by itemId prevents duplicates
3. Deduplication by title+price+date composite key prevents duplicates
4. Shrink guard refuses to write if merged < existing
5. Non-existent destination does a simple move
6. Sort order is date descending after merge
7. Rows with < 4 columns are skipped (malformed)
"""

import csv
import sys
import tempfile
from pathlib import Path

import pytest

# Import _merge_csv from the export script
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

# We need to mock heavy imports (playwright, etc.) before importing the module
from unittest.mock import MagicMock

sys.modules["playwright"] = MagicMock()
sys.modules["playwright.sync_api"] = MagicMock()

# Import just the function we need by exec'ing the relevant portion
# Since terapeak-export.py has side effects on import, extract _merge_csv directly
import importlib.util

_script_path = Path(__file__).resolve().parent.parent / "scripts" / "terapeak-export.py"


def _load_merge_csv():
    """Load only _merge_csv from the script without running __main__ code."""
    import types

    # Read the source and extract the function + its dependencies
    source = _script_path.read_text()

    # Build a minimal module with just what _merge_csv needs
    module_code = """
import csv
from pathlib import Path
from datetime import datetime

"""
    # Extract the _merge_csv function (from "def _merge_csv" to "def upload_to_blob")
    start = source.index("def _merge_csv(")
    end = source.index("\n# ── Upload to Azure Blob Storage", start)
    module_code += source[start:end]

    mod = types.ModuleType("merge_csv_mod")
    exec(compile(module_code, str(_script_path), "exec"), mod.__dict__)
    return mod._merge_csv


_merge_csv = _load_merge_csv()


def _write_csv(path, header, rows):
    """Helper: write a CSV file."""
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


HEADER = ["Title", "Item ID", "Sold Date", "Total Price"]


class TestMergeCSVBasic:
    """Basic merge scenarios."""

    def test_new_file_when_dest_missing(self, tmp_path):
        """If existing CSV doesn't exist, new file is simply moved into place."""
        new_csv = tmp_path / "download.csv"
        dest = tmp_path / "final.csv"

        _write_csv(new_csv, HEADER, [
            ["2024 Silver Eagle", "111", "May 01, 2026", "$35.00"],
        ])

        result = _merge_csv(new_csv, dest)

        assert result == dest
        assert dest.exists()
        assert not new_csv.exists()  # moved, not copied

    def test_merge_adds_new_rows(self, tmp_path):
        """New rows are added to existing data."""
        existing = tmp_path / "coin.csv"
        new_csv = tmp_path / "download.csv"

        _write_csv(existing, HEADER, [
            ["2024 Silver Eagle", "111", "May 01, 2026", "$35.00"],
            ["2024 Silver Eagle BU", "222", "Apr 28, 2026", "$36.50"],
        ])
        _write_csv(new_csv, HEADER, [
            ["2024 Silver Eagle Roll", "333", "May 10, 2026", "$700.00"],
        ])

        _merge_csv(new_csv, existing)

        with open(existing, "r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader)  # skip header
            rows = list(reader)

        assert len(rows) == 3

    def test_existing_rows_never_lost(self, tmp_path):
        """Existing deep-paginated rows are preserved even when new CSV is smaller."""
        existing = tmp_path / "coin.csv"
        new_csv = tmp_path / "download.csv"

        # Simulate deep-paginated file with 100 rows
        existing_rows = [
            [f"Morgan Dollar #{i}", f"ID{i:04d}", "Apr 15, 2026", f"${50+i}.00"]
            for i in range(100)
        ]
        _write_csv(existing, HEADER, existing_rows)

        # New page-1 refresh has only 20 rows (some overlap, some new)
        new_rows = [
            [f"Morgan Dollar #{i}", f"ID{i:04d}", "Apr 15, 2026", f"${50+i}.00"]
            for i in range(15)  # 15 duplicates
        ] + [
            [f"Morgan Dollar NEW #{i}", f"NEW{i:04d}", "May 12, 2026", f"${80+i}.00"]
            for i in range(5)  # 5 genuinely new
        ]
        _write_csv(new_csv, HEADER, new_rows)

        _merge_csv(new_csv, existing)

        with open(existing, "r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader)
            rows = list(reader)

        # Must have all 100 original + 5 new = 105
        assert len(rows) == 105


class TestMergeCSVDeduplication:
    """Deduplication logic."""

    def test_dedup_by_item_id(self, tmp_path):
        """Same itemId in new file is skipped."""
        existing = tmp_path / "coin.csv"
        new_csv = tmp_path / "download.csv"

        _write_csv(existing, HEADER, [
            ["2024 Silver Eagle", "111", "May 01, 2026", "$35.00"],
        ])
        # Same item ID but different title -- should still be skipped
        _write_csv(new_csv, HEADER, [
            ["2024 ASE BU", "111", "May 01, 2026", "$35.00"],
        ])

        _merge_csv(new_csv, existing)

        with open(existing, "r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader)
            rows = list(reader)

        assert len(rows) == 1
        assert rows[0][0] == "2024 Silver Eagle"  # original kept

    def test_dedup_by_composite_key(self, tmp_path):
        """Same title+price+date composite key is skipped even without itemId."""
        existing = tmp_path / "coin.csv"
        new_csv = tmp_path / "download.csv"

        _write_csv(existing, HEADER, [
            ["2024 silver eagle bu tube of 20", "", "May 01, 2026", "$700.00"],
        ])
        _write_csv(new_csv, HEADER, [
            ["2024 Silver Eagle BU Tube of 20", "", "May 01, 2026", "$700.00"],
        ])

        _merge_csv(new_csv, existing)

        with open(existing, "r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader)
            rows = list(reader)

        # Composite key uses title[:80].lower() so these match
        assert len(rows) == 1

    def test_different_price_is_not_duplicate(self, tmp_path):
        """Same title+date but different price is a distinct comp."""
        existing = tmp_path / "coin.csv"
        new_csv = tmp_path / "download.csv"

        _write_csv(existing, HEADER, [
            ["2024 Silver Eagle", "111", "May 01, 2026", "$35.00"],
        ])
        _write_csv(new_csv, HEADER, [
            ["2024 Silver Eagle", "222", "May 01, 2026", "$38.00"],
        ])

        _merge_csv(new_csv, existing)

        with open(existing, "r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader)
            rows = list(reader)

        assert len(rows) == 2


class TestMergeCSVShrinkGuard:
    """Shrink guard prevents data loss."""

    def test_shrink_guard_blocks_smaller_output(self, tmp_path, capsys):
        """If merged result is somehow smaller than existing, keep existing."""
        existing = tmp_path / "coin.csv"
        new_csv = tmp_path / "download.csv"

        # Write 10 rows to existing
        rows_10 = [
            [f"Coin #{i}", f"ID{i}", "May 01, 2026", f"${30+i}.00"]
            for i in range(10)
        ]
        _write_csv(existing, HEADER, rows_10)

        # Craft a scenario where dedup keys cause shrinkage:
        # We can't naturally produce this with correct dedup logic,
        # so we test by writing a new file with rows that all match existing
        # keys but also corrupting the existing_rows dict wouldn't shrink...
        #
        # Actually the shrink guard is a safety net for unexpected bugs.
        # Let's verify it by temporarily modifying the existing file line count
        # to be artificially high (simulating a race condition or corruption).
        # Write existing with 10 data rows
        _write_csv(existing, HEADER, rows_10)

        # Append garbage lines to existing to inflate line count without valid CSV rows
        with open(existing, "a", encoding="utf-8") as f:
            for i in range(5):
                f.write("x\n")  # short rows (<4 cols) won't parse but count as lines

        # New CSV has 0 genuinely new rows (all dupes)
        _write_csv(new_csv, HEADER, rows_10[:5])

        _merge_csv(new_csv, existing)
        captured = capsys.readouterr()

        # Shrink guard should have fired (10 parsed rows < 15 line count)
        assert "SHRINK GUARD" in captured.out


class TestMergeCSVSorting:
    """Merged output is sorted by date descending."""

    def test_output_sorted_by_date_desc(self, tmp_path):
        """After merge, rows are sorted newest-first."""
        existing = tmp_path / "coin.csv"
        new_csv = tmp_path / "download.csv"

        _write_csv(existing, HEADER, [
            ["Eagle Jan", "001", "Jan 15, 2026", "$30.00"],
            ["Eagle Mar", "002", "Mar 20, 2026", "$32.00"],
        ])
        _write_csv(new_csv, HEADER, [
            ["Eagle May", "003", "May 10, 2026", "$35.00"],
            ["Eagle Feb", "004", "Feb 05, 2026", "$31.00"],
        ])

        _merge_csv(new_csv, existing)

        with open(existing, "r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader)
            rows = list(reader)

        dates = [r[2].strip() for r in rows]
        assert dates == ["May 10, 2026", "Mar 20, 2026", "Feb 05, 2026", "Jan 15, 2026"]


class TestMergeCSVEdgeCases:
    """Edge cases and malformed data."""

    def test_malformed_rows_skipped(self, tmp_path):
        """Rows with fewer than 4 columns are ignored."""
        existing = tmp_path / "coin.csv"
        new_csv = tmp_path / "download.csv"

        _write_csv(existing, HEADER, [
            ["Eagle", "001", "May 01, 2026", "$35.00"],
        ])

        # Write new CSV with a mix of valid and malformed rows
        with open(new_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(HEADER)
            writer.writerow(["Short row"])  # < 4 cols
            writer.writerow(["Two", "cols"])  # < 4 cols
            writer.writerow(["New Eagle", "002", "May 05, 2026", "$36.00"])  # valid

        _merge_csv(new_csv, existing)

        with open(existing, "r", newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            next(reader)
            rows = list(reader)

        assert len(rows) == 2  # original + 1 valid new row

    def test_temp_file_cleaned_up(self, tmp_path):
        """The new (temp) CSV is deleted after merge."""
        existing = tmp_path / "coin.csv"
        new_csv = tmp_path / "download.csv"

        _write_csv(existing, HEADER, [
            ["Eagle", "001", "May 01, 2026", "$35.00"],
        ])
        _write_csv(new_csv, HEADER, [
            ["Eagle New", "002", "May 05, 2026", "$36.00"],
        ])

        _merge_csv(new_csv, existing)

        assert not new_csv.exists()
        assert existing.exists()
