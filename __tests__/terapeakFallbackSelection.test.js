'use strict';

// P3 fallback selection, drained exit, report validity and yield logging in scripts/terapeak-export.py (#330H).
// The exporter is Python, so the tests import it under stub playwright/requests modules and drive
// its pure helpers and its --dry-run CLI with temporary data directories.

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { P3_FALLBACK_TIER_ORDER } = require('../src/services/freshnessClassifier');

jest.setTimeout(60000);

const PROJECT_ROOT = path.join(__dirname, '..');
const SCRIPT_DIR = path.join(PROJECT_ROOT, 'scripts');
const EXPORTER = path.join(SCRIPT_DIR, 'terapeak-export.py');
const PARSER = path.join(SCRIPT_DIR, '_parse-terapeak-pass.py');

function toWslPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`);
}

const PRELUDE = `
import contextlib
import importlib.util
import io
import json
import re
import sys
import tempfile
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

playwright = types.ModuleType("playwright")
sync_api = types.ModuleType("playwright.sync_api")
sync_api.sync_playwright = lambda: None
sync_api.TimeoutError = TimeoutError
playwright.sync_api = sync_api
sys.modules["playwright"] = playwright
sys.modules["playwright.sync_api"] = sync_api
sys.modules["requests"] = types.ModuleType("requests")

spec = importlib.util.spec_from_file_location("terapeak_export", EXPORTER_PATH)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

parser_spec = importlib.util.spec_from_file_location("parse_terapeak_pass", PARSER_PATH)
parser_module = importlib.util.module_from_spec(parser_spec)
parser_spec.loader.exec_module(parser_module)


def term(name, tier, **extra):
    base = {"term": name, "_fallback_tier": tier}
    base.update(extra)
    return base


def dataset(key, priority, tier=None, **extra):
    item = {"key": key, "searchTerm": key, "priority": priority, "actions": ["refresh" if priority else "ok"]}
    if priority == "P3":
        item["actions"] = ["monitor-refresh"]
        item["p3Tier"] = tier
    item.update(extra)
    return item


def dry_run(items, args, generated_at=None, datasets=None, with_backlog=True):
    tmp = Path(tempfile.mkdtemp())
    terapeak = tmp / "terapeak"
    terapeak.mkdir()
    exporter.TERAPEAK_DIR = terapeak
    exporter.CSV_DIR = terapeak
    exporter.PROGRESS_FILE = tmp / "progress.json"
    for item in items:
        if item.get("_nofile"):
            continue
        (terapeak / (item["key"].replace(" ", "_") + ".csv")).write_text("Item Title,Item ID,Sold Date,Sold Price\\n")
    report = {
        "generatedAt": generated_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "datasets": items if datasets is None else datasets,
    }
    if generated_at == "missing":
        del report["generatedAt"]
    (tmp / "report.json").write_text(json.dumps(report))
    argv = ["terapeak-export.py", "--dry-run", "--no-shuffle"]
    if with_backlog:
        argv += ["--backlog", str(tmp / "report.json")]
    argv += args
    captured = io.StringIO()
    code = 0
    old_argv = sys.argv
    sys.argv = argv
    try:
        with contextlib.redirect_stdout(captured):
            exporter.main()
    except SystemExit as exit_info:
        code = exit_info.code if isinstance(exit_info.code, int) else 1
    finally:
        sys.argv = old_argv
    text = captured.getvalue()
    lines = text.splitlines()
    return {
        "code": code,
        "listed": [re.sub(r"^\\s+\\d+\\.\\s+", "", line) for line in lines if re.match(r"^\\s+\\d+\\.\\s", line)],
        "info": [line for line in lines if line.startswith(("Mixed", "Fallback", "P0.1 surplus", "DRAINED", "ERROR", "No terms", "Skipping"))],
    }
`;

function runPython(body, extraArgs = {}) {
  const win = process.platform === 'win32';
  const exporterPath = win ? toWslPath(EXPORTER) : EXPORTER;
  const parserPath = win ? toWslPath(PARSER) : PARSER;
  const snippet = `EXPORTER_PATH = ${JSON.stringify(exporterPath)}\nPARSER_PATH = ${JSON.stringify(parserPath)}\n${PRELUDE}\n${body}`;
  const options = { cwd: PROJECT_ROOT, encoding: 'utf8', ...extraArgs };
  const result = win
    ? childProcess.spawnSync('wsl', ['python3', '-c', snippet], options)
    : childProcess.spawnSync('python3', ['-c', snippet], options);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  return JSON.parse(result.stdout);
}

const MIXED = (extra, p01 = 0) => ['--mixed-p01-fixed', String(p01), '--mixed-extra-min', String(extra), '--mixed-extra-max', String(extra)];

describe('tier order is defined once per language and kept equal', () => {
  test('exporter, pass parser, and freshness report agree', () => {
    const out = runPython(`
print(json.dumps({
    "exporter": list(exporter.FALLBACK_TIER_ORDER),
    "parser": list(parser_module.FALLBACK_TIER_ORDER),
}))
`);
    expect(out.exporter).toEqual([...P3_FALLBACK_TIER_ORDER]);
    expect(out.parser).toEqual([...P3_FALLBACK_TIER_ORDER]);
  });
});

describe('parse_fallback_tiers', () => {
  test('parses, trims, de-duplicates, and keeps the given order', () => {
    const out = runPython(`
print(json.dumps({
    "all": list(exporter.parse_fallback_tiers("all")),
    "ALL": list(exporter.parse_fallback_tiers(" ALL ")),
    "ordered": list(exporter.parse_fallback_tiers(" thin-low , near-viable,thin-low ,, ")),
    "empty": list(exporter.parse_fallback_tiers("")),
    "none": list(exporter.parse_fallback_tiers(None)),
}))
`);
    expect(out.all).toEqual([...P3_FALLBACK_TIER_ORDER]);
    expect(out.ALL).toEqual([...P3_FALLBACK_TIER_ORDER]);
    expect(out.ordered).toEqual(['thin-low', 'near-viable']);
    expect(out.empty).toEqual([]);
    expect(out.none).toEqual([]);
  });

  test('rejects an unknown tier and a generic tier request, naming the valid tiers', () => {
    const out = runPython(`
messages = []
for value in ("bogus", "near-viable,generic"):
    try:
        exporter.parse_fallback_tiers(value)
        messages.append("accepted")
    except ValueError as error:
        messages.append(str(error))
print(json.dumps(messages))
`);
    expect(out[0]).toContain("unknown fallback tier 'bogus'");
    expect(out[0]).toContain('probe-with-data');
    expect(out[1]).toContain("unknown fallback tier 'generic'");
  });
});

describe('select_fallback_terms', () => {
  const POOL = `
pool = [
    term("thin w", "thin-low", _comp_count=1, _stale_days=1),
    term("conf a", "confirmed-thin", _comp_count=3, _stale_days=100),
    term("near c", "near-viable", _p3_sale_rate=0.5, _stale_days=10),
    term("probe a", "probe-with-data", _p3_sale_rate=2.0, _stale_days=100),
    term("thin x", "thin-low", _comp_count=4, _stale_days=30),
    term("near a", "near-viable", _p3_sale_rate=1.0, _stale_days=200),
    term("probe c", "probe-with-data", _p3_sale_rate=None, _stale_days=300),
    term("probe b", "probe-with-data", _p3_sale_rate=3.0, _stale_days=50),
    term("thin y", "thin-low", _comp_count=4, _stale_days=10),
    term("near b", "near-viable", _p3_sale_rate=1.0, _stale_days=400),
    term("empty a", "probe-no-data"),
    term("conf b", "confirmed-thin", _comp_count=5, _stale_days=400),
    term("thin z", "thin-low", _comp_count=2, _stale_days=5),
]
names = lambda items: [t["term"] for t in items]
order = exporter.FALLBACK_TIER_ORDER
`;

  test('fills tier by tier, so a lower tier only joins after every higher-tier item is taken', () => {
    const out = runPython(`${POOL}
print(json.dumps({
    "two": names(exporter.select_fallback_terms(pool, order, 2)),
    "five": names(exporter.select_fallback_terms(pool, order, 5)),
    "everything": names(exporter.select_fallback_terms(pool, order, 99)),
}))
`);
    expect(out.two).toEqual(['probe b', 'probe a']);
    expect(out.five).toEqual(['probe b', 'probe a', 'probe c', 'near b', 'near a']);
    expect(out.everything).toEqual([
      // probe-with-data and near-viable: sale rate high to low, unknown last, ties stalest first
      'probe b', 'probe a', 'probe c', 'near b', 'near a', 'near c',
      'empty a',
      // thin-low and confirmed-thin: most comps first, ties most recent sale first
      'thin y', 'thin x', 'thin z', 'thin w',
      'conf b', 'conf a',
    ]);
  });

  test('only uses the requested tiers, in the requested order', () => {
    const out = runPython(`${POOL}
print(json.dumps({
    "subset": names(exporter.select_fallback_terms(pool, ("thin-low", "near-viable"), 99)),
    "single": names(exporter.select_fallback_terms(pool, ("confirmed-thin",), 1)),
    "none": names(exporter.select_fallback_terms(pool, (), 99)),
}))
`);
    expect(out.subset).toEqual(['thin y', 'thin x', 'thin z', 'thin w', 'near b', 'near a', 'near c']);
    expect(out.single).toEqual(['conf b']);
    expect(out.none).toEqual([]);
  });

  test('returns nothing for zero or negative slots and an empty pool', () => {
    const out = runPython(`${POOL}
print(json.dumps({
    "zero": names(exporter.select_fallback_terms(pool, order, 0)),
    "negative": names(exporter.select_fallback_terms(pool, order, -3)),
    "empty": names(exporter.select_fallback_terms([], order, 5)),
}))
`);
    expect(out).toEqual({ zero: [], negative: [], empty: [] });
  });

  test('breaks full ties by name so the order is deterministic', () => {
    const out = runPython(`
pool = [term("b", "near-viable", _p3_sale_rate=1.0, _stale_days=5), term("a", "near-viable", _p3_sale_rate=1.0, _stale_days=5)]
print(json.dumps([t["term"] for t in exporter.select_fallback_terms(pool, ("near-viable",), 2)]))
`);
    expect(out).toEqual(['a', 'b']);
  });
});

describe('report_is_valid', () => {
  test('accepts a report with datasets that was generated minutes ago', () => {
    const out = runPython(`
now = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
fresh = {"generatedAt": "2026-11-04T11:30:00.000Z", "datasets": [{"key": "x"}]}
print(json.dumps(exporter.report_is_valid(fresh, now=now)))
`);
    expect(out).toEqual([true, '']);
  });

  test.each([
    ['older than the allowed age', '{"generatedAt": "2026-11-04T09:00:00Z", "datasets": [{"key": "x"}]}', 'report is 180 minutes old'],
    ['an empty dataset list', '{"generatedAt": "2026-11-04T11:59:00Z", "datasets": []}', 'report lists no datasets'],
    ['no dataset list', '{"generatedAt": "2026-11-04T11:59:00Z"}', 'report lists no datasets'],
    ['no generatedAt', '{"datasets": [{"key": "x"}]}', 'report has no valid generatedAt'],
    ['an unparseable generatedAt', '{"generatedAt": "yesterday", "datasets": [{"key": "x"}]}', 'report has no valid generatedAt'],
    ['a generatedAt in the future', '{"generatedAt": "2026-11-04T13:00:00Z", "datasets": [{"key": "x"}]}', 'report generatedAt is in the future'],
    ['a report that is not an object', '[1, 2]', 'report is not a JSON object'],
  ])('rejects %s', (_label, reportJson, reason) => {
    const out = runPython(`
now = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
print(json.dumps(exporter.report_is_valid(json.loads(${JSON.stringify(reportJson)}), now=now)))
`);
    expect(out).toEqual([false, reason]);
  });

  test('treats a timezone-less generatedAt as UTC', () => {
    const out = runPython(`
now = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
print(json.dumps(exporter.report_is_valid({"generatedAt": "2026-11-04T11:50:00", "datasets": [{"key": "x"}]}, now=now)))
`);
    expect(out).toEqual([true, '']);
  });
});

describe('--dry-run backlog selection with fallback tiers', () => {
  // Three P0 datasets, and thirteen eligible fallback datasets spread over the five tiers.
  const FIXTURE = `
primary = [dataset("primary a", "P0"), dataset("primary b", "P0"), dataset("primary c", "P0")]
fallback = [
    dataset("probe data a", "P3", "probe-with-data", p3SaleRate=2.0, staleDays=100, compCount=20),
    dataset("probe data b", "P3", "probe-with-data", p3SaleRate=3.0, staleDays=50, compCount=20),
    dataset("probe data c", "P3", "probe-with-data", p3SaleRate=None, staleDays=300, compCount=20),
    dataset("near via a", "P3", "near-viable", p3SaleRate=1.0, staleDays=200, compCount=6),
    dataset("near via b", "P3", "near-viable", p3SaleRate=1.0, staleDays=400, compCount=6),
    dataset("near via c", "P3", "near-viable", p3SaleRate=0.5, staleDays=10, compCount=6),
    dataset("probe empty a", "P3", "probe-no-data", compCount=0, _nofile=True),
    dataset("thin x", "P3", "thin-low", staleDays=30, compCount=4),
    dataset("thin y", "P3", "thin-low", staleDays=10, compCount=4),
    dataset("thin z", "P3", "thin-low", staleDays=5, compCount=2),
    dataset("thin w", "P3", "thin-low", staleDays=1, compCount=1),
    dataset("conf a", "P3", "confirmed-thin", staleDays=100, compCount=3),
    dataset("conf b", "P3", "confirmed-thin", staleDays=400, compCount=5),
]
generic = [dataset("bench generic", "P3", "generic", compCount=50)]
FILL_ORDER = ["probe data b", "probe data a", "probe data c", "near via b", "near via a", "near via c",
              "probe empty a", "thin y", "thin x", "thin z", "thin w", "conf b", "conf a"]
`;

  test('open batch slots are filled from the tiers in order, after P0-P2', () => {
    const out = runPython(`${FIXTURE}
result = dry_run(primary + fallback + generic, ${JSON.stringify(MIXED(8))} + ["--fallback-tiers", "all"])
print(json.dumps(result))
`);
    expect(out.code).toBe(0);
    expect(out.listed).toEqual(['primary a', 'primary b', 'primary c', 'probe data b', 'probe data a', 'probe data c', 'near via b', 'near via a']);
    expect(out.info).toContain('Mixed backlog selection: P0.1 0/0, non-P0.1 3/8, total 8/8');
    expect(out.info).toContain('Fallback pool: 13 eligible (probe-with-data=3, near-viable=3, probe-no-data=1, thin-low=4, confirmed-thin=2)');
    expect(out.info).toContain('Fallback fill: 5 (probe-with-data=3, near-viable=2, probe-no-data=0, thin-low=0, confirmed-thin=0)');
  });

  test('a batch larger than every pool takes all of it, in tier order, including a dataset with no CSV yet', () => {
    const out = runPython(`${FIXTURE}
result = dry_run(primary + fallback + generic, ${JSON.stringify(MIXED(40))} + ["--fallback-tiers", "all"])
result["fill_order"] = FILL_ORDER
print(json.dumps(result))
`);
    expect(out.listed).toEqual(['primary a', 'primary b', 'primary c', ...out.fill_order]);
    expect(out.info).toContain('Fallback fill: 13 (probe-with-data=3, near-viable=3, probe-no-data=1, thin-low=4, confirmed-thin=2)');
    expect(out.listed).not.toContain('bench generic');
  });

  test('P0 to P2 datasets that fill the batch leave no slot for the fallback', () => {
    const out = runPython(`${FIXTURE}
many = [dataset("primary " + c, "P0") for c in "abcdefghij"]
result = dry_run(many + fallback, ${JSON.stringify(MIXED(8))} + ["--fallback-tiers", "all"])
print(json.dumps(result))
`);
    expect(out.listed).toHaveLength(8);
    expect(out.listed.every(name => name.startsWith('primary '))).toBe(true);
    expect(out.info).toContain('Fallback fill: 0 (probe-with-data=0, near-viable=0, probe-no-data=0, thin-low=0, confirmed-thin=0)');
  });

  test('P0.1 slots that go unused also go to the fallback, so the pass still uses the full batch', () => {
    const out = runPython(`${FIXTURE}
bullion = [dataset("bullion a", "P0.1"), dataset("bullion b", "P0.1")]
result = dry_run(bullion + primary + fallback, ${JSON.stringify(MIXED(5, 15))} + ["--fallback-tiers", "all"])
print(json.dumps(result))
`);
    // total 15 + 5 = 20: 2 P0.1 + 3 P0 + 13 fallback = 18 (the pools run out before the batch does)
    expect(out.listed).toHaveLength(18);
    expect(out.listed.slice(0, 2)).toEqual(['bullion a', 'bullion b']);
    expect(out.info).toContain('Mixed backlog selection: P0.1 2/15, non-P0.1 3/18, total 18/20');
  });

  test('without --fallback-tiers P3 datasets are skipped exactly as before', () => {
    const out = runPython(`${FIXTURE}
result = dry_run(primary + fallback + generic, ${JSON.stringify(MIXED(8))})
print(json.dumps(result))
`);
    expect(out.listed).toEqual(['primary a', 'primary b', 'primary c']);
    expect(out.info).toContain('Skipping 14 thin-market datasets (P3 monitor cadence, use --include-thin to include)');
    expect(out.info.filter(line => line.startsWith('Fallback'))).toEqual([]);
  });

  test('only the requested tiers join the pool, and the others are reported as skipped', () => {
    const out = runPython(`${FIXTURE}
result = dry_run(primary + fallback + generic, ${JSON.stringify(MIXED(30))} + ["--fallback-tiers", "near-viable,thin-low"])
print(json.dumps(result))
`);
    expect(out.listed).toEqual([
      'primary a', 'primary b', 'primary c',
      'near via b', 'near via a', 'near via c',
      'thin y', 'thin x', 'thin z', 'thin w',
    ]);
    expect(out.info).toContain('Fallback fill: 7 (near-viable=3, thin-low=4)');
    expect(out.info).toContain('Skipping 7 thin-market datasets (outside the fallback tiers)');
  });
});

describe('--dry-run drained exit', () => {
  const EMPTY_QUEUE = `
settled = [dataset("settled " + c, None) for c in "abc"]
base_args = ${JSON.stringify([...MIXED(8)])} + ["--fallback-tiers", "all", "--exit-on-drained"]
`;

  test('exits 20 when no dataset is eligible in P0-P2 or any fallback tier', () => {
    const out = runPython(`${EMPTY_QUEUE}
print(json.dumps(dry_run(settled, base_args)))
`);
    expect(out.code).toBe(20);
    expect(out.info).toContain('DRAINED: no eligible dataset in P0-P2 or any fallback tier');
    expect(out.listed).toEqual([]);
  });

  test('is a plain empty run, not a drain, without --exit-on-drained', () => {
    const out = runPython(`${EMPTY_QUEUE}
print(json.dumps(dry_run(settled, ${JSON.stringify([...MIXED(8)])} + ["--fallback-tiers", "all"])))
`);
    expect(out.code).toBe(0);
    expect(out.info).toContain('No terms to process.');
  });

  test('is not drained while a fallback dataset is eligible', () => {
    const out = runPython(`${EMPTY_QUEUE}
only_fallback = [dataset("probe data a", "P3", "probe-with-data", compCount=20), dataset("conf a", "P3", "confirmed-thin", compCount=3)]
print(json.dumps(dry_run(settled + only_fallback, base_args)))
`);
    expect(out.code).toBe(0);
    expect(out.listed).toEqual(['probe data a', 'conf a']);
  });

  test('P3 datasets outside the requested tiers do not keep the run alive', () => {
    const out = runPython(`${EMPTY_QUEUE}
extra = [dataset("bench generic", "P3", "generic", compCount=50), dataset("conf a", "P3", "confirmed-thin", compCount=3)]
print(json.dumps(dry_run(settled + extra, ${JSON.stringify([...MIXED(8)])} + ["--fallback-tiers", "near-viable", "--exit-on-drained"])))
`);
    expect(out.code).toBe(20);
  });

  test.each([
    ['older than the allowed age', 'generated_at=(datetime.now(timezone.utc) - timedelta(hours=5)).isoformat()', /report is \d+ minutes old/],
    ['without a generation time', 'generated_at="missing"', /report has no valid generatedAt/],
    ['without any datasets', 'datasets=[]', /report lists no datasets/],
  ])('an empty queue from a report %s is a failure, never a drain', (_label, override, pattern) => {
    const out = runPython(`${EMPTY_QUEUE}
print(json.dumps(dry_run(settled, base_args, ${override})))
`);
    expect(out.code).toBe(1);
    expect(out.info.join('\n')).toMatch(/refusing to treat an empty queue as drained/);
    expect(out.info.join('\n')).toMatch(pattern);
    expect(out.info.join('\n')).not.toMatch(/DRAINED/);
  });

  test('an old report does not stop a run that still has eligible work', () => {
    const out = runPython(`${EMPTY_QUEUE}
work = [dataset("primary a", "P0")]
print(json.dumps(dry_run(work, base_args, generated_at=(datetime.now(timezone.utc) - timedelta(hours=5)).isoformat())))
`);
    expect(out.code).toBe(0);
    expect(out.listed).toEqual(['primary a']);
  });

  test('a --filter that matches nothing is not a drain', () => {
    const out = runPython(`${EMPTY_QUEUE}
print(json.dumps(dry_run(settled, base_args + ["--filter", "no-such-dataset"])))
`);
    expect(out.code).toBe(0);
    expect(out.info).toContain('No terms to process.');
  });

  test('--exit-on-drained works without fallback tiers: drained means P0-P2 is empty', () => {
    const out = runPython(`${EMPTY_QUEUE}
print(json.dumps(dry_run(settled, ${JSON.stringify([...MIXED(8)])} + ["--exit-on-drained"])))
`);
    expect(out.code).toBe(20);
  });
});

describe('--dry-run option validation', () => {
  test.each([
    ['an unknown tier', '["--fallback-tiers", "bogus"] + MIXED', 2, /unknown fallback tier 'bogus'/],
    ['--include-thin together with tiers', '["--fallback-tiers", "all", "--include-thin"] + MIXED', 2, /cannot be combined with --include-thin/],
    ['tiers without mixed selection', '["--fallback-tiers", "all"]', 2, /require mixed selection/],
    ['--exit-on-drained without mixed selection', '["--exit-on-drained"]', 2, /require mixed selection/],
  ])('rejects %s', (_label, argsExpr, code, pattern) => {
    const out = runPython(`
MIXED = ${JSON.stringify([...MIXED(8)])}
print(json.dumps(dry_run([dataset("primary a", "P0")], ${argsExpr})))
`);
    expect(out.code).toBe(code);
    expect(out.info.join('\n')).toMatch(pattern);
  });

  test('tiers need --backlog', () => {
    const out = runPython(`
MIXED = ${JSON.stringify([...MIXED(8)])}
print(json.dumps(dry_run([dataset("primary a", "P0")], ["--fallback-tiers", "all"] + MIXED, with_backlog=False)))
`);
    expect(out.code).toBe(2);
    expect(out.info.join('\n')).toMatch(/require --backlog/);
  });
});

describe('dataset merge yield', () => {
  const MERGE = `
def write(path, rows):
    header = "Item Title,Item ID,Sold Date,Sold Price\\n"
    path.write_text(header + "".join(",".join(r) + "\\n" for r in rows))

tmp = Path(tempfile.mkdtemp())
existing = [("Coin A", "111", "Jan 05 2026", "$10.00"), ("Coin B", "222", "Jan 06 2026", "$11.00")]
`;

  test('counts only the rows a merge adds, not rows already present', () => {
    const out = runPython(`${MERGE}
dest = tmp / "dest.csv"
write(dest, existing)
fresh = tmp / "fresh.csv"
write(fresh, [
    ("Coin B", "222", "Jan 06 2026", "$11.00"),
    ("Coin C", "333", "Jan 07 2026", "$12.00"),
    ("coin a", "", "Jan 05 2026", "$10.00"),
])
exporter._merge_csv(fresh, dest)
print(json.dumps({"appended": exporter._LAST_MERGE["appended"], "rows": len(dest.read_text().splitlines()) - 1}))
`);
    expect(out).toEqual({ appended: 1, rows: 3 });
  });

  test('a dataset created by the merge counts all of its rows', () => {
    const out = runPython(`${MERGE}
dest = tmp / "brand_new.csv"
fresh = tmp / "fresh.csv"
write(fresh, existing + [("Coin C", "333", "Jan 07 2026", "$12.00")])
exporter._merge_csv(fresh, dest)
print(json.dumps({"appended": exporter._LAST_MERGE["appended"], "exists": dest.exists()}))
`);
    expect(out).toEqual({ appended: 3, exists: true });
  });

  test('resets to zero when the merge adds nothing', () => {
    const out = runPython(`${MERGE}
dest = tmp / "dest.csv"
write(dest, existing)
exporter._LAST_MERGE["appended"] = 99
fresh = tmp / "fresh.csv"
write(fresh, existing)
exporter._merge_csv(fresh, dest)
print(json.dumps({"appended": exporter._LAST_MERGE["appended"]}))
`);
    expect(out).toEqual({ appended: 0 });
  });
});

describe('surplus P0.1 items take open slots before the fallback', () => {
  const POOLS = `
bullion = [dataset("bullion " + c, "P0.1") for c in "abcdef"]
other = [dataset("primary a", "P0")]
fallback = [dataset("probe data a", "P3", "probe-with-data", p3SaleRate=2.0, staleDays=10, compCount=9),
            dataset("thin x", "P3", "thin-low", staleDays=10, compCount=4)]
`;

  test('P0.1 items beyond the fixed share fill open slots, so no fallback item runs while P0.1 work waits', () => {
    const out = runPython(`${POOLS}
print(json.dumps(dry_run(bullion + other + fallback, ${JSON.stringify(MIXED(4, 2))} + ["--fallback-tiers", "all"])))
`);
    // total 6: 2 fixed P0.1, 1 P0, then 3 surplus P0.1 instead of fallback items
    expect(out.listed).toEqual(['bullion a', 'bullion b', 'bullion c', 'bullion d', 'bullion e', 'primary a']);
    expect(out.info).toContain('P0.1 surplus fill: 3 (open slots used by P0.1 items beyond the fixed share)');
    expect(out.info).toContain('Fallback fill: 0 (probe-with-data=0, near-viable=0, probe-no-data=0, thin-low=0, confirmed-thin=0)');
  });

  test('slots left after the surplus P0.1 items go to the fallback', () => {
    const out = runPython(`${POOLS}
print(json.dumps(dry_run(bullion[:3] + other + fallback, ${JSON.stringify(MIXED(5, 2))} + ["--fallback-tiers", "all"])))
`);
    // total 7: 2 fixed P0.1, 1 P0, 1 surplus P0.1, then 2 fallback items for the remaining 3 slots
    expect(out.listed).toEqual(['bullion a', 'bullion b', 'bullion c', 'primary a', 'probe data a', 'thin x']);
    expect(out.info).toContain('P0.1 surplus fill: 1 (open slots used by P0.1 items beyond the fixed share)');
  });

  test('without fallback tiers the open slots stay empty exactly as before', () => {
    const out = runPython(`${POOLS}
print(json.dumps(dry_run(bullion + other, ${JSON.stringify(MIXED(4, 2))})))
`);
    expect(out.listed).toEqual(['bullion a', 'bullion b', 'primary a']);
    expect(out.info.filter(line => line.startsWith('P0.1 surplus'))).toEqual([]);
  });
});

describe('--include-thin with --exit-on-drained', () => {
  const ITEMS = `
settled = [dataset("settled a", None)]
generic = [dataset("bench generic", "P3", "generic", compCount=50)]
thin = [dataset("thin x", "P3", "thin-low", staleDays=10, compCount=4)]
args = ${JSON.stringify([...MIXED(8)])} + ["--include-thin", "--exit-on-drained"]
`;

  test('generic benchmark items alone do not keep the run alive', () => {
    const out = runPython(`${ITEMS}
print(json.dumps(dry_run(settled + generic, args)))
`);
    expect(out.code).toBe(20);
    expect(out.info).toContain('DRAINED: no eligible dataset in P0-P2 or any fallback tier');
  });

  test('a real thin dataset still keeps the run alive, and the generic item runs beside it as before', () => {
    const out = runPython(`${ITEMS}
print(json.dumps(dry_run(settled + generic + thin, args)))
`);
    expect(out.code).toBe(0);
    expect(out.listed).toEqual(expect.arrayContaining(['thin x', 'bench generic']));
    expect(out.listed).toHaveLength(2);
  });

  test('an invalid report with only generic items is a failure, not a drain', () => {
    const out = runPython(`${ITEMS}
print(json.dumps(dry_run(settled + generic, args, datasets=[])))
`);
    expect(out.code).toBe(1);
    expect(out.info.join('\n')).not.toMatch(/DRAINED/);
  });
});

describe('drain guard with priority filters', () => {
  const WORK = `
work = [dataset("primary a", "P0"), dataset("second b", "P1")]
base = ${JSON.stringify([...MIXED(8)])} + ["--exit-on-drained"]
`;

  test.each([
    ['--priority-include', 'P2'],
    ['--priority-exclude', 'P0,P1'],
  ])('%s that hides all work is a filtered run, not a drain', (flag, value) => {
    const out = runPython(`${WORK}
print(json.dumps(dry_run(work, base + [${JSON.stringify(flag)}, ${JSON.stringify(value)}])))
`);
    expect(out.code).toBe(0);
    expect(out.info).toContain('No terms to process.');
    expect(out.info.join('\n')).not.toMatch(/DRAINED/);
  });

  test('the same empty queue without a filter is still a drain', () => {
    const out = runPython(`
print(json.dumps(dry_run([dataset("settled a", None)], ${JSON.stringify([...MIXED(8)])} + ["--exit-on-drained"])))
`);
    expect(out.code).toBe(20);
  });
});

describe('[yield] logging follows the upload outcome and the dataset that is kept', () => {
  const YIELD = `
HEADER = "Item Title,Item ID,Date,Price\\n"
NO_COMPS = "HTTP 422: " + json.dumps({"error": "No valid comps found in CSV"})
tmp = Path(tempfile.mkdtemp())
exporter.REJECTED_DIR = tmp / "rejected"
exporter._report_no_data = lambda term_name: None
(tmp / "data").mkdir()
(tmp / "incoming").mkdir()

def stage(name, tier, rows):
    dest = tmp / "data" / (name + ".csv")
    incoming = tmp / "incoming" / (name + ".csv")
    incoming.write_text(HEADER + "".join(row + "\\n" for row in rows))
    exporter._stage_dataset(incoming, dest, name)
    exporter._dataset_yield[name]["tier"] = tier

def log_of(action):
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        action()
    return buffer.getvalue()

def tiers_of(text):
    log = tmp / "pass.log"
    log.write_text(text)
    return parser_module.parse_tier_telemetry(str(log))["tier_yield"]
`;

  test('sync outcome: the yield is its own line after the result, so the coin line stays intact', () => {
    const out = runPython(`${YIELD}
exporter._begin_run()
def loop_body():
    print("  [ 25%] Coin A...", end=" ", flush=True)
    stage("Coin A", "near-viable", ["Coin A,1,2026-01-01,10.00", "Coin A,2,2026-01-02,11.00"])
    exporter._record_sync_upload_result("Coin A", True, "2 new, 0 dups", {})
    exporter._emit_yield("Coin A")
text = log_of(loop_body)
print(json.dumps({"lines": text.splitlines(), "tiers": tiers_of(text)}))
`);
    expect(out.lines).toEqual([
      '  [ 25%] Coin A... OK (2 new, 0 dups)',
      '  [yield] tier=near-viable appended=2 term=Coin A',
    ]);
    expect(out.tiers).toEqual({ 'near-viable': { items: 1, appended_rows: 2 } });
  });

  test('async outcome: the yield follows SAVED and is not glued to the coin line', () => {
    const out = runPython(`${YIELD}
exporter._begin_run()
def loop_body():
    print("  [ 25%] Coin B...", end=" ", flush=True)
    stage("Coin B", "primary", ["Coin B,1,2026-01-01,10.00"])
    print("SAVED (upload pending)")
    exporter._emit_yield("Coin B")
print(json.dumps({"lines": log_of(loop_body).splitlines()}))
`);
    expect(out.lines).toEqual([
      '  [ 25%] Coin B... SAVED (upload pending)',
      '  [yield] tier=primary appended=1 term=Coin B',
    ]);
  });

  test('a sync 422 rejection logs zero rows, because the CSV is set aside', () => {
    const out = runPython(`${YIELD}
exporter._begin_run()
def loop_body():
    print("  [ 25%] Coin C...", end=" ", flush=True)
    stage("Coin C", "thin-low", ["Coin C,1,2026-01-01,10.00", "Coin C,2,2026-01-02,11.00"])
    exporter._record_sync_upload_result("Coin C", False, NO_COMPS, {})
    exporter._emit_yield("Coin C")
text = log_of(loop_body)
print(json.dumps({"yields": [l for l in text.splitlines() if "[yield]" in l], "tiers": tiers_of(text), "rejected": len(list((tmp / "rejected").glob("*.csv")))}))
`);
    expect(out.yields).toEqual(['  [yield] tier=thin-low appended=0 term=Coin C']);
    expect(out.tiers).toEqual({ 'thin-low': { items: 1, appended_rows: 0 } });
    expect(out.rejected).toBe(1);
  });

  test('an async 422 rejection after the yield was logged adds a correcting line the parser honours', () => {
    const out = runPython(`${YIELD}
exporter._begin_run()
lines = []
def first():
    print("  [ 25%] Coin D...", end=" ", flush=True)
    stage("Coin D", "near-viable", ["Coin D,1,2026-01-01,10.00", "Coin D,2,2026-01-02,11.00", "Coin D,3,2026-01-03,12.00"])
    print("SAVED (upload pending)")
    exporter._emit_yield("Coin D")
def later():
    exporter._record_upload_result({"term": "Coin D", "ok": False, "msg": NO_COMPS}, {})
first_text = log_of(first)
later_text = log_of(later)
print(json.dumps({"first": [l for l in first_text.splitlines() if "[yield]" in l],
                  "later": [l for l in later_text.splitlines() if "[yield]" in l],
                  "tiers": tiers_of(first_text + later_text)}))
`);
    expect(out.first).toEqual(['  [yield] tier=near-viable appended=3 term=Coin D']);
    expect(out.later).toEqual(['  [yield] tier=near-viable appended=0 term=Coin D']);
    expect(out.tiers).toEqual({ 'near-viable': { items: 1, appended_rows: 0 } });
  });

  test('a rejected dataset that was never logged does not add a stray yield line', () => {
    const out = runPython(`${YIELD}
exporter._begin_run()
stage("Coin E", "primary", ["Coin E,1,2026-01-01,10.00"])
text = log_of(lambda: exporter._record_upload_result({"term": "Coin E", "ok": False, "msg": NO_COMPS}, {}))
print(json.dumps({"yields": [l for l in text.splitlines() if "[yield]" in l]}))
`);
    expect(out.yields).toEqual([]);
  });

  test('the run loop logs the yield after the upload block, for every upload mode', () => {
    const source = fs.readFileSync(EXPORTER, 'utf8');
    const staged = source.indexOf('dest = _stage_dataset(csv_path, dest, term)');
    const syncResult = source.indexOf('_record_sync_upload_result(', staged);
    const emitted = source.indexOf('_emit_yield(term)', staged);
    const noExport = source.indexOf('NO EXPORT (no results or button not found)', staged);
    expect(staged).toBeGreaterThan(-1);
    expect(syncResult).toBeGreaterThan(staged);
    expect(emitted).toBeGreaterThan(syncResult);
    expect(noExport).toBeGreaterThan(emitted);
    expect(source).not.toMatch(/print\(f"\[yield\]/);
  });
});
